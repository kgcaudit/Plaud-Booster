// 올린 음원을 16kHz 모노로 바꿔 OPFS에 저장한다(브라우저 내장 디코더 사용).
// 긴 MP3를 통째로 풀면 메모리가 수 GB까지 커지므로, MP3는 프레임 경계에서 약 60초씩 잘라 푼다.
// 각 조각 앞에 이전 프레임 몇 개를 겹쳐 넣고 그만큼 앞을 버려, 조각 경계의 잡음을 없앤다.

const SR = 16000;

function ctx() {
  return new OfflineAudioContext(1, 1, SR);
}

async function decodeTo16k(arrayBuffer) {
  const buf = await ctx().decodeAudioData(arrayBuffer);
  const n = buf.length, ch = buf.numberOfChannels;
  if (ch === 1) return buf.getChannelData(0).slice();
  const out = new Float32Array(n);
  for (let c = 0; c < ch; c++) { const d = buf.getChannelData(c); for (let i = 0; i < n; i++) out[i] += d[i] / ch; }
  return out;
}

/* ---------------- MP3 프레임 찾기 */
const BR = {
  "1-3": [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320], // MPEG1 Layer III
  "2-3": [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160], // MPEG2/2.5 Layer III
};
const SRATE = { 3: [44100, 48000, 32000], 2: [22050, 24000, 16000], 0: [11025, 12000, 8000] };

function frameAt(b, i) {
  if (i + 4 > b.length || b[i] !== 0xff || (b[i + 1] & 0xe0) !== 0xe0) return null;
  const ver = (b[i + 1] >> 3) & 3, layer = (b[i + 1] >> 1) & 3;
  if (ver === 1 || layer !== 1) return null; // Layer III만
  const bri = (b[i + 2] >> 4) & 15, sri = (b[i + 2] >> 2) & 3, pad = (b[i + 2] >> 1) & 1;
  if (bri === 0 || bri === 15 || sri === 3) return null;
  const sr = SRATE[ver][sri];
  const kbps = BR[ver === 3 ? "1-3" : "2-3"][bri];
  const spf = ver === 3 ? 1152 : 576;
  const len = Math.floor(((spf / 8) * kbps * 1000) / sr) + pad;
  return { len, sr, spf };
}

/** MP3 프레임 위치 목록. 동기 신호가 연달아 맞는 곳에서만 시작한다. */
export function mp3Frames(b) {
  let i = 0;
  if (b[0] === 0x49 && b[1] === 0x44 && b[2] === 0x33) { // ID3v2
    const size = ((b[6] & 0x7f) << 21) | ((b[7] & 0x7f) << 14) | ((b[8] & 0x7f) << 7) | (b[9] & 0x7f);
    i = 10 + size + (b[5] & 0x10 ? 10 : 0);
  }
  const frames = [];
  while (i < b.length - 4) {
    const f = frameAt(b, i);
    if (f && f.len > 4) {
      const g = frameAt(b, i + f.len);
      if (g || i + f.len >= b.length - 128) { frames.push([i, f.len, f.sr, f.spf]); i += f.len; continue; }
    }
    i++;
  }
  // 첫 프레임이 Xing/Info(LAME) 머리 프레임이면 뺀다 — 조각마다 디코더가 다르게 다듬는 일을 막는다
  if (frames.length) {
    const [s, len] = frames[0];
    const txt = String.fromCharCode(...b.subarray(s, Math.min(s + len, s + 200)));
    if (/Xing|Info/.test(txt)) frames.shift();
  }
  return frames;
}

/* ---------------- AAC(m4a·mp4·aac) — 휴대폰 녹음 앱 대부분이 쓰는 형식
 * m4a(MP4 상자)에서 AAC 프레임 위치를 읽고, 프레임마다 ADTS 머리(7바이트)를 붙여 60초씩 풀 수 있게 한다.
 * 그래야 2시간짜리 휴대폰 녹음도 통째로 풀지 않아 메모리가 안전하다. */
