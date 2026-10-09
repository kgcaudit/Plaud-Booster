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

test("말소리 구간(에너지): 쉼 없는 통화에서 작게 들리는 상대방 말도 잡는다", () => {
  const SR = 16000, x = new Float32Array(60 * SR);
  let seed = 1; const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 4294967296 - 0.5);
  // 0~2초 조용함(선 잡음), 이후 4초씩 큰 사람(0.3)·작은 사람(0.03) 번갈아, 쉼 없음. 말은 음절처럼 세기가 오르내린다
  for (let i = 0; i < x.length; i++) {
    const t = i / SR, loud = Math.floor((t - 2) / 4) % 2 === 0, amp = t < 2 ? 0 : loud ? 0.3 : 0.03;
    x[i] = 0.002 * rnd() + amp * (0.6 + 0.4 * Math.sin(2 * Math.PI * 4 * t)) * Math.sin(i / 6);
  }
  const ch = vadChunks(x, 0);
  const cov = ch.reduce((m, [a, b]) => m + b - a, 0);
  assert.ok(cov > 54, `잡힌 말소리 ${cov.toFixed(1)}초 / 58초`);
  assert.ok(ch[0][0] >= 1.5); // 앞의 조용한 2초는 빼고
});
