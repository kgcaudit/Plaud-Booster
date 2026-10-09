// 소리 처리: Whisper용 log-mel, 화자 모델(CAM++)용 kaldi fbank, 말소리 구간 나누기.
// 계산 방식은 tools/ref_*.py(파이썬 기준 구현)와 같고, tests/dsp.test.mjs가 수치를 대조한다.

export const SR = 16000;

/* ------------------------------------------------------------------ 공통 */
function percentile(arr, q) {
  const a = Float64Array.from(arr).sort();
  if (!a.length) return 0;
  const pos = (a.length - 1) * (q / 100);
  const lo = Math.floor(pos), hi = Math.ceil(pos);
  return a[lo] + (a[hi] - a[lo]) * (pos - lo);
}

/** 반복 가능한 실수 FFT(2의 거듭제곱 길이) — 제자리 계산 */
export function fftInPlace(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k, b = a + len / 2;
        const tr = re[b] * cr - im[b] * ci, ti = re[b] * ci + im[b] * cr;
        re[b] = re[a] - tr; im[b] = im[a] - ti;
        re[a] += tr; im[a] += ti;
        const ncr = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = ncr;
      }
    }
  }
}

/* ------------------------------------------------------------------ Whisper log-mel (128) */
const W_NFFT = 400, W_HOP = 160, W_BINS = 201;
let melFilters = null, dftCos = null, dftSin = null, hann = null;

function hzToMel(f) {
  const fsp = 200 / 3, minHz = 1000, minMel = minHz / fsp, step = Math.log(6.4) / 27;
  return f >= minHz ? minMel + Math.log(f / minHz) / step : f / fsp;
}
function melToHz(m) {
  const fsp = 200 / 3, minHz = 1000, minMel = minHz / fsp, step = Math.log(6.4) / 27;
  return m >= minMel ? minHz * Math.exp(step * (m - minMel)) : fsp * m;
}
/** librosa.filters.mel(sr=16000, n_fft=400, n_mels, htk=False, norm="slaney") */
export function whisperMelFilters(nMels = 128) {
  const fft = Array.from({ length: W_BINS }, (_, i) => (i * SR) / W_NFFT);
  const lo = hzToMel(0), hi = hzToMel(SR / 2);
  const melF = Array.from({ length: nMels + 2 }, (_, i) => melToHz(lo + ((hi - lo) * i) / (nMels + 1)));
  const w = new Float32Array(nMels * W_BINS);
  for (let m = 0; m < nMels; m++) {
    const enorm = 2 / (melF[m + 2] - melF[m]);
    for (let k = 0; k < W_BINS; k++) {
      const lower = (fft[k] - melF[m]) / (melF[m + 1] - melF[m]);
      const upper = (melF[m + 2] - fft[k]) / (melF[m + 2] - melF[m + 1]);
      w[m * W_BINS + k] = Math.max(0, Math.min(lower, upper)) * enorm;
    }
  }
  return w;
}

function initWhisper() {
  if (melFilters) return;
  melFilters = whisperMelFilters(128);
  hann = new Float32Array(W_NFFT);
  for (let i = 0; i < W_NFFT; i++) hann[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / W_NFFT);
  dftCos = new Float32Array(W_BINS * W_NFFT);
  dftSin = new Float32Array(W_BINS * W_NFFT);
  for (let k = 0; k < W_BINS; k++) for (let n = 0; n < W_NFFT; n++) {
    const a = (2 * Math.PI * k * n) / W_NFFT;
    dftCos[k * W_NFFT + n] = Math.cos(a);
    dftSin[k * W_NFFT + n] = Math.sin(a);
  }
}

