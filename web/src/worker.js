// 처리 일꾼(Web Worker): 모델을 받아 두고, 대기 중인 작업을 하나씩 처리한다.
// 화면과는 postMessage로만 이야기하고, 결과는 IndexedDB에 바로 쓴다.
import * as S from "./store.js";
import { runJob, isGeneric } from "./engine.js";
import { isDiar } from "./export.js";

const FAKE = new URL(self.location.href).searchParams.get("fake") === "1";
const post = (m) => self.postMessage(m);
let ort = null, whisper = null, camp = null, vad = null, busy = false, stopId = null, manifest = null;

/* ------------------------------------------------------------------ 모델 */
// 모델 파일마다 내용 해시로 캐시를 따로 둔다(pb-m-<sha>). 모델 하나를 더하거나 바꿔도 나머지는 다시 받지 않는다.
// 예전 방식(pb-models-<판>, 전체 한 캐시)에 있던 조각은 해시를 확인한 뒤 옮겨 쓴다.
const LEGACY = "pb-models-";
const cacheName = (info) => "pb-m-" + info.sha256.slice(0, 16);
const partUrl = (part) => new URL("../models/" + part, self.location.href).href;

async function getManifest() {
  if (!manifest) manifest = await (await fetch("../models/manifest.json", { cache: "no-store" })).json();
  return manifest;
}

async function findPart(info, url) {
  const r = await (await caches.open(cacheName(info))).match(url);
  if (r) return { r, legacy: false };
  for (const k of await caches.keys()) {
    if (!k.startsWith(LEGACY)) continue;
    const q = await (await caches.open(k)).match(url);
    if (q) return { r: q, legacy: true };
  }
  return null;
}

const hex = (buf) => [...new Uint8Array(buf)].map((x) => x.toString(16).padStart(2, "0")).join("");

/** 모델 파일(조각)을 받아 캐시에 두고 합친 바이트를 돌려준다 */
async function loadFile(info, onBytes, fromNet = false) {
  const cache = await caches.open(cacheName(info));
  const out = new Uint8Array(info.size);
  let o = 0, legacy = false;
  for (const part of info.parts) {
    const url = partUrl(part);
    const hit = fromNet ? null : await findPart(info, url);
    let b;
    if (hit) {
      b = new Uint8Array(await hit.r.arrayBuffer());
      if (hit.legacy) { legacy = true; await cache.put(url, new Response(b)); }
    } else {
      const net = await fetch(url, { cache: "no-store" });
      if (!net.ok) throw new Error(`모델 받기 실패: ${part} (${net.status})`);
      await cache.put(url, net.clone());
      b = new Uint8Array(await net.arrayBuffer());
    }
    if (o + b.length > info.size) break;
    out.set(b, o);
    o += b.length;
    onBytes(b.length);
  }
  const bad = o !== info.size || (legacy && hex(await crypto.subtle.digest("SHA-256", out)) !== info.sha256);
  if (bad) {
    if (fromNet || !legacy) throw new Error(`모델 크기가 맞지 않습니다: ${info.name}`);
    await caches.delete(cacheName(info));
    return loadFile(info, onBytes, true); // 예전 캐시 내용이 달랐다 → 새로 받는다
  }
  return out;
}

export async function modelStatus() {
  if (FAKE) return { ready: true, cachedBytes: 0, totalBytes: 0 };
  const m = await getManifest();
  let cached = 0, total = 0;
  for (const f of Object.values(m.files)) {
    for (let i = 0; i < f.parts.length; i++) {
      total += f.partSizes[i];
      if (await findPart(f, partUrl(f.parts[i]))) cached += f.partSizes[i];
    }
  }
  return { ready: cached === total, cachedBytes: cached, totalBytes: total, version: m.version };
}

/** 모든 모델을 새 캐시로 옮긴 뒤 예전 캐시와 이제 안 쓰는 모델 캐시를 지운다 */
async function cleanupOldCaches() {
  const keep = new Set(Object.values(manifest.files).map(cacheName));
  for (const k of await caches.keys()) if (k.startsWith(LEGACY) || (k.startsWith("pb-m-") && !keep.has(k))) await caches.delete(k);
}

/**
 * 모델 불러오기. need = "diar"(화자 묶기 단계: Silero·CAM++ 약 30MB만) | "all"(전사까지: Whisper 포함).
 * 휴대폰에서 「이름 대기」까지는 Whisper(약 0.8GB)를 메모리에 올리지 않아 빨리 시작하고 가볍게 돈다.
 */
