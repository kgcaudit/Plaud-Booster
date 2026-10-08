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
    if (fr.length > 100) {
      const per = Math.max(1, Math.round((60 * fr[0][2]) / fr[0][3])); // 약 60초
      const WARM = 4;
      for (let k = 0; k < fr.length; k += per) {
        const from = Math.max(0, k - WARM), to = Math.min(fr.length, k + per);
        const s = fr[from][0], e = fr[to - 1][0] + fr[to - 1][1];
        const pcm = await decodeTo16k(b.slice(s, e).buffer);
        // 이 조각이 맡은 프레임만큼의 길이를 뒤쪽 기준으로 남긴다
        let own = 0;
        for (let q = k; q < to; q++) own += (fr[q][3] * SR) / fr[q][2];
        const keep = Math.min(pcm.length, Math.round(own));
        const part = k === 0 ? pcm.subarray(0, keep) : pcm.subarray(pcm.length - keep);
        await onChunk(part);
        total += part.length;
        onProgress(to / fr.length);
      }
      return total / SR;
    }
  }
  if (name.endsWith(".wav")) {
    const r = await decodeWavStreaming(file, onChunk, onProgress);
    if (r != null) return r;
  }
  // 그 밖의 형식(m4a 등)은 통째로 푼다
  if (file.size > 300 * 1024 * 1024) throw new Error("이 형식은 300MB 넘는 파일을 열 수 없습니다. MP3나 WAV로 바꿔 올려 주세요.");
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