function u32(b, i) { return ((b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]) >>> 0; }
function boxes(b, s, e) {
  const out = [];
  while (s + 8 <= e) {
    let size = u32(b, s), hdr = 8;
    const type = String.fromCharCode(b[s + 4], b[s + 5], b[s + 6], b[s + 7]);
    if (size === 1) { size = u32(b, s + 8) * 4294967296 + u32(b, s + 12); hdr = 16; }
    else if (size === 0) size = e - s;
    if (size < hdr || s + size > e) break;
    out.push({ type, s, d: s + hdr, e: s + size });
    s += size;
  }
  return out;
}
const child = (b, box, type) => boxes(b, box.d, box.e).find((x) => x.type === type);
const SFREQ = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];

/** AudioSpecificConfig → { aot(ADTS용 기본 형식), sfi, sr, ch } */
export function parseAsc(a) {
  let bit = 0;
  const rd = (n) => { let v = 0; for (let i = 0; i < n; i++, bit++) v = (v << 1) | ((a[bit >> 3] >> (7 - (bit & 7))) & 1); return v; };
  let aot = rd(5); if (aot === 31) aot = 32 + rd(6);
  let sfi = rd(4), sr = sfi === 15 ? rd(24) : SFREQ[sfi];
  const ch = rd(4);
  if (aot === 5 || aot === 29) { // HE-AAC: 바탕 형식(LC)과 바탕 표본율로 ADTS를 만든다(디코더가 SBR을 스스로 찾음)
    rd(4); aot = rd(5); if (aot === 31) aot = 32 + rd(6);
  }
  return { aot, sfi, sr, ch };
}

