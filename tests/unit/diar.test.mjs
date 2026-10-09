import { test } from "node:test";
import assert from "node:assert/strict";
import {
  speechRegions, packRegions, windowsOf, turnsOf, linkage, cutTree, clusterTurns, unitsOf, diarize,
  printsFromReview, recordedAt, orderFiles, agcGains, FRAME,
} from "../../web/src/diar.js";
import { runJob } from "../../web/src/engine.js";
import { mergedLines, speakerOf } from "../../web/src/export.js";

// 합성 목소리 특징: 사람마다 정해진 방향 + 작은 흔들림
function voice(k, d = 16) { const v = new Float32Array(d); v[k % d] = 1; return v; }
function noisy(v, seed, amt = 0.15) {
  let x = Math.sin(seed * 12.9898) * 43758.5453;
  const out = Float32Array.from(v, () => { x = Math.sin(x) * 43758.5453; return 0; });
  for (let i = 0; i < v.length; i++) { x = Math.sin(x + i) * 43758.5453; out[i] = v[i] + amt * ((x - Math.floor(x)) - 0.5); }
  let n = 0; for (const y of out) n += y * y; n = Math.sqrt(n);
  return out.map((y) => y / n);
}

test("말소리 구간: 켜짐 0.5·꺼짐 0.35, 짧은 쉼은 잇고 0.5초 이상 쉬면 끊는다", () => {
  const p = new Float32Array(400).fill(0.02);
  const on = (a, b, v = 0.9) => { for (let i = Math.round(a / FRAME); i < Math.round(b / FRAME); i++) p[i] = v; };
  on(1, 3); on(3.2, 4); // 0.2초 쉼 → 이어짐
  on(5, 6); on(6, 6.4, 0.4); // 꺼짐 기준(0.35) 위라 이어짐
  on(10, 10.1); // 0.1초 → 버림
  const r = speechRegions(p, 100);
  assert.equal(r.length, 2);
  assert.ok(Math.abs(r[0][0] - 100.88) < 0.05 && Math.abs(r[0][1] - 104.12) < 0.05, JSON.stringify(r));
  assert.ok(Math.abs(r[1][1] - 106.52) < 0.05, JSON.stringify(r));
});

test("음량 맞추기: 작은 소리는 키우고(최대 +30dB) 큰 소리는 줄인다", () => {
  const x = new Float32Array(16000 * 6);
  for (let i = 0; i < x.length; i++) x[i] = (i < 48000 ? 0.002 : 0.5) * Math.sin(i / 7);
  const g = agcGains(x);
  assert.ok(g[10] > 20 && g[g.length - 10] < 0.2, `${g[10]} ${g[g.length - 10]}`);
});

test("전사 단위: 가까운 구간은 25초 안에서 합치고 긴 구간은 고르게 나눈다", () => {
  assert.deepEqual(packRegions([[0, 5], [5.5, 10], [20, 22]]), [[0, 10], [20, 22]]);
  const long = packRegions([[0, 60]]);
  assert.equal(long.length, 3);
  assert.ok(long.every(([s, e]) => e - s <= 25));
});

test("창: 3초·1.5초 간격, 마지막 창은 구간 끝에 맞추고 1초 미만 구간은 뺀다", () => {
  const w = windowsOf([[0, 7], [10, 10.5], [20, 22]]);
  assert.deepEqual(w.map((x) => [x.r, x.s, x.e]), [[0, 0, 3], [0, 1.5, 4.5], [0, 3, 6], [0, 4, 7], [2, 20, 22]]);
});

test("창 묶기: 말 중간에 혼자 튄 창 하나는 앞뒤 묶음을 따른다", () => {
  const plan = [];
  for (let i = 0; i < 6; i++) plan.push([0, 20], [1, 20]);
  const { wins, vecs } = scene(plan);
  vecs[5] = noisy(voice(1), 999, 0.1); // 0번 사람 말 중간에 1번 목소리 창 하나
  const d = diarize(wins, vecs);
  assert.equal(d.units.filter((u) => u.f === 0 && u.s < 20).length, 1);
});

