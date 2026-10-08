// 처리 일꾼(Web Worker): 모델을 받아 두고, 대기 중인 작업을 하나씩 처리한다.
// 화면과는 postMessage로만 이야기하고, 결과는 IndexedDB에 바로 쓴다.
import * as S from "./store.js";
import { runJob, isGeneric } from "./engine.js";

const FAKE = new URL(self.location.href).searchParams.get("fake") === "1";
const post = (m) => self.postMessage(m);
let ort = null, whisper = null, camp = null, busy = false, stopId = null, manifest = null;

/* ------------------------------------------------------------------ 모델 */
const CACHE = "pb-models";

async function getManifest() {
  if (!manifest) manifest = await (await fetch("../models/manifest.json", { cache: "no-store" })).json();
  return manifest;
}

/** 모델 파일(조각)을 받아 캐시에 두고 합친 바이트를 돌려준다 */
async function loadFile(info, onBytes) {
  const cache = await caches.open(CACHE + "-" + manifest.version);
  const out = new Uint8Array(info.size);
  let o = 0;
  for (const part of info.parts) {
    const url = new URL("../models/" + part, self.location.href).href;
    let r = await cache.match(url);
    if (!r) {
      const net = await fetch(url);
      if (!net.ok) throw new Error(`모델 받기 실패: ${part} (${net.status})`);
      await cache.put(url, net.clone());
      r = net;
    }
    const b = new Uint8Array(await r.arrayBuffer());
    out.set(b, o);
    o += b.length;
    onBytes(b.length);
  }
  if (o !== info.size) throw new Error(`모델 크기가 맞지 않습니다: ${info.name}`);
  return out;
}

export async function modelStatus() {
  if (FAKE) return { ready: true, cachedBytes: 0, totalBytes: 0 };
  const m = await getManifest();
  const cache = await caches.open(CACHE + "-" + m.version);
  let cached = 0, total = 0;
  for (const f of Object.values(m.files)) {
    for (let i = 0; i < f.parts.length; i++) {
      const sz = f.partSizes[i];
      total += sz;
      if (await cache.match(new URL("../models/" + f.parts[i], self.location.href).href)) cached += sz;
    }
  }
  return { ready: cached === total, cachedBytes: cached, totalBytes: total, version: m.version };
}

async function cleanupOldCaches() {
  const keep = CACHE + "-" + manifest.version;
  for (const k of await caches.keys()) if (k.startsWith(CACHE) && k !== keep) await caches.delete(k);
}

async function ensureModels() {
  if (FAKE) {
    whisper = whisper || { transcribe: async (a) => `가짜 전사 ${(a.length / 16000).toFixed(1)}초` };
    camp = camp || { embed: async (a) => { let s = 0; for (let i = 0; i < a.length; i += 97) s += Math.abs(a[i]); const v = new Float32Array(192); for (let i = 0; i < 192; i++) v[i] = Math.sin(i * (1 + (s % 7))); let n = 0; for (const x of v) n += x * x; n = Math.sqrt(n); return v.map((x) => x / n); } };
    return;
  }
  if (whisper && camp) return;
  const m = await getManifest();
  await cleanupOldCaches();
  if (!ort) {
    ort = await import("../vendor/ort/ort.wasm.min.mjs");
    const set = (await S.get("kv", "settings")) || {};
    const hc = self.navigator.hardwareConcurrency || 4;
    ort.env.wasm.numThreads = set.threads || Math.min(16, hc > 2 ? hc - 1 : hc); // 화면용으로 하나 남긴다(2코어 이하는 전부)
  }
  const st = await modelStatus();
  let got = st.cachedBytes;
  const tick = (n) => { got += n; post({ type: "models", phase: "download", got, total: st.totalBytes }); };
  // 이미 캐시에 있는 조각은 tick이 다시 세지 않도록 0부터 센다
  got = 0;
  const { Whisper, CamPlus } = await import("./models.js");
  const tokens = new TextDecoder().decode(await loadFile(m.files.tokens, tick));
  const campBytes = await loadFile(m.files.campplus, tick);
  const decBytes = await loadFile(m.files.decoder, tick);
  const encBytes = await loadFile(m.files.encoder, tick);
  post({ type: "models", phase: "load" });
  camp = await CamPlus.create(ort, campBytes);
  whisper = await Whisper.create(ort, encBytes, decBytes, tokens);
  post({ type: "models", phase: "ready", threads: ort.env.wasm.numThreads });
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
  await ensureModels();
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
    embed: (a) => camp.embed(a),
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
  const { result, fresh } = await runJob(job, job.audioFiles, ctx);
  if (!result) {
    const j = await S.get("jobs", id);
    await S.saveJob(id, { status: "중지", progress: { pct: j.progress?.pct || 0, msg: "중지됨 — 다시 시작하면 이어서 합니다" } });
    post({ type: "job", id });
    return;
  }
  result.updatedAt = S.now();
  await S.put("results", id, result);
  const source = job.title || id;
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

self.onmessage = async (ev) => {
  const m = ev.data;
  try {
    if (m.type === "kick" && owner) loop();
    if (m.type === "stop") stopId = m.id;
    if (m.type === "status") post({ type: "status", models: await modelStatus(), busy, owner, coi: self.crossOriginIsolated, fake: FAKE });
    if (m.type === "download") { await ensureModels(); post({ type: "status", models: await modelStatus(), busy, owner, coi: self.crossOriginIsolated, fake: FAKE }); }
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
