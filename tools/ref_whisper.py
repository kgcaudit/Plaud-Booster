"""Whisper turbo(sherpa ONNX 내보내기) 직접 디코딩 — 브라우저 이식 전 기준 구현."""
import base64, sys, time
import numpy as np
import onnxruntime as ort

SR = 16000; N_FFT = 400; HOP = 160; N_MELS = 128


def hz_to_mel(f):
    f = np.asarray(f, dtype=np.float64)
    f_sp = 200.0 / 3
    mels = f / f_sp
    min_log_hz = 1000.0; min_log_mel = min_log_hz / f_sp; logstep = np.log(6.4) / 27.0
    return np.where(f >= min_log_hz, min_log_mel + np.log(np.maximum(f, 1e-10) / min_log_hz) / logstep, mels)


def mel_to_hz(m):
    m = np.asarray(m, dtype=np.float64)
    f_sp = 200.0 / 3
    freqs = f_sp * m
    min_log_hz = 1000.0; min_log_mel = min_log_hz / f_sp; logstep = np.log(6.4) / 27.0
    return np.where(m >= min_log_mel, min_log_hz * np.exp(logstep * (m - min_log_mel)), freqs)


def mel_filters(n_mels=N_MELS):
    """librosa.filters.mel(sr=16000, n_fft=400, n_mels, htk=False, norm='slaney')"""
    fftfreqs = np.linspace(0, SR / 2, 1 + N_FFT // 2)
    mel_f = mel_to_hz(np.linspace(hz_to_mel(0), hz_to_mel(SR / 2), n_mels + 2))
    fdiff = np.diff(mel_f)
    ramps = mel_f[:, None] - fftfreqs[None, :]
    w = np.zeros((n_mels, len(fftfreqs)))
    for i in range(n_mels):
        lower = -ramps[i] / fdiff[i]; upper = ramps[i + 2] / fdiff[i + 1]
        w[i] = np.maximum(0, np.minimum(lower, upper))
    enorm = 2.0 / (mel_f[2:n_mels + 2] - mel_f[:n_mels])
    return (w * enorm[:, None]).astype(np.float32)


def log_mel(audio, n_frames=3000):
    a = np.zeros(n_frames * HOP, dtype=np.float32)
    a[:min(len(audio), len(a))] = audio[:len(a)]
    pad = N_FFT // 2
    x = np.pad(a, (pad, pad), mode="reflect")
    win = (0.5 - 0.5 * np.cos(2 * np.pi * np.arange(N_FFT) / N_FFT)).astype(np.float32)  # periodic hann
    nfr = 1 + (len(x) - N_FFT) // HOP
    idx = np.arange(N_FFT)[None, :] + HOP * np.arange(nfr)[:, None]
    spec = np.fft.rfft(x[idx] * win, axis=1)
    mag = (np.abs(spec) ** 2)[:-1].T  # (201, 3000)
    mel = mel_filters() @ mag
    lg = np.log10(np.maximum(mel, 1e-10))
    lg = np.maximum(lg, lg.max() - 8.0)
    return ((lg + 4.0) / 4.0).astype(np.float32)


class Whisper:
    def __init__(self, d, enc="turbo-encoder.int8.onnx", dec="turbo-decoder.int8.onnx", threads=2):
        o = ort.SessionOptions(); o.intra_op_num_threads = threads
        self.enc = ort.InferenceSession(f"{d}/{enc}", o, providers=["CPUExecutionProvider"])
        self.dec = ort.InferenceSession(f"{d}/{dec}", o, providers=["CPUExecutionProvider"])
        m = self.enc.get_modelmeta().custom_metadata_map
        codes = m["all_language_codes"].split(","); toks = [int(x) for x in m["all_language_tokens"].split(",")]
        self.ko = toks[codes.index("ko")]
        self.sot, self.eot, self.transcribe, self.notime = int(m["sot"]), int(m["eot"]), int(m["transcribe"]), int(m["no_timestamps"])
        self.tok = {}
        for line in open(f"{d}/turbo-tokens.txt", encoding="utf-8"):
            b, i = line.rstrip("\n").split(" ")
            self.tok[int(i)] = base64.b64decode(b)

    def __call__(self, audio):
        t = time.time()
        mel = log_mel(audio)[None]
        ck, cv = self.enc.run(None, {"mel": mel})
        te = time.time() - t
        z = np.zeros((4, 1, 448, 1280), np.float32)
        toks = [self.sot, self.ko, self.transcribe, self.notime]
        out = self.dec.run(None, {"tokens": np.array([toks], np.int64), "in_n_layer_self_k_cache": z, "in_n_layer_self_v_cache": z,
                                  "n_layer_cross_k": ck, "n_layer_cross_v": cv, "offset": np.array([0], np.int64)})
        res = []; off = len(toks)
        for _ in range(200):
            nxt = int(out[0][0, -1].argmax())
            if nxt == self.eot:
                break
            res.append(nxt)
            out = self.dec.run(None, {"tokens": np.array([[nxt]], np.int64), "in_n_layer_self_k_cache": out[1], "in_n_layer_self_v_cache": out[2],
                                      "n_layer_cross_k": ck, "n_layer_cross_v": cv, "offset": np.array([off], np.int64)})
            off += 1
        txt = b"".join(self.tok.get(i, b"") for i in res).decode("utf-8", "replace").strip()
        return txt, te, time.time() - t - te, len(res)


if __name__ == "__main__":
    import soundfile as sf
    d, wav = sys.argv[1], sys.argv[2]
    enc = sys.argv[5] if len(sys.argv) > 5 else "turbo-encoder.int8.onnx"
    dec = sys.argv[6] if len(sys.argv) > 6 else "turbo-decoder.int8.onnx"
    w = Whisper(d, enc, dec)
    s, e = float(sys.argv[3]), float(sys.argv[4])
    a, _ = sf.read(wav, dtype="float32", start=int(s * SR), stop=int(e * SR))
    print(w(a))