test("차례: 같은 구간에서 목소리가 바뀌면 끊고, 한 창만 튀면 잇는다", () => {
  const wins = Array.from({ length: 8 }, (_, i) => ({ r: 0, s: i * 1.5, e: i * 1.5 + 3 }));
  const vecs = [0, 0, 0, 1, 0, 0, 2, 2].map((k, i) => noisy(voice(k), i, 0.05));
  const t = turnsOf(wins, vecs, 0.35);
  assert.deepEqual(t.map((x) => x.w), [[0, 1, 2, 3, 4, 5], [6, 7]]);
  assert.equal(t[0].e, t[1].s); // 겹친 곳 가운데에서 나눔
});

test("평균 연결 묶기: 무차별 계산과 같은 계층", () => {
  const vecs = Array.from({ length: 30 }, (_, i) => noisy(voice(i % 4), i, 0.9));
  const w = vecs.map((_, i) => 1 + (i % 3));
  const merges = linkage(vecs, w);
  assert.equal(merges.length, 29);
  // 무차별: 가장 닮은 두 묶음(가중 평균 유사도)을 차례로 합침
  let cl = vecs.map((_, i) => [i]);
  const sim = (a, b) => { let s = 0, n = 0; for (const i of a) for (const j of b) { let d = 0; for (let k = 0; k < 16; k++) d += vecs[i][k] * vecs[j][k]; s += d * w[i] * w[j]; n += w[i] * w[j]; } return s / n; };
  const brute = [];
  while (cl.length > 1) {
    let best = null;
    for (let i = 0; i < cl.length; i++) for (let j = i + 1; j < cl.length; j++) { const s = sim(cl[i], cl[j]); if (!best || s > best[2]) best = [i, j, s]; }
    brute.push(best[2]);
    cl = cl.filter((_, k) => k !== best[0] && k !== best[1]).concat([[...cl[best[0]], ...cl[best[1]]]]);
  }
  const mine = merges.map((m) => m[2]).sort((a, b) => b - a);
  brute.sort((a, b) => b - a);
  mine.forEach((s, i) => assert.ok(Math.abs(s - brute[i]) < 1e-4, `${i}: ${s} vs ${brute[i]}`));
  for (const cut of [0.2, 0.5, 0.8]) assert.equal(new Set(cutTree(30, merges, cut)).size, 30 - brute.filter((s) => s >= cut).length);
  assert.equal(new Set(cutTree(30, merges, 0.5, 2)).size, 2);
});

function scene(people) { // people: [[사람, 초], ...] 차례대로 말함
  const wins = [], vecs = [];
  let t = 0, r = 0, seed = 1;
  for (const [k, sec] of people) {
    for (let a = t; a + 3 <= t + sec + 1e-9; a += 1.5) { wins.push({ r, s: a, e: a + 3 }); vecs.push(noisy(voice(k), seed++, 0.4)); }
    t += sec + 1; r++;
  }
  return { wins, vecs };
}

test("묶기: 인원 수 없이도 말이 적은 사람을 따로 잡고, 아주 짧은 묶음은 흡수한다", () => {
  const plan = [];
  for (let i = 0; i < 20; i++) plan.push([0, 30], [1, 12]);
  plan.push([2, 6], [0, 30], [2, 9], [0, 30], [2, 6]); // 2번 사람: 21초뿐
  plan.push([3, 4.5]); // 3번: 4.5초(창 2개) → 흡수
  const { wins, vecs } = scene(plan);
  const d = diarize(wins, vecs);
  assert.equal(d.clusters.length, 3, d.clusters.map((c) => c.dur).join(","));
  assert.equal(d.clusters[0].label, "Speaker 1");
  assert.ok(d.clusters.some((c) => c.dur > 15 && c.dur < 30), "말이 적은 사람 묶음");
  assert.ok(d.units.every((u) => u.e - u.s <= 25.01));
  assert.ok(d.clusters.every((c) => c.samples.length > 0 && c.samples.every((x) => x.e - x.s >= 2.5)));
  // 인원 상한: 2로 걸면 묶음 2개
  assert.equal(diarize(wins, vecs, {}, { cap: 2 }).clusters.length, 2);
  // 창이 아주 많으면 차례 평균으로 묶는다(같은 결과여야 함)
  const big = diarize(wins, vecs, {}, { maxWin: 10 });
  assert.equal(big.clusters.length, 3);
  assert.ok(big.units.length < d.units.length + 5);
});

