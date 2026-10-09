"""sherpa-onnx Whisper int8(동적 양자화) 모델의 MatMulInteger 묶음을 MatMulNBits(4/8비트 블록 양자화)로 바꾼다.

패턴: DynamicQuantizeLinear(x) -> MatMulInteger(xq, Wq, xzp, Wzp) -> Cast -> Mul(x_scale*W_scale)
바꾼 뒤: MatMulNBits(x, Wpacked, scales, zp) -> (Mul 출력 이름 그대로)
사용: python to_nbits.py in.onnx out.onnx [bits=4] [block=32] [accuracy_level=4]
"""
import sys
import collections
import numpy as np
import onnx
from onnx import numpy_helper, helper
from onnxruntime.capi._pybind_state import quantize_matmul_4bits, quantize_matmul_8bits

src, dst = sys.argv[1], sys.argv[2]
bits = int(sys.argv[3]) if len(sys.argv) > 3 else 4
block = int(sys.argv[4]) if len(sys.argv) > 4 else 32
acc = int(sys.argv[5]) if len(sys.argv) > 5 else 4

m = onnx.load(src)
g = m.graph
inits = {t.name: t for t in g.initializer}
prod = {o: n for n in g.node for o in n.output}
cons = collections.defaultdict(list)
for n in g.node:
    for i in n.input:
        cons[i].append(n)


def arr(name):
    return numpy_helper.to_array(inits[name])


def block_quant(w):
    K, N = w.shape
    kpack = 8 // bits
    kb = (K + block - 1) // block
    blob = (block + kpack - 1) // kpack
    pad = kb * block - K
    if pad:
        w = np.pad(w, ((0, pad), (0, 0)))
    w = np.ascontiguousarray(w.astype(np.float32))
    packed = np.zeros((N, kb, blob), np.uint8)
    zp = np.zeros((N, (kb + kpack - 1) // kpack), np.uint8)
    sc = np.zeros((N, kb), np.float32)
    (quantize_matmul_4bits if bits == 4 else quantize_matmul_8bits)(packed, w, sc, zp, block, N, K, False)
    return packed, sc, zp


remove = set()
new_nodes = {}
new_inits = []
count = 0
for mi in [n for n in g.node if n.op_type == "MatMulInteger"]:
    xq, wq, xzp, wzp = mi.input
    if wq not in inits:
        continue
    dql = prod.get(xq)
    cast = cons[mi.output[0]]
    if not dql or dql.op_type != "DynamicQuantizeLinear" or len(cast) != 1 or cast[0].op_type != "Cast":
        continue
    cast = cast[0]
    mul = cons[cast.output[0]]
    if len(mul) != 1 or mul[0].op_type != "Mul":
        continue
    mul = mul[0]
    sc_in = [i for i in mul.input if i != cast.output[0]][0]
    scmul = prod.get(sc_in)
    if scmul is None or scmul.op_type != "Mul":
        continue
    w_scale_name = [i for i in scmul.input if i in inits]
    if len(w_scale_name) != 1:
        continue
    W = (arr(wq).astype(np.float32) - arr(wzp).astype(np.float32)) * arr(w_scale_name[0]).astype(np.float32)
    K, N = W.shape
    packed, sc, zp = block_quant(W)
    base = wq.replace("_quantized", "")
    new_inits += [numpy_helper.from_array(packed, base + f"_Q{bits}"), numpy_helper.from_array(sc.reshape(-1), base + "_scales"),
                  numpy_helper.from_array(zp.reshape(-1), base + "_zp")]
    node = helper.make_node("MatMulNBits", [dql.input[0], base + f"_Q{bits}", base + "_scales", base + "_zp"], [mul.output[0]],
                            name=mi.name + f"_Q{bits}", domain="com.microsoft", K=K, N=N, bits=bits, block_size=block, accuracy_level=acc)
    new_nodes[mi.name] = node
    remove |= {id(mi), id(cast), id(mul), id(scmul)}
    for nm in (wq, wzp, w_scale_name[0]):
        remove.add(("init", nm))
    count += 1

# DynamicQuantizeLinear 중 더 이상 쓰는 곳이 없는 것 제거
out = []
for n in g.node:
    if n.name in new_nodes:
        out.append(new_nodes[n.name])
    elif id(n) not in remove:
        out.append(n)
used = {i for n in out for i in n.input} | {o.name for o in g.output}
out = [n for n in out if not (n.op_type == "DynamicQuantizeLinear" and not any(o in used for o in n.output))]
used = {i for n in out for i in n.input} | {o.name for o in g.output}
del g.node[:]
g.node.extend(out)
keep = [t for t in g.initializer if t.name in used]
del g.initializer[:]
g.initializer.extend(keep + new_inits)
if not any(o.domain == "com.microsoft" for o in m.opset_import):
    m.opset_import.append(helper.make_opsetid("com.microsoft", 1))
onnx.save(m, dst)
print(f"{count} MatMulInteger -> MatMulNBits({bits}bit, block {block}); saved {dst}")
