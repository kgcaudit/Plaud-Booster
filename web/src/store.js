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

function req(r) { return new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); }); }

export async function get(store, key) {
  const d = await db();
  return req(d.transaction(store).objectStore(store).get(key));
}
export async function put(store, key, value) {
  const d = await db();
  const tx = d.transaction(store, "readwrite");
  tx.objectStore(store).put(value, key);
  return new Promise((res, rej) => { tx.oncomplete = () => res(); tx.onerror = () => rej(tx.error); });
}
export async function del(store, key) {
  const d = await db();
  const tx = d.transaction(store, "readwrite");
  tx.objectStore(store).delete(key);
  return new Promise((res, rej) => { tx.oncomplete = () => res(); tx.onerror = () => rej(tx.error); });
}
export async function all(store) {
  const d = await db();
  const s = d.transaction(store).objectStore(store);
  const [keys, vals] = await Promise.all([req(s.getAllKeys()), req(s.getAll())]);
  return keys.map((k, i) => [k, vals[i]]);
}
/** 읽고-고치고-쓰기를 한 트랜잭션으로 */
export async function update(store, key, fn) {
  const d = await db();
  const tx = d.transaction(store, "readwrite");
  const s = tx.objectStore(store);
  let out;
  const cur = await req(s.get(key));
  out = fn(cur);
  s.put(out, key);
  await new Promise((res, rej) => { tx.oncomplete = () => res(); tx.onerror = () => rej(tx.error); });
  return out;
}

export const now = () => new Date().toISOString().replace(/\.\d+Z$/, "Z");

export async function saveJob(id, patch) {
  return update("jobs", id, (j) => ({ ...(j || {}), ...patch, updatedAt: now() }));
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

export async function deleteJob(id) {
  for (const s of ["jobs", "plaud", "results", "edits", "partials", "enroll", "chunks"]) await del(s, id);
  await deleteAudio(id);
}

/** 처음부터 다시: 중간 결과를 지운다(음원·전사·검수는 남김) */
export async function resetJob(id) {
  for (const s of ["results", "partials", "enroll", "chunks"]) await del(s, id);
}
