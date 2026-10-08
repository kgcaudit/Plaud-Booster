// onnxruntime-web 실행 파일을 web/vendor/ort 로 복사한다(저장소에는 넣지 않고 배포 때 만든다).
import fs from "node:fs";
import path from "node:path";
const src = "node_modules/onnxruntime-web/dist";
const dst = "web/vendor/ort";
fs.mkdirSync(dst, { recursive: true });
for (const f of ["ort.wasm.min.mjs", "ort-wasm-simd-threaded.mjs", "ort-wasm-simd-threaded.wasm"]) {
  fs.copyFileSync(path.join(src, f), path.join(dst, f));
}
console.log("vendored onnxruntime-web ->", dst);
