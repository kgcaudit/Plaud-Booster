// 화자 먼저 나누기(소니 녹음처럼 Plaud 이름이 없는 녹음용) — 순수 함수(시험 가능).
//
//  말소리 확률(Silero, 음량 맞춤) → 말소리 구간 → 3초 창(1.5초 간격) 목소리 특징
//  → 창마다 인원 수를 정하지 않고 평균 연결 계층 묶기(임계값으로 끊음) → 말 중간에 혼자 튄 창은 앞뒤를 따름
//  → 아주 작은 묶음은 가까운 묶음에 흡수
//  → 묶음마다 저장된 목소리 기준과 비교해 이름을 「추천」(확정은 사람이) → 처음 나온 순서로 Speaker 1, 2…
//  → 같은 묶음끼리 이어지는 차례를 25초 이하 「발언」으로 합쳐 전사 단위로 쓴다.
//
// 처음부터 N명으로 묶으면 말이 적은 사람이 사라지므로(10-08 시험 79.6%) 인원 수는 상한으로만 쓴다.
// 10-08 회의(5명, 1시간 57분)를 Plaud 이름을 숨기고 돌린 결과: 묶음 8개, 묶음별 다수 이름 기준 98.1%, 5명 모두 따로 잡힘.
// 저장된 기준이 있을 때 「아는 사람을 묶기 전에 떼어 두는」 방식(seed)은 97.8% → 96.6%로 오히려 낮아 기본은 끄고,
// 묶은 뒤 이름 추천으로만 쓴다. 인원 수를 그대로 상한으로 걸면 닮은 두 사람이 합쳐져(93.7%) 「인원 + 2」를 상한으로 쓴다.

export const FRAME = 512 / 16000; // Silero 한 칸(32ms)

export const DEFAULTS = {
  win: 3, hop: 1.5, minWin: 1.0, // 창
  // 창 하나하나를 묶는다(10-08: 98.1%). 창이 maxWin개를 넘는 아주 긴 녹음은 메모리(창 수²) 때문에
  // 화자가 바뀌는 곳에서 끊은 「차례」 평균으로 묶는다(change 0.5·cut 0.40 → 97.7%).
  maxWin: 6000, bigChange: 0.5, bigCut: 0.40,
  change: 2, // 차례 안에서 이 값보다 덜 닮은 창이 나오면 화자가 바뀐 것으로 본다(코사인, 2 = 창마다 끊음)
  cut: 0.35, // 묶기: 평균 유사도가 이 값 이상이면 같은 사람(10-08 회의: 0.30이면 두 사람이 합쳐지고 0.35면 5명 모두 따로)
  // 전화 음질(8kHz → 16kHz, 4kHz 위가 빔)에서는 목소리 특징이 서로 더 닮아(창 쌍 유사도 중앙값 0.25 → 0.33)
  // 0.35로는 5명 중 3명만 남는다(81%). 대역 비가 narrowDb보다 낮으면 narrowCut을 쓴다(10-08을 8kHz로 낮춘 시험: 0.45 → 93%, 5명 모두).
  narrowDb: -47, narrowCut: 0.45,
  known: 0.50, knownGap: 0.08, // 저장된 기준과 이 값 이상 닮고 2위와 차이가 있으면 그 사람 묶음으로
  suggest: 0.60, weak: 0.45, // 묶음 중심이 저장된 기준과 0.60 이상이면 추천, 0.45 이상이면 「닮음」 표시만
  seed: false, // 아는 사람을 묶기 전에 떼어 두기 — 10-08 시험에서 오히려 정확도가 낮아(97.8%→96.6%) 기본은 끔
  tinySec: 10, tinyTurns: Infinity, // 말한 시간이 이보다 짧은 묶음은 가장 닮은 묶음에 흡수
  unitMax: 25, unitGap: 1.2,
};

const dot = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; };
function unit(v) {
  let s = 0;
  for (const x of v) s += x * x;
  s = Math.sqrt(s) + 1e-9;
  return Float32Array.from(v, (x) => x / s);
}
function meanOf(vecs, idx, w) {
  const d = vecs[idx[0]].length, m = new Float64Array(d);
  for (const i of idx) { const k = w ? w[i] : 1; const v = vecs[i]; for (let j = 0; j < d; j++) m[j] += v[j] * k; }
  return unit(m);
}
const r2 = (v) => Math.round(v * 100) / 100;

/**
 * Silero에 넣기 전 음량 맞추기: 512표본 칸마다 앞뒤 약 3초 평균 음량을 -26dBFS로 맞춘다(최대 +30dB).
 * 10-08 회의(멀리 앉은 사람 목소리가 작음)에서 그냥 넣으면 Plaud 발언 414개 중 50개를 놓쳤고, 맞춘 뒤에는 1개였다
 * (에너지 기준 방식은 5개). 칸별 배율을 돌려준다.
 */
export function agcGains(x, frame = 512, span = 94, target = 0.0501, maxGain = 31.6) {
  const n = Math.floor(x.length / frame);
  const e = new Float64Array(n);
  for (let i = 0; i < n; i++) { let s = 0; for (let k = i * frame; k < (i + 1) * frame; k++) s += x[k] * x[k]; e[i] = s / frame; }
  const c = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) c[i + 1] = c[i] + e[i];
  const g = new Float32Array(n), h = Math.floor(span / 2);
  for (let i = 0; i < n; i++) {
    const a = Math.max(0, i - h), b = Math.min(n, i - h + span);
    g[i] = Math.min(maxGain, Math.max(0.1, target / (Math.sqrt((c[b] - c[a]) / span) + 1e-6)));
  }
  return g;
}

