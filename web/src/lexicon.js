// 교정 사전(배우는 사전) — 순수 함수. 2026-10-12 사용자 승인으로 저장 형식 추가(kv「lexicon」, 백업 lexicon 필드).
//
// 항목은 「바른 표기(to)」 하나에 「잘못 들린 꼴(from)」 여러 개를 묶는다. 꼴마다 상태와 근거를 둔다.
//   { v:1, terms:[ { to, kind:"term"|"name", hint, vars:[ { from, st:"cand"|"on"|"off", when:[…]|null, manual,
//       by:{ 작업id:{ n, neg, undo, app, ex:[발언번호…], nx:{뒷말:횟수} } } } ] } ], updatedAt }
//   st  cand=후보(자동으로 바꾸지 않음) · on=확정(바꿈) · off=꺼짐
//   by  녹음별 근거 — 그 녹음을 검수할 때마다 통째로 다시 센다(같은 수정을 두 번 세지 않게)
//       n=사람이 이렇게 고친 발언 수 · neg=이 꼴이 있는데 고치지 않고 ✓확인한 발언 수
//       undo=사전이 바꾼 것을 사람이 되돌린 수 · app=사전이 바꾼 채로 ✓확인된 수 · nx=고친 자리 바로 뒤 어절(앞 두 글자)
//       pl=같은 자리 Plaud 전사가 이렇게 적은 발언 수(Plaud 대조, 2026-10-12 — 사람이 고친 것보다 문턱을 높게: PL_REC)
//
// 적용(applyLexicon)은 어절 경계 안에서만, 긴 꼴부터 한 번에 훑어 바꾼다. 이미 바른 꼴이면 건너뛴다.
// 후보 뽑기(diffPairs)는 원래 전사와 고친 글을 어절로 맞춰 바뀐 덩어리를 찾고, 조사를 떼고, 소리가 닮은 것만 남긴다.

export const LEX_FORMAT = 1;
export const SIM_MIN = 0.55; // 자모 닮음 문턱(이보다 낮으면 말을 바꿔 쓴 것으로 봄)
export const REC_MIN = 2; // 추천: 서로 다른 발언 수
export const PL_REC = 3; // 추천: Plaud 대조까지 더한 발언 수(Plaud도 자동 전사라 더 높게)
export const PL_KEEP = 2; // Plaud 대조 쌍은 한 녹음에서 이만큼 나와야 후보로 넣음(1곳짜리는 대부분 말투 차이·Plaud 쪽 오인식)

/* ------------------------------------------------------------------ 자모 */
const CHO = "ㄱㄲㄴㄷㄸㄹㅁㅂㅃㅅㅆㅇㅈㅉㅊㅋㅌㅍㅎ", JUNG = "ㅏㅐㅑㅒㅓㅔㅕㅖㅗㅘㅙㅚㅛㅜㅝㅞㅟㅠㅡㅢㅣ",
  JONG = " ㄱㄲㄳㄴㄵㄶㄷㄹㄺㄻㄼㄽㄾㄿㅀㅁㅂㅄㅅㅆㅇㅈㅊㅋㅌㅍㅎ";
/** 글 → 자모 배열(한글 아닌 글자는 소문자 그대로, 띄어쓰기는 뺌) */
export function jamo(s) {
  const out = [];
  for (const ch of String(s || "").replace(/\s+/g, "")) {
    const c = ch.charCodeAt(0) - 0xac00;
    if (c < 0 || c > 11171) { out.push(ch.toLowerCase()); continue; }
    out.push(CHO[Math.floor(c / 588)], JUNG[Math.floor((c % 588) / 28)]);
    if (c % 28) out.push(JONG[c % 28]);
  }
  return out;
}
function lev(a, b) {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur.push(Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)));
    prev = cur;
  }
  return prev[b.length];
}
/** 소리 닮음 0~1(자모 편집 거리) */
export function jamoSim(a, b) {
  const x = jamo(a), y = jamo(b), m = Math.max(x.length, y.length);
  return m ? 1 - lev(x, y) / m : 1;
}

