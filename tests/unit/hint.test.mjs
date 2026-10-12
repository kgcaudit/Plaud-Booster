import test from "node:test";
import assert from "node:assert/strict";
import { Whisper } from "../../web/src/models.js";

// 작은 토큰 목록: 바이트(base64) 번호
const b64 = (s) => Buffer.from(s, "utf8").toString("base64");
const toks = [[" ", 1], ["과", 2], ["과기", 3], ["과기성", 4], [",", 5], [".", 6], [" 과기성", 7], ["노무비", 8], [" 노무비", 9]]
  .map(([t, i]) => `${b64(t)} ${i}`).join("\n");

test("전사 힌트: 가장 긴 토큰부터 부호화, 상한 넘으면 뒤 낱말부터 빼고, 앞머리에 「이전 글」", () => {
  const w = new Whisper(null, [], null, toks);
  assert.deepEqual(w.encodeText(" 과기성, 노무비."), [7, 5, 9, 6]);
  assert.deepEqual(w.setHint(["과기성", "노무비"], 4), ["과기성", "노무비"]);
  assert.deepEqual(w.setHint(["과기성", "노무비"], 3), ["과기성"]);
  const base = [w.SOT, w.KO, w.TRANSCRIBE];
  assert.deepEqual(w.head(base), [50362n, 7n, 6n, ...base]);
  assert.deepEqual(w.head(base, false), base);
  assert.equal(w.leaked("과기성."), false); // 한 낱말만이면 새어 나온 것으로 보지 않음
  w.setHint(["과기성", "노무비"], 9);
  assert.equal(w.leaked("과기성, 노무비."), true);
  assert.equal(w.hintDrops, 1);
  assert.deepEqual(w.setHint([]), []);
  assert.deepEqual(w.head(base), base);
});
