// ONNX 모델 실행: Whisper turbo(sherpa-onnx 내보내기, int8)와 CAM++ 화자 특징.
// 탐욕 디코딩은 tools/ref_whisper.py와 같다: [sot, ko, transcribe, notimestamps]로 시작해 eot까지.
import { whisperLogMel, campFeatures } from "./dsp.js";
import { normalize } from "./engine.js";
import { agcGains } from "./diar.js";

export class Whisper {
  /** @param ort onnxruntime-web 모듈, encBytes/decBytes: Uint8Array, tokensText: tokens.txt 내용 */
  static async create(ort, encBytes, decBytes, tokensText, opts = {}) {
    const so = { executionProviders: ["wasm"], graphOptimizationLevel: "all", ...opts };
    const enc = await ort.InferenceSession.create(encBytes, so);
    const dec = await ort.InferenceSession.create(decBytes, so);
    return new Whisper(ort, enc, dec, tokensText);
  }

  constructor(ort, enc, dec, tokensText) {
    this.ort = ort; this.enc = enc; this.dec = dec;
    this.bytes = new Map();
    for (const line of tokensText.split("\n")) {
      const sp = line.lastIndexOf(" ");
      if (sp < 0) continue;
      let bin = "";
      try { bin = atob(line.slice(0, sp)); } catch { /* 「=」처럼 빈 토큰 */ }
      this.bytes.set(+line.slice(sp + 1), Uint8Array.from(bin, (c) => c.charCodeAt(0)));
    }
    // sherpa-onnx turbo 메타데이터 값
    this.SOT = 50258n; this.KO = 50264n; this.TRANSCRIBE = 50360n; this.NOTS = 50364n; this.EOT = 50257;
    this.maxTokens = 220;
  }

  detok(ids) {
    const parts = ids.map((i) => this.bytes.get(i) || new Uint8Array());
    const all = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let o = 0;
    for (const p of parts) { all.set(p, o); o += p.length; }
    return new TextDecoder("utf-8").decode(all).trim();
  }

  /** 마지막 토큰들이 같은 묶음을 4번 이상 되풀이하면 멈춘다(환각 반복 방지) */
  static looping(ids) {
    for (let p = 1; p <= 12; p++) {
      if (ids.length < p * 4) break;
      const tail = ids.slice(-p);
      let rep = true;
      for (let r = 2; r <= 4 && rep; r++) for (let j = 0; j < p; j++) if (ids[ids.length - r * p + j] !== tail[j]) { rep = false; break; }
      if (rep) return true;
    }
    return false;
  }

  async transcribe(audio) {
    const { ort } = this;
    const mel = new ort.Tensor("float32", whisperLogMel(audio), [1, 128, 3000]);
    const { n_layer_cross_k: ck, n_layer_cross_v: cv } = await this.enc.run({ mel });
    const cache = () => new ort.Tensor("float32", new Float32Array(4 * 448 * 1280), [4, 1, 448, 1280]);
    const i64 = (arr, dims) => new ort.Tensor("int64", BigInt64Array.from(arr), dims);
    const prompt = [this.SOT, this.KO, this.TRANSCRIBE, this.NOTS];
    let out = await this.dec.run({
      tokens: i64(prompt, [1, prompt.length]), in_n_layer_self_k_cache: cache(), in_n_layer_self_v_cache: cache(),
      n_layer_cross_k: ck, n_layer_cross_v: cv, offset: i64([0n], [1]),
    });
    const res = [];
    let off = prompt.length;
    for (let step = 0; step < this.maxTokens; step++) {
      const L = out.logits;
      const V = L.dims[2], base = (L.dims[1] - 1) * V, d = L.data;
      let best = 0, bi = 0;
      for (let i = 0; i < V; i++) if (d[base + i] > best || i === 0) { best = d[base + i]; bi = i; }
      if (bi === this.EOT) break;
      res.push(bi);
      if (Whisper.looping(res)) break;
      const prev = out;
      out = await this.dec.run({
        tokens: i64([BigInt(bi)], [1, 1]), in_n_layer_self_k_cache: prev.out_n_layer_self_k_cache,
        in_n_layer_self_v_cache: prev.out_n_layer_self_v_cache, n_layer_cross_k: ck, n_layer_cross_v: cv, offset: i64([BigInt(off)], [1]),
      });
      for (const t of Object.values(prev)) t.dispose?.();
      off++;
    }
    for (const t of Object.values(out)) t.dispose?.();
    ck.dispose?.(); cv.dispose?.();
    return this.detok(res);
  }
}