test("이름 추천: 저장된 기준과 0.6 이상 닮으면 추천, 0.45~0.6은 「닮음」만", () => {
  const { wins, vecs } = scene([[0, 30], [1, 30], [0, 30], [1, 30]]);
  const half = Float32Array.from(voice(1), (x, i) => x + (i === 5 ? 1.1 : 0)); // voice(1)과 0.67쯤
  let n = 0; for (const x of half) n += x * x; n = Math.sqrt(n);
  const known = { 갑: voice(0), 을: half.map((x) => x / n), 병: voice(9) };
  const d = diarize(wins, vecs, known);
  assert.equal(d.clusters[0].suggest.name, "갑");
  assert.equal(d.clusters[0].suggest.strong, true);
  assert.equal(d.clusters[1].suggest.name, "을");
  const weak = clusterTurns(turnsOf(wins, vecs), known, { suggest: 0.95 }).clusters[1].suggest;
  assert.equal(weak.strong, false);
});

test("목소리 기준: 묶음 이름·발언별 수정 반영, 임시 이름·30초 미만은 빼기", () => {
  const units = [{ v: [1, 0], n: 10, s: 0, e: 20 }, { v: [1, 0], n: 10, s: 20, e: 40 }, { v: [0, 1], n: 5, s: 40, e: 50 }, { v: [0, 1], n: 20, s: 50, e: 90 }];
  const segs = [{ i: 1, u: 0, cluster: "S1" }, { i: 2, u: 1, cluster: "S1" }, { i: 3, u: 2, cluster: "S1" }, { i: 4, u: 3, cluster: "S2", speaker: "Speaker 2" }];
  const edits = { e: { 3: { speaker: "을" } }, names: { S1: "갑" } };
  const p = printsFromReview(segs, units, (g) => speakerOf(g, edits), (n) => /^Speaker/.test(n));
  assert.deepEqual(Object.keys(p), ["갑"]); // 을은 10초뿐, Speaker 2는 임시 이름
  assert.equal(p.갑.n, 20);
  assert.equal(p.갑.vec[0], 1);
});

test("소니 파일 이름의 녹음 시각으로 정렬", () => {
  assert.deepEqual(recordedAt("251009_1430.mp3"), { at: "2025-10-09T14:30:00", seq: 0 });
  assert.deepEqual(recordedAt("251009_1430_02.mp3"), { at: "2025-10-09T14:30:00", seq: 2 });
  assert.equal(recordedAt("20251009_093015.wav").at, "2025-10-09T09:30:15");
  assert.equal(recordedAt("회의.mp3"), null);
  const o = orderFiles([{ name: "251009_1500.mp3" }, { name: "메모.mp3" }, { name: "251009_1430_02.mp3" }, { name: "251009_1430.mp3" }]);
  assert.deepEqual(o.map((x) => x.name), ["251009_1430.mp3", "251009_1430_02.mp3", "251009_1500.mp3", "메모.mp3"]);
  assert.equal(o[0].recordedAt, "2025-10-09T14:30:00");
});