/* ------------------------------------------------------------------ 조사·어미 */
// 어절 끝에 붙는 말(긴 것부터). 바뀐 덩어리의 양쪽에 같은 것이 붙어 있으면 뗀다.
const JOSA = ["에서부터", "으로부터", "이라고는", "에게서", "한테서", "이라고", "이라는", "이라서", "이었다", "입니다", "이에요", "이니까",
  "에서는", "에서도", "으로는", "으로도", "까지는", "부터는", "에서", "에게", "한테", "께서", "으로", "이랑", "이나", "이고", "이면", "이며",
  "이다", "이죠", "이요", "까지", "부터", "처럼", "보다", "라고", "라는", "라서", "였다", "예요", "이지", "인데", "인지", "하고",
  "을", "를", "이", "가", "은", "는", "의", "도", "만", "에", "와", "과", "로", "랑", "나", "요", "죠", "고", "인", "지"];
// 꼴 바로 뒤에 와도 되는 것: 조사·「하다/되다」 활용·문장부호. 이것 말고 다른 글자가 이어지면 더 긴 낱말의 일부로 본다(「기상청」).
const TAIL = new RegExp("^(?:(?:" + JOSA.join("|") + "|다)+|(?:하|했|할|한|해|합|됐|되|된|될|돼|됩|시켰|시키|이었|였|입니|이네|이니)[가-힣]*)?[\\s.,!?…·~\"'”’」』)\\]]*$");
const PUNCT_L = /^[\s"'“‘「『(\[]+/, PUNCT_R = /[\s.,!?…·~"'”’」』)\]]+$/;
/** 받침 따라 조사 맞추기: 바뀐 말 뒤 「을/를·이/가·은/는·과/와·으로/로」를 바른 말 끝소리에 맞춤(「임지소방지서를」 → 「임시소방시설을」) */
const PAIRS = [["으로", "로"], ["을", "를"], ["은", "는"], ["과", "와"], ["이", "가"]];
function fixJosa(word, rest) {
  const ch = String(word).slice(-1), c = ch.charCodeAt(0) - 0xac00;
  if (c < 0 || c > 11171) return rest; // 한글로 끝나지 않으면 그대로(영문·숫자 읽기는 모름)
  const jong = c % 28, has = jong > 0;
  for (const [withB, noB] of PAIRS) {
    for (const cur of [withB, noB]) {
      if (!rest.startsWith(cur)) continue;
      const after = rest.slice(cur.length);
      if (cur === "이" || cur === "가") { if (after && !/^[\s.,!?…·~"'”’」』)\]]/.test(after)) continue; } // 「이다」·「이고」 같은 것은 건드리지 않음
      const pick = withB === "으로" ? (has && jong !== 8 ? "으로" : "로") : has ? withB : noB;
      return pick + after;
    }
  }
  return rest;
}
/** 어절 끝 조사 떼기 → [줄기, 조사] (줄기가 한 글자 이상 남을 때만) */
export function stripJosa(w) {
  for (const j of JOSA) if (w.length > j.length && w.endsWith(j)) return [w.slice(0, -j.length), j];
  return [w, ""];
}
const core = (w) => w.replace(PUNCT_L, "").replace(PUNCT_R, "");

/* ------------------------------------------------------------------ 후보 뽑기 */
/** 어절 정렬(LCS) → 바뀐 덩어리 [[원래 어절들], [고친 어절들], 고친 쪽 바로 뒤 어절] */
function blocks(a, b) {
  const A = a.map(core), B = b.map(core);
  const n = A.length, m = B.length;
  const L = Array.from({ length: n + 1 }, () => new Int32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i][j] = A[i] === B[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  const out = [];
  let i = 0, j = 0, ra = [], rb = [];
  const flush = () => { if (ra.length || rb.length) out.push([ra, rb, B[j] || ""]); ra = []; rb = []; };
  while (i < n || j < m) {
    if (i < n && j < m && A[i] === B[j]) { flush(); i++; j++; }
    else if (j < m && (i >= n || L[i][j + 1] >= L[i + 1][j])) rb.push(B[j++]);
    else ra.push(A[i++]);
  }
  flush();
  return out;
}
const ENDING = /(?:다|요|죠|까|네|지|고|서|며|면|니|게|데|구나|군요)$/; // 문장 끝 다듬기(했습니다 → 하였습니다)
/**
 * 원래 전사 a와 고친 글 b에서 「잘못 들린 말 → 바른 말」 후보 [{from, to, next}]
 * 띄어쓰기만 다름·지우기·넣기·숫자·어미 다듬기·소리가 닮지 않은 바꿈·한 글자·4어절 넘는 덩어리는 뺀다.
 */
export function diffPairs(a, b, { raw = false } = {}) {
  const ta = String(a || "").split(/\s+/).filter(Boolean), tb = String(b || "").split(/\s+/).filter(Boolean);
  const out = [];
  const units = [];
  for (const [ra, rb, after] of blocks(ta, tb)) {
    if (!ra.length || !rb.length) continue; // 지우기·넣기
    if (ra.length > 4 || rb.length > 4) continue;
    // 어절 수가 같으면 어절끼리 따로 본다(이웃한 두 낱말을 함께 고쳐도 쌍이 섞이지 않게)
    if (ra.length === rb.length && ra.length > 1) ra.forEach((x, k) => { if (x !== rb[k]) units.push([[x], [rb[k]], k === ra.length - 1 ? after : rb[k + 1]]); });
    else units.push([ra, rb, after]);
  }
  for (const [ra, rb, after] of units) {
    let from = ra.join(" "), to = rb.join(" ");
    if (from.replace(/\s/g, "") === to.replace(/\s/g, "")) continue; // 띄어쓰기만
    // 끝 조사: 양쪽이 같은 것으로 끝나면 뗀다
    const [fs, fj] = stripJosa(from), [ts, tj] = stripJosa(to);
    if (fj && fj === tj) { from = fs; to = ts; }
    if (raw) { if (from !== to) out.push({ from, to, next: (after || "").slice(0, 2) }); continue; } // 거르지 않은 바꿈(되돌림 찾기용)
    if (/\d/.test(from + to)) continue;
    const fn = from.replace(/\s/g, ""), tn = to.replace(/\s/g, "");
    if (fn.length < 2 || tn.length < 2) continue;
    if (fn === tn) continue;
    if (fn.includes(tn) || tn.includes(fn)) continue; // 낱말을 덧붙이거나 지운 것(띄어쓰기와 섞여도)
    if (ENDING.test(from) && ENDING.test(to) && from[0] !== undefined && jamo(from)[0] === jamo(to)[0]) continue;
    if (jamoSim(from, to) < SIM_MIN) continue;
    out.push({ from, to, next: (after || "").slice(0, 2) });
  }
  return out;
}

/* ------------------------------------------------------------------ 적용 */
/** 바꿀 꼴 목록(확정만) — 긴 꼴부터 */
export function activeRules(lex) {
  const rules = [];
  for (const t of (lex && lex.terms) || []) for (const v of t.vars || []) {
    if (v.st !== "on" || !v.from) continue;
    rules.push({ from: v.from, to: t.to, toks: v.from.split(/\s+/), when: v.when && v.when.length ? v.when : null });
  }
  return rules.sort((x, y) => y.from.length - x.from.length);
}
/**
 * 사전 적용 → { text, hits:[{k, from, to}] }. opt.skip: 되돌릴 자리 번호(Set) — 그 자리는 원래 꼴로 둔다.
 * 어절 앞머리에서만 맞추고, 꼴 뒤에는 조사·「하다」 활용·문장부호만 와야 한다. 바른 꼴로 이미 시작하는 어절은 건드리지 않는다.
 * 흔한 낱말 조건(when)이 있으면 바로 뒤 어절이 그 말로 시작할 때만 바꾼다. 한 번 훑으므로 바뀐 결과에 다른 규칙이 다시 걸리지 않는다.
 */
export function applyLexicon(text, lex, opt = {}) {
  const rules = Array.isArray(lex) ? lex : activeRules(lex);
  const src = String(text ?? "");
  if (!rules.length || !src) return { text: src, hits: [] };
  const parts = src.split(/(\s+)/); // 어절과 띄어쓰기를 번갈아
  const words = [];
  for (let p = 0; p < parts.length; p += 2) words.push(p);
  const hits = [];
  let k = 0;
  for (let w = 0; w < words.length; w++) {
    for (const r of rules) {
      const n = r.toks.length;
      if (w + n > words.length) continue;
      let ok = true;
      for (let q = 0; q < n - 1 && ok; q++) ok = core(parts[words[w + q]]) === r.toks[q];
      if (!ok) continue;
      const lastRaw = parts[words[w + n - 1]], lead = n === 1 ? (lastRaw.match(PUNCT_L) || [""])[0] : "";
      const last = lastRaw.slice(lead.length), lt = r.toks[n - 1];
      if (!last.startsWith(lt)) continue;
      const rest = last.slice(lt.length);
      if (!TAIL.test(rest)) continue;
      const whole = (n > 1 ? r.toks.slice(0, -1).join(" ") + " " : "") + last;
      if (core(whole).startsWith(r.to) || core(last).startsWith(r.to)) continue; // 이미 바른 꼴
      if (r.when) {
        const nx = w + n < words.length ? core(parts[words[w + n]]) : "";
        if (!r.when.some((x) => x && nx.startsWith(x))) continue;
      }
      const here = k++;
      hits.push({ k: here, from: r.from, to: r.to });
      if (opt.skip && opt.skip.has(here)) break;
      // 바꾸기: 앞 어절들은 비우고(띄어쓰기도) 마지막 어절 자리에 바른 꼴 + 뒷말
      const first = (n === 1 ? lead : (parts[words[w]].match(PUNCT_L) || [""])[0]);
      for (let q = 0; q < n - 1; q++) { parts[words[w + q]] = ""; parts[words[w + q] + 1] = ""; }
      parts[words[w + n - 1]] = first + r.to + fixJosa(r.to, rest);
      w += n - 1;
      break;
    }
  }
  return { text: parts.join(""), hits };
}

/* ------------------------------------------------------------------ 사전 다루기 */
export const emptyLex = () => ({ v: LEX_FORMAT, terms: [] });
/** 예전 사전 {pairs:[{from,to}]} → 새 사전(모두 확정·직접 넣음) */
export function fromGlossary(pairs) {
  const lex = emptyLex();
  for (const p of pairs || []) {
    const from = String(p.from || "").trim(), to = String(p.to ?? "").trim();
    if (!from) continue;
    const t = termOf(lex, to, true);
    if (!t.vars.some((v) => v.from === from)) t.vars.push({ from, st: "on", manual: true, by: {} });
  }
  return lex;
}
/** 백업·예전 판을 위한 펼친 목록(확정만) */
export function toPairs(lex) {
  const out = [];
  for (const t of (lex && lex.terms) || []) for (const v of t.vars || []) if (v.st === "on") out.push({ from: v.from, to: t.to });
  return out;
}
export function termOf(lex, to, make = false) {
  let t = lex.terms.find((x) => x.to === to);
  if (!t && make) { t = { to, kind: "term", hint: true, vars: [] }; lex.terms.push(t); }
  return t;
}
/** 꼴의 근거 합계 */
export function totals(v) {
  const s = { n: 0, neg: 0, undo: 0, app: 0, pl: 0, jobs: 0, nx: {} };
  for (const b of Object.values(v.by || {})) {
    s.n += b.n || 0; s.neg += b.neg || 0; s.undo += b.undo || 0; s.app += b.app || 0; s.pl += b.pl || 0;
    if (b.n || b.app || b.pl) s.jobs++;
    for (const [w, c] of Object.entries(b.nx || {})) s.nx[w] = (s.nx[w] || 0) + c;
  }
  return s;
}
/** 같은 꼴이 서로 다른 바른 말로 고쳐진 적이 있으면 그 꼴 목록 */
export function conflicts(lex) {
  const seen = new Map();
  for (const t of lex.terms) for (const v of t.vars) if (v.st !== "off") { if (!seen.has(v.from)) seen.set(v.from, new Set()); seen.get(v.from).add(t.to); }
  return new Set([...seen].filter(([, s]) => s.size > 1).map(([f]) => f));
}
/**
 * 꼴 하나의 판정: { rec, name, common, conflict, s }
 * rec: 사람이 고친 발언 REC_MIN곳 이상(또는 Plaud 대조까지 더해 PL_REC곳 이상), 되돌림 0, 충돌 없음, 이름 아님 — 흔한 낱말(고치지 않고 확인한 곳 있음)이면 조건을 붙여야 함
 */
export function judge(lex, t, v, conf = conflicts(lex)) {
  const s = totals(v), conflict = conf.has(v.from), name = t.kind === "name", common = s.neg > 0;
  const rec = v.st === "cand" && (s.n >= REC_MIN || s.n + s.pl >= PL_REC) && !s.undo && !conflict && !name;
  return { rec, name, common, conflict, s };
}
/** 고친 자리 뒤에 자주 온 말(흔한 낱말 조건 후보) */
export function whenOf(v, max = 4) {
  return Object.entries(totals(v).nx).filter(([w]) => w.length >= 1).sort((a, b) => b[1] - a[1]).slice(0, max).map(([w]) => w);
}

/**
 * 녹음 하나의 근거를 다시 센다(그 녹음 몫은 지우고 새로). 사전 객체를 고쳐서 돌려준다.
 * segs: [{i, text}] 원래 전사 · edits: {i:{text?, parts?, ok?}} · names: 사람 이름 집합(이름 꼴은 늘 사람이 확인)
 * 확정 꼴이 사람 손으로 원래대로 돌아갔으면 undo, 그런 일이 많으면(되돌림 ≥2이고 적용의 ⅓ 넘음) 자동으로 끈다.
 * plaud: [{i, from, to, next}] — 같은 자리 Plaud 글과 견준 쌍(compare.js plaudPairs, 발언마다 같은 쌍 한 번). 이 녹음에서 PL_KEEP곳 이상이거나
 *   사전에 이미 있는 꼴만 pl로 센다. 사람이 그 발언에서 같은 쌍으로 고쳤으면 n으로만 센다.
 */
export function harvest(lex, jobId, segs, edits, names = new Set(), plaud = []) {
  lex = lex && lex.terms ? lex : emptyLex();
  for (const t of lex.terms) for (const v of t.vars) if (v.by) delete v.by[jobId];
  const rules = activeRules(lex);
  const add = (from, to, field, i, next) => {
    const t = termOf(lex, to, true);
    if (names.has(to)) t.kind = "name";
    let v = t.vars.find((x) => x.from === from);
    if (!v) { v = { from, st: "cand", by: {} }; t.vars.push(v); }
    const b = (v.by[jobId] = v.by[jobId] || { n: 0, neg: 0, undo: 0, app: 0, ex: [], nx: {} });
    b[field] = (b[field] || 0) + 1;
    if ((field === "n" || field === "pl") && b.ex.length < 5 && !b.ex.includes(i)) b.ex.push(i);
    if (next) b.nx[next] = (b.nx[next] || 0) + 1;
  };
  // 이 녹음에서 사람이 고친 쌍 — 발언마다 같은 쌍은 한 번만
  const pairsOf = new Map(), ruleTo = new Map(rules.map((r) => [r.to + "\u0000" + r.from, r]));
  for (const g of segs || []) {
    const e = edits && edits[g.i];
    if (!e) continue;
    const fin = e.parts && e.parts.length ? e.parts.map((p) => p.text || "").join(" ") : e.text;
    if (fin == null) continue;
    const shown = applyLexicon(g.text, rules).text; // 사람이 고치기 전에 보던 글
    const seen = new Set(), list = [];
    // 사전이 바꾼 것(to)을 사람이 원래 꼴(from)로 되돌린 것은 소리 닮음과 상관없이 센다(사람이 보던 글 기준)
    for (const p of diffPairs(shown, fin, { raw: true })) if (ruleTo.has(p.from + "\u0000" + p.to) && !seen.has("u" + p.from)) { seen.add("u" + p.from); list.push({ ...p, undo: true }); }
    // 고친 것은 원래 전사 기준으로 센다 — 사람이 보던 글 기준이면 그 말을 확정한 뒤 다시 셀 때 근거가 0으로 사라졌다
    for (const p of diffPairs(g.text, fin)) {
      const key = p.from + "\u0000" + p.to;
      if (seen.has(key)) continue;
      seen.add(key); list.push(p);
    }
    pairsOf.set(g.i, list);
  }
  for (const [i, list] of pairsOf) for (const p of list) {
    if (p.undo) { add(p.to, p.from, "undo", i); continue; }
    if (ruleTo.has(p.from + "\u0000" + p.to)) continue; // 위에서 되돌림으로 셈
    add(p.from, p.to, "n", i, p.next);
  }
  // Plaud 대조: 한 녹음에서 PL_KEEP곳 이상 나왔거나 사전에 이미 있는 꼴만
  if (plaud && plaud.length) {
    const have = new Set();
    // 이미 있는 꼴: 사람이 정했거나(확정·꺼짐·직접 넣음) 다른 녹음에 근거가 있는 것(이 녹음 몫은 위에서 지웠음)
    for (const t of lex.terms) for (const v of t.vars) if (v.st !== "cand" || v.manual || Object.keys(v.by || {}).length) have.add(v.from + "\u0000" + t.to);
    const cnt = new Map();
    for (const p of plaud) { const k = p.from + "\u0000" + p.to; cnt.set(k, (cnt.get(k) || 0) + 1); }
    for (const p of plaud) {
      const k = p.from + "\u0000" + p.to;
      if (cnt.get(k) < PL_KEEP && !have.has(k)) continue;
      if ((pairsOf.get(p.i) || []).some((x) => x.from === p.from && x.to === p.to)) continue; // 사람이 같게 고침 — n으로 셈
      add(p.from, p.to, "pl", p.i, p.next);
    }
  }
  // 고치지 않고 확인한 발언: 후보 꼴이 그대로 있으면 반대 증거, 확정 꼴이 바뀐 채면 적용 증거
  const cands = [];
  for (const t of lex.terms) for (const v of t.vars) if (v.st === "cand") cands.push([t, v]);
  for (const g of segs || []) {
    const e = edits && edits[g.i];
    if (!e || !e.ok || e.text != null || (e.parts && e.parts.length)) continue;
    const r = applyLexicon(g.text, rules);
    for (const h of r.hits) add(h.from, h.to, "app", g.i);
    if (!cands.length) continue;
    const words = String(g.text || "").split(/\s+/).map(core);
    for (const [t, v] of cands) {
      const ft = v.from.split(/\s+/);
      for (let w = 0; w + ft.length <= words.length; w++) {
        let ok = true;
        for (let q = 0; q < ft.length - 1 && ok; q++) ok = words[w + q] === ft[q];
        const last = words[w + ft.length - 1];
        if (ok && last.startsWith(ft[ft.length - 1]) && TAIL.test(last.slice(ft[ft.length - 1].length))) { add(v.from, t.to, "neg", g.i); break; }
      }
    }
  }
  // 정리: 근거가 다 사라진 후보 꼴은 지우고(직접 넣은 것·확정·꺼짐은 남김), 빈 항목도 지움. 되돌림이 많은 확정 꼴은 끔
  for (const t of lex.terms) {
    t.vars = t.vars.filter((v) => {
      for (const [k, b] of Object.entries(v.by || {})) if (!b.n && !b.neg && !b.undo && !b.app && !b.pl) delete v.by[k];
      if (v.st === "cand" && !v.manual && !Object.keys(v.by || {}).length) return false;
      if (v.st === "on") { const s = totals(v); if (s.undo >= 2 && s.undo * 3 > s.app + s.n) { v.st = "off"; v.why = "되돌림이 많아 꺼짐"; } }
      return true;
    });
  }
  lex.terms = lex.terms.filter((t) => t.vars.length);
  return lex;
}
/** 녹음을 지울 때 그 녹음의 근거를 뺀다 */
export function dropJob(lex, jobId) {
  if (!lex || !lex.terms) return lex;
  for (const t of lex.terms) for (const v of t.vars) if (v.by) delete v.by[jobId];
  for (const t of lex.terms) t.vars = t.vars.filter((v) => v.st !== "cand" || v.manual || Object.keys(v.by || {}).length);
  lex.terms = lex.terms.filter((t) => t.vars.length);
  return lex;
}
/** 꼴 상태 바꾸기(사람 결정). st: on | off | cand · when: 흔한 낱말 조건 */
export function setVar(lex, to, from, st, when) {
  const t = termOf(lex, to);
  const v = t && t.vars.find((x) => x.from === from);
  if (!v) return lex;
  v.st = st;
  delete v.why;
  if (when !== undefined) v.when = when && when.length ? when : null;
  return lex;
}
/** 직접 넣기 */
export function addManual(lex, from, to) {
  from = String(from || "").trim(); to = String(to ?? "").trim();
  if (!from || !to || from === to) return lex;
  const t = termOf(lex, to, true);
  const v = t.vars.find((x) => x.from === from);
  if (v) { v.st = "on"; v.manual = true; } else t.vars.push({ from, st: "on", manual: true, by: {} });
  return lex;
}
/** 백업 합치기: 같은 바른 말·꼴은 합치고(상태는 지금 것 우선, 근거는 녹음별로 합침) */
export function mergeLex(cur, add) {
  const out = JSON.parse(JSON.stringify(cur && cur.terms ? cur : emptyLex()));
  let n = 0;
  for (const t of (add && add.terms) || []) {
    const mine = termOf(out, t.to, true);
    if (t.kind === "name") mine.kind = "name";
    for (const v of t.vars || []) {
      const m = mine.vars.find((x) => x.from === v.from);
      if (!m) { mine.vars.push(JSON.parse(JSON.stringify(v))); n++; continue; }
      for (const [k, b] of Object.entries(v.by || {})) if (!m.by[k]) m.by[k] = b;
    }
  }
  return { lex: out, added: n };
}

/* ------------------------------------------------------------------ 전사 힌트 */
/**
 * 다음 전사 앞머리에 넣을 바른 표기 목록. 확정 꼴이 있고 힌트를 끄지 않은 항목만, 이 녹음 글(ctx: Plaud 전사·작업 이름)에
 * 나온 것을 먼저, 그다음 고친 횟수 많은 순. max개까지.
 */
export function hintTerms(lex, ctx = "", max = 10) {
  const list = [];
  for (const t of (lex && lex.terms) || []) {
    if (t.hint === false || !t.to || t.to.length < 2) continue;
    const on = t.vars.filter((v) => v.st === "on");
    if (!on.length) continue;
    const n = on.reduce((m, v) => m + totals(v).n + totals(v).app, 0);
    list.push({ to: t.to, n, inCtx: ctx && ctx.includes(t.to) ? 1 : 0 });
  }
  return list.sort((a, b) => b.inCtx - a.inCtx || b.n - a.n || a.to.localeCompare(b.to, "ko")).slice(0, max).map((x) => x.to);
}
/** 힌트로 넣을 글(Whisper 「이전 글」 자리). 낱말을 쉼표로 이어 짧은 문장처럼 */
export const hintText = (terms) => (terms.length ? terms.join(", ") + "." : "");
/** 전사 결과가 힌트 낱말을 늘어놓은 것뿐이면(소리에 없는 힌트가 새어 나옴) 참 */
export function hintLeak(out, terms) {
  if (!terms || !terms.length) return false;
  let rest = String(out || "");
  for (const w of [...terms].sort((a, b) => b.length - a.length)) rest = rest.split(w).join("");
  const left = rest.replace(/[\s.,!?…·~"'-]/g, "");
  const used = terms.filter((w) => String(out || "").includes(w)).length;
  return used >= 2 && left.length <= 2;
}