async function ensureModels(need = "all") {
  if (FAKE) {
    whisper = whisper || {
      transcribe: async (a) => `가짜 전사 ${(a.length / 16000).toFixed(1)}초`,
      // 묶은 창: 0.3초 넘게 조용한 곳으로 나눠 구간마다 글 하나
      transcribeTs: async (a) => {
        const segs = [], F = 160; let s0 = -1, quiet = 0;
        for (let i = 0; i + F <= a.length; i += F) {
          let e = 0; for (let k = i; k < i + F; k++) e += a[k] * a[k];
          const loud = Math.sqrt(e / F) > 0.01;
          if (loud) { if (s0 < 0) s0 = i; quiet = 0; } else if (s0 >= 0 && ++quiet > 30) { segs.push([s0, i]); s0 = -1; }
        }
        if (s0 >= 0) segs.push([s0, a.length]);
        return segs.map(([x, y]) => ({ s: x / 16000, e: y / 16000, text: `가짜 전사 ${((y - x) / 16000).toFixed(1)}초` }));
      },
    };
    camp = camp || { embed: async (a) => fakeEmbed(a) };
    vad = vad || { probs: async (x) => { const n = Math.floor(x.length / 512), p = new Float32Array(n); for (let i = 0; i < n; i++) { let s = 0; for (let k = i * 512; k < (i + 1) * 512; k++) s += x[k] * x[k]; p[i] = Math.sqrt(s / 512) > 0.01 ? 0.9 : 0.02; } return p; } };
    return;
  }
  const m = await getManifest();
  const haveDiar = camp && (vad || !m.files.vad);
  if (haveDiar && (need === "diar" || whisper)) return;
  if (!ort) {
    ort = await import("../vendor/ort/ort.wasm.min.mjs");
    const set = (await S.get("kv", "settings")) || {};
    const hc = self.navigator.hardwareConcurrency || 4;
    ort.env.wasm.numThreads = set.threads || Math.min(16, hc > 2 ? hc - 1 : hc); // 화면용으로 하나 남긴다(2코어 이하는 전부)
  }
  const st = await modelStatus();

  let got = 0; // 이번에 읽는 양만 센다(이미 캐시에 있는 조각도 읽으면서 센다)
  const toLoad = [...(haveDiar ? [] : [m.files.vad, m.files.campplus]), ...(need === "all" && !whisper ? [m.files.tokens, m.files.decoder, m.files.encoder] : [])].filter(Boolean);
  const want = toLoad.reduce((x, f) => x + f.size, 0) || st.totalBytes;
  const tick = (n) => { got += n; post({ type: "models", phase: "download", got, total: want }); };
  const { Whisper, CamPlus, SileroVad } = await import("./models.js");
  if (!haveDiar) {
    const vadBytes = m.files.vad ? await loadFile(m.files.vad, tick) : null;
    const campBytes = await loadFile(m.files.campplus, tick);
    post({ type: "models", phase: "load" });
    if (vadBytes) vad = await SileroVad.create(ort, vadBytes);
    camp = await CamPlus.create(ort, campBytes);
  }
  if (need === "all" && !whisper) {
    const tokens = new TextDecoder().decode(await loadFile(m.files.tokens, tick));
    const decBytes = await loadFile(m.files.decoder, tick);
    let encBytes = await loadFile(m.files.encoder, tick);
    await cleanupOldCaches();
    post({ type: "models", phase: "load" });
    whisper = await Whisper.create(ort, encBytes, decBytes, tokens);
    encBytes = null; // 세션을 만든 뒤에는 원본 바이트를 놓아 메모리를 돌려준다
  }
  post({ type: "models", phase: "ready", threads: ort.env.wasm.numThreads, partial: !whisper });
}

/* ------------------------------------------------------------------ 작업 */
async function nextJob() {
  const jobs = (await S.all("jobs")).map(([id, j]) => ({ ...j, id })).filter((j) => j.status === "대기");
  jobs.sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
  return jobs[0];
}

