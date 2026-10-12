// Plaud 대조(compare.js)·Plaud 근거(lexicon harvest pl)·통합본 정리(export tidyLines) — 합성 글만 씀
import { test } from "node:test";
import assert from "node:assert/strict";
import { plaudFor, plaudAlign, plaudDiffers, plaudPairs, normText, PL_MIN } from "../../web/src/compare.js";
import { diffPairs, stripJosa, harvest, judge, emptyLex, PL_REC, PL_KEEP } from "../../web/src/lexicon.js";
import { commaAmounts, tidyLines, mergedLines } from "../../web/src/export.js";

const P = [
  { start: 0, end: 20, speaker: "갑", text: "오늘은 공사비 정산 얘기를 하겠습니다. 먼저 노임 단가부터 보시죠." },
  { start: 20, end: 30, speaker: "을", text: "네 알겠습니다. 자료는 제가 드리겠습니다." },
  { start: 30, end: 60, speaker: "갑", text: "감정인이 낸 보고서를 보면 착오가 있었던 것 같아요." },
];

test("같은 자리 Plaud 글을 잘라 내고 겹침을 잰다", () => {
  const r = plaudFor({ start: 10, end: 19, text: "먼저 노인 단가부터 보시죠" }, P);
  assert.ok(r.text.includes("노임 단가부터"), r.text);
  assert.ok(!r.text.includes("오늘은"), "앞 문장까지 가져오지 않음: " + r.text);
  assert.ok(r.sim > 0.8 && !plaudDiffers(r), String(r.sim));
  const bad = plaudFor({ start: 31, end: 40, text: "고등학교 책이라고 해서 돌려받으려고" }, P);
  assert.ok(bad.sim < PL_MIN && plaudDiffers(bad), String(bad.sim));
});

test("짧은 발언·Plaud 없는 자리", () => {
  assert.equal(plaudFor({ start: 20, end: 21, text: "네." }, P), null);
  const none = plaudFor({ start: 200, end: 205, text: "이 자리에는 Plaud 글이 없습니다" }, P);
  assert.equal(none.text, ""); assert.equal(none.sim, 0); assert.ok(plaudDiffers(none));
  assert.equal(plaudFor({ start: 0, end: 5, text: "아무 말이나 합니다" }, []), null);
});

test("발언 안에서 Plaud 화자가 바뀌면 그 시각과 글자 위치를 준다", () => {
  const g = { start: 14, end: 25, text: "노임 단가부터 보시죠 네 알겠습니다 자료는 제가 드리겠습니다" };
  const r = plaudFor(g, P);
  assert.ok(r.change, "바뀜 찾음");
  assert.equal(r.change.t, 20);
  assert.equal(r.change.from, "갑"); assert.equal(r.change.to, "을");
  assert.equal(g.text.slice(r.change.pos).trim().slice(0, 1), "네", g.text.slice(r.change.pos));
  // 짧은 발언(3초 미만)은 나누기 제안 안 함
  assert.equal(plaudFor({ start: 19, end: 21, text: "보시죠 네 알겠습니다" }, P).change, null);
});

test("녹음 전체 맞추기는 발언 번호로", () => {
  const segs = [{ i: 1, start: 0, end: 9, text: "오늘은 공사비 정산 얘기를 하겠습니다" }, { i: 2, start: 20, end: 20.5, text: "네" }];
  const m = plaudAlign(segs, P);
  assert.ok(m.has(1) && !m.has(2));
  assert.equal(normText(" 가, 나. 다 "), "가나다");
});

test("Plaud 대조 쌍: 말투 차이는 빼고 소리가 닮은 오인식만", () => {
  const pp = (h, p) => plaudPairs(h, p, diffPairs, stripJosa).map((x) => x.from + "→" + x.to);
  assert.deepEqual(pp("감정 결과는 착고가 있었다", "감정 결과는 착오가 있었다"), ["착고→착오"]);
  assert.deepEqual(pp("이건 그렇게 말이에요 좋아요", "이거는 그렇게 말이야 좋아요"), []);
  assert.deepEqual(pp("이제 끝났어요", "이게 끝났어요"), []);
});

