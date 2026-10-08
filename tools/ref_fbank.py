"""kaldi-native-fbank(sherpa 화자 모델 설정) 재현: 80 mel, 25ms/10ms, povey 창, 0.97 preemph, snip_edges=False."""
import numpy as np

SR = 16000; FL = 400; FS = 160; NFFT = 512; NB = 80; LOW = 20.0; HIGH = SR / 2 - 400


def mel(f):
    return 1127.0 * np.log(1.0 + np.asarray(f) / 700.0)


def mel_banks():
    nyq = SR / 2
    fft_bin_width = SR / NFFT
    ml, mh = mel(LOW), mel(HIGH)
    delta = (mh - ml) / (NB + 1)
    banks = np.zeros((NB, NFFT // 2 + 1), np.float32)
    for b in range(NB):
        left, center, right = ml + b * delta, ml + (b + 1) * delta, ml + (b + 2) * delta
        for i in range(NFFT // 2):  # kaldi: num_fft_bins = padded/2, 마지막(나이퀴스트) 빈 제외
            m = mel(fft_bin_width * i)
            if left < m < right:
                banks[b, i] = (m - left) / (center - left) if m <= center else (right - m) / (right - center)
    return banks


BANKS = mel_banks()
WIN = (0.5 - 0.5 * np.cos(2 * np.pi * np.arange(FL) / (FL - 1))) ** 0.85  # povey


def fbank(x):
    x = np.asarray(x, np.float64)
    n = len(x)
    nf = (n + FS // 2) // FS
    out = np.zeros((nf, NB), np.float32)
    eps = np.finfo(np.float32).eps
    for i in range(nf):
        start = i * FS + FS // 2 - FL // 2
        idx = np.arange(start, start + FL)
        idx = np.where(idx < 0, -idx - 1, idx)
        idx = np.where(idx >= n, 2 * n - 1 - idx, idx)
        fr = x[idx].copy()
        fr -= fr.mean()
        fr[1:] = fr[1:] - 0.97 * fr[:-1]
        fr[0] -= 0.97 * fr[0]
        fr *= WIN
        sp = np.fft.rfft(fr, NFFT)
        pw = (sp.real ** 2 + sp.imag ** 2)
        out[i] = np.log(np.maximum(BANKS @ pw, eps))
    return out