/** m4a·mp4 안의 첫 AAC 소리 트랙: { asc, off(Float64Array), size(Uint32Array), createdAt } 또는 null */
export function mp4Audio(b) {
  const top = boxes(b, 0, b.length);
  if (!top.length || top[0].type !== "ftyp") return null;
  const moov = top.find((x) => x.type === "moov");
  if (!moov) return null;
  let createdAt = null;
  const mvhd = child(b, moov, "mvhd");
  if (mvhd) {
    const v = b[mvhd.d], t = v === 1 ? u32(b, mvhd.d + 4) * 4294967296 + u32(b, mvhd.d + 8) : u32(b, mvhd.d + 4);
    const ms = (t - 2082844800) * 1000; // 1904년 기준 → 1970년 기준
    if (ms > Date.UTC(2005, 0, 1) && ms < Date.UTC(2100, 0, 1)) createdAt = new Date(ms);
  }
  for (const trak of boxes(b, moov.d, moov.e).filter((x) => x.type === "trak")) {
    const mdia = child(b, trak, "mdia"); if (!mdia) continue;
    const hdlr = child(b, mdia, "hdlr");
    if (!hdlr || String.fromCharCode(...b.subarray(hdlr.d + 8, hdlr.d + 12)) !== "soun") continue;
    const stbl = (() => { const minf = child(b, mdia, "minf"); return minf && child(b, minf, "stbl"); })();
    if (!stbl) continue;
    const stsd = child(b, stbl, "stsd");
    if (!stsd) continue;
    const ent = boxes(b, stsd.d + 8, stsd.e)[0];
    if (!ent || ent.type !== "mp4a") return null; // ALAC(무손실) 등은 통째로 푼다
    const ver = (b[ent.d + 8] << 8) | b[ent.d + 9];
    const sub = ent.d + 28 + (ver === 1 ? 16 : ver === 2 ? 36 : 0);
    let esds = boxes(b, sub, ent.e).find((x) => x.type === "esds");
    if (!esds) { const wave = boxes(b, sub, ent.e).find((x) => x.type === "wave"); esds = wave && child(b, wave, "esds"); }
    if (!esds) return null;
    // 기술자(descriptor) 따라가기: 03 ES → 04 DecoderConfig(0x40=AAC) → 05 DecoderSpecificInfo(=ASC)
    let p = esds.d + 4, asc = null, oti = 0;
    const len = () => { let n = 0, c; do { c = b[p++]; n = (n << 7) | (c & 0x7f); } while (c & 0x80); return n; };
    while (p < esds.e) {
      const tag = b[p++], n = len();
      if (tag === 0x03) { const fl = b[p + 2]; p += 3 + (fl & 0x80 ? 2 : 0) + (fl & 0x40 ? 1 + b[p + 3] : 0) + (fl & 0x20 ? 2 : 0); }
      else if (tag === 0x04) { oti = b[p]; p += 13; }
      else if (tag === 0x05) { asc = parseAsc(b.subarray(p, p + n)); break; }
      else p += n;
    }
    if (!asc || (oti !== 0x40 && oti !== 0x66 && oti !== 0x67) || asc.aot < 1 || asc.aot > 4 || !(asc.sfi < 13) || asc.ch < 1 || asc.ch > 7) return null;
    const stsz = child(b, stbl, "stsz"), stsc = child(b, stbl, "stsc"), stco = child(b, stbl, "stco") || child(b, stbl, "co64");
    if (!stsz || !stsc || !stco) return null;
    const fixed = u32(b, stsz.d + 4), n = u32(b, stsz.d + 8);
    const size = new Uint32Array(n);
    for (let i = 0; i < n; i++) size[i] = fixed || u32(b, stsz.d + 12 + i * 4);
    const big = stco.type === "co64", nc = u32(b, stco.d + 4);
    const chunkOff = (k) => (big ? u32(b, stco.d + 8 + k * 8) * 4294967296 + u32(b, stco.d + 12 + k * 8) : u32(b, stco.d + 8 + k * 4));
    const ns = u32(b, stsc.d + 4), runs = [];
    for (let i = 0; i < ns; i++) runs.push([u32(b, stsc.d + 8 + i * 12) - 1, u32(b, stsc.d + 12 + i * 12)]);
    const off = new Float64Array(n);
    let si = 0;
    for (let r = 0; r < runs.length && si < n; r++) {
      const [first, per] = runs[r], last = r + 1 < runs.length ? runs[r + 1][0] : nc;
      for (let c = first; c < last && si < n; c++) { let o = chunkOff(c); for (let k = 0; k < per && si < n; k++) { off[si] = o; o += size[si]; si++; } }
    }
    if (si !== n) return null;
    return { asc, off, size, createdAt };
  }
  return null;
}

/** 날 AAC(ADTS, .aac) 프레임 목록 */
export function adtsFrames(b) {
  const off = [], size = [];
  let i = 0, asc = null;
  if (b[0] === 0x49 && b[1] === 0x44 && b[2] === 0x33) i = 10 + (((b[6] & 0x7f) << 21) | ((b[7] & 0x7f) << 14) | ((b[8] & 0x7f) << 7) | (b[9] & 0x7f));
  while (i + 7 <= b.length) {
    if (b[i] !== 0xff || (b[i + 1] & 0xf6) !== 0xf0) { i++; continue; }
    const len = ((b[i + 3] & 3) << 11) | (b[i + 4] << 3) | (b[i + 5] >> 5);
    if (len < 7 || i + len > b.length) break;
    if (!asc) { const sfi = (b[i + 2] >> 2) & 15; asc = { aot: ((b[i + 2] >> 6) & 3) + 1, sfi, sr: SFREQ[sfi], ch: ((b[i + 2] & 1) << 2) | (b[i + 3] >> 6) }; }
    off.push(i); size.push(len); i += len;
  }
  return asc && off.length ? { asc, off: Float64Array.from(off), size: Uint32Array.from(size), adts: true } : null;
}