test("harvest: Plaud 근거(pl)는 한 녹음 PL_KEEP곳부터, 사람 고침과 겹치면 n만, PL_REC곳이면 추천", () => {
  const segs = [1, 2, 3, 4].map((i) => ({ i, text: `착고가 있었다 ${i}` }));
  const one = [{ i: 1, from: "도곡", to: "도급", next: "" }];
  let lex = harvest(emptyLex(), "j1", segs, {}, new Set(), one);
  assert.equal(lex.terms.length, 0, "1곳짜리는 넣지 않음");
  const three = [1, 2, 3].map((i) => ({ i, from: "착고", to: "착오", next: "가" }));
  lex = harvest(emptyLex(), "j1", segs, { 1: { text: "착오가 있었다 1" } }, new Set(), three);
  const t = lex.terms.find((x) => x.to === "착오"), v = t.vars[0];
  assert.equal(v.st, "cand");
  assert.deepEqual([v.by.j1.n, v.by.j1.pl], [1, 2], "발언 1은 사람이 고침 → n");
  assert.ok(judge(lex, t, v).rec, "n 1 + pl 2 = 3곳 → 추천");
  assert.equal(PL_REC, 3); assert.equal(PL_KEEP, 2);
  // Plaud만 2곳: 후보(추천 아님)
  lex = harvest(emptyLex(), "j1", segs, {}, new Set(), three.slice(0, 2));
  const t2 = lex.terms[0];
  assert.equal(t2.vars[0].by.j1.pl, 2);
  assert.ok(!judge(lex, t2, t2.vars[0]).rec);
  // 다시 세면 같은 값(두 번 세지 않음), Plaud를 떼면 근거가 사라져 후보도 지움
  lex = harvest(lex, "j1", segs, {}, new Set(), three.slice(0, 2));
  assert.equal(lex.terms[0].vars[0].by.j1.pl, 2);
  lex = harvest(lex, "j1", segs, {}, new Set(), []);
  assert.equal(lex.terms.length, 0);
});

test("금액 쉼표: 돈 단위 앞뒤의 네 자리 이상만", () => {
  assert.equal(commaAmounts("32억 2800이 아니고 25억 4400입니다"), "32억 2,800이 아니고 25억 4,400입니다");
  assert.equal(commaAmounts("총 15000000원"), "총 15,000,000원");
  assert.equal(commaAmounts("2026년 10월, 010-1234-5678, 3.14159원, 1,234원, 사업 4400건"), "2026년 10월, 010-1234-5678, 3.14159원, 1,234원, 사업 4400건");
});

test("통합본 정리: 맞장구 줄 빼기 → 같은 화자 30초 안 이어 붙이기", () => {
  const L = [{ t: 0, file: 0, spk: "갑", text: "첫 말입니다.", src: "" }, { t: 4, file: 0, spk: "을", text: "네.", src: "" },
    { t: 8, file: 0, spk: "갑", text: "이어서 말합니다.", src: "" }, { t: 60, file: 0, spk: "갑", text: "한참 뒤 말.", src: "" }, { t: 61, file: 1, spk: "갑", text: "다른 파일.", src: "" }];
  assert.equal(tidyLines(L, { join: true }).length, 5, "맞장구가 사이에 있으면 안 붙임");
  const r = tidyLines(L, { join: true, dropShort: true });
  assert.deepEqual(r.map((x) => [x.t, x.text]), [[0, "첫 말입니다. 이어서 말합니다."], [60, "한참 뒤 말."], [61, "다른 파일."]]);
  assert.equal(tidyLines(L, {}).length, 5, "선택하지 않으면 그대로");
  // mergedLines에서 옵션으로
  const data = { job: { mode: "diar" }, result: { stats: {}, segs: L.map((x, k) => ({ i: k + 1, start: x.t, file: x.file, speaker: x.spk, text: x.text })) }, edits: { e: {} }, plaud: [] };
  assert.equal(mergedLines(data).length, 5);
  assert.equal(mergedLines(data, { join: true, dropShort: true }).length, 3);
});