/** 말소리 확률(칸마다) → [[시작, 끝]] 초. 켜짐 on 이상, 꺼짐 off 미만이 minSil초 이어지면 끊는다. */
export function speechRegions(probs, t0 = 0, { on = 0.5, off = 0.35, minSil = 0.5, minSpeech = 0.25, pad = 0.12 } = {}) {
  const out = [];
  let st = -1, lastOn = -1;
  for (let i = 0; i < probs.length; i++) {
    const p = probs[i];
    if (st < 0) { if (p >= on) { st = i; lastOn = i; } continue; }
    if (p >= off) lastOn = i;
    else if ((i - lastOn) * FRAME >= minSil) { out.push([st, lastOn + 1]); st = -1; }
  }
  if (st >= 0) out.push([st, lastOn + 1]);
  const end = t0 + probs.length * FRAME;
  const res = [];
  for (const [a, b] of out) {
    if ((b - a) * FRAME < minSpeech) continue;
    const s = Math.max(t0, t0 + a * FRAME - pad), e = Math.min(end, t0 + b * FRAME + pad);
    const last = res[res.length - 1];
    if (last && s <= last[1]) last[1] = e; else res.push([s, e]);
  }
  return res.map(([s, e]) => [r2(s), r2(e)]);
}

/** 전사 단위: 가까운 구간(gap초 미만)은 maxlen 안에서 합치고, 긴 구간은 고르게 나눈다 */
export function packRegions(regions, maxlen = 25, gap = 1.2) {
  const m = [];
  for (const [s, e] of regions) {
    const last = m[m.length - 1];
    if (last && s - last[1] < gap && e - last[0] <= maxlen) last[1] = e;
    else m.push([s, e]);
  }
  const out = [];
  for (const [s, e] of m) {
    const n = Math.ceil((e - s) / maxlen - 1e-9);
    for (let k = 0; k < n; k++) out.push([r2(s + ((e - s) * k) / n), r2(s + ((e - s) * (k + 1)) / n)]);
  }
  return out.filter(([s, e]) => e - s >= 0.3); // 0.3초 넘는 짧은 대답(「네」)도 전사(예전 0.5초)
}

/** 구간마다 win초 창을 hop초 간격으로. 마지막 창은 구간 끝에 맞춘다. 구간 번호 r 포함 */
export function windowsOf(regions, { win = 3, hop = 1.5, minWin = 1.0, minShort = 0.3, shortSpan = 1.5 } = {}) {
  const out = [];
  regions.forEach(([s, e], r) => {
    if (e - s < minShort) return;
    // 1초보다 짧은 말(조용한 뒤 「네」「아, 그건」)도 버리지 않는다: 목소리 특징은 가운데 1.5초(es~ee)로 뽑고, 차례 시각은 실제 말(s~e) 그대로.
    // 예전에는 이런 덩어리가 어느 화자에도 속하지 못해 전사에서 통째로 빠졌다(10-08 회의: 1,517개 중 196개, 150초)
    if (e - s < minWin) { const m = (s + e) / 2; out.push({ r, s, e, es: r2(Math.max(0, m - shortSpan / 2)), ee: r2(m + shortSpan / 2) }); return; }
    if (e - s <= win) { out.push({ r, s, e }); return; }
    let a = s;
    for (; a + win < e - 0.25; a += hop) out.push({ r, s: r2(a), e: r2(a + win) });
    out.push({ r, s: r2(e - win), e: r2(e) });
  });
  return out;
}

/** 같은 구간 안에서 이웃 창이 이어지면 한 차례. 지금 차례의 평균과 덜 닮은 창이 두 번 이어지면 끊는다 */
export function turnsOf(wins, vecs, change = DEFAULTS.change) {
  const turns = [];
  let cur = null;
  const close = () => { if (cur) { turns.push(cur); cur = null; } };
  for (let i = 0; i < wins.length; i++) {
    const w = wins[i];
    if (!cur || cur.r !== w.r || cur.f !== (w.f || 0)) { close(); cur = { f: w.f || 0, r: w.r, w: [i], sum: Float64Array.from(vecs[i]) }; continue; }
    const m = unit(cur.sum);
    const sim = dot(m, vecs[i]);
    if (sim < change) {
      const nxt = i + 1 < wins.length && wins[i + 1].r === w.r && (wins[i + 1].f || 0) === (w.f || 0) ? dot(m, vecs[i + 1]) : -1;
      if (nxt < change) { close(); cur = { f: w.f || 0, r: w.r, w: [i], sum: Float64Array.from(vecs[i]) }; continue; }
    }
    cur.w.push(i);
    for (let j = 0; j < cur.sum.length; j++) cur.sum[j] += vecs[i][j];
  }
  close();
  // 시간: 이웃 차례가 겹치면 겹친 곳 가운데에서 나눈다
  for (let k = 0; k < turns.length; k++) {
    const t = turns[k];
    t.s = wins[t.w[0]].s; t.e = wins[t.w[t.w.length - 1]].e;
    const p = turns[k - 1];
    if (p && p.f === t.f && p.r === t.r && t.s < p.e) { const mid = r2((t.s + p.e) / 2); p.e = mid; t.s = mid; }
    t.v = unit(t.sum);
    delete t.sum;
  }
  return turns;
}

/**
 * 평균 연결 계층 묶기(최근접 이웃 사슬, O(n²)). 무게 w(창 수)로 가중 평균.
 * 반환: 합침 목록 [[a, b, 유사도]] — 유사도가 큰 순서로 적용하면 계층이 된다.
 */
