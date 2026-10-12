// 교정 사전 기본값(1차) 만들기 — web/lexicon-seed.json. 2026-10-12.
// 근거: ① 10-08 회의를 앱 엔진(Whisper turbo)으로 전사해 힌트 켬·끔을 견준 실측(엔진이 실제로 잘못 듣는 꼴)
//       ② 감사 면담 회의록의 「오인식 정정」 목록(Plaud·클로바노트 전사) ③ 외부 조사 — 한국어 건설·감사 분야
//       음성 인식 오인식 목록은 공개된 것이 없어(2026-10 검색), 실제 녹취에서 확인된 것만 넣는다.
// 사람·업체·지명은 넣지 않는다(저장소에 실명 금지 — 이름은 각자 검수에서 쌓임).
// st: on = 실제 낱말이 아닌 꼴이라 바로 바꿔도 안전 · cand = 실제로 쓰이는 낱말이라 사람이 확인(when: 뒷말 조건 미리 붙임)
import fs from "node:fs";
const W = "10-08 회의 Whisper 실측", C = "면담 녹취(클로바노트) 정정", P = "면담 회의록(Plaud) 정정";
const rows = [
  // 바른 표기, 잘못 들린 꼴, 상태, 근거, 뒷말 조건
  ["발주처", "발출처", "on", W], ["발주처", "발표처", "on", W], ["발주처", "발주차", "on", W],
  ["도급", "도국", "on", W], ["도급", "도구", "cand", W, ["인정", "받", "과", "계약", "공사"]],
  ["병합", "병학", "on", W],
  ["표준품셈", "표준품샘", "on", W], ["표준품셈", "표정품샘", "on", W],
  ["노무비", "농업이", "cand", W],
  ["반소", "단소", "cand", W],
  ["과기성", "과외성", "on", C], ["과기성", "과기상", "on", C], ["과기성", "과계상", "on", C], ["과기성", "박기성", "cand", C],
  ["과대 기성", "대세기선", "on", P],
  ["기성", "기상", "cand", C, ["사정", "관리", "청구", "금액", "지급"]], ["기성", "기선", "cand", C, ["사정", "관리", "청구", "금액", "지급"]],
  ["관리 미스", "갈리미스", "on", C],
  ["물탱크", "물테크", "on", C],
  ["샵 비용", "찹비용", "on", P],
  ["딜리버리", "딜레마리", "on", P],
  ["준공", "중공업", "cand", P], ["실행", "시행", "cand", P, ["예산", "내역", "금액"]], ["간선", "관선", "cand", P],
  ["발주", "파주", "cand", P, ["띄우", "넣", "내"]], ["수전", "발포", "cand", P, ["받"]],
  ["실측", "스킬", "cand", P], ["트레이", "트랙", "cand", P], ["폐전선", "회전선", "cand", P],
];
const terms = new Map();
for (const [to, from, st, src, when] of rows) {
  if (!terms.has(to)) terms.set(to, { to, kind: "term", hint: true, vars: [] });
  terms.get(to).vars.push({ from, st, manual: true, src, ...(when ? { when } : {}), by: {} });
}
const lex = { v: 1, terms: [...terms.values()], seed: "2026-10-12" };
fs.writeFileSync(new URL("../web/lexicon-seed.json", import.meta.url), JSON.stringify(lex, null, 1) + "\n");
console.log("terms", lex.terms.length, "vars", rows.length, "on", rows.filter((r) => r[2] === "on").length);
