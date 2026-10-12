// Plaud 대조 — 순수 함수(화면·시험 공용). 2026-10-12 사용자 승인(Plaud 대조 개선 1~3).
//
// 같은 녹음의 Plaud 전사([{start, end, speaker, text}])가 있으면 HAUD 발언마다
//   · 같은 자리의 Plaud 글(시각으로 고른 줄들에서 글자 정렬로 맞는 부분만 잘라 냄)
//   · 두 글이 얼마나 겹치는지(sim 0~1, 정렬해 같은 글자 × 2 ÷ 두 글 글자 수) — PL_MIN보다 낮으면 「Plaud와 많이 다름」으로 먼저 보게 함
//   · 발언 안에서 Plaud 화자가 바뀌는 시각과 그 자리의 글자 위치(나누기 제안)
// 를 구한다. Plaud도 자동 전사라 정답이 아니므로 자동으로 바꾸지 않는다.

export const PL_MIN = 0.6; // 이보다 덜 같으면 「Plaud와 많이 다름」(10-08 회의: 120/580 — 짧은 발언 빼고)
export const PL_SHORT = 4; // 이보다 짧은 발언(「네」 등)은 견주지 않음 — Plaud는 맞장구를 옆 발언에 붙임
const SPLIT_MIN = 3; // 이보다 짧은 발언은 나누기 제안 안 함(초)
const EDGE = 0.8; // 발언 끝에서 이만큼 안쪽에서 바뀔 때만(초)