export function linkage(vecs, w) {
  const n = vecs.length;
  if (n < 2) return [];
  const S = new Float32Array(n * n);
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) { const d = dot(vecs[i], vecs[j]); S[i * n + j] = d; S[j * n + i] = d; }
  const size = Float64Array.from(w || vecs.map(() => 1));
  const alive = new Uint8Array(n).fill(1);
  const id = Array.from({ length: n }, (_, i) => i); // 대표 칸 → 바깥 번호
  let next = n;
  const merges = [];
  const chain = [];
  let left = n;
  while (left > 1) {
    if (!chain.length) { for (let i = 0; i < n; i++) if (alive[i]) { chain.push(i); break; } }
    const a = chain[chain.length - 1];
    const prev = chain.length > 1 ? chain[chain.length - 2] : -1;
    let best = -Infinity, bi = -1;
    for (let j = 0; j < n; j++) {
      if (j === a || !alive[j]) continue;
      const s = S[a * n + j];
      if (s > best || (s === best && j === prev)) { best = s; bi = j; }
    }
    if (bi === prev) {
      chain.pop(); chain.pop();
      const b = prev;
      merges.push([id[a], id[b], best]);
      // a 칸에 합친다
      const wa = size[a], wb = size[b];
      for (let j = 0; j < n; j++) {
        if (!alive[j] || j === a || j === b) continue;
        const s = (wa * S[a * n + j] + wb * S[b * n + j]) / (wa + wb);
        S[a * n + j] = s; S[j * n + a] = s;
      }
      size[a] = wa + wb; alive[b] = 0; id[a] = next++; left--;
    } else chain.push(bi);
  }
  return merges;
}

/** 합침 목록을 유사도 cut 이상까지 적용(최대 묶음 수 cap이 있으면 그 수가 될 때까지 더 적용) → 칸별 묶음 번호 */
export function cutTree(n, merges, cut, cap = 0) {
  const parent = Array.from({ length: 2 * n }, (_, i) => i);
  const find = (x) => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
  // merges는 바깥 번호(잎 0..n-1, 새 묶음 n..) — 만들어진 순서대로 새 번호를 단다
  const order = merges.map((m, k) => ({ a: m[0], b: m[1], s: m[2], id: n + k }));
  let groups = n;
  for (const m of [...order].sort((x, y) => y.s - x.s)) {
    if (m.s < cut && !(cap && groups > cap)) break;
    parent[find(m.a)] = m.id; parent[find(m.b)] = m.id; groups--;
  }
  const lab = new Map();
  return Array.from({ length: n }, (_, i) => { const r = find(i); if (!lab.has(r)) lab.set(r, lab.size); return lab.get(r); });
}

/**
 * 차례들을 묶는다.
 * known: { 이름: 단위벡터 } — 저장된 목소리 기준(참석자를 골랐으면 그 사람들만)
 * 반환: { labels: 차례별 묶음 번호, clusters: [{ turns:[k], vec, dur, nwin, suggest, alt }] } (처음 나온 순)
 */
export function clusterTurns(turns, known = {}, opt = {}) {
  const o = { ...DEFAULTS, ...opt };
  const names = Object.keys(known);
  const dur = (t) => t.e - t.s;
  const w = turns.map((t) => t.w.length);
  // ① 아는 사람 먼저
  const seed = turns.map((t) => {
    if (!names.length || !o.seed) return null;
    const sims = names.map((n) => [n, dot(known[n], t.v)]).sort((a, b) => b[1] - a[1]);
    return sims[0][1] >= o.known && sims[0][1] - (sims[1] ? sims[1][1] : -1) >= o.knownGap ? sims[0][0] : null;
  });
  const groups = new Map(); // 키 → 차례 목록
  names.forEach((n) => groups.set("k:" + n, []));
  const rest = [];
  turns.forEach((t, k) => (seed[k] ? groups.get("k:" + seed[k]).push(k) : rest.push(k)));
  // ② 나머지는 계층 묶기
  if (rest.length) {
    const labs = rest.length > 1 ? cutTree(rest.length, linkage(rest.map((k) => turns[k].v), rest.map((k) => w[k])), o.cut) : [0];
    rest.forEach((k, i) => { const key = "c:" + labs[i]; if (!groups.has(key)) groups.set(key, []); groups.get(key).push(k); });
  }
  let cl = [...groups.entries()].filter(([, ks]) => ks.length).map(([key, ks]) => ({ key, turns: ks }));
  const vecOf = (ks) => meanOf(turns.map((t) => t.v), ks, w);
  const durOf = (ks) => ks.reduce((m, k) => m + dur(turns[k]), 0);
  cl.forEach((c) => { c.vec = vecOf(c.turns); c.dur = durOf(c.turns); });
  // 인원 수 상한: 넘치면 가장 닮은 두 묶음을 합친다(아는 사람 묶음끼리는 합치지 않음)
  const merge = (a, b) => { a.turns.push(...b.turns); a.vec = vecOf(a.turns); a.dur = durOf(a.turns); if (b.key.startsWith("k:") && !a.key.startsWith("k:")) a.key = b.key; cl = cl.filter((x) => x !== b); };
  // ③ 아주 작은 묶음 흡수 — 짧은 녹음에서는 기준을 말한 시간의 4%로 줄인다(100초짜리에서 10초면 사람 하나가 사라짐)
  const tinySec = Math.min(o.tinySec, 0.04 * cl.reduce((m, c) => m + c.dur, 0));
  for (;;) {
    const tiny = cl.filter((c) => c.dur < tinySec && c.turns.length <= o.tinyTurns && !c.key.startsWith("k:")).sort((a, b) => a.dur - b.dur)[0];
    if (!tiny || cl.length < 2) break;
    const host = cl.filter((c) => c !== tiny).map((c) => [c, dot(c.vec, tiny.vec)]).sort((a, b) => b[1] - a[1])[0][0];
    merge(host, tiny);
  }
  while (o.cap && cl.length > o.cap) {
    let best = null;
    for (let i = 0; i < cl.length; i++) for (let j = i + 1; j < cl.length; j++) {
      if (cl[i].key.startsWith("k:") && cl[j].key.startsWith("k:")) continue;
      const s = dot(cl[i].vec, cl[j].vec);
      if (!best || s > best[2]) best = [cl[i], cl[j], s];
    }
    if (!best) break;
    const [a, b] = best[0].key.startsWith("k:") ? [best[0], best[1]] : [best[1], best[0]];
    merge(a, b);
  }
  // 이름 추천
  for (const c of cl) {
    const sims = names.map((n) => [n, Math.round(dot(known[n], c.vec) * 100) / 100]).sort((a, b) => b[1] - a[1]);
    c.suggest = c.key.startsWith("k:") ? { name: c.key.slice(2), sim: sims.find((s) => s[0] === c.key.slice(2))[1], strong: true }
      : sims[0] && sims[0][1] >= o.weak ? { name: sims[0][0], sim: sims[0][1], strong: sims[0][1] >= o.suggest } : null;
    c.alt = sims.filter((s) => !c.suggest || s[0] !== c.suggest.name).slice(0, 1).map(([name, sim]) => ({ name, sim }))[0] || null;
    c.turns.sort((a, b) => a - b);
  }
  cl.sort((a, b) => a.turns[0] - b.turns[0]);
  const labels = new Array(turns.length).fill(-1);
  cl.forEach((c, ci) => c.turns.forEach((k) => { labels[k] = ci; }));
  return { labels, clusters: cl };
}

