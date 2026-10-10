// 검수 규칙 — 보기 범위 나누기·발언 나누기/합치기. 순수 함수(화면·시험 공용).
//
// 보기 범위는 포함 관계다:  전체 = 확인함 + 미검수,  미검수 = 확인 필요 + 판정 확실
//   확인함   : 사람이 「✓ 확인」한 발언(e.ok)
//   확인 필요: 미검수 중 자동 화자 판정이 불확실한 것(isNeed)
//   판정 확실: 미검수 중 나머지 — 자동 판정은 확실하나 아직 사람이 안 본 것
// 「고친 발언만」은 범위가 아니라 거르는 조건(화자·글·나누기 중 하나라도 고침).

export const SCOPES = ["all", "ok", "todo", "need", "sure"];

export const isEdited = (e) => !!(e && (e.speaker || e.text || (e.parts && e.parts.length)));

/** 발언 g(수정 e)가 범위 f에 드는가 */
export function inScope(f, e, need) {
  const ok = !!(e && e.ok);
  if (f === "ok") return ok;
  if (f === "todo") return !ok;
  if (f === "need") return !ok && need;
  if (f === "sure") return !ok && !need;
  return true;
}

/** 범위별 개수 {all, ok, todo, need, sure, edited} */
export function scopeCounts(segs, edits, isNeed) {
  const c = { all: 0, ok: 0, todo: 0, need: 0, sure: 0, edited: 0 };
  for (const g of segs) {
    const e = edits[g.i], need = isNeed(g);
    c.all++;
    for (const f of ["ok", "todo", "need", "sure"]) if (inScope(f, e, need)) c[f]++;
    if (isEdited(e)) c.edited++;
  }
  return c;
}

/**
 * 발언(또는 이미 나눈 조각 k)을 글자 위치 pos에서 둘로 나눈다.
 * @param g     발언 {start, end}
 * @param parts 지금 조각 목록(없으면 null — 발언 통째)
 * @param k     나눌 조각 번호(통째면 0)
 * @param text  나눌 글(화면에 보이는 그대로 — 고친 글 포함)
 * @param pos   글자 위치(1 ~ 길이-1)
 * @param at    뒤 조각 시작 시각(초). 없으면 글자 수 비율로 어림
 * @returns 새 조각 목록 [{start, text, speaker?}] — 앞뒤 공백은 걷어 냄. 나눌 수 없으면 null
 */
export function splitPart(g, parts, k, text, pos, at) {
  const list = parts && parts.length ? parts.map((p) => ({ ...p })) : [{ start: g.start, text }];
  const cur = list[k];
  if (!cur) return null;
  const a = text.slice(0, pos).trim(), b = text.slice(pos).trim();
  if (!a || !b) return null;
  const s0 = cur.start, s1 = k + 1 < list.length ? list[k + 1].start : g.end;
  let t = Number.isFinite(at) ? at : s0 + (s1 - s0) * (pos / Math.max(1, text.length));
  t = Math.round(Math.min(s1 - 0.1, Math.max(s0 + 0.1, t)) * 100) / 100;
  const front = { ...cur, text: a }, back = { start: t, text: b };
  if (cur.speaker) back.speaker = cur.speaker; // 처음엔 같은 화자 — 사람이 바꾼다
  list.splice(k, 1, front, back);
  return list;
}

/**
 * 조각을 다시 한 발언으로 합친다 → {text, speaker} (speaker는 모든 조각이 같은 사람으로 지정됐을 때만)
 */
export function mergeParts(parts) {
  const text = parts.map((p) => p.text).join(" ").replace(/\s+/g, " ").trim();
  const sp = new Set(parts.map((p) => p.speaker || ""));
  const speaker = sp.size === 1 ? [...sp][0] : "";
  return { text, speaker };
}

/** 조각 k의 끝 시각 */
export const partEnd = (g, parts, k) => (k + 1 < parts.length ? parts[k + 1].start : g.end);
