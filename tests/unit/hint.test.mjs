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
  // 고르기: 힌트 낱말만 늘어놓았거나, 힌트 없을 때보다 10% 넘게 짧으면 힌트 없는 글
  w.setHint(["과기성", "노무비"], 9);
  assert.equal(w.pickHint("과기성 나간 부분은 노무비로", "과외성 나간 부분은 농업이로"), true);
  assert.equal(w.pickHint("과기성, 노무비.", ""), false);
  assert.equal(w.pickHint("부분은 노무비로", "과외성 나간 부분은 농업이로"), false);
  assert.equal(w.hintDrops, 2);
  assert.deepEqual(w.setHint([]), []);
  assert.deepEqual(w.head(base), base);
});
