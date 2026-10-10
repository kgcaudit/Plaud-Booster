// 브라우저 저장소: IndexedDB(작업·결과·검수·목소리 기준·사전)와 OPFS(16kHz 음원).
// 모든 데이터는 이 브라우저 안에만 있다. 서버로 보내는 곳은 없다.

const DB_NAME = "plaud-booster";
const STORES = ["jobs", "plaud", "results", "edits", "partials", "enroll", "chunks", "voiceprints", "kv"];
let dbp = null;

export function db() {
  if (!dbp) {
    dbp = new Promise((res, rej) => {
      const r = indexedDB.open(DB_NAME, 1);
      r.onupgradeneeded = () => { for (const s of STORES) if (!r.result.objectStoreNames.contains(s)) r.result.createObjectStore(s); };
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
  }
  return dbp;
}

// 쓰기 끝을 기다림: 저장 공간이 모자라면 크롬은 error가 아니라 abort로 알리므로 둘 다 받는다(안 받으면 작업이 「처리중」에서 멈춤)
const done = (tx) => new Promise((res, rej) => { tx.oncomplete = () => res(); tx.onerror = () => rej(tx.error); tx.onabort = () => rej(tx.error || new DOMException("저장이 취소되었습니다", "AbortError")); });
function req(r) { return new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); }); }

export async function get(store, key) {
  const d = await db();
  return req(d.transaction(store).objectStore(store).get(key));
}
export async function put(store, key, value) {
  const d = await db();
  const tx = d.transaction(store, "readwrite");
  tx.objectStore(store).put(value, key);
  return done(tx);
}
export async function del(store, key) {
  const d = await db();
  const tx = d.transaction(store, "readwrite");
  tx.objectStore(store).delete(key);
  return done(tx);
}
export async function all(store) {
  const d = await db();
  const s = d.transaction(store).objectStore(store);
  const [keys, vals] = await Promise.all([req(s.getAllKeys()), req(s.getAll())]);
  return keys.map((k, i) => [k, vals[i]]);
}
/** 키만(값은 읽지 않음) — 결과처럼 큰 값이 있는 저장소에서 「있는지」만 볼 때 */
export async function keys(store) {
  const d = await db();
  return req(d.transaction(store).objectStore(store).getAllKeys());
}
/** 읽고-고치고-쓰기를 한 트랜잭션으로 */
export async function update(store, key, fn) {
  const d = await db();
  const tx = d.transaction(store, "readwrite");
  const s = tx.objectStore(store);
  let out;
  const cur = await req(s.get(key));
  out = fn(cur);
  if (out !== undefined) s.put(out, key); // undefined면 쓰지 않음(지워진 작업을 빈 기록으로 되살리지 않게)
  await done(tx);
  return out;
}

export const now = () => new Date().toISOString().replace(/\.\d+Z$/, "Z");

export async function saveJob(id, patch) {
  // 없는(지워진) 작업은 되살리지 않는다 — 지운 뒤 늦게 온 진행률·상태 저장이 이름 없는 유령 작업을 만들어 처리까지 하던 문제
  return update("jobs", id, (j) => (j ? { ...j, ...patch, updatedAt: now() } : undefined));
}

/* ------------------------------------------------------------------ 음원(OPFS) */
async function audioDir(jobId, create = false) {
  const root = await navigator.storage.getDirectory();
  const a = await root.getDirectoryHandle("audio", { create: true });
  return a.getDirectoryHandle(jobId, { create });
}

/** 16kHz 모노 Int16 조각들을 차례로 써 넣는 쓰개 */
export async function audioWriter(jobId, fileIndex) {
  const dir = await audioDir(jobId, true);
  const fh = await dir.getFileHandle(`${fileIndex}.pcm`, { create: true });
  const w = await fh.createWritable();
  let samples = 0;
  return {
    async write(f32) {
      const i16 = new Int16Array(f32.length);
      for (let i = 0; i < f32.length; i++) { const v = Math.max(-1, Math.min(1, f32[i])); i16[i] = v < 0 ? v * 32768 : v * 32767; }
      await w.write(i16);
      samples += f32.length;
    },
    async close() { await w.close(); return samples; },
    async abort() { try { await w.abort(); } catch { /* 이미 닫힘 */ } },
  };
}