const SKIP = /[\s.,?!~·…"'“”‘’「」『』()[\]\-:;]/;
/** 견줄 글자만 남기고, 남긴 글자마다 원래 위치를 적어 둔다 */
function normMap(s) {
  const n = [], idx = [];
  for (let k = 0; k < s.length; k++) { const c = s[k]; if (!SKIP.test(c)) { n.push(c.toLowerCase()); idx.push(k); } }
  return { n, idx };
}
export const normText = (s) => normMap(String(s || "")).n.join("");

/**
 * 글 h가 글 c의 어느 부분과 맞는지(앞뒤는 공짜로 건너뜀) → {d 편집 거리, a, b: c에서 맞는 범위 [a,b), at: h 글자마다 맞은 c 위치, same: 같은 글자 수}
 */
function locate(h, c) {
  const n = h.length, m = c.length, W = m + 1;
  const D = new Int32Array((n + 1) * W), B = new Uint8Array((n + 1) * W); // B: 1 대각 · 2 위(h만) · 3 왼쪽(c만)
  for (let i = 1; i <= n; i++) { D[i * W] = i; B[i * W] = 2; }
  for (let i = 1; i <= n; i++) for (let j = 1; j <= m; j++) {
    const dg = D[(i - 1) * W + j - 1] + (h[i - 1] === c[j - 1] ? 0 : 1), up = D[(i - 1) * W + j] + 1, lf = D[i * W + j - 1] + 1;
    let v = dg, b = 1;
    if (up < v) { v = up; b = 2; }
    if (lf < v) { v = lf; b = 3; }
    D[i * W + j] = v; B[i * W + j] = b;
  }
  let bj = 0;
  for (let j = 1; j <= m; j++) if (D[n * W + j] < D[n * W + bj]) bj = j;
  const at = new Int32Array(n).fill(-1);
  let i = n, j = bj;
  while (i > 0) {
    const b = B[i * W + j];
    if (b === 1) { at[i - 1] = j - 1; i--; j--; } else if (b === 2) i--; else j--;
  }
  let same = 0;
  for (let q = 0; q < n; q++) if (at[q] >= 0 && h[q] === c[at[q]]) same++;
  return { d: D[n * W + bj], a: j, b: bj, at, same };
}

/**
 * HAUD 발언 하나 g {start, end, text}에 맞는 Plaud 글.
 * → null(견줄 수 없음: 짧은 발언·Plaud 없음) | { text, sim, change: {t, pos, from, to} | null }
 *   text: 맞는 Plaud 글(어절 경계까지 넓힘, 맞는 곳이 없으면 "") · sim: 겹침 0~1
 *   change: 발언 안에서 Plaud 화자가 바뀌는 시각 t, 그 자리의 HAUD 글 위치 pos(띄어쓰기 자리), 앞뒤 화자 이름
 */
export function plaudFor(g, plaud) {
  const htext = String(g.text || ""), H = normMap(htext);
  if (H.n.length < PL_SHORT || !plaud || !plaud.length) return null;
  const s = g.start, e = Math.max(g.end ?? g.start, g.start + 0.5);
  // 시각으로 고른 Plaud 줄 — 줄 안에서는 글자를 시간에 고르게 나눠 앞뒤 여유를 두고 자른다(긴 줄 전체와 맞추지 않게)
  const span = [];
  for (const p of plaud) {
    const pe = Math.max(p.end ?? p.start, p.start + 0.5);
    if (pe < s - 3 || p.start > e + 3) continue;
    const t = String(p.text || ""), cps = t.length / Math.max(1, pe - p.start), pad = 8 + H.n.length * 0.3;
    const a = Math.max(0, Math.floor((Math.max(s - 4, p.start) - p.start) * cps - pad));
    const b = Math.min(t.length, Math.ceil((Math.min(e + 4, pe) - p.start) * cps + pad));
    if (b > a) span.push({ p, a, b });
  }
  if (!span.length) return { text: "", sim: 0, change: null };
  // 이어 붙인 글과 글자마다 (줄, 원래 위치)
  const C = [], from = [];
  span.forEach((x, li) => {
    const m = normMap(x.p.text.slice(x.a, x.b));
    m.n.forEach((ch, k) => { C.push(ch); from.push([li, x.a + m.idx[k]]); });
  });
  if (!C.length) return { text: "", sim: 0, change: null };
  const r = locate(H.n, C);
  if (r.b <= r.a) return { text: "", sim: 0, change: null };
  // 맞는 범위 → 줄마다 원래 글(어절 경계까지 넓힘)
  const pieces = [];
  for (let k = r.a; k < r.b; k++) {
    const [li, pos] = from[k];
    const last = pieces[pieces.length - 1];
    if (last && last.li === li) last.b = pos + 1; else pieces.push({ li, a: pos, b: pos + 1 });
  }
  const text = pieces.map(({ li, a, b }) => {
    const t = span[li].p.text;
    while (a > 0 && !/\s/.test(t[a - 1])) a--;
    while (b < t.length && !/\s/.test(t[b])) b++;
    return t.slice(a, b).trim();
  }).join(" ").replace(/\s+/g, " ").trim();
  const sub = r.b - r.a, sim = (2 * r.same) / (H.n.length + sub); // 겹침: 같은 글자 × 2 ÷ 두 글자 수
  // 화자 바뀜: 맞은 범위 안에서 다음 줄로 넘어가는 곳 중 화자가 다른 것(발언 안쪽 시각)
  let change = null;
  if (e - s >= SPLIT_MIN) {
    for (let k = 1; k < pieces.length && !change; k++) {
      const A = span[pieces[k - 1].li].p, Bp = span[pieces[k].li].p;
      if (!A.speaker || !Bp.speaker || A.speaker === Bp.speaker) continue;
      if (Bp.start < s + EDGE || Bp.start > e - EDGE) continue;
      // 뒤 줄 첫 글자(정렬 위치)에 맞은 HAUD 글자 → 그 앞 띄어쓰기
      const firstC = from.findIndex(([li], q) => q >= r.a && li === pieces[k].li);
      let hk = -1;
      for (let q = 0; q < r.at.length; q++) if (r.at[q] >= firstC) { hk = q; break; }
      if (hk <= 0) continue;
      let pos = H.idx[hk];
      while (pos > 0 && !/\s/.test(htext[pos - 1])) pos--;
      if (pos <= 0 || pos >= htext.trim().length) { pos = H.idx[hk]; }
      if (!htext.slice(0, pos).trim() || !htext.slice(pos).trim()) continue;
      change = { t: Math.round(Bp.start * 100) / 100, pos, from: A.speaker, to: Bp.speaker };
    }
  }
  return { text, sim: Math.round(sim * 1000) / 1000, change };
}

/** 녹음 전체: 발언 번호 → plaudFor 결과(견줄 수 없는 발언은 빠짐) */
export function plaudAlign(segs, plaud) {
  const out = new Map();
  if (!plaud || !plaud.length) return out;
  const sorted = [...plaud].sort((a, b) => a.start - b.start);
  for (const g of segs || []) {
    // 시각이 가까운 줄만 넘긴다(긴 녹음에서 줄 전체를 매번 훑지 않게)
    const near = [];
    for (const p of sorted) { if (p.start > (g.end ?? g.start) + 3) break; if ((p.end ?? p.start + 60) >= g.start - 3) near.push(p); }
    const r = plaudFor(g, near);
    if (r) out.set(g.i, r);
  }
  return out;
}
export const plaudDiffers = (r) => !!r && r.sim < PL_MIN;

/* ------------------------------------------------------------------ 교정 사전 후보(Plaud 대조) */
// 말투 차이(이건/이거는·말이에요/말이야·쟤네/걔네)는 잘못 들린 것이 아니므로 뺀다.
const STOP = new Set(["이제", "이게", "그게", "저게", "이거", "그거", "저거", "이건", "그건", "저건", "이거는", "그거는", "저거는", "것은", "거는", "건",
  "얘네", "쟤네", "걔네", "얘가", "쟤가", "걔가", "얘", "쟤", "걔", "여기", "거기", "저기", "요거", "고거", "이런", "그런", "저런", "이렇게", "그렇게", "저렇게",
  "근데", "그런데", "그래서", "그러니까", "그니까", "그러면", "그럼", "그러면은", "그면", "뭐", "좀", "막", "아니", "네", "예", "응", "어", "아", "음", "그", "이", "저"]);
const ENDISH = /(?:요|야|다|어|아|지|죠|네|니|까|고|게|데|는|은|거|건|걸|게요|거든)$/;
const syl = (w) => [...w.replace(/\s/g, "")];
/** HAUD 원래 전사 h ↔ 같은 자리 Plaud 글 p → 교정 사전 후보 [{from, to, next}] (diffPairs + 말투 차이 빼기) */
export function plaudPairs(h, p, diffPairs, stripJosa) {
  const out = [];
  for (const x of diffPairs(h, p)) {
    const a = stripJosa(x.from)[0], b = stripJosa(x.to)[0];
    if (STOP.has(x.from) || STOP.has(x.to) || STOP.has(a) || STOP.has(b)) continue;
    // 같은 줄기에 끝만 다른 말투(말이에요/말이야·아니에요/아니야·했어요/했어)
    const A = syl(x.from), B = syl(x.to);
    let k = 0;
    while (k < A.length && k < B.length && A[k] === B[k]) k++;
    if (k >= 1 && A.length - k <= 2 && B.length - k <= 2 && ENDISH.test(x.from) && ENDISH.test(x.to)) continue;
    out.push(x);
  }
  return out;
}