/**
 * 발언 단위: 같은 파일·같은 묶음 차례가 gap초 안에 이어지면 unitMax초까지 합친다. 긴 차례는 고르게 나눈다.
 * 각 발언: { f, s, e, c(묶음 번호), turns:[k], v(평균 특징), sim(제 묶음과), margin(2위 묶음과 차이) }
 */
export function unitsOf(turns, labels, clusters, opt = {}) {
  const o = { ...DEFAULTS, ...opt };
  const order = turns.map((t, k) => k).filter((k) => labels[k] >= 0).sort((a, b) => turns[a].f - turns[b].f || turns[a].s - turns[b].s);
  const raw = [];
  for (const k of order) {
    const t = turns[k], c = labels[k], last = raw[raw.length - 1];
    if (last && last.f === t.f && last.c === c && t.s - last.e < o.unitGap && t.e - last.s <= o.unitMax) { last.e = t.e; last.turns.push(k); }
    else raw.push({ f: t.f, s: t.s, e: t.e, c, turns: [k] });
  }
  const out = [];
  for (const u of raw) {
    const n = Math.ceil((u.e - u.s) / o.unitMax - 1e-9);
    if (n <= 1) { out.push(u); continue; }
    for (let i = 0; i < n; i++) out.push({ ...u, s: r2(u.s + ((u.e - u.s) * i) / n), e: r2(u.s + ((u.e - u.s) * (i + 1)) / n), turns: u.turns.filter((k) => turns[k].e > u.s + ((u.e - u.s) * i) / n && turns[k].s < u.s + ((u.e - u.s) * (i + 1)) / n) });
  }
  const tv = turns.map((t) => t.v), tw = turns.map((t) => t.w.length);
  for (const u of out) {
    u.v = meanOf(tv, u.turns, tw);
    const sims = clusters.map((c) => dot(c.vec, u.v));
    u.sim = Math.round(sims[u.c] * 100) / 100;
    const other = sims.filter((_, i) => i !== u.c);
    u.margin = Math.round((sims[u.c] - (other.length ? Math.max(...other) : -1)) * 100) / 100;
    u.nwin = u.turns.reduce((m, k) => m + tw[k], 0);
  }
  return out;
}

/** 묶음마다 들어 볼 대표 발언(2.5초 이상, 묶음 중심에 가까운 순으로 max개, 시간 순 정렬) */
export function samplesOf(units, ci, max = 6) {
  const mine = units.filter((u) => u.c === ci);
  const long = mine.filter((u) => u.e - u.s >= 2.5);
  return (long.length ? long : mine).slice().sort((a, b) => b.sim - a.sim).slice(0, max)
    .sort((a, b) => a.f - b.f || a.s - b.s).map((u) => ({ f: u.f, s: u.s, e: u.e }));
}

/** 화자 먼저 나누기 전체: 창·특징 → { turns, clusters, units } (저장용으로 숫자를 줄인다) */
export function diarize(wins, vecs, known = {}, opt = {}) {
  const big = wins.length > (opt.maxWin ?? DEFAULTS.maxWin);
  opt = { ...opt, change: opt.change ?? (big ? DEFAULTS.bigChange : DEFAULTS.change), cut: opt.cut ?? (big ? DEFAULTS.bigCut : DEFAULTS.cut) };
  const turns = turnsOf(wins, vecs, opt.change);
  const { labels, clusters } = clusterTurns(turns, known, opt);
  // 앞뒤가 같은 묶음인데 혼자 다른 창(같은 구간 안)은 앞뒤를 따른다 — 말 중간에 1.5초짜리 발언이 생기지 않게
  for (let k = 1; k + 1 < turns.length; k++) {
    const a = turns[k - 1], t = turns[k], b = turns[k + 1];
    if (labels[k - 1] === labels[k + 1] && labels[k] !== labels[k - 1] && a.r === t.r && t.r === b.r && a.f === t.f && t.f === b.f && t.w.length === 1) labels[k] = labels[k - 1];
  }
  clusters.forEach((c, ci) => { c.turns = labels.map((l, k) => (l === ci ? k : -1)).filter((k) => k >= 0); c.dur = c.turns.reduce((m, k) => m + turns[k].e - turns[k].s, 0); });
  const keep = clusters.map((c) => c.turns.length > 0), remap = [];
  let nk = 0;
  keep.forEach((ok, i) => { remap[i] = ok ? nk++ : -1; });
  if (nk < clusters.length) { for (let k = 0; k < labels.length; k++) labels[k] = remap[labels[k]]; clusters.splice(0, clusters.length, ...clusters.filter((_, i) => keep[i])); }
  const units = unitsOf(turns, labels, clusters, opt);
  const q = (v) => Array.from(v, (x) => Math.round(x * 1e4) / 1e4);
  return {
    turns: turns.map((t, k) => ({ f: t.f, s: t.s, e: t.e, n: t.w.length, c: labels[k], v: q(t.v) })),
    clusters: clusters.map((c, i) => ({
      id: "S" + (i + 1), label: "Speaker " + (i + 1), dur: Math.round(c.dur), nturn: c.turns.length,
      nunit: units.filter((u) => u.c === i).length, vec: q(c.vec), suggest: c.suggest, alt: c.alt, samples: samplesOf(units, i),
    })),
    units: units.map((u) => ({ f: u.f, s: u.s, e: u.e, c: u.c, sim: u.sim, margin: u.margin, n: u.nwin, v: q(u.v) })),
  };
}

