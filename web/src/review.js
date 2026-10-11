// 검수 규칙 — 보기 범위 나누기·발언 나누기/합치기. 순수 함수(화면·시험 공용).
//
// 보기 범위는 포함 관계다:  전체 = 확인함 + 미검수,  미검수 = 확인 필요 + 판정 확실
//   확인함   : 사람이 「✓ 확인」한 발언(e.ok)
//   확인 필요: 미검수 중 자동 화자 판정이 불확실한 것(isNeed)
//   판정 확실: 미검수 중 나머지 — 자동 판정은 확실하나 아직 사람이 안 본 것
// 「고친 발언만」은 범위가 아니라 거르는 조건(화자·글·나누기 중 하나라도 고침).

export const SCOPES = ["all", "ok", "todo", "need", "sure"];

export const isEdited = (e) => !!(e && (e.speaker || e.text != null || (e.parts && e.parts.length))); // 글을 다 지운 것("")도 고친 것

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
  t = s1 - s0 < 0.2 ? (s0 + s1) / 2 : Math.min(s1 - 0.1, Math.max(s0 + 0.1, t)); // 아주 짧은 조각은 가운데
  t = Math.round(t * 100) / 100;
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

/**
 * 녹음 한 건의 진행 단계와 「지금 할 일」(녹음 목록 카드·작업 화면 머리 공용).
 * 화자 분리: 등록 → 화자 분리(자동) → 이름 지정 → 전사(자동) → 검수 → 내보내기
 * 그 밖(누락 보충·구간 재전사·바로 맞히기): 등록 → 전사(자동) → 검수 → 내보내기 · 목소리 기준만: 등록 → 목소리 기준(자동)
 * rv = 검수 진행 {ok, all, exportedAt}(kv 「rv:작업id」 — 없으면 모름)
 * 반환 { steps:[{label, auto, state: done|cur|proc|stop|todo}], badge, action:{a, label, primary}|null, busy }
 */
export function jobFlow(job, rv = null) {
  const diar = job.mode === "diar" || job.mode === "sony";
  // [이름, 단계 열쇠(색), 앱이 하는 단계?]
  const labels = diar ? [["등록", "reg"], ["화자 분리", "diar", 1], ["이름 지정", "name"], ["전사", "tr", 1], ["검수", "rv"], ["내보내기", "ex"]]
    : job.mode === "enroll" ? [["등록", "reg"], ["목소리 기준", "vp", 1]] : [["등록", "reg"], ["전사", "tr", 1], ["검수", "rv"], ["내보내기", "ex"]];
  const st = job.status, run = st === "대기" || st === "처리중", halted = st === "중지" || st === "오류";
  const autoAt = diar ? (job.stage === "transcribe" ? 3 : 1) : 1; // 지금 돌거나 멈춘 자동 단계
  let at, state, badge, action = null, group;
  if (st === "준비") { at = 0; state = "proc"; badge = "등록 중"; group = "run"; }
  else if (run) { at = autoAt; state = "proc"; badge = st === "대기" ? labels[at][0] + " 대기" : labels[at][0] + " 중"; group = "run"; }
  else if (halted) {
    at = autoAt; state = "stop"; badge = labels[at][0] + " " + st; group = "todo";
    action = { a: "resume", label: st === "오류" ? "다시 시도 →" : "이어서 처리 →", primary: true };
  } else if (st === "이름 대기") { at = 2; state = "cur"; badge = "이름 지정"; group = "todo"; action = { a: "review", label: "화자 이름 지정 →", primary: true }; }
  else if (job.mode === "enroll") { at = labels.length; state = "done"; badge = "완료"; group = "done"; action = { a: "voices", label: "목소리 기준 보기 →", primary: false }; }
  else { // 완료 — 검수·내보내기는 사람이 하는 일
    const n = labels.length, left = rv && rv.all ? rv.all - rv.ok : null;
    if (rv && rv.exportedAt) { at = n; state = "done"; badge = "완료"; group = "done"; action = { a: "review", label: "결과 열기 →", primary: false }; }
    else if (left === 0) { at = n - 1; state = "cur"; badge = "내보내기"; group = "todo"; action = { a: "review", label: "내보내기 →", primary: true }; }
    else { at = n - 2; state = "cur"; badge = "검수"; group = "todo"; action = { a: "review", label: left == null ? "검수하기 →" : `검수 이어하기 · 남음 ${left} →`, primary: true }; }
  }
  const steps = labels.map(([label, key, auto], i) => ({ label, key, auto: !!auto, state: i < at ? "done" : i === at ? state : "todo" }));
  const stage = at < labels.length ? labels[at][1] : "done"; // 지금 단계 열쇠(카드 색)
  return { steps, badge, action, busy: run || st === "준비", group, stage };
}