/** 30초(3000프레임)로 맞춘 Whisper 입력 [128 × 3000]. 오디오 뒤는 0으로 채운다. */
export function whisperLogMel(audio, nFrames = 3000) {
  initWhisper();
  const N = nFrames * W_HOP, pad = W_NFFT / 2;
  const a = new Float32Array(N);
  a.set(audio.subarray(0, Math.min(audio.length, N)));
  const x = new Float32Array(N + 2 * pad); // reflect 패딩
  x.set(a, pad);
  for (let i = 0; i < pad; i++) { x[pad - 1 - i] = a[i + 1]; x[pad + N + i] = a[N - 2 - i]; }
  const nMels = 128;
  const mel = new Float32Array(nMels * nFrames);
  const frame = new Float32Array(W_NFFT), pw = new Float32Array(W_BINS);
  const lastAudio = Math.min(audio.length, N) + pad; // 이 뒤로는 창 전체가 0
  let maxLog = -Infinity;
  for (let t = 0; t < nFrames; t++) {
    const s = t * W_HOP;
    if (s > lastAudio) { for (let m = 0; m < nMels; m++) mel[m * nFrames + t] = -10; continue; }
    for (let n = 0; n < W_NFFT; n++) frame[n] = x[s + n] * hann[n];
    for (let k = 0; k < W_BINS; k++) {
      let re = 0, im = 0;
      const o = k * W_NFFT;
      for (let n = 0; n < W_NFFT; n++) { re += frame[n] * dftCos[o + n]; im += frame[n] * dftSin[o + n]; }
      pw[k] = re * re + im * im;
    }
    for (let m = 0; m < nMels; m++) {
      let v = 0;
      const o = m * W_BINS;
      for (let k = 0; k < W_BINS; k++) v += melFilters[o + k] * pw[k];
      const lg = Math.log10(Math.max(v, 1e-10));
      mel[m * nFrames + t] = lg;
      if (lg > maxLog) maxLog = lg;
    }
  }
  if (maxLog < -10) maxLog = -10;
  const floor = maxLog - 8;
  for (let i = 0; i < mel.length; i++) mel[i] = (Math.max(mel[i], floor) + 4) / 4;
  return mel;
}

/* ------------------------------------------------------------------ kaldi fbank (80, 화자 모델용) */
const K_FL = 400, K_FS = 160, K_NFFT = 512, K_NB = 80;
let kBanks = null, kWin = null;
function kMel(f) { return 1127 * Math.log(1 + f / 700); }
function initKaldi() {
  if (kBanks) return;
  const low = 20, high = SR / 2 - 400, w = SR / K_NFFT;
  const ml = kMel(low), mh = kMel(high), delta = (mh - ml) / (K_NB + 1);
  kBanks = [];
  for (let b = 0; b < K_NB; b++) {
    const left = ml + b * delta, center = left + delta, right = center + delta;
    const idx = [], val = [];
    for (let i = 0; i < K_NFFT / 2; i++) {
      const m = kMel(w * i);
      if (m > left && m < right) { idx.push(i); val.push(m <= center ? (m - left) / (center - left) : (right - m) / (right - center)); }
    }
    kBanks.push({ idx, val });
  }
  kWin = new Float64Array(K_FL);
  for (let i = 0; i < K_FL; i++) kWin[i] = Math.pow(0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (K_FL - 1)), 0.85);
}

/** kaldi-native-fbank(dither 0, snip_edges=false, 80 bins, 20~7600Hz)와 같은 결과. 반환 [T × 80] */
export function kaldiFbank(x) {
  initKaldi();
  const n = x.length, nf = Math.floor((n + K_FS / 2) / K_FS);
  const out = new Float32Array(nf * K_NB);
  const re = new Float64Array(K_NFFT), im = new Float64Array(K_NFFT), fr = new Float64Array(K_FL);
  const eps = 1.1920928955078125e-7;
  for (let i = 0; i < nf; i++) {
    const start = i * K_FS + K_FS / 2 - K_FL / 2;
    let mean = 0;
    for (let k = 0; k < K_FL; k++) {
      let j = start + k;
      if (j < 0) j = -j - 1;
      if (j >= n) j = 2 * n - 1 - j;
      fr[k] = x[j];
      mean += fr[k];
    }
    mean /= K_FL;
    for (let k = 0; k < K_FL; k++) fr[k] -= mean;
    for (let k = K_FL - 1; k > 0; k--) fr[k] -= 0.97 * fr[k - 1];
    fr[0] -= 0.97 * fr[0];
    re.fill(0); im.fill(0);
    for (let k = 0; k < K_FL; k++) re[k] = fr[k] * kWin[k];
    fftInPlace(re, im);
    for (let b = 0; b < K_NB; b++) {
      const { idx, val } = kBanks[b];
      let v = 0;
      for (let q = 0; q < idx.length; q++) { const k = idx[q]; v += val[q] * (re[k] * re[k] + im[k] * im[k]); }
      out[i * K_NB + b] = Math.log(Math.max(v, eps));
    }
  }
  return { data: out, frames: nf };
}

