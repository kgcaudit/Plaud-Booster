"""Whisper 인코더를 블록 경계에서 여러 조각(세션)으로 나눈다 — 휴대폰 메모리 최대치를 줄이려고.

700MB 인코더를 한 번에 세션으로 만들면 JS 사본 + wasm 사본(+ 그래픽 칩 사본)이 겹쳐 휴대폰 탭이 꺼진다.
조각마다 세션을 만들고 바이트를 놓으면 한 번에 드는 양이 조각 크기로 줄어든다.
조각 k의 입력은 앞 조각의 블록 출력(hidden), 마지막 조각의 출력은 원래 출력(n_layer_cross_k·v).

사용: python split_encoder.py <encoder.onnx> <out_prefix> [조각 수=4]
      → <out_prefix>.0.onnx … 와 조각 사이 텐서 이름을 출력(JSON 한 줄)
"""
import json
import sys

import onnx
from onnx.utils import Extractor

src, prefix = sys.argv[1], sys.argv[2]
parts = int(sys.argv[3]) if len(sys.argv) > 3 else 4
m = onnx.load(src)
blocks = sorted({int(n.name.split("blocks.")[1].split("/")[0]) for n in m.graph.node if "/blocks." in n.name})
nb = len(blocks)
cuts = [f"/audioEncoder/blocks.{(nb * (k + 1)) // parts - 1}/Add_1_output_0" for k in range(parts - 1)]
ex = Extractor(m)
ins = ["mel"] + cuts
outs = cuts + [o.name for o in m.graph.output]
names = []
for k in range(parts):
    o = outs[k:k + 1] if k < parts - 1 else [o.name for o in m.graph.output]
    sub = ex.extract_model([ins[k]], o)
    for imp in m.opset_import:
        if not any(i.domain == imp.domain for i in sub.opset_import):
            sub.opset_import.append(imp)
    sub.ir_version = m.ir_version
    p = f"{prefix}.{k}.onnx"
    onnx.save(sub, p)
    names.append({"file": p, "input": ins[k], "outputs": o})
print(json.dumps({"parts": names}))