/**
 * 검수 결과로 목소리 기준 만들기: 사람 이름 → { vec, n }
 * - 묶음 이름(names)과 발언별 수정(edits)을 반영해 발언마다 최종 이름을 정하고, 이름별로 발언 특징을 창 수 가중 평균
 * - 임시 이름(Speaker N)·혼재·이름 없는 것은 빼고, 말한 시간이 minSec 미만이면 저장하지 않는다
 */
export function printsFromReview(segs, units, nameOf, isGeneric, minSec = 30) {
  const acc = new Map();
  for (const g of segs) {
    const u = units[g.u];
    if (!u || !u.v) continue;
    const name = nameOf(g);
    if (!name || isGeneric(name) || g.kind === "혼재") continue;
    if (!acc.has(name)) acc.set(name, { sum: new Float64Array(u.v.length), n: 0, sec: 0 });
    const a = acc.get(name);
    for (let j = 0; j < u.v.length; j++) a.sum[j] += u.v[j] * u.n;
    a.n += u.n; a.sec += u.e - u.s;
  }
  const out = {};
  for (const [name, a] of acc) if (a.sec >= minSec) out[name] = { vec: Array.from(unit(a.sum), (x) => Math.round(x * 1e5) / 1e5), n: a.n, sec: Math.round(a.sec) };
  return out;
}

/** 파일 이름에서 녹음 시각 읽기(소니 ICD: 251009_1430.mp3, 251009_1430_01.mp3, 20251009_143000 …) */
export function recordedAt(name) {
  const m = String(name).match(/(?:^|[^\d])(\d{2}|\d{4})(\d{2})(\d{2})[_\- ]?(\d{2})(\d{2})(\d{2})?(?:[_\- ](\d{1,3}))?(?=[^\d]|$)/);
  if (!m) return null;
  const y = m[1].length === 2 ? 2000 + +m[1] : +m[1];
  const [mo, d, h, mi, s] = [+m[2], +m[3], +m[4], +m[5], +(m[6] || 0)];
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59 || s > 59) return null;
  return { at: `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}T${String(h).padStart(2, "0")}:${String(mi).padStart(2, "0")}:${String(s).padStart(2, "0")}`, seq: m[7] ? +m[7] : 0 };
}

/** 소니 파일 여러 개를 녹음 시각 순으로(시각을 못 읽으면 이름 순) */
export function orderFiles(list) {
  return [...list].map((x, i) => ({ x, i, r: recordedAt(x.name) || (x.recordedAt ? { at: x.recordedAt, seq: 0 } : null) })).sort((a, b) => {
    if (a.r && b.r) return a.r.at < b.r.at ? -1 : a.r.at > b.r.at ? 1 : a.r.seq - b.r.seq;
    if (a.r || b.r) return a.r ? -1 : 1;
    return a.x.name.localeCompare(b.x.name, "ko", { numeric: true });
  }).map((y) => ({ ...y.x, recordedAt: y.r ? y.r.at : null }));
}

/**
 * 파일 이름 → 작업 이름(새 작업에서 자동 기입). 확장자·밑줄을 걷고, 이름 속 날짜·시각은 「26년 9월 14일 오전 7시 51분」처럼 풀어 앞에 둔다.
 * 「음성」「녹음」「Recording」처럼 기기가 붙인 말만 남으면 뺀다. 파일이 여럿이면 「… 외 n개」.
 *   "통화 녹음 홍길동_260914_075100.m4a" → "26년 9월 14일 오전 7시 51분 · 통화 녹음 홍길동"
 *   "251009_1430.MP3" → "25년 10월 9일 오후 2시 30분"
 */
