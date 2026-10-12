import test from "node:test";
import assert from "node:assert/strict";
import { jamoSim, stripJosa, diffPairs, applyLexicon, fromGlossary, toPairs, harvest, judge, conflicts, setVar, addManual,
  hintTerms, hintText, hintLeak, mergeLex, dropJob, whenOf, emptyLex, totals } from "../../web/src/lexicon.js";

const lexOf = (pairs) => fromGlossary(pairs);

test("자모 닮음: 잘못 들린 말은 가깝고 바꿔 쓴 말은 멂", () => {
  assert.ok(jamoSim("과외성", "과기성") > 0.65);
  assert.ok(jamoSim("기상", "기성") > 0.75);
  assert.ok(jamoSim("소장님", "현장소장") < 0.4);
  assert.ok(jamoSim("업체", "협력업체") < 0.55);
});

test("조사 떼기", () => {
  assert.deepEqual(stripJosa("과기성에서"), ["과기성", "에서"]);
  assert.deepEqual(stripJosa("한빛"), ["한빛", ""]);
});

test("예전 사전 오작동 세 가지가 고쳐짐", () => {
  // 이미 바른 말을 또 바꾸지 않음
  assert.equal(applyLexicon("한빛이엔씨가 청구했고 한빛에서 확인", lexOf([{ from: "한빛", to: "한빛이엔씨" }])).text, "한빛이엔씨가 청구했고 한빛이엔씨에서 확인");
  // 낱말 안쪽은 건드리지 않음
  assert.equal(applyLexicon("기상청 예보와 기상 사정", lexOf([{ from: "기상", to: "기성" }])).text, "기상청 예보와 기성 사정");
  // 바뀐 결과에 다른 규칙이 다시 걸리지 않음(줄 순서와 무관)
  const a = applyLexicon("과외성 나간 부분", lexOf([{ from: "과외성", to: "과기성" }, { from: "과기성", to: "과다기성" }])).text;
  const b = applyLexicon("과외성 나간 부분", lexOf([{ from: "과기성", to: "과다기성" }, { from: "과외성", to: "과기성" }])).text;
  assert.equal(a, "과기성 나간 부분"); assert.equal(b, a);
});

test("적용: 조사·하다 활용·문장부호는 붙은 채로, 여러 어절 꼴, 되돌릴 자리", () => {
  const lex = lexOf([{ from: "과외성", to: "과기성" }, { from: "갈리 미스", to: "관리 미스" }]);
  const r = applyLexicon("「과외성이」 나왔고 과외성했다. 갈리 미스였다", lex);
  assert.equal(r.text, "「과기성이」 나왔고 과기성했다. 관리 미스였다");
  assert.equal(r.hits.length, 3);
  const back = applyLexicon("과외성이 나왔고 과외성했다", lex, { skip: new Set([1]) });
  assert.equal(back.text, "과기성이 나왔고 과외성했다");
});

test("흔한 낱말 조건: 뒤 어절이 맞을 때만", () => {
  const lex = lexOf([{ from: "기상", to: "기성" }]);
  setVar(lex, "기성", "기상", "on", ["사정", "청구"]);
  assert.equal(applyLexicon("기상 상황이 나빠 기상 사정했고 기상 청구", lex).text, "기상 상황이 나빠 기성 사정했고 기성 청구");
});

test("차이 뽑기: 인식 오류만 남김", () => {
  const p = diffPairs("그거는 과외성 나간 거고 한빈에서 청구를 했습니다", "그거는 과기성 나간 거고 한빛에서 청구를 하였습니다");
  assert.deepEqual(p.map((x) => [x.from, x.to]), [["과외성", "과기성"], ["한빈", "한빛"]]);
  assert.equal(p[0].next, "나간");
  // 띄어쓰기만·지우기·숫자·바꿔 쓰기는 버림
  assert.deepEqual(diffPairs("간이 소화장치 그러니까 삼백 개 소장님", "간이소화장치 삼백 개 현장소장"), []);
  assert.deepEqual(diffPairs("공사비 300만원", "공사비 400만원"), []);
});