/** 프레임 [from, to)를 ADTS 바이트로(이미 ADTS면 그대로 이어 붙임) */
export function adtsChunk(b, t, from, to) {
  let n = 0;
  for (let i = from; i < to; i++) n += t.size[i] + (t.adts ? 0 : 7);
  const out = new Uint8Array(n);
  let o = 0;
  const { aot, sfi, ch } = t.asc;
  for (let i = from; i < to; i++) {
    const s = t.off[i], z = t.size[i];
    if (!t.adts) {
      const L = z + 7;
      out[o] = 0xff; out[o + 1] = 0xf1;
      out[o + 2] = (((aot - 1) & 3) << 6) | ((sfi & 15) << 2) | ((ch >> 2) & 1);
      out[o + 3] = ((ch & 3) << 6) | ((L >> 11) & 3);
      out[o + 4] = (L >> 3) & 0xff; out[o + 5] = ((L & 7) << 5) | 0x1f; out[o + 6] = 0xfc;
      o += 7;
    }
    out.set(b.subarray(s, s + z), o); o += z;
  }
  return out;
}

/** 프레임 단위로 잘라 푸는 공통 부분: frames 개수, 프레임당 표본 수 spf·표본율 sr, chunkOf(from,to)→바이트 */
async function decodeFramed(nFrames, spf, sr, chunkOf, onChunk, onProgress) {
  const per = Math.max(1, Math.round((60 * sr) / spf)); // 약 60초
  const WARM = 4;
  let total = 0;
  for (let k = 0; k < nFrames; k += per) {
    const from = Math.max(0, k - WARM), to = Math.min(nFrames, k + per);
    const pcm = await decodeTo16k(chunkOf(from, to).buffer);
    const keep = Math.min(pcm.length, Math.round(((to - k) * spf * SR) / sr)); // 이 조각이 맡은 프레임 길이만큼 뒤쪽 기준으로
    const part = k === 0 ? pcm.subarray(0, keep) : pcm.subarray(pcm.length - keep);
    await onChunk(part);
    total += part.length;
    onProgress(to / nFrames);
  }
  return total / SR;
}

/** 녹음 시각 단서(파일 안 정보): m4a의 생성 시각. 없으면 null */
export async function embeddedTime(file) {
  const name = file.name.toLowerCase();
  if (!/\.(m4a|mp4|3gp|aac)$/.test(name) || file.size > 400 * 1048576) return null;
  try { const t = mp4Audio(new Uint8Array(await file.arrayBuffer())); return t && t.createdAt ? t.createdAt : null; } catch { return null; }
}

/**
 * 파일을 풀어 onChunk(Float32Array 16kHz)로 차례로 넘긴다. 반환: 길이(초)
 * @param {File} file
 */
export async function decodeFile(file, onChunk, onProgress = () => {}) {
  const name = file.name.toLowerCase();
  const head = new Uint8Array(await file.slice(0, 16).arrayBuffer());
  const isMp3 = name.endsWith(".mp3") || (head[0] === 0x49 && head[1] === 0x44 && head[2] === 0x33) || (head[0] === 0xff && (head[1] & 0xe0) === 0xe0);
  let total = 0;
  if (isMp3) {
    const b = new Uint8Array(await file.arrayBuffer());
    const fr = mp3Frames(b);
    if (fr.length > 100) return decodeFramed(fr.length, fr[0][3], fr[0][2], (f, e) => b.slice(fr[f][0], fr[e - 1][0] + fr[e - 1][1]), onChunk, onProgress);
  }
  const isMp4 = head[4] === 0x66 && head[5] === 0x74 && head[6] === 0x79 && head[7] === 0x70; // "ftyp"
  if (isMp4 || name.endsWith(".aac")) {
    const b = new Uint8Array(await file.arrayBuffer());
    const t = isMp4 ? mp4Audio(b) : adtsFrames(b);
    if (t && t.off.length > 50) return decodeFramed(t.off.length, 1024, t.asc.sr, (f, e) => adtsChunk(b, t, f, e), onChunk, onProgress);
  }
  if (name.endsWith(".wav")) {
    const r = await decodeWavStreaming(file, onChunk, onProgress);
    if (r != null) return r;
  }
  // 그 밖의 형식(m4a 등)은 통째로 푼다
  if (file.size > 300 * 1024 * 1024) throw new Error("이 형식은 300MB 넘는 파일을 열 수 없습니다. MP3·M4A(AAC)·WAV로 바꿔 올려 주세요.");
  const pcm = await decodeTo16k(await file.arrayBuffer());
  for (let i = 0; i < pcm.length; i += SR * 60) await onChunk(pcm.subarray(i, Math.min(pcm.length, i + SR * 60)));
  onProgress(1);
  return pcm.length / SR;
}