export function titleFromFiles(names) {
  const list = (names || []).filter(Boolean);
  if (!list.length) return "";
  let base = String(list[0]).replace(/\.[A-Za-z0-9]{1,5}$/, "");
  let when = null;
  const m1 = base.match(/(?:^|[^\d])((\d{2}|\d{4})(\d{2})(\d{2})[_\- ]?(\d{2})(\d{2})(\d{2})?(?:[_\- ]\d{1,3})?)(?=[^\d]|$)/);
  const m2 = base.match(/((\d{4})[-.](\d{1,2})[-.](\d{1,2})(?:[ _T]+(\d{1,2})[:.\-](\d{2})(?:[:.\-]\d{2})?)?)/);
  const r = m1 && recordedAt(m1[1]);
  if (r) { when = r.at; base = base.replace(m1[1], " "); }
  else if (m2 && +m2[3] >= 1 && +m2[3] <= 12 && +m2[4] >= 1 && +m2[4] <= 31) {
    const p = (x) => String(x).padStart(2, "0");
    when = `${m2[2]}-${p(m2[3])}-${p(m2[4])}` + (m2[5] != null && +m2[5] < 24 ? `T${p(m2[5])}:${m2[6]}:00` : "");
    base = base.replace(m2[1], " ");
  }
  let rest = base.replace(/[_]+/g, " ").replace(/\s*[-·]+\s*$/g, "").replace(/^\s*[-·]+\s*/g, "").replace(/\s+/g, " ").trim();
  if (/^(음성|녹음|새 녹음|음성 녹음|통화|recording|record|rec|voice|audio|memo|new recording)?\s*\d{0,3}$/i.test(rest)) rest = "";
  let date = "";
  if (when) {
    const [d, t] = when.split("T");
    const [y, mo, da] = d.split("-").map(Number);
    date = `${String(y).slice(2)}년 ${mo}월 ${da}일`;
    if (t) {
      const [h, mi] = t.split(":").map(Number);
      date += ` ${h < 12 ? "오전" : "오후"} ${h % 12 || 12}시${mi ? ` ${mi}분` : ""}`;
    }
  }
  let title = [date, rest].filter(Boolean).join(" · ") || String(list[0]).replace(/\.[^.]+$/, "");
  if (list.length > 1) title += ` 외 ${list.length - 1}개`;
  return title;
}

/**
 * 「이 묶음 둘로 나누기」(이름 대기 중에만): 두 사람이 쉼 없이 주고받아 한 묶음으로 잡힌 경우.
 * 그 묶음의 차례(창)만 평균 연결로 둘이 될 때까지 묶고 2-평균으로 다듬는다.
 * 말한 시간이 긴 쪽이 원래 번호(이름)를 이어받고, 짧은 쪽은 새 번호(S마지막+1)를 단다. 발언 단위·대표 구간은 다시 만든다.
 * known: { 이름: 단위벡터 } — 있으면 두 묶음의 이름 추천을 다시 계산한다.
 * 반환: 새 diar(입력은 그대로) 또는 null(나눌 수 없음 — 차례가 너무 적거나 한쪽이 비면)
 */
export function splitCluster(diar, ci, known = {}, opt = {}) {
  const o = { ...DEFAULTS, ...opt };
  const T = diar.turns;
  const ks = T.map((t, k) => (t.c === ci && !t.m ? k : -1)).filter((k) => k >= 0); // 사람이 정한 차례는 그대로
  if (ks.length < 4) return null;
  const V = ks.map((k) => unit(T[k].v)), W = ks.map((k) => T[k].n || 1);
  let lab = cutTree(ks.length, linkage(V, W), Infinity, 2);
  for (let it = 0; it < 20; it++) { // 2-평균(코사인)으로 다듬기 — 평균 연결이 튀는 창 하나만 떼어 내는 것을 막는다
    const cs = [0, 1].map((g) => { const idx = lab.map((l, i) => (l === g ? i : -1)).filter((i) => i >= 0); return idx.length ? meanOf(V, idx, W) : null; });
    if (!cs[0] || !cs[1]) return null;
    const nl = V.map((v) => (dot(v, cs[0]) >= dot(v, cs[1]) ? 0 : 1));
    if (nl.every((l, i) => l === lab[i])) break;
    lab = nl;
  }
  // (혼자 튄 창을 앞뒤에 맞추는 다듬기는 하지 않는다 — 쉼 없이 주고받는 대화에서는 1.5초 창 하나가 실제 한 사람의 말이다)
  const durOf = (g) => ks.reduce((m, k, i) => m + (lab[i] === g ? T[k].e - T[k].s : 0), 0);
  if (!durOf(0) || !durOf(1)) return null;
  const moved = durOf(0) >= durOf(1) ? 1 : 0; // 짧은 쪽이 새 묶음
  const nc = diar.clusters.length;
  const turns = T.map((t) => ({ ...t }));
  ks.forEach((k, i) => { if (lab[i] === moved) turns[k].c = nc; });
  const maxId = Math.max(0, ...diar.clusters.map((c) => +String(c.id).replace(/\D/g, "") || 0));
  const tt = turns.map((t) => ({ f: t.f, s: t.s, e: t.e, w: { length: t.n || 1 }, v: unit(t.v) }));
  const labels = turns.map((t) => t.c);
  const tv = tt.map((t) => t.v), tw = tt.map((t) => t.w.length);
  const cl = [...diar.clusters.map((c) => ({ ...c })), { id: "S" + (maxId + 1), label: "Speaker " + (maxId + 1), suggest: null, alt: null }];
  const q = (v) => Array.from(v, (x) => Math.round(x * 1e4) / 1e4);
  const vecs = cl.map((c, i) => {
    const idx = labels.map((l, k) => (l === i ? k : -1)).filter((k) => k >= 0);
    return idx.length ? meanOf(tv, idx, tw) : unit(c.vec);
  });
  const units = unitsOf(tt, labels, vecs.map((vec) => ({ vec })), o);
  const names = Object.keys(known);
  cl.forEach((c, i) => {
    c.nunit = units.filter((u) => u.c === i).length;
    c.samples = samplesOf(units, i);
    if (i !== ci && i !== nc) return;
    const idx = labels.map((l, k) => (l === i ? k : -1)).filter((k) => k >= 0);
    c.vec = q(vecs[i]);
    c.dur = Math.round(idx.reduce((m, k) => m + tt[k].e - tt[k].s, 0));
    c.nturn = idx.length;
    const sims = names.map((n) => [n, Math.round(dot(known[n], vecs[i]) * 100) / 100]).sort((a, b) => b[1] - a[1]);
    c.suggest = sims[0] && sims[0][1] >= o.weak ? { name: sims[0][0], sim: sims[0][1], strong: sims[0][1] >= o.suggest } : null;
    c.alt = sims.filter((s) => !c.suggest || s[0] !== c.suggest.name).slice(0, 1).map(([name, sim]) => ({ name, sim }))[0] || null;
  });
  return {
    ...diar,
    turns,
    clusters: cl,
    units: units.map((u) => ({ f: u.f, s: u.s, e: u.e, c: u.c, sim: u.sim, margin: u.margin, n: u.nwin, v: q(u.v) })),
    splits: [...(diar.splits || []), { from: diar.clusters[ci].id, to: "S" + (maxId + 1) }],
  };
}

