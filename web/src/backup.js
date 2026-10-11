// 백업 암호화 — 순수 함수(브라우저·node 공용, Web Crypto만 씀). 2026-10-11 사용자 승인으로 백업 파일 겉모양 추가.
//
// 속 내용은 예전 그대로의 백업({format:"plaud-booster-backup", version:2, …})이고, 그것을 gzip으로 줄인 뒤
// 암호에서 만든 열쇠(PBKDF2-SHA256, 60만 번)로 AES-256-GCM 암호화해 아래 겉모양에 담는다. 암호는 어디에도 저장하지 않는다.
//   { format:"haud-ai-backup-enc", version:1, kdf:{name,hash,iter,salt}, cipher:{name,iv}, data }   (salt·iv·data는 base64)
// GCM은 내용이 한 글자라도 바뀌거나 암호가 틀리면 풀리지 않으므로, 틀린 암호와 망가진 파일은 같은 오류로 알린다.

export const ENC_FORMAT = "haud-ai-backup-enc";
export const PLAIN_FORMAT = "plaud-booster-backup";
export const MIN_PW = 8;
const ITER = 600000;

const C = () => globalThis.crypto;
const te = new TextEncoder(), td = new TextDecoder();

function b64(buf) {
  const u = new Uint8Array(buf);
  let s = "";
  for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000));
  return btoa(s);
}
function unb64(s) {
  const b = atob(String(s || ""));
  const u = new Uint8Array(b.length);
  for (let i = 0; i < b.length; i++) u[i] = b.charCodeAt(i);
  return u;
}
async function pipe(bytes, stream) {
  return new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(stream)).arrayBuffer());
}
async function keyOf(pw, salt, iter, usage) {
  const base = await C().subtle.importKey("raw", te.encode(String(pw).normalize("NFC")), "PBKDF2", false, ["deriveKey"]);
  return C().subtle.deriveKey({ name: "PBKDF2", hash: "SHA-256", salt, iterations: iter }, base, { name: "AES-GCM", length: 256 }, false, [usage]);
}

/** 이 글이 암호 걸린 백업인가 */
export const isEncrypted = (o) => !!(o && o.format === ENC_FORMAT);

/** 백업 객체 → 암호 걸린 겉모양 객체 */
export async function encryptBackup(bk, pw, opt = {}) {
  if (String(pw || "").length < MIN_PW) throw new Error(`암호는 ${MIN_PW}자 이상이어야 합니다`);
  const iter = opt.iter || ITER;
  const salt = C().getRandomValues(new Uint8Array(16)), iv = C().getRandomValues(new Uint8Array(12));
  const packed = await pipe(te.encode(JSON.stringify(bk)), new CompressionStream("gzip"));
  const key = await keyOf(pw, salt, iter, "encrypt");
  const ct = await C().subtle.encrypt({ name: "AES-GCM", iv }, key, packed);
  return { format: ENC_FORMAT, version: 1, exportedAt: bk.exportedAt || null,
    kdf: { name: "PBKDF2", hash: "SHA-256", iter, salt: b64(salt) }, cipher: { name: "AES-GCM", iv: b64(iv) }, data: b64(ct) };
}

/** 암호 걸린 겉모양 객체 → 백업 객체(암호가 틀리거나 파일이 망가지면 오류) */
export async function decryptBackup(enc, pw) {
  if (!isEncrypted(enc)) throw new Error("암호 걸린 백업이 아닙니다");
  if (enc.version > 1) throw new Error("이 화면보다 새 판에서 만든 백업입니다. 페이지를 새로 고친 뒤 다시 올려 주세요.");
  const iter = +enc.kdf?.iter;
  if (!(iter >= 1000 && iter <= 10000000)) throw new Error("백업 파일이 망가졌습니다");
  let plain;
  try {
    const key = await keyOf(pw, unb64(enc.kdf.salt), iter, "decrypt");
    plain = await C().subtle.decrypt({ name: "AES-GCM", iv: unb64(enc.cipher.iv) }, key, unb64(enc.data));
  } catch {
    throw new Error("암호가 맞지 않거나 백업 파일이 망가졌습니다");
  }
  return JSON.parse(td.decode(await pipe(new Uint8Array(plain), new DecompressionStream("gzip"))));
}

/** 백업 파일 이름: HAUD-AI-backup_YYYYMMDD.json(암호 없이 받으면 _plain을 붙여 구분) — 한글이 깨지지 않게 영문만 */
export function backupName(d = new Date(), plain = false) {
  const p = (x) => String(x).padStart(2, "0");
  return `HAUD-AI-backup_${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${plain ? "_plain" : ""}.json`;
}
