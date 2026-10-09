"""사이트에 올릴 모델 파일을 만든다(배포 때 GitHub Actions가 돌린다).

입력: sherpa-onnx-whisper-turbo 폴더(int8 인코더·디코더·토큰), CAM++ onnx, (선택) Silero VAD onnx
출력: <out>/ 아래 조각 파일들과 manifest.json
  - 디코더는 토큰 임베딩(fp32 265MB)을 행별 int8로 줄인다(shrink_decoder.py) — 전사 결과는 사실상 같다
  - GitHub Pages 한 파일 크기 걱정이 없도록 45MB 조각으로 나눈다

사용: python tools/prepare_models.py <turbo_dir> <campplus.onnx> <out_dir> [silero_vad.onnx]
"""
import hashlib
import json
import os
import subprocess
import sys

PART = 45 * 1024 * 1024


def split(src, out, name):
    size = os.path.getsize(src)
    parts, sizes = [], []
    h = hashlib.sha256()
    with open(src, "rb") as f:
        i = 0
        while True:
            b = f.read(PART)
            if not b:
                break
            h.update(b)
            pn = f"{name}.{i:03d}"
            with open(os.path.join(out, pn), "wb") as w:
                w.write(b)
            parts.append(pn)
            sizes.append(len(b))
            i += 1
    return {"name": name, "size": size, "parts": parts, "partSizes": sizes, "sha256": h.hexdigest()}


def main():
    turbo, camp, out = sys.argv[1:4]
    vad = sys.argv[4] if len(sys.argv) > 4 else None
    os.makedirs(out, exist_ok=True)
    here = os.path.dirname(os.path.abspath(__file__))
    small = os.path.join(out, "_decoder.tmp.onnx")
    subprocess.run([sys.executable, os.path.join(here, "shrink_decoder.py"), os.path.join(turbo, "turbo-decoder.int8.onnx"), small], check=True)
    files = {
        "encoder": split(os.path.join(turbo, "turbo-encoder.int8.onnx"), out, "whisper-encoder.onnx"),
        "decoder": split(small, out, "whisper-decoder.onnx"),
        "campplus": split(camp, out, "campplus.onnx"),
        "tokens": split(os.path.join(turbo, "turbo-tokens.txt"), out, "tokens.txt"),
    }
    if vad:
        files["vad"] = split(vad, out, "silero-vad.onnx")
    os.remove(small)
    version = hashlib.sha256("".join(f["sha256"] for f in files.values()).encode()).hexdigest()[:12]
    with open(os.path.join(out, "manifest.json"), "w") as f:
        json.dump({"version": version, "files": files}, f, indent=1)
    total = sum(f["size"] for f in files.values())
    print(f"models {version}: {total / 2**20:.0f} MB in {sum(len(f['parts']) for f in files.values())} parts")


if __name__ == "__main__":
    main()