/* ------------------------------------------------------------------ 구간 손보기(이름 대기 중)
 * 사람이 시작·끝을 정한 구간을 한 사람(기존 묶음 · 새 사람 · 빼기)으로 못 박는다.
 *  - 구간에 걸친 차례는 경계에서 잘라, 안쪽만 옮긴다(목소리 특징은 원래 창 것을 그대로 씀).
 *  - 사람이 정한 차례는 m: 1로 표시해 둘로 나누기·비슷한 곳 찾기가 다시 건드리지 않는다.
 *  - 기준 구간(ref: 1)은 그 사람 목소리 기준으로 쓴다(사람이 고친 구간을 기준에 더하면 화자 오류가 크게 준다 — arXiv 2509.18377).
 *  - 빼기는 c: -1(발언 단위에서 빠져 전사하지 않음).
 */
const relabelDiar = (diar, turns, extraCl, touched, known, o) => {
  const tt = turns.map((t) => ({ f: t.f, s: t.s, e: t.e, w: { length: t.n || 1 }, v: unit(t.v) }));
  const labels = turns.map((t) => (t.c == null ? -1 : t.c));
  const tv = tt.map((t) => t.v), tw = tt.map((t) => t.w.length);
  const cl = [...diar.clusters.map((c) => ({ ...c })), ...extraCl];
  const q = (v) => Array.from(v, (x) => Math.round(x * 1e4) / 1e4);
  const vecs = cl.map((c, i) => {
    const idx = labels.map((l, k) => (l === i ? k : -1)).filter((k) => k >= 0);
    return idx.length ? meanOf(tv, idx, tw) : unit(c.vec);
  });
  const units = unitsOf(tt, labels, vecs.map((vec) => ({ vec })), o);
  const names = Object.keys(known || {});
  cl.forEach((c, i) => {
    c.nunit = units.filter((u) => u.c === i).length;
    c.samples = samplesOf(units, i);
    if (!touched.has(i)) return;
    const idx = labels.map((l, k) => (l === i ? k : -1)).filter((k) => k >= 0);
    c.vec = q(vecs[i]);
    c.dur = Math.round(idx.reduce((m, k) => m + tt[k].e - tt[k].s, 0));
    c.nturn = idx.length;
    const sims = names.map((n) => [n, Math.round(dot(known[n], vecs[i]) * 100) / 100]).sort((a, b) => b[1] - a[1]);
    c.suggest = sims[0] && sims[0][1] >= o.weak ? { name: sims[0][0], sim: sims[0][1], strong: sims[0][1] >= o.suggest } : null;
    c.alt = sims.filter((s) => !c.suggest || s[0] !== c.suggest.name).slice(0, 1).map(([name, sim]) => ({ name, sim }))[0] || null;
  });
  return { ...diar, turns, clusters: cl, units: units.map((u) => ({ f: u.f, s: u.s, e: u.e, c: u.c, sim: u.sim, margin: u.margin, n: u.nwin, v: q(u.v) })) };
};

/**
 * 구간 [s, e](파일 f)를 target으로: 묶음 번호 · "new"(새 사람) · "drop"(빼기).
 * opt.ref: 이 구간을 그 사람 목소리 기준으로 표시(기본 true). 반환: { diar, to(묶음 번호 또는 -1), from(구간을 가장 많이 갖고 있던 묶음) } 또는 null
 */
export function relabelRange(diar, f, s, e, target, known = {}, opt = {}) {
  const o = { ...DEFAULTS, ...opt };
  if (!(e - s >= 0.2)) return null;
  const nc = diar.clusters.length;
  const to = target === "new" ? nc : target === "drop" ? -1 : +target;
  const extra = [];
  if (target === "new") {
    const maxId = Math.max(0, ...diar.clusters.map((c) => +String(c.id).replace(/\D/g, "") || 0));
    extra.push({ id: "S" + (maxId + 1), label: "Speaker " + (maxId + 1), suggest: null, alt: null, vec: diar.clusters[0] ? diar.clusters[0].vec : [] });
  }
  const turns = [];
  const had = {};
  let hit = 0;
  for (const t of diar.turns) {
    if ((t.f || 0) !== f || t.e <= s || t.s >= e) { turns.push({ ...t }); continue; }
    const a = Math.max(s, t.s), b = Math.min(e, t.e);
    had[t.c] = (had[t.c] || 0) + (b - a);
    if (t.s < a - 0.05) turns.push({ ...t, e: r2(a) }); // 앞 자투리는 그대로
    turns.push({ ...t, s: r2(a), e: r2(b), c: to, m: 1, ...(opt.ref === false || to < 0 ? {} : { ref: 1 }) });
    if (t.e > b + 0.05) turns.push({ ...t, s: r2(b) }); // 뒤 자투리
    hit++;
  }
  if (!hit) return null;
  const from = +Object.entries(had).sort((x, y) => y[1] - x[1])[0][0];
  const touched = new Set([to, ...Object.keys(had).map(Number)].filter((x) => x >= 0));
  const nd = relabelDiar(diar, turns, extra, touched, known, o);
  nd.manual = [...(diar.manual || []), { f, s: r2(s), e: r2(e), to: to < 0 ? null : nd.clusters[to].id }];
  return { diar: nd, to, from };
}