test("근거 모으기 → 추천 → 확정 → 적용·되돌림 → 자동 끔", () => {
  const segs = [
    { i: 1, text: "과외성 나간 부분은" }, { i: 2, text: "그 과외성이 문제" }, { i: 3, text: "과외성 금액" }, { i: 4, text: "다른 말" },
  ];
  let lex = harvest(emptyLex(), "j1", segs, { 1: { text: "과기성 나간 부분은" }, 2: { text: "그 과기성이 문제" } });
  const t = lex.terms.find((x) => x.to === "과기성"), v = t.vars[0];
  assert.equal(v.st, "cand"); assert.equal(totals(v).n, 2);
  assert.equal(judge(lex, t, v).rec, true);
  // 다시 세어도 두 번 세지 않음
  lex = harvest(lex, "j1", segs, { 1: { text: "과기성 나간 부분은" }, 2: { text: "그 과기성이 문제" } });
  assert.equal(totals(lex.terms[0].vars[0]).n, 2);
  // 고치지 않고 확인한 곳은 반대 증거(흔한 낱말 표시)
  lex = harvest(lex, "j1", segs, { 1: { text: "과기성 나간 부분은" }, 2: { text: "그 과기성이 문제" }, 3: { ok: true } });
  const j = judge(lex, lex.terms[0], lex.terms[0].vars[0]);
  assert.equal(j.common, true);
  assert.deepEqual(whenOf(lex.terms[0].vars[0]), ["나간", "문제"]);
  // 확정 뒤: 다른 녹음에서 사전이 바꾼 채 확인 → 적용 증거, 사람이 되돌림 → 되돌림
  setVar(lex, "과기성", "과외성", "on");
  const s2 = [1, 2, 3, 4].map((i) => ({ i, text: "과외성 금액 " + i })).concat([{ i: 5, text: "과외성 수업" }]);
  lex = harvest(lex, "j2", s2, { 1: { ok: true }, 2: { ok: true }, 3: { ok: true }, 4: { ok: true }, 5: { text: "과외성 수업" } });
  const s = totals(lex.terms[0].vars[0]);
  assert.equal(s.app, 4); assert.equal(s.undo, 1);
  assert.equal(lex.terms[0].vars[0].st, "on"); // 되돌림 1 → 켜 둠
  lex = harvest(lex, "j3", [{ i: 1, text: "과외성 과외" }, { i: 2, text: "과외성 선생" }], { 1: { text: "과외성 과외" }, 2: { text: "과외성 선생" } });
  assert.equal(lex.terms[0].vars[0].st, "off");
  // 근거가 사라진 후보는 지워짐
  lex = harvest(lex, "j9", [{ i: 1, text: "기상 사정" }], { 1: { text: "기성 사정" } });
  assert.ok(lex.terms.some((x) => x.to === "기성"));
  lex = harvest(lex, "j9", [{ i: 1, text: "기상 사정" }], {});
  assert.ok(!lex.terms.some((x) => x.to === "기성"));
});

test("이름·충돌은 추천하지 않음", () => {
  const segs = [{ i: 1, text: "한빈 대리가" }, { i: 2, text: "한빈 대리는" }, { i: 3, text: "하빈 씨" }];
  let lex = harvest(emptyLex(), "j1", segs, { 1: { text: "한빛 대리가" }, 2: { text: "한빛 대리는" } }, new Set(["한빛"]));
  const t = lex.terms[0];
  assert.equal(t.kind, "name"); assert.equal(judge(lex, t, t.vars[0]).rec, false);
  lex = harvest(lex, "j2", [{ i: 1, text: "한빈 과장" }, { i: 2, text: "한빈 과장님" }], { 1: { text: "한분 과장" }, 2: { text: "한분 과장님" } });
  assert.ok(conflicts(lex).has("한빈"));
});

test("예전 사전·백업·지우기·직접 넣기", () => {
  const lex = fromGlossary([{ from: "찹비용", to: "샵 비용" }, { from: "", to: "x" }]);
  assert.deepEqual(toPairs(lex), [{ from: "찹비용", to: "샵 비용" }]);
  addManual(lex, "기상", "기성");
  assert.equal(toPairs(lex).length, 2);
  const other = harvest(emptyLex(), "j5", [{ i: 1, text: "과외성 나감" }], { 1: { text: "과기성 나감" } });
  const m = mergeLex(lex, other);
  assert.equal(m.added, 1); assert.equal(m.lex.terms.length, 3);
  dropJob(m.lex, "j5");
  assert.equal(m.lex.terms.length, 2);
});

test("전사 힌트: 확정만, 이 녹음에 나온 것 먼저, 새어 나온 힌트 알아보기", () => {
  const lex = fromGlossary([{ from: "과외성", to: "과기성" }, { from: "찹비용", to: "샵 비용" }, { from: "한빈", to: "한빛이엔씨" }]);
  lex.terms[1].hint = false;
  assert.deepEqual(hintTerms(lex, "한빛이엔씨 기성 회의"), ["한빛이엔씨", "과기성"]);
  assert.equal(hintText(["과기성", "한빛이엔씨"]), "과기성, 한빛이엔씨.");
  assert.equal(hintLeak("과기성, 한빛이엔씨.", ["과기성", "한빛이엔씨"]), true);
  assert.equal(hintLeak("과기성 나간 부분이 있습니다", ["과기성", "한빛이엔씨"]), false);
});