async function processJob(job) {
  const id = job.id;
  await S.saveJob(id, { status: "처리중", error: null, startedAt: S.now(), progress: { pct: 1, msg: "모델 준비" } });
  post({ type: "job", id });
  await ensureModels(isDiar(job.mode) && job.stage !== "transcribe" ? "diar" : "all");
  let last = 0;
  const progress = async (pct, msg) => {
    if (Date.now() - last < 1500 && pct < 99) return;
    last = Date.now();
    await S.saveJob(id, { progress: { pct, msg } });
    post({ type: "job", id, pct, msg });
  };
  const vpStore = Object.fromEntries(await S.all("voiceprints"));
  const ctx = {
    readAudio: (fi, s, e) => S.readAudio(id, fi, s, e),
    transcribe: (a) => whisper.transcribe(a),
    transcribeTs: whisper && whisper.transcribeTs ? (a) => whisper.transcribeTs(a) : undefined,
    embed: (a) => camp.embed(a),
    vadProbs: vad ? (x) => vad.probs(x) : undefined,
    clearPartial: () => S.del("partials", id),
    plaud: (await S.get("plaud", id)) || [],
    vpStore,
    loadEnroll: () => S.get("enroll", id),
    saveEnroll: (v) => S.put("enroll", id, v),
    loadChunks: () => S.get("chunks", id),
    saveChunks: (c) => S.put("chunks", id, c),
    loadPartial: async () => (await S.get("partials", id)) || {},
    savePartial: (rec) => S.update("partials", id, (p) => ({ ...(p || {}), [rec.k]: rec })),
    progress,
    shouldStop: () => stopId === id,
  };
  const { result, fresh, awaiting, diar } = await runJob(job, job.audioFiles, ctx);
  if (awaiting) {
    await S.saveJob(id, { status: "이름 대기", stats: { clusters: diar.clusters.length, units: diar.units.length }, progress: { pct: 100, msg: "화자 이름을 붙인 뒤 전사를 시작하세요" } });
    post({ type: "job", id, naming: true });
    return;
  }
  if (!result) {
    const j = await S.get("jobs", id);
    await S.saveJob(id, { status: "중지", progress: { pct: j.progress?.pct || 0, msg: "중지됨 — 다시 시작하면 이어서 합니다" } });
    post({ type: "job", id });
    return;
  }
  result.updatedAt = S.now();
  await S.put("results", id, result);
  const source = job.title || id;
  // 소니 녹음은 사람이 이름을 확인한 뒤 검수 화면의 「목소리 기준 저장」으로만 저장한다(확인 안 된 이름이 기준을 흐리지 않게)
  for (const [name, d] of Object.entries(fresh || {})) {
    if (isGeneric(name)) continue; // 「Speaker 1」 같은 임시 이름은 저장하지 않는다
    await S.update("voiceprints", name, (ent) => {
      const e = ent || { name, items: {}, model: "campplus" };
      e.items = { ...e.items, [source]: { vec: d.vec, n: d.n, at: S.now() } }; // 같은 출처면 바꿔 넣는다
      e.updatedAt = S.now();
      return e;
    });
  }
  await S.saveJob(id, { status: "완료", stats: result.stats, finishedAt: S.now(), progress: { pct: 100, msg: "완료" } });
  post({ type: "job", id, done: true });
}

/** 가짜 엔진 목소리 특징: 소리의 대략적인 높낮이(영점 교차 수)로 정한다 — 시험 음원의 두 「사람」을 가른다 */
function fakeEmbed(a) {
  let z = 0;
  for (let i = 1; i < a.length; i++) if ((a[i - 1] < 0) !== (a[i] < 0)) z++;
  const hz = (z / 2) / (a.length / 16000 || 1);
  const v = new Float32Array(192);
  const k = hz < 330 ? 0 : 1;
  for (let i = 0; i < 192; i++) v[i] = (i % 2 === k ? 1 : 0.05) + 0.01 * Math.sin(i + hz / 50);
  let n = 0; for (const x of v) n += x * x; n = Math.sqrt(n);
  return v.map((x) => x / n);
}

async function loop() {
  if (busy) return;
  busy = true;
  try {
    for (;;) {
      const job = await nextJob();
      if (!job) break;
      stopId = null;
      try {
        await processJob(job);
      } catch (e) {
        console.error(e);
        const msg = e && e.name === "QuotaExceededError"
          ? "저장 공간이 부족합니다. 시크릿 창이 아닌 일반 창에서 열고, 설정·백업 탭에서 남은 공간을 확인하세요."
          : String((e && e.message) || e).slice(0, 300);
        await S.saveJob(job.id, { status: "오류", error: msg });
        post({ type: "job", id: job.id });
      }
    }
  } finally {
    busy = false;
    post({ type: "idle" });
  }
}

