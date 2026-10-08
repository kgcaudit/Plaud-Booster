"""디코더의 토큰 임베딩(fp32 265MB)을 행별 int8 + 배율로 줄인다. 실행 시 ORT가 상수로 펼친다."""
import sys
import numpy as np
import onnx
from onnx import helper, numpy_helper, TensorProto

src, dst = sys.argv[1], sys.argv[2]
m = onnx.load(src)
g = m.graph
name = "textDecoder.token_embedding.weight"
idx = next(i for i, t in enumerate(g.initializer) if t.name == name)
w = numpy_helper.to_array(g.initializer[idx]).astype(np.float32)
scale = np.abs(w).max(axis=1, keepdims=True) / 127.0
scale[scale == 0] = 1.0
q = np.clip(np.round(w / scale), -127, 127).astype(np.int8)
del g.initializer[idx]
g.initializer.extend([numpy_helper.from_array(q, name + "_q"), numpy_helper.from_array(scale.astype(np.float32), name + "_scale")])
nodes = [helper.make_node("Cast", [name + "_q"], [name + "_f"], to=TensorProto.FLOAT, name="emb_dq_cast"),
         helper.make_node("Mul", [name + "_f", name + "_scale"], [name], name="emb_dq_mul")]
for n in reversed(nodes):
    g.node.insert(0, n)
onnx.save(m, dst)
err = np.abs(q.astype(np.float32) * scale - w).max()
print("saved", dst, "max abs err", err)