/**
 * 시각 토큰을 켜고 전사한다(짧은 발언 여러 개를 한 창에 묶어 넣을 때). 돌려주는 값: [{s, e, text}] (초, 창 안 기준)
 * Whisper 규칙: 첫 토큰은 1초 이하 시각, 시각은 「여는 시각·글·닫는 시각」 짝, 뒤로 가지 않음,
 * 시각 토큰 확률의 합이 가장 큰 글자 토큰보다 크면 시각을 고른다.
 */
Whisper.prototype.transcribeTs = async function (audio) {
  const { ort } = this;
  const TS0 = Number(this.NOTS) + 1, EOT = this.EOT, SOT = Number(this.SOT);
  const dur = audio.length / 16000, maxTs = TS0 + Math.min(1500, Math.floor(dur / 0.02) + 1);
  const mel = new ort.Tensor("float32", whisperLogMel(audio), [1, 128, 3000]);
  const { n_layer_cross_k: ck, n_layer_cross_v: cv } = await this.enc.run({ mel });
  const cache = () => new ort.Tensor("float32", new Float32Array(4 * 448 * 1280), [4, 1, 448, 1280]);
  const i64 = (arr, dims) => new ort.Tensor("int64", BigInt64Array.from(arr), dims);
  const prompt = [this.SOT, this.KO, this.TRANSCRIBE];
  let out = await this.dec.run({ tokens: i64(prompt, [1, prompt.length]), in_n_layer_self_k_cache: cache(), in_n_layer_self_v_cache: cache(),
    n_layer_cross_k: ck, n_layer_cross_v: cv, offset: i64([0n], [1]) });
  const res = [];
  let off = prompt.length;
  for (let step = 0; step < this.maxTokens; step++) {
    const L = out.logits, V = L.dims[2], base = (L.dims[1] - 1) * V, d = L.data;
    const last = res.length ? res[res.length - 1] : -1, prev = res.length > 1 ? res[res.length - 2] : -1;
    const isT = (t) => t >= TS0;
    const closing = isT(last) && prev >= 0 && !isT(prev);
    const lastTs = res.reduce((m, t) => (isT(t) ? t : m), -1);
    const allowText = res.length > 0 && !closing; // 닫는 시각 뒤에는 시각(다음 여는 시각)이나 끝만
    // 허용 범위 정하기
    const tsLo = res.length === 0 ? TS0 : lastTs < 0 ? TS0 : lastTs + (closing ? 0 : 1);
    const tsHi = res.length === 0 ? TS0 + 50 : maxTs;
    const tsOk = !(res.length > 0 && isT(last) && (prev < 0 || isT(prev))); // 시각 두 개(또는 첫 시각) 뒤에는 글
    let bestT = -Infinity, bt = -1, bestX = -Infinity, bx = -1;
    if (tsOk) for (let i = tsLo; i <= Math.min(tsHi, V - 1); i++) if (d[base + i] > bestT) { bestT = d[base + i]; bt = i; }
    if (res.length > 0) {
      for (let i = 0; i < SOT; i++) {
        if (i !== EOT && !allowText) continue;
        if (d[base + i] > bestX) { bestX = d[base + i]; bx = i; }
      }
    }
    let pick;
    if (bt < 0) pick = bx;
    else if (bx < 0) pick = bt;
    else {
      // 시각 확률 합(log-sum-exp) 대 가장 큰 글자 확률
      let lse = 0;
      for (let i = tsLo; i <= Math.min(tsHi, V - 1); i++) lse += Math.exp(d[base + i] - bestT);
      pick = bestT + Math.log(lse) > bestX ? bt : bx;
    }
    if (pick < 0 || pick === EOT) break;
    res.push(pick);
    if (!isT(pick) && Whisper.looping(res.filter((t) => !isT(t)))) break;
    const p = out;
    out = await this.dec.run({ tokens: i64([BigInt(pick)], [1, 1]), in_n_layer_self_k_cache: p.out_n_layer_self_k_cache,
      in_n_layer_self_v_cache: p.out_n_layer_self_v_cache, n_layer_cross_k: ck, n_layer_cross_v: cv, offset: i64([BigInt(off)], [1]) });
    for (const t of Object.values(p)) t.dispose?.();
    off++;
  }
  for (const t of Object.values(out)) t.dispose?.();
  ck.dispose?.(); cv.dispose?.();
  return tsSegments(res, TS0, dur, (ids) => this.detok(ids));
};

