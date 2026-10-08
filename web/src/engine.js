// 작업 실행 논리(모델과 저장소는 바깥에서 넣어 준다). 파이썬 기준 구현과 같은 규칙:
// - 전사: 말소리 구간(25초 이하)마다 Whisper
// - 화자: Plaud가 이름 붙인 구간으로 사람별 기준(6초 창 평균)을 만들고, 3초 창(1.5초 간격) 투표로 판정
//   70% 이상이면 「단일」, 아니면 「혼재」. 1·2위 유사도 차이가 작으면 신뢰도를 낮춘다.
// - 처음부터 N명으로 묶는 방식은 소수 화자가 사라져 쓰지 않는다.
import { vadChunks, activeEnd } from "./dsp.js";

const HALLU = /다음 영상에서|시청해 주셔서|구독(과|,)? ?좋아요|^감사합니다\.?$|^MBC 뉴스|자막 제공|^\(?음악\)?$/;
const GENERIC = /^(speaker|spk|화자|발언자|참석자)\s*[_-]?\s*\d+$/i;

export const isGeneric = (name) => GENERIC.test(String(name).trim());
export function isHallu(t) {
  t = t.trim();
  return !t || t === "-" || t === "." || HALLU.test(t) || /(.{4,})\1{3,}/u.test(t);
}

export function normalize(v) {
  let s = 0;
  for (const x of v) s += x * x;
  s = Math.sqrt(s) + 1e-9;
  return Float32Array.from(v, (x) => x / s);
}
function dot(a, b) { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; }

/** 사람별 기준: 출처(회의)별 평균을 창 개수 가중으로 합친 것 */
export function centroid(entry) {
  let tot = null, n = 0;
  for (const it of Object.values(entry.items || {})) {
    if (!tot) tot = new Float64Array(it.vec.length);
    for (let i = 0; i < it.vec.length; i++) tot[i] += it.vec[i] * it.n;
    n += it.n;
  }
  return tot ? { vec: normalize(tot), n } : { vec: null, n: 0 };
}

export function label(votes, whole) {
  const top = Object.entries(votes);
  if (!top.length) return ["미상", "미상", 0];
  if (top[0][1] >= 0.7) {
    let conf = top[0][1];
    const w = Object.values(whole || {});
    if (w.length > 1) conf = Math.min(conf, 0.5 + (w[0] - w[1]));
    return [top[0][0], "단일", Math.round(conf * 100) / 100];
  }
  return [top[0][0] + "·" + (top[1] ? top[1][0] : "?"), "혼재", Math.round(top[0][1] * 100) / 100];
}

/** 이름 붙은 2.5초 이상 발언을 6초 창으로 잘라 사람별 평균 특징을 만든다 */
export async function enroll(embedAt, segs, keep, onStep = () => {}, maxPerSpeaker = 80) {
  const V = new Map();
  const seen = new Set();
  const todo = [];
  for (const g of segs) {
    const who = (g.speaker || "").trim();
    const key = g.start + "|" + who;
    if (!who || seen.has(key) || !keep(g) || g.end - g.start < 2.5) continue;
    seen.add(key);
    for (let t = g.start + 0.3; t + 1.5 <= g.end - 0.3; t += 6) todo.push([who, t, Math.min(t + 6, g.end - 0.3)]);
  }
  // 한 사람당 최대 maxPerSpeaker개 창을 회의 전체에 고르게 고른다(평균은 거의 같고 처리는 몇 배 빨라진다)
  const bySpk = new Map();
  for (const w of todo) { if (!bySpk.has(w[0])) bySpk.set(w[0], []); bySpk.get(w[0]).push(w); }
  todo.length = 0;
  for (const ws of bySpk.values()) {
    if (ws.length <= maxPerSpeaker) todo.push(...ws);
    else for (let i = 0; i < maxPerSpeaker; i++) todo.push(ws[Math.floor((i * ws.length) / maxPerSpeaker)]);
  }
  for (let i = 0; i < todo.length; i++) {
    const [who, a, b] = todo[i];
    if (!V.has(who)) V.set(who, []);
    V.get(who).push(await embedAt(a, b));
    onStep(i + 1, todo.length);
  }
  const out = {};
  for (const [who, vs] of V) {
    const c = new Float64Array(vs[0].length);
    for (const v of vs) for (let i = 0; i < c.length; i++) c[i] += v[i];
    out[who] = { vec: Array.from(normalize(c), (x) => Math.round(x * 1e5) / 1e5), n: vs.length };
  }
  return out;
}