import { mergedLines, mergeBackup } from "../../web/src/export.js";
test("통합본: 사람이 고친 글은 사전이 다시 건드리지 않음 · 백업은 lexicon과 예전 쌍 목록 모두 합침", () => {
  const lex = fromGlossary([{ from: "과외성", to: "과기성" }]);
  const data = { job: { mode: "diar" }, edits: { e: { 2: { text: "과외성 수업은 따로" } } }, plaud: [], lexicon: lex,
    result: { segs: [{ i: 1, start: 1, text: "과외성 나감", speaker: "갑" }, { i: 2, start: 2, text: "과외성 수업", speaker: "갑" }], stats: {} } };
  assert.deepEqual(mergedLines(data).map((l) => l.text), ["과기성 나감", "과외성 수업은 따로"]);
  assert.deepEqual(mergedLines(data, { useGlossary: false }).map((l) => l.text), ["과외성 나감", "과외성 수업은 따로"]);
  const cur = { voiceprints: {}, glossary: [], lexicon: lex, jobIds: new Set() };
  const m1 = mergeBackup(cur, { glossary: [{ from: "찹비용", to: "샵 비용" }] }); // 예전 백업
  assert.equal(m1.added.glossary, 1); assert.equal(m1.lexicon.terms.length, 2);
  const m2 = mergeBackup(cur, { glossary: [], lexicon: fromGlossary([{ from: "기상", to: "기성" }, { from: "과외성", to: "과기성" }]) });
  assert.equal(m2.added.glossary, 1); assert.equal(m2.lexicon.terms.length, 2);
});

test("이웃한 두 낱말을 함께 고쳐도 쌍이 따로 잡힘", () => {
  assert.deepEqual(diffPairs("과기성 전사 4초", "과외성 전서 4초").map((x) => [x.from, x.to, x.next]), [["과기성", "과외성", "전서"], ["전사", "전서", "4초"]]);
  // 소리가 닮지 않은 말이라도 사전이 바꾼 것을 사람이 되돌리면 되돌림으로 셈
  const lex = fromGlossary([{ from: "가짜", to: "진짜" }]);
  harvest(lex, "j", [{ i: 1, text: "가짜 전사" }], { 1: { text: "가짜 전서" } });
  assert.equal(totals(lex.terms[0].vars[0]).undo, 1);
});

import fs from "node:fs";
test("기본 사전(web/lexicon-seed.json): 형식·근거, 확정 꼴만 바로 바꾸고 실제 낱말 꼴은 후보로", () => {
  const seed = JSON.parse(fs.readFileSync(new URL("../../web/lexicon-seed.json", import.meta.url), "utf8"));
  assert.equal(seed.v, 1);
  for (const t of seed.terms) for (const v of t.vars) {
    assert.ok(v.from && t.to && v.from !== t.to && ["on", "cand"].includes(v.st) && v.manual && v.src, JSON.stringify(v));
  }
  const m = mergeBackup({ voiceprints: {}, glossary: [], lexicon: emptyLex(), jobIds: new Set() }, { lexicon: seed });
  assert.equal(m.added.glossary, seed.terms.reduce((n, t) => n + t.vars.length, 0));
  const r = applyLexicon("발출처랑 도국을 받았고 표정품샘으로 보면 과외성이 나왔다. 기상 상황과 도구 정리", m.lexicon).text;
  assert.equal(r, "발주처랑 도급을 받았고 표준품셈으로 보면 과기성이 나왔다. 기상 상황과 도구 정리");
  // 후보 꼴을 확정하면 미리 붙인 뒷말 조건이 걸림
  setVar(m.lexicon, "기성", "기상", "on");
  assert.equal(applyLexicon("기상 상황에서 기상 사정을", m.lexicon).text, "기상 상황에서 기성 사정을");
});

test("확정한 뒤 다시 세어도 사람이 고친 근거는 남음", () => {
  const segs = [{ i: 1, text: "과외성 나감" }, { i: 2, text: "과외성 금액" }];
  const ed = { 1: { text: "과기성 나감" }, 2: { text: "과기성 금액" } };
  const lex = harvest(emptyLex(), "j", segs, ed);
  setVar(lex, "과기성", "과외성", "on");
  harvest(lex, "j", segs, ed);
  const s = totals(lex.terms[0].vars[0]);
  assert.equal(s.n, 2); assert.equal(s.undo, 0);
});

test("배포(pages.yml)가 기본 사전 파일을 함께 올린다", () => {
  const yml = fs.readFileSync(new URL("../../.github/workflows/pages.yml", import.meta.url), "utf8");
  assert.match(yml, /cp [^\n]*web\/lexicon-seed\.json[^\n]*_site\//);
});

test("바꾼 말 뒤 조사를 받침에 맞추고, 「~다」로 끝나는 꼴도 바꿈", () => {
  const lex = fromGlossary([{ from: "임지소방지서", to: "임시소방시설" }, { from: "관리비스", to: "관리 미스" }, { from: "야대", to: "야드" }, { from: "온자재", to: "원자재" }]);
  assert.equal(applyLexicon("임지소방지서를 내고 임지소방지서가 있고 임지소방지서는", lex).text, "임시소방시설을 내고 임시소방시설이 있고 임시소방시설은");
  assert.equal(applyLexicon("관리비스다 이렇게, 야대에 두고 야대로 옮김", lex).text, "관리 미스다 이렇게, 야드에 두고 야드로 옮김");
  assert.equal(applyLexicon("온자재가가 올라", lex).text, "원자재가가 올라"); // 「가」 뒤에 글자가 이어지면 조사로 보지 않음
});