/* ------------------------------------------------------------------ 기기 성능 시험 */
// 실제 회의 음원은 쓰지 않는다 — 말소리 비슷한 합성 신호(높낮이·세기가 바뀌는 배음)로만 잰다.
function synth(sec) {
  const n = sec * 16000, x = new Float32Array(n);
  let seed = 7; const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 4294967296 - 0.5);
  let ph = 0;
  for (let i = 0; i < n; i++) {
    const t = i / 16000, f0 = 130 + 40 * Math.sin(2 * Math.PI * 0.7 * t), env = Math.max(0, Math.sin(2 * Math.PI * 1.3 * t));
    ph += 2 * Math.PI * f0 / 16000;
    x[i] = env * (0.25 * Math.sin(ph) + 0.12 * Math.sin(2 * ph) + 0.06 * Math.sin(3 * ph)) + 0.01 * rnd();
  }
  return x;
}
async function bench() {
  const say = (msg) => post({ type: "bench", msg });
  const now = () => performance.now();
  const r = { threads: ort?.env?.wasm?.numThreads || 0 };
  say("모델 준비");
  let t = now();
  await ensureModels("all");
  r.threads = FAKE ? 0 : ort.env.wasm.numThreads;
  r.load = now() - t;
  const a60 = synth(60);
  if (vad) { say("말소리 찾기(Silero) 1분"); t = now(); await vad.probs(a60); r.vadMin = now() - t; }
  say("목소리 특징(CAM++) 3초 × 10");
  t = now();
  for (let k = 0; k < 10; k++) await camp.embed(a60.subarray(k * 48000, k * 48000 + 48000));
  r.emb = (now() - t) / 10;
  r.enc = []; r.decStep = [];
  for (let k = 0; k < 3; k++) {
    say(`전사(Whisper) 30초 창 ${k + 1}/3`);
    const a = a60.subarray(k * 8000, k * 8000 + 480000);
    if (whisper.bench) { const b = await whisper.bench(a); r.enc.push(b.enc); r.decStep.push(b.decStep); }
    else { t = now(); await whisper.transcribe(a); r.enc.push(now() - t); r.decStep.push(0); }
  }
  // 1시간 회의 어림(10-08 회의 기준: 시간당 발언 약 330개·목소리 창 약 2,000개·발언당 약 30토큰,
  // 같은 화자의 짧은 발언을 묶어 전사 창은 발언의 약 60%(641→381) — 시간당 약 200창)
  const enc = r.enc.reduce((x, y) => x + y, 0) / r.enc.length, dec = r.decStep.reduce((x, y) => x + y, 0) / r.decStep.length;
  r.estDiar = 60 * (r.vadMin || 0) + 2000 * r.emb;
  r.estTr = 200 * enc + 330 * 30 * dec;
  r.slow = r.enc[r.enc.length - 1] / r.enc[0];
  return r;
}

self.onmessage = async (ev) => {
  const m = ev.data;
  try {
    if (m.type === "kick" && owner) loop();
    if (m.type === "stop") stopId = m.id;
    if (m.type === "status") post({ type: "status", models: await modelStatus(), busy, owner, coi: self.crossOriginIsolated, fake: FAKE });
    if (m.type === "bench") {
      if (busy) { post({ type: "bench", error: "작업을 처리하는 중에는 시험할 수 없습니다. 작업이 끝난 뒤 다시 누르세요." }); return; }
      busy = true;
      try { post({ type: "bench", result: await bench() }); }
      catch (e) { post({ type: "bench", error: String((e && e.message) || e) }); }
      finally { busy = false; if (owner) loop(); }
      return;
    }
    if (m.type === "download") { await ensureModels("all"); post({ type: "status", models: await modelStatus(), busy, owner, coi: self.crossOriginIsolated, fake: FAKE }); }
  } catch (e) {
    post({ type: "error", message: String(e && e.message || e) });
  }
};

// 탭을 여러 개 열어도 처리는 한 곳에서만 한다(Web Locks).
let owner = false;
(async () => {
  await new Promise((res) => {
    if (!self.navigator.locks) { owner = true; res(); return; }
    self.navigator.locks.request("plaud-booster-worker", { ifAvailable: true }, (lock) => {
      owner = !!lock;
      res();
      return owner ? new Promise(() => {}) : undefined; // 가진 쪽은 끝까지 붙든다
    });
  });
  if (owner) {
    // 처리 중에 페이지를 닫았다가 다시 열면 「처리중」으로 남은 작업을 대기로 돌려 이어서 한다
    for (const [id, j] of await S.all("jobs")) if (j.status === "처리중") await S.saveJob(id, { status: "대기" });
  }
  post({ type: "hello", owner });
})();
