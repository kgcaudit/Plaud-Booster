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