export async function match(embedAt, s, e, C) {
  const names = Object.keys(C);
  if (!names.length) return [{}, {}];
  const votes = {};
  for (let a = s; a < Math.max(s + 0.01, e - 1.0); a += 1.5) {
    const b = Math.min(a + 3, e);
    if (b - a < 1) continue;
    const v = await embedAt(a, b);
    let best = 0, bi = -1;
    names.forEach((k, i) => { const d = dot(C[k], v); if (bi < 0 || d > best) { best = d; bi = i; } });
    votes[names[bi]] = (votes[names[bi]] || 0) + (b - a);
  }
  let whole = {};
  if (e - s >= 1) {
    const v = await embedAt(s, e);
    const sims = names.map((k) => [k, dot(C[k], v)]).sort((x, y) => y[1] - x[1]).slice(0, 3);
    whole = Object.fromEntries(sims.map(([k, d]) => [k, Math.round(d * 1000) / 1000]));
  }
  const tot = Object.values(votes).reduce((x, y) => x + y, 0) || 1;
  const sorted = Object.entries(votes).sort((x, y) => y[1] - x[1]);
  return [Object.fromEntries(sorted.map(([k, v]) => [k, Math.round((v / tot) * 100) / 100])), whole];
}

/** 처리 대상 구간 [[파일번호, 시작, 끝]] */
export async function planTargets(job, files, plaudEnd, readAudio) {
  if (job.mode === "enroll") return [];
  if (job.mode === "fragment") return files.map((f, i) => [i, 0, f.dur]);
  const f0 = files[0];
  if (job.mode === "gap") {
    const t0 = Math.max(0, (job.transcriptEndSec || plaudEnd || 0) - 15);
    return [[0, t0, activeEnd(await readAudio(0, t0, f0.dur), t0, f0.dur)]];
  }
  const r = job.range || {};
  return [[0, +(r.from || 0), Math.min(f0.dur, +(r.to ?? f0.dur))]];
}

/**
 * 작업 하나를 처리한다. 중간에 멈춰도 ctx.partial에 구간별 결과가 남아 이어서 할 수 있다.
 * ctx: { readAudio(fi,s,e)→Float32Array, transcribe(Float32Array)→string, embed(Float32Array)→Float32Array,
 *        plaud:[], vpStore:{}, loadEnroll(), saveEnroll(v), loadChunks(), saveChunks(c), loadPartial()→{k:rec}, savePartial(rec),
 *        progress(pct,msg), shouldStop() }
 * 반환: { result, fresh } — 멈췄으면 result=null
 */