/** CAM++ 입력: fbank에서 시간 평균을 뺀 [1 × T × 80] */
export function campFeatures(x) {
  const { data, frames } = kaldiFbank(x);
  const mean = new Float64Array(K_NB);
  for (let t = 0; t < frames; t++) for (let b = 0; b < K_NB; b++) mean[b] += data[t * K_NB + b];
  for (let b = 0; b < K_NB; b++) mean[b] /= frames || 1;
  for (let t = 0; t < frames; t++) for (let b = 0; b < K_NB; b++) data[t * K_NB + b] -= mean[b];
  return { data, frames };
}

/* ------------------------------------------------------------------ 말소리 구간 */
/** 에너지 기준으로 말소리 구간을 25초 이하로 자른다(Whisper는 30초 넘는 입력을 자른다). a는 t0부터의 소리. */
export function vadChunks(a, t0, maxlen = 25) {
  const fr = Math.floor(0.03 * SR);
  if (a.length < fr * 10) return [];
  const nfr = Math.floor(a.length / fr);
  const e = new Float64Array(nfr);
  for (let i = 0; i < nfr; i++) {
    let s = 0;
    for (let k = i * fr; k < (i + 1) * fr; k++) s += a[k] * a[k];
    e[i] = 20 * Math.log10(Math.sqrt(s / fr) + 1e-9);
  }
  const thr = percentile(e, 20) + 6;
  const ch = [];
  let st = null, sil = 0;
  for (let i = 0; i < nfr; i++) {
    if (e[i] > thr) {
      if (st === null) st = i;
      sil = 0;
      if ((i - st) * 0.03 >= maxlen) { ch.push([st, i]); st = null; }
    } else if (st !== null) {
      sil++;
      if (sil * 0.03 >= 0.8) { ch.push([st, i - sil + 1]); st = null; sil = 0; }
    }
  }
  if (st !== null) ch.push([st, nfr]);
  const m = [];
  for (const [s, e2] of ch) {
    const last = m[m.length - 1];
    if (last && (s - last[1]) * 0.03 < 1.2 && (e2 - last[0]) * 0.03 <= maxlen) last[1] = e2;
    else m.push([s, e2]);
  }
  const r2 = (v) => Math.round(v * 100) / 100;
  return m.filter(([s, e2]) => (e2 - s) * 0.03 >= 0.5).map(([s, e2]) => [r2(t0 + s * 0.03), r2(t0 + e2 * 0.03)]);
}

/** t1 이전 마지막 발화 시각(말소리 없는 꼬리 제외). a는 t0~t1 소리 */
export function activeEnd(a, t0, t1) {
  const w = SR * 5;
  if (a.length < w) return t1;
  const n = Math.floor(a.length / w);
  const db = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let k = i * w; k < (i + 1) * w; k++) s += a[k] * a[k];
    db[i] = 20 * Math.log10(Math.sqrt(s / w) + 1e-9);
  }
  const thr = percentile(db, 30) + 8;
  let last = -1;
  for (let i = 0; i < n; i++) if (db[i] > thr) last = i;
  return last < 0 ? t1 : Math.min(t1, t0 + (last + 1) * 5 + 5);
}

/**
 * 전화 음질(좁은 대역) 판정용: 소리 있는 칸들의 4.2~7.8kHz 에너지 ÷ 0.3~3.4kHz 에너지(dB).
 * 넓은 대역 회의 녹음은 -20~-36dB, 8kHz로 녹음된 전화·통화 녹음을 16kHz로 올린 것은 -55dB 아래로 떨어진다.
 */
export function bandRatioDb(x) {
  const N = 512, n = Math.floor(x.length / N);
  if (n < 8) return 0;
  const win = Float64Array.from({ length: N }, (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (N - 1)));
  const re = new Float64Array(N), im = new Float64Array(N);
  const frames = [];
  for (let f = 0; f < n; f++) {
    let e = 0;
    for (let k = 0; k < N; k++) { const v = x[f * N + k]; re[k] = v * win[k]; im[k] = 0; e += v * v; }
    fftInPlace(re, im);
    let lo = 0, hi = 0;
    for (let b = 1; b < N / 2; b++) {
      const hz = (b * SR) / N, p = re[b] * re[b] + im[b] * im[b];
      if (hz >= 300 && hz < 3400) lo += p; else if (hz >= 4200 && hz < 7800) hi += p;
    }
    frames.push([e, lo, hi]);
  }
  const es = frames.map((q) => q[0]).sort((a, b) => a - b), med = es[es.length >> 1];
  let lo = 0, hi = 0;
  for (const [e, l, h] of frames) if (e > med) { lo += l; hi += h; } // 소리 있는(음량 위쪽 절반) 칸만
  return 10 * Math.log10((hi + 1e-20) / (lo + 1e-20));
}
