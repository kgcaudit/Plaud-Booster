import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { whisperLogMel, kaldiFbank, vadChunks, activeEnd } from "../../web/src/dsp.js";

const fx = JSON.parse(fs.readFileSync(new URL("../fixtures/dsp.json", import.meta.url)));
function signal() {
  const sr = 16000, n = Math.floor(2.3 * sr), x = new Float32Array(n);
  for (let i = 0; i < n; i++) { const t = i / sr; x[i] = 0.3 * Math.sin(2 * Math.PI * 220 * t) * (1 + 0.5 * Math.sin(2 * Math.PI * 3 * t)) + 0.05 * Math.sin(2 * Math.PI * 1500 * t + 0.3); }
  return x;
}

test("Whisper log-mel이 파이썬 기준 구현과 같다", () => {
  const mel = whisperLogMel(signal());
  for (const [m, f, v] of fx.mel) assert.ok(Math.abs(mel[m * 3000 + f] - v) < 1e-4, `mel[${m},${f}] ${mel[m * 3000 + f]} vs ${v}`);
});

test("kaldi fbank가 파이썬 기준 구현(=kaldi-native-fbank)과 같다", () => {
  const { data, frames } = kaldiFbank(signal());
  assert.equal(frames, fx.fbank.frames);
  for (const [f, b, v] of fx.fbank.values) assert.ok(Math.abs(data[f * 80 + b] - v) < 1e-3, `fb[${f},${b}] ${data[f * 80 + b]} vs ${v}`);
});

test("말소리 구간은 25초를 넘지 않고, 쉼에서 나뉜다", () => {
  const sr = 16000, x = new Float32Array(sr * 70);
  for (let s = 0; s < 70; s += 7) for (let i = s * sr; i < (s + 5) * sr && i < x.length; i++) x[i] = 0.3 * Math.sin(i / 7); // 5초 말 + 2초 쉼
  const ch = vadChunks(x, 100);
  assert.ok(ch.length >= 3);
  for (const [a, b] of ch) { assert.ok(b - a <= 25.01); assert.ok(a >= 100); }
  assert.ok(activeEnd(x, 100, 170) <= 170);
});