/**
 * 비슷한 곳 찾기: 묶음 from 안에서(사람이 정하지 않은 차례만) 묶음 to의 기준 구간 목소리에 더 가까운 곳.
 * 기준 = to의 기준 구간(ref) 차례 평균(없으면 to 전체 평균). from 자신의 평균보다 기준에 더 닮고 minSim 이상인 차례를
 * 이어지는 것끼리 한 곳으로 묶어 닮은 순으로 돌려준다: [{ f, s, e, sim }]
 */
export function similarRegions(diar, from, to, { minSim = 0.45, max = 12, gap = 0.5, minDur = 0.8 } = {}) {
  const T = diar.turns;
  const refIdx = T.map((t, k) => (t.c === to && t.ref ? k : -1)).filter((k) => k >= 0);
  const toIdx = refIdx.length ? refIdx : T.map((t, k) => (t.c === to ? k : -1)).filter((k) => k >= 0);
  const fromIdx = T.map((t, k) => (t.c === from ? k : -1)).filter((k) => k >= 0);
  if (!toIdx.length || !fromIdx.length) return [];
  const V = T.map((t) => unit(t.v)), W = T.map((t) => t.n || 1);
  const ref = meanOf(V, toIdx, W), own = meanOf(V, fromIdx, W);
  const cand = fromIdx.filter((k) => !T[k].m).map((k) => ({ k, sim: dot(V[k], ref), self: dot(V[k], own) })).filter((x) => x.sim >= minSim && x.sim > x.self);
  cand.sort((a, b) => (T[a.k].f || 0) - (T[b.k].f || 0) || T[a.k].s - T[b.k].s);
  const out = [];
  for (const x of cand) {
    const t = T[x.k], last = out[out.length - 1];
    if (last && last.f === (t.f || 0) && t.s - last.e <= gap) { last.e = Math.max(last.e, t.e); last.sims.push(x.sim); }
    else out.push({ f: t.f || 0, s: t.s, e: t.e, sims: [x.sim] });
  }
  return out.filter((r) => r.e - r.s >= minDur).map((r) => ({ f: r.f, s: r.s, e: r.e, sim: Math.round((r.sims.reduce((m, v) => m + v, 0) / r.sims.length) * 100) / 100 }))
    .sort((a, b) => b.sim - a.sim).slice(0, max);
}

/**
 * 섞였을 수 있는 곳: 묶음 안에서 (1) 다른 묶음 평균에 더 가까운 차례, 또는 (2) 제 묶음과 유난히 덜 닮은 차례
 * (제 묶음 안 닮음 분포의 평균 − 2×표준편차 밑, 묶음이 하나뿐인 녹음에서도 잡히게)가 이어진 곳. 사람이 정한 차례는 뺀다.
 * 반환: [{ c, f, s, e, ctxS, ctxE, other(가까운 다른 묶음 번호 또는 -1) }] 긴 순으로 max개
 */
export function mixSuspects(diar, { max = 5, gap = 0.5, minDur = 1.4, ctx = 6 } = {}) {
  const T = diar.turns, V = T.map((t) => unit(t.v)), W = T.map((t) => t.n || 1);
  const cs = diar.clusters.map((c, i) => { const idx = T.map((t, k) => (t.c === i ? k : -1)).filter((k) => k >= 0); return idx.length ? meanOf(V, idx, W) : null; });
  const flag = new Array(T.length).fill(null);
  diar.clusters.forEach((c, i) => {
    const idx = T.map((t, k) => (t.c === i && !t.m ? k : -1)).filter((k) => k >= 0);
    if (idx.length < 6 || !cs[i]) return;
    const own = idx.map((k) => dot(V[k], cs[i]));
    const mu = own.reduce((m, v) => m + v, 0) / own.length, sd = Math.sqrt(own.reduce((m, v) => m + (v - mu) ** 2, 0) / own.length);
    idx.forEach((k, j) => {
      let best = -1, bo = -1;
      cs.forEach((v, o) => { if (o !== i && v) { const d = dot(V[k], v); if (d > best) { best = d; bo = o; } } });
      if (best > own[j] + 0.02) flag[k] = bo;
      else if (own[j] < mu - 2 * sd && own[j] < 0.5) flag[k] = -1;
    });
  });
  const order = T.map((t, k) => k).sort((a, b) => (T[a].f || 0) - (T[b].f || 0) || T[a].s - T[b].s);
  const out = [];
  let cur = null;
  for (const k of order) {
    const t = T[k];
    if (flag[k] === null) continue;
    if (cur && cur.c === t.c && cur.f === (t.f || 0) && t.s - cur.e <= gap) { cur.e = Math.max(cur.e, t.e); if (flag[k] >= 0) cur.other = flag[k]; continue; }
    cur = { c: t.c, f: t.f || 0, s: t.s, e: t.e, other: flag[k] };
    out.push(cur);
  }
  const fileEnd = (f) => Math.max(...T.filter((t) => (t.f || 0) === f).map((t) => t.e));
  return out.filter((r) => r.e - r.s >= minDur).sort((a, b) => (b.e - b.s) - (a.e - a.s)).slice(0, max)
    .map((r) => ({ ...r, s: r2(r.s), e: r2(r.e), ctxS: r2(Math.max(0, r.s - ctx)), ctxE: r2(Math.min(fileEnd(r.f), r.e + ctx)) }))
    .sort((a, b) => a.f - b.f || a.s - b.s);
}