/** PCM WAV를 60초씩 잘라(머리 붙여) 푼다. 읽을 수 없는 WAV면 null */
async function decodeWavStreaming(file, onChunk, onProgress) {
  const head = new DataView(await file.slice(0, 4096).arrayBuffer());
  if (head.getUint32(0, false) !== 0x52494646 || head.getUint32(8, false) !== 0x57415645) return null;
  let p = 12, fmt = null, dataOff = -1, dataLen = 0;
  while (p + 8 <= head.byteLength) {
    const id = head.getUint32(p, false), size = head.getUint32(p + 4, true);
    if (id === 0x666d7420) fmt = { ch: head.getUint16(p + 10, true), sr: head.getUint32(p + 12, true), align: head.getUint16(p + 20, true), fmtBytes: new Uint8Array(head.buffer.slice(p, p + 8 + size)) };
    if (id === 0x64617461) { dataOff = p + 8; dataLen = Math.min(size, file.size - dataOff); break; }
    p += 8 + size + (size & 1);
  }
  if (!fmt || dataOff < 0) return null;
  const per = fmt.sr * 60 * fmt.align;
  let total = 0;
  for (let o = 0; o < dataLen; o += per) {
    const body = new Uint8Array(await file.slice(dataOff + o, dataOff + Math.min(dataLen, o + per)).arrayBuffer());
    const out = new Uint8Array(12 + fmt.fmtBytes.length + 8 + body.length);
    const dv = new DataView(out.buffer);
    dv.setUint32(0, 0x52494646, false); dv.setUint32(4, out.length - 8, true); dv.setUint32(8, 0x57415645, false);
    out.set(fmt.fmtBytes, 12);
    const q = 12 + fmt.fmtBytes.length;
    dv.setUint32(q, 0x64617461, false); dv.setUint32(q + 4, body.length, true);
    out.set(body, q + 8);
    const pcm = await decodeTo16k(out.buffer);
    await onChunk(pcm);
    total += pcm.length;
    onProgress(Math.min(1, (o + per) / dataLen));
  }
  return total / SR;
}

/** 재생용 WAV(16비트) 만들기 */
export function wavBlob(f32) {
  const out = new DataView(new ArrayBuffer(44 + f32.length * 2));
  const w = (o, s) => [...s].forEach((c, i) => out.setUint8(o + i, c.charCodeAt(0)));
  w(0, "RIFF"); out.setUint32(4, 36 + f32.length * 2, true); w(8, "WAVE"); w(12, "fmt ");
  out.setUint32(16, 16, true); out.setUint16(20, 1, true); out.setUint16(22, 1, true); out.setUint32(24, SR, true);
  out.setUint32(28, SR * 2, true); out.setUint16(32, 2, true); out.setUint16(34, 16, true); w(36, "data"); out.setUint32(40, f32.length * 2, true);
  for (let i = 0; i < f32.length; i++) { const v = Math.max(-1, Math.min(1, f32[i])); out.setInt16(44 + i * 2, v < 0 ? v * 32768 : v * 32767, true); }
  return new Blob([out.buffer], { type: "audio/wav" });
}
