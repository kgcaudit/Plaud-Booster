import { test } from "node:test";
import assert from "node:assert/strict";
import { parse } from "../../web/src/plaud.js";

const enc = (s) => new TextEncoder().encode(s);
const names = (segs) => segs.map((g) => [Math.round(g.start), g.speaker, g.text]);

test("시간 다음 화자, 다음 줄부터 발언", async () => {
  const r = await parse("a.txt", enc("00:00:01 김응옥\n안녕하세요 시작하겠습니다.\n\n00:00:15 Speaker 2\n네 좋습니다.\n추가로 말씀드리면\n"));
  assert.deepEqual(names(r.segs), [[1, "김응옥", "안녕하세요 시작하겠습니다."], [15, "Speaker 2", "네 좋습니다. 추가로 말씀드리면"]]);
  assert.equal(r.segs[0].end, 15);
});
test("화자 다음 시간", async () => {
  const r = await parse("a.txt", enc("Speaker 1 00:01:05\n첫 발언입니다.\nSpeaker 2 00:01:20\n둘째 발언."));
  assert.deepEqual(names(r.segs), [[65, "Speaker 1", "첫 발언입니다."], [80, "Speaker 2", "둘째 발언."]]);
});
test("한 줄 [시간] 화자: 발언", async () => {
  const r = await parse("a.txt", enc("[00:00:03] 배소정: 금액이 너무 커요\n[00:00:09] 하상수: 네 맞습니다"));
  assert.deepEqual(names(r.segs), [[3, "배소정", "금액이 너무 커요"], [9, "하상수", "네 맞습니다"]]);
});
test("화자 (시간): 발언", async () => {
  const r = await parse("a.txt", enc("김응옥 (01:05): 이건 이렇게\n고태준 (1:01:07): 그렇죠"));
  assert.deepEqual(names(r.segs), [[65, "김응옥", "이건 이렇게"], [3667, "고태준", "그렇죠"]]);
});
test("구간 줄", async () => {
  const r = await parse("a.txt", enc("00:00:01 - 00:00:04 Speaker 1\n가나다\n00:00:05 - 00:00:09 Speaker 2: 라마바"));
  assert.deepEqual(r.segs.map((g) => [g.start, g.end, g.speaker, g.text]), [[1, 4, "Speaker 1", "가나다"], [5, 9, "Speaker 2", "라마바"]]);
});
test("SRT", async () => {
  const r = await parse("a.srt", enc("1\n00:00:01,000 --> 00:00:04,500\n김응옥: 안녕하세요\n\n2\n00:00:05,000 --> 00:00:08,000\n[Speaker 2] 네\n"));
  assert.deepEqual(r.segs.map((g) => [g.start, g.end, g.speaker, g.text]), [[1, 4.5, "김응옥", "안녕하세요"], [5, 8, "Speaker 2", "네"]]);
});
test("EUC-KR·BOM", async () => {
  const bom = await parse("a.txt", enc("﻿00:00:01 김응옥\n한글"));
  assert.equal(bom.segs[0].speaker, "김응옥");
  // "00:00:01 가\n나" 의 EUC-KR 바이트
  const euckr = Uint8Array.from([0x30, 0x30, 0x3a, 0x30, 0x30, 0x3a, 0x30, 0x31, 0x20, 0xb0, 0xa1, 0x0a, 0xb3, 0xaa]);
  const r = await parse("a.txt", euckr);
  assert.deepEqual(names(r.segs), [[1, "가", "나"]]);
});
test("커넥터 JSON 중복 제거·직함 떼기", async () => {
  const d = [{ start_time: 1000, end_time: 3000, speaker: "김응옥 (법제팀장)", content: "가" }, { start_time: 1000, end_time: 3000, speaker: "김응옥 (법제팀장)", content: "가" }, { start_time: 4000, end_time: 6000, speaker: "배소정", content: "나" }];
  const r = await parse("a.json", enc(JSON.stringify(d)));
  assert.deepEqual(names(r.segs), [[1, "김응옥", "가"], [4, "배소정", "나"]]);
});
test("시간 없는 파일은 경고", async () => {
  const r = await parse("a.txt", enc("김응옥: 시간 없는 발언\n배소정: 또"));
  assert.equal(r.segs.length, 0);
  assert.ok(r.warnings.length);
});