const fileCache = new Map();
/** [s, e) 초 구간을 Float32로 읽는다 */
export async function readAudio(jobId, fileIndex, s, e) {
  const key = jobId + "/" + fileIndex;
  let file = fileCache.get(key);
  if (!file) {
    const dir = await audioDir(jobId);
    file = await (await dir.getFileHandle(`${fileIndex}.pcm`)).getFile();
    fileCache.set(key, file);
  }
  const total = file.size / 2;
  const a = Math.max(0, Math.min(total, Math.floor(s * 16000)));
  const b = Math.max(a, Math.min(total, Math.floor(e * 16000)));
  const i16 = new Int16Array(await file.slice(a * 2, b * 2).arrayBuffer());
  const f = new Float32Array(i16.length);
  for (let i = 0; i < i16.length; i++) f[i] = i16[i] / 32768;
  return f;
}

/** 저장된 16kHz 음원 파일 하나 전체(File, Int16) — 전체 재생 막대용. 메모리에 올리지 않고 파일을 그대로 가리킨다 */
export async function audioFile(jobId, fileIndex) {
  const dir = await audioDir(jobId);
  return (await dir.getFileHandle(`${fileIndex}.pcm`)).getFile();
}

export async function deleteAudio(jobId) {
  for (const k of [...fileCache.keys()]) if (k.startsWith(jobId + "/")) fileCache.delete(k);
  try {
    const root = await navigator.storage.getDirectory();
    const a = await root.getDirectoryHandle("audio", { create: true });
    await a.removeEntry(jobId, { recursive: true });
  } catch { /* 없음 */ }
}

/* ------------------------------------------------------------------ 중간 결과(partials)
 * 이어서 하기용 기록. 예전에는 작업 하나를 한 덩어리({k: rec})로 두고 기록할 때마다 통째로 읽어 다시 썼다
 * — 긴 녹음에서 저장 비용이 발언 수의 제곱으로 늘었다(2시간 회의 목소리 특징만 약 1천만 개 숫자를 복사).
 * 지금은 기록 하나를 「작업id#k」 키 하나로 쓴다. 예전 덩어리(키 = 작업id)도 그대로 읽고, 지울 때 함께 지운다. */
const pkey = (id, k) => id + "#" + k;
const prange = (id) => IDBKeyRange.bound(id + "#", id + "#\uffff");
export async function loadPartials(id) {
  const d = await db();
  const s = d.transaction("partials").objectStore("partials");
  const [old, vals] = await Promise.all([req(s.get(id)), req(s.getAll(prange(id)))]);
  const out = { ...(old || {}) };
  for (const v of vals) out[v.k] = v;
  return out;
}
export const savePartial = (id, rec) => put("partials", pkey(id, rec.k), rec);
export async function clearPartials(id) {
  const d = await db();
  const tx = d.transaction("partials", "readwrite");
  const s = tx.objectStore("partials");
  s.delete(id); s.delete(prange(id));
  return done(tx);
}

export async function deleteJob(id) {
  // 작업 기록은 맨 나중에 지운다 — 중간에 탭이 닫혀도 「작업 없는 결과·음원」이 보이지 않게 남지 않도록(작업이 남아 다시 지울 수 있음)
  for (const s of ["plaud", "results", "edits", "enroll", "chunks"]) await del(s, id);
  await clearPartials(id);
  await deleteAudio(id);
  await del("jobs", id);
}

/** 처음부터 다시: 중간 결과를 지운다(음원·전사·검수는 남김) */
export async function resetJob(id) {
  for (const s of ["results", "enroll", "chunks"]) await del(s, id);
  await clearPartials(id);
}