export async function runJob(job, files, ctx) {
  const smap = job.speakerMap || {};
  const plaud = (ctx.plaud || []).map((g) => ({ ...g, speaker: (smap[g.speaker] || g.speaker || "").trim() }));
  const plaudEnd = plaud.reduce((m, g) => Math.max(m, g.end), 0) || null;
  const targets = await planTargets(job, files, plaudEnd, ctx.readAudio);
  const embedAt0 = async (a, b) => ctx.embed(await ctx.readAudio(0, a, b));

  let fresh = await ctx.loadEnroll();
  if (!fresh) {
    fresh = {};
    if (plaud.length && ["gap", "range", "enroll"].includes(job.mode)) {
      let keep = () => true;
      if (job.mode === "gap") { const t0 = targets[0][1]; keep = (g) => g.start < t0 + 1; }
      if (job.mode === "range") { const [, a, b] = targets[0]; keep = (g) => g.end <= a || g.start >= b; }
      fresh = await enroll(embedAt0, plaud, keep, (i, n) => ctx.progress(1 + Math.floor((i / n) * 9), `목소리 기준 만드는 중 ${i}/${n}`));
    }
    await ctx.saveEnroll(fresh);
  }

  let C = {};
  if (job.useVoiceprints !== false) {
    for (const [name, entry] of Object.entries(ctx.vpStore || {})) {
      const { vec } = centroid(entry);
      if (vec) C[name] = vec;
    }
  }
  for (const [name, d] of Object.entries(fresh)) { // 이번 회의 기준이 있으면 저장된 기준과 합쳐 쓴다
    if (C[name]) C[name] = centroid({ items: { ...(ctx.vpStore[name].items || {}), __this__: d } }).vec;
    else C[name] = Float32Array.from(d.vec);
  }
  const only = new Set(job.speakers || []);
  if (only.size) C = Object.fromEntries(Object.entries(C).filter(([k]) => only.has(k)));
  const enrolled = Object.fromEntries(Object.entries(fresh).map(([k, v]) => [k, v.n]));

  if (job.mode === "enroll") return { result: { segs: [], stats: { segments: 0, enrolled } }, fresh };

  let chunks = await ctx.loadChunks();
  if (!chunks) {
    ctx.progress(10, "말소리 구간 나누는 중");
    chunks = [];
    for (const [fi, a, b] of targets) {
      for (const [s, e] of vadChunks(await ctx.readAudio(fi, a, b), a)) chunks.push([fi, s, e]);
    }
    await ctx.saveChunks(chunks);
  }

  const done = await ctx.loadPartial();
  const tic = Date.now();
  let nNew = 0;
  for (let k = 0; k < chunks.length; k++) {
    if (done[k]) continue;
    if (ctx.shouldStop()) return { result: null, fresh };
    const [fi, s, e] = chunks[k];
    const audio = await ctx.readAudio(fi, Math.max(0, s - 0.15), e + 0.15);
    const text = await ctx.transcribe(audio);
    const rec = { k, file: fi, start: s, end: e, text };
    if (isHallu(text)) rec.hallu = true;
    else {
      const embedAt = async (a, b) => ctx.embed(await ctx.readAudio(fi, a, b));
      const [votes, whole] = Object.keys(C).length ? await match(embedAt, s, e, C) : [{}, {}];
      const [speaker, kind, conf] = label(votes, whole);
      Object.assign(rec, { speaker, kind, conf, votes });
    }
    await ctx.savePartial(rec);
    done[k] = rec;
    nNew++;
    const n = Object.keys(done).length;
    const left = ((chunks.length - n) * (Date.now() - tic)) / nNew / 60000;
    ctx.progress(10 + Math.floor((n / Math.max(1, chunks.length)) * 89), `${n}/${chunks.length} 구간 · 남은 시간 약 ${Math.ceil(left)}분`);
  }

  const segs = [];
  let dropped = 0;
  for (let k = 0; k < chunks.length; k++) {
    const r = done[k];
    if (r.hallu) { dropped++; continue; }
    segs.push({ i: segs.length + 1, file: r.file, start: r.start, end: r.end, text: r.text, speaker: r.speaker, kind: r.kind, conf: r.conf, votes: r.votes });
  }
  const cnt = (k) => segs.filter((g) => g.kind === k).length;
  const r1 = (v) => Math.round(v * 10) / 10;
  const stats = {
    segments: segs.length, single: cnt("단일"), mixed: cnt("혼재"), unknown: cnt("미상"),
    lowConf: segs.filter((g) => g.kind === "단일" && g.conf < 0.6).length, droppedHallucination: dropped,
    targetSec: r1(targets.reduce((m, [, a, b]) => m + b - a, 0)),
    targets: targets.map(([file, a, b]) => ({ file, from: r1(a), to: r1(b) })),
    files: files.map((f) => ({ name: f.name, dur: r1(f.dur) })),
    speakersUsed: Object.keys(C).sort(), enrolled,
  };
  return { result: { segs, stats }, fresh };
}