/** 토큰 열 → [{s, e, text}] (닫는 시각이 없으면 창 끝까지) */
export function tsSegments(ids, TS0, dur, detok) {
  const segs = [];
  let cur = [], t0 = null;
  for (const t of ids) {
    if (t >= TS0) {
      const tt = (t - TS0) * 0.02;
      if (t0 === null) t0 = tt;
      else if (cur.length) { segs.push({ s: t0, e: tt, text: detok(cur) }); cur = []; t0 = null; }
      else t0 = tt;
    } else cur.push(t);
  }
  if (cur.length) segs.push({ s: t0 ?? 0, e: dur, text: detok(cur) });
  return segs.filter((g) => g.text);
}

/** 기기 성능 시험: 30초 창 인코더 1번 + 디코더 steps걸음(고정 토큰) 시간을 잰다. 결과 글자는 버린다 */
Whisper.prototype.bench = async function (audio, steps = 24) {
  const { ort } = this;
  const now = () => performance.now();
  let t = now();
  const mel = new ort.Tensor("float32", whisperLogMel(audio), [1, 128, 3000]);
  const { n_layer_cross_k: ck, n_layer_cross_v: cv } = await this.enc.run({ mel });
  const enc = now() - t;
  const cache = () => new ort.Tensor("float32", new Float32Array(4 * 448 * 1280), [4, 1, 448, 1280]);
  const i64 = (arr, dims) => new ort.Tensor("int64", BigInt64Array.from(arr), dims);
  const prompt = [this.SOT, this.KO, this.TRANSCRIBE, this.NOTS];
  let out = await this.dec.run({ tokens: i64(prompt, [1, prompt.length]), in_n_layer_self_k_cache: cache(), in_n_layer_self_v_cache: cache(),
    n_layer_cross_k: ck, n_layer_cross_v: cv, offset: i64([0n], [1]) });
  t = now();
  for (let k = 0; k < steps; k++) {
    const prev = out;
    out = await this.dec.run({ tokens: i64([220n], [1, 1]), in_n_layer_self_k_cache: prev.out_n_layer_self_k_cache,
      in_n_layer_self_v_cache: prev.out_n_layer_self_v_cache, n_layer_cross_k: ck, n_layer_cross_v: cv, offset: i64([BigInt(prompt.length + k)], [1]) });
    for (const x of Object.values(prev)) x.dispose?.();
  }
  const decStep = (now() - t) / steps;
  for (const x of Object.values(out)) x.dispose?.();
  ck.dispose?.(); cv.dispose?.();
  return { enc, decStep };
};

export class CamPlus {
  static async create(ort, bytes, opts = {}) {
    const s = await ort.InferenceSession.create(bytes, { executionProviders: ["wasm"], graphOptimizationLevel: "all", ...opts });
    return new CamPlus(ort, s);
  }
  constructor(ort, s) { this.ort = ort; this.s = s; }
  async embed(audio) {
    const { data, frames } = campFeatures(audio);
    const r = await this.s.run({ x: new this.ort.Tensor("float32", data, [1, frames, 80]) });
    const v = normalize(r.embedding.data);
    r.embedding.dispose?.();
    return v;
  }
}

/** Silero VAD(sherpa-onnx 판, 입력 x[1,512]·h·c[2,1,64]) — 칸(32ms)마다 말소리 확률. 음량은 agcGains로 맞춰 넣는다 */
export class SileroVad {
  static async create(ort, bytes) {
    const s = await ort.InferenceSession.create(bytes, { executionProviders: ["wasm"], graphOptimizationLevel: "all" });
    return new SileroVad(ort, s);
  }
  constructor(ort, s) { this.ort = ort; this.s = s; }
  /** x: 16kHz Float32Array → Float32Array(칸 수) */
  async probs(x) {
    const { ort } = this;
    const gains = agcGains(x);
    const n = gains.length, out = new Float32Array(n);
    let h = new ort.Tensor("float32", new Float32Array(128), [2, 1, 64]);
    let c = new ort.Tensor("float32", new Float32Array(128), [2, 1, 64]);
    const buf = new Float32Array(512);
    const xt = new ort.Tensor("float32", buf, [1, 512]);
    for (let i = 0; i < n; i++) {
      const g = gains[i];
      for (let k = 0; k < 512; k++) { const v = x[i * 512 + k] * g; buf[k] = v > 1 ? 1 : v < -1 ? -1 : v; }
      const r = await this.s.run({ x: xt, h, c });
      out[i] = r.prob.data[0];
      h.dispose?.(); c.dispose?.(); r.prob.dispose?.();
      h = r.new_h; c = r.new_c;
    }
    h.dispose?.(); c.dispose?.();
    return out;
  }
}