// ---- 작업 흐름: 화자 먼저 → 이름 대기 → 전사(이어하기·묶음 빼기)
const SR = 16000;
function sonyCtx(sec) {
  // 6초 주기: 4초 말 + 2초 쉼. 앞 4초 말은 「갑」(0~), 짝수 번째 주기는 갑, 홀수는 을
  const x = new Float32Array(sec * SR);
  for (let s = 0; s < sec; s += 6) for (let i = s * SR; i < (s + 4) * SR && i < x.length; i++) x[i] = 0.3 * Math.sin(i / 5);
  const store = { chunks: null, partial: {} };
  return {
    store,
    readAudio: async (fi, s, e) => { const a = x.subarray(Math.floor(s * SR), Math.floor(e * SR)); a.t0 = s; return a; },
    vadProbs: async (a) => { const n = Math.floor(a.length / 512), p = new Float32Array(n); for (let i = 0; i < n; i++) p[i] = Math.abs(a[i * 512 + 100]) > 0.001 || Math.abs(a[i * 512 + 300]) > 0.001 ? 0.9 : 0; return p; },
    transcribe: async (a) => `말 ${a.t0.toFixed(1)}`,
    embed: async (a) => noisy(voice(Math.floor((a.t0 + 0.5) / 6) % 2), Math.round(a.t0 * 10), 0.1),
    vpStore: {}, loadEnroll: async () => null, saveEnroll: async () => {},
    loadChunks: async () => store.chunks, saveChunks: async (c) => { store.chunks = c; },
    loadPartial: async () => ({ ...store.partial }), savePartial: async (r) => { store.partial[r.k] = r; },
    clearPartial: async () => { store.partial = {}; },
    progress: () => {}, shouldStop: () => false,
  };
}

test("소니 녹음: 화자 먼저 묶고 이름 대기 → 전사, 뺀 묶음은 전사하지 않는다", async () => {
  const ctx = sonyCtx(120);
  const files = [{ name: "251009_1430.mp3", dur: 120 }];
  const job = { mode: "sony", stage: "diar" };
  const r1 = await runJob(job, files, ctx);
  assert.equal(r1.awaiting, true);
  assert.equal(r1.diar.clusters.length, 2);
  assert.ok(r1.diar.units.every((u) => u.e - u.s <= 4.5));
  assert.deepEqual(ctx.store.partial, {}); // 특징 임시 저장은 비움
  let calls = 0;
  const t = ctx.transcribe; ctx.transcribe = async (a) => { calls++; return t(a); };
  const r2 = await runJob({ ...job, stage: "transcribe", skip: ["S2"] }, files, ctx);
  assert.ok(r2.result.segs.length > 0 && r2.result.segs.every((g) => g.cluster === "S1"));
  assert.equal(r2.result.stats.skipped, r1.diar.units.filter((u) => u.c === 1).length);
  assert.ok(!("vec" in r2.result.clusters[0])); // 특징 벡터는 결과에 넣지 않음
  const n1 = calls;
  // 뺐던 묶음을 다시 넣으면 그 발언만 더 전사하고, 발언 번호는 그대로
  const r3 = await runJob({ ...job, stage: "transcribe", skip: [] }, files, ctx);
  assert.equal(calls - n1, r1.diar.units.length - n1);
  const before = Object.fromEntries(r2.result.segs.map((g) => [g.i, g.start]));
  for (const g of r3.result.segs) if (before[g.i] != null) assert.equal(before[g.i], g.start);
  // 통합본: 묶음 이름 > 처리 결과, 발언별 수정이 먼저
  const g0 = r3.result.segs.find((g) => g.cluster === "S2");
  const lines = mergedLines({ job: { mode: "sony", audioFiles: files }, result: r3.result, edits: { e: { [g0.i]: { speaker: "병" } }, names: { S1: "갑", S2: "을" } }, plaud: [], glossary: [] });
  assert.equal(lines.find((l) => l.t === g0.start).spk, "병");
  assert.ok(lines.some((l) => l.spk === "갑") && lines.some((l) => l.spk === "을"));
});

test("소니 녹음: 특징 계산 중 멈추면 100개 단위로 이어서 한다", async () => {
  const ctx = sonyCtx(1200);
  let n = 0, stop = true;
  const emb = ctx.embed; ctx.embed = async (a) => { n++; return emb(a); };
  ctx.shouldStop = () => stop && n >= 150;
  const r = await runJob({ mode: "sony", stage: "diar" }, [{ name: "a.wav", dur: 1200 }], ctx);
  assert.equal(r.result, null);
  assert.equal(Object.keys(ctx.store.partial).length, 2); // e0, e1
  stop = false;
  const before = n;
  const r2 = await runJob({ mode: "sony", stage: "diar" }, [{ name: "a.wav", dur: 1200 }], ctx);
  assert.equal(r2.awaiting, true);
  assert.equal(n - before, r2.diar.nwin - 200);
});
