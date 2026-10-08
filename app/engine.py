"""전사·화자 매칭 엔진 (sherpa-onnx, 오프라인)

- 전사: Whisper turbo(int8). sherpa-onnx는 토큰을 글자로 바꾸는 과정에서 한글 일부가 빠지므로
  토큰 표를 16진수 자리표시자로 바꾼 tokens-hex.txt를 쓰고, 결과 토큰을 바이트로 되돌린다.
- 화자: CAM++ 목소리 특징. Plaud가 이름 붙인 구간으로 사람별 기준을 만든 뒤 구간마다 맞힌다.
  처음부터 N명으로 묶는 방식은 소수 화자가 사라져 쓰지 않는다.

PB_FAKE_ENGINE=1 이면 모델 없이 가짜 결과를 낸다(시험·CI용).
"""
from __future__ import annotations

import base64
import collections
import json
import os
import re
import shutil
import subprocess
import sys
import tarfile
import time
import urllib.request

import numpy as np

SR = 16000
GH = "https://github.com/k2-fsa/sherpa-onnx/releases/download"
MODELS = {
    "emb": ("speaker-recongition-models/3dspeaker_speech_campplus_sv_zh_en_16k-common_advanced.onnx",
            "3dspeaker_speech_campplus_sv_zh_en_16k-common_advanced.onnx"),
    "asr": ("asr-models/sherpa-onnx-whisper-turbo.tar.bz2",
            "sherpa-onnx-whisper-turbo/turbo-encoder.int8.onnx"),
}
ASR_DIR = "sherpa-onnx-whisper-turbo"
HALLU = re.compile(r"다음 영상에서|시청해 주셔서|구독(과|,)? ?좋아요|^감사합니다\.?$|^MBC 뉴스|자막 제공|^\(?음악\)?$")
GENERIC_SPK = re.compile(r"^(speaker|spk|화자|발언자|참석자)\s*[_-]?\s*\d+$", re.I)
FAKE = os.environ.get("PB_FAKE_ENGINE") == "1"


def log(*a):
    print(time.strftime("%H:%M:%S"), *a, file=sys.stderr, flush=True)


# ---------------------------------------------------------------- models
def models_ready(md: str) -> bool:
    if FAKE:
        return True
    return all(os.path.exists(os.path.join(md, rel)) for _, rel in MODELS.values()) and \
        os.path.exists(os.path.join(md, ASR_DIR, "tokens-hex.txt"))


def setup(md: str, progress=lambda msg: None):
    """모델을 GitHub 릴리스에서 받아 풀고 한글 우회용 토큰 표를 만든다(약 1GB, 처음 한 번)."""
    os.makedirs(md, exist_ok=True)
    for key, (url, rel) in MODELS.items():
        if os.path.exists(os.path.join(md, rel)):
            continue
        fn = os.path.join(md, os.path.basename(url))
        progress(f"{key} 모델 받는 중")
        log("download", url)
        with urllib.request.urlopen(f"{GH}/{url}") as r, open(fn + ".part", "wb") as f:
            total = int(r.headers.get("Content-Length") or 0)
            got = 0
            while True:
                b = r.read(1 << 20)
                if not b:
                    break
                f.write(b)
                got += len(b)
                if total:
                    progress(f"{key} 모델 받는 중 {got * 100 // total}%")
        os.replace(fn + ".part", fn)
        if fn.endswith(".tar.bz2"):
            progress(f"{key} 모델 푸는 중")
            with tarfile.open(fn, "r:bz2") as t:
                # 쓰지 않는 원본 정밀도 모델(수 GB)은 풀지 않는다
                members = [m for m in t.getmembers()
                           if m.isdir() or re.search(r"(\.int8\.onnx|tokens\.txt)$", m.name)]
                t.extractall(md, members=members, filter="data")
            os.remove(fn)
    tdir = os.path.join(md, ASR_DIR)
    hexf = os.path.join(tdir, "tokens-hex.txt")
    if not os.path.exists(hexf):
        with open(hexf, "w") as out:
            for line in open(os.path.join(tdir, "turbo-tokens.txt"), encoding="utf-8"):
                b64, i = line.rstrip("\n").split(" ")
                raw = base64.b64decode(b64)
                out.write(base64.b64encode(("~" + raw.hex() + "~").encode()).decode() + " " + i + "\n")
    progress("모델 준비 완료")
    log("models ready")


# ---------------------------------------------------------------- audio
def ffmpeg_bin() -> str:
    exe = shutil.which("ffmpeg")
    if exe:
        return exe
    import imageio_ffmpeg  # 시스템 ffmpeg가 없을 때
    return imageio_ffmpeg.get_ffmpeg_exe()


def to_wav(src: str, dst: str) -> float:
    subprocess.run([ffmpeg_bin(), "-loglevel", "error", "-y", "-i", src, "-ar", str(SR), "-ac", "1",
                    "-c:a", "pcm_s16le", dst], check=True)
    import soundfile as sf
    return float(sf.info(dst).duration)


def read(wav: str, s: float, e: float) -> np.ndarray:
    import soundfile as sf
    a, _ = sf.read(wav, dtype="float32", start=int(max(0.0, s) * SR), stop=int(max(s, e) * SR))
    return a


def clip_wav_bytes(wav: str, s: float, e: float) -> bytes:
    import io
    import soundfile as sf
    buf = io.BytesIO()
    sf.write(buf, read(wav, s, e), SR, format="WAV", subtype="PCM_16")
    return buf.getvalue()


def vad_chunks(wav: str, t0: float, t1: float, maxlen: float = 25.0):
    """에너지 기준으로 말소리 구간을 25초 이하로 자른다(Whisper는 30초 넘는 입력을 자른다)."""
    a = read(wav, t0, t1)
    fr = int(0.03 * SR)
    if len(a) < fr * 10:
        return []
    e = 20 * np.log10(np.sqrt((a[:len(a) // fr * fr].reshape(-1, fr) ** 2).mean(1)) + 1e-9)
    thr = np.percentile(e, 20) + 6
    act = e > thr
    ch, st, sil = [], None, 0
    for i, v in enumerate(act):
        if v:
            if st is None:
                st = i
            sil = 0
            if (i - st) * .03 >= maxlen:
                ch.append((st, i))
                st = None
        elif st is not None:
            sil += 1
            if sil * .03 >= .8:
                ch.append((st, i - sil + 1))
                st, sil = None, 0
    if st is not None:
        ch.append((st, len(act)))
    m = []
    for s, e_ in ch:
        if m and (s - m[-1][1]) * .03 < 1.2 and (e_ - m[-1][0]) * .03 <= maxlen:
            m[-1] = (m[-1][0], e_)
        else:
            m.append((s, e_))
    return [(round(t0 + s * .03, 2), round(t0 + e_ * .03, 2)) for s, e_ in m if (e_ - s) * .03 >= .5]


def active_end(wav: str, t0: float, t1: float) -> float:
    """t1 이전 마지막 발화 시각(말소리 없는 꼬리 제외)."""
    a = read(wav, t0, t1)
    w = SR * 5
    if len(a) < w:
        return t1
    r = np.sqrt((a[:len(a) // w * w].reshape(-1, w) ** 2).mean(1))
    db = 20 * np.log10(r + 1e-9)
    idx = np.where(db > np.percentile(db, 30) + 8)[0]
    return t1 if not len(idx) else min(t1, t0 + (idx[-1] + 1) * 5 + 5)


# ---------------------------------------------------------------- text
def decode_hex(tokens) -> str:
    hx = "".join(re.findall(r"~([0-9a-f]*)~", "".join(tokens)))
    return bytes.fromhex(hx).decode("utf-8", errors="replace").strip()


def is_hallu(t: str) -> bool:
    t = t.strip()
    return (not t) or t in "-." or bool(HALLU.search(t)) or bool(re.search(r"(.{4,})\1{3,}", t))


def is_generic(name: str) -> bool:
    return bool(GENERIC_SPK.match(name.strip()))


# ---------------------------------------------------------------- voiceprints
def centroid(entry: dict) -> tuple[np.ndarray, int]:
    """사람별 기준: 출처(회의)별 평균을 창 개수 가중으로 합친 것."""
    tot, n = None, 0
    for it in entry.get("items", {}).values():
        v = np.array(it["vec"], dtype=np.float64) * it["n"]
        tot = v if tot is None else tot + v
        n += it["n"]
    if tot is None:
        return None, 0
    return tot / (np.linalg.norm(tot) + 1e-9), n


def label(votes: dict, whole: dict):
    top = list(votes.items())
    if not top:
        return "미상", "미상", 0.0
    if top[0][1] >= .7:
        conf = top[0][1]
        if whole and len(whole) > 1:
            vals = list(whole.values())
            conf = min(conf, 0.5 + (vals[0] - vals[1]))  # 1·2위 유사도 차이가 작으면 신뢰도를 낮춘다
        return top[0][0], "단일", round(float(conf), 2)
    return top[0][0] + "·" + (top[1][0] if len(top) > 1 else "?"), "혼재", round(float(top[0][1]), 2)


class Engine:
    def __init__(self, model_dir: str, threads: int | None = None):
        self.md = model_dir
        self.threads = threads or max(1, (os.cpu_count() or 2))
        self._asr = None
        self._ex = None

    # lazy load
    @property
    def asr(self):
        if self._asr is None:
            import sherpa_onnx
            d = os.path.join(self.md, ASR_DIR)
            self._asr = sherpa_onnx.OfflineRecognizer.from_whisper(
                encoder=f"{d}/turbo-encoder.int8.onnx", decoder=f"{d}/turbo-decoder.int8.onnx",
                tokens=f"{d}/tokens-hex.txt", language="ko", task="transcribe", num_threads=self.threads)
        return self._asr

    @property
    def ex(self):
        if self._ex is None:
            import sherpa_onnx
            self._ex = sherpa_onnx.SpeakerEmbeddingExtractor(sherpa_onnx.SpeakerEmbeddingExtractorConfig(
                model=os.path.join(self.md, MODELS["emb"][1]), num_threads=self.threads))
        return self._ex

    def transcribe(self, wav: str, s: float, e: float) -> str:
        if FAKE:
            return f"가짜 전사 {s:.1f}-{e:.1f}"
        st = self.asr.create_stream()
        st.accept_waveform(SR, read(wav, s - .15, e + .15))
        self.asr.decode_stream(st)
        return decode_hex(st.result.tokens)

    def embed(self, wav: str, s: float, e: float) -> np.ndarray:
        if FAKE:
            rng = np.random.default_rng(int(s * 10))
            v = rng.normal(size=192)
            return v / np.linalg.norm(v)
        a = read(wav, s, e)
        st = self.ex.create_stream()
        st.accept_waveform(SR, a)
        st.input_finished()
        v = np.array(self.ex.compute(st))
        return v / (np.linalg.norm(v) + 1e-9)

    def enroll(self, wav: str, segs: list[dict], keep) -> dict:
        """이름 붙은 2.5초 이상 발언을 6초 창으로 잘라 사람별 평균 특징을 만든다.
        segs: [{start,end,speaker}] (초). keep(seg) 가 참인 것만 쓴다."""
        V = collections.defaultdict(list)
        seen = set()
        for g in segs:
            s, e, who = float(g["start"]), float(g["end"]), g["speaker"].strip()
            if not who or (s, who) in seen or not keep(g) or e - s < 2.5:
                continue
            seen.add((s, who))
            t = s + .3
            while t + 1.5 <= e - .3:
                V[who].append(self.embed(wav, t, min(t + 6, e - .3)))
                t += 6
        out = {}
        for who, vs in V.items():
            c = np.mean(vs, 0)
            out[who] = {"vec": (c / np.linalg.norm(c)).round(5).tolist(), "n": len(vs)}
        return out

    def match(self, wav: str, s: float, e: float, C: dict):
        """3초 창(1.5초 간격)마다 가장 가까운 사람에게 표를 주고, 구간 전체 유사도도 함께 본다."""
        names = list(C)
        if not names:
            return {}, {}
        M = np.array([C[k] for k in names])
        votes = collections.Counter()
        for a in np.arange(s, max(s + .01, e - 1.0), 1.5):
            b = min(a + 3.0, e)
            if b - a < 1.0:
                continue
            votes[names[int((M @ self.embed(wav, a, b)).argmax())]] += b - a
        whole = M @ self.embed(wav, s, e) if e - s >= 1.0 else None
        tot = sum(votes.values()) or 1
        return ({k: round(v / tot, 2) for k, v in votes.most_common()},
                ({names[i]: round(float(whole[i]), 3) for i in np.argsort(-whole)[:3]} if whole is not None else {}))


# ---------------------------------------------------------------- job
def plan_targets(job: dict, files: list[dict], plaud_end: float | None):
    """처리 대상 구간 목록 [(파일번호, 시작, 끝)]."""
    mode = job["mode"]
    if mode == "enroll":
        return []
    if mode == "fragment":
        return [(i, 0.0, f["dur"]) for i, f in enumerate(files)]
    f0 = files[0]
    if mode == "gap":
        t0 = max(0.0, float(job.get("transcriptEndSec") or plaud_end or 0) - 15)
        return [(0, t0, active_end(f0["wav"], t0, f0["dur"]))]
    r = job.get("range") or {}
    return [(0, float(r.get("from", 0)), min(f0["dur"], float(r.get("to", f0["dur"]))))]


def run_job(engine: Engine, job_dir: str, job: dict, vp_store: dict, progress, should_stop=lambda: False):
    """작업 하나를 처리한다. 중간에 멈춰도 partial.jsonl 덕분에 이어서 할 수 있다.
    반환: (result dict, fresh voiceprints {name: {vec,n}})"""
    wdir = os.path.join(job_dir, "wav")
    os.makedirs(wdir, exist_ok=True)
    files = []
    for i, src in enumerate(job["audioFiles"]):
        wav = os.path.join(wdir, f"{i}.wav")
        if not os.path.exists(wav):
            progress(1, f"음원 변환 {i + 1}/{len(job['audioFiles'])}")
            to_wav(os.path.join(job_dir, "src", src), wav + ".tmp.wav")
            os.replace(wav + ".tmp.wav", wav)
        import soundfile as sf
        files.append({"name": src, "wav": wav, "dur": float(sf.info(wav).duration)})

    plaud = []
    pp = os.path.join(job_dir, "plaud.json")
    if os.path.exists(pp):
        plaud = json.load(open(pp, encoding="utf-8"))
    smap = job.get("speakerMap") or {}
    for g in plaud:
        g["speaker"] = smap.get(g["speaker"], g["speaker"]).strip()
    plaud_end = max((g["end"] for g in plaud), default=None)

    targets = plan_targets(job, files, plaud_end)
    tdur = sum(b - a for _, a, b in targets)

    # 같은 음원의 Plaud 이름 구간으로 이번 작업용 기준을 만든다(대상 구간과 겹치는 발언은 뺀다)
    fresh = {}
    ep = os.path.join(job_dir, "enroll.json")  # 이어하기 때 다시 만들지 않도록 저장해 둔다
    if os.path.exists(ep):
        fresh = json.load(open(ep, encoding="utf-8"))
    elif plaud and job["mode"] in ("gap", "range", "enroll"):
        progress(3, "목소리 기준 만드는 중")
        if job["mode"] == "gap":
            t0 = targets[0][1]
            keep = lambda g: g["start"] < t0 + 1
        elif job["mode"] == "range":
            _, a, b = targets[0]
            keep = lambda g: g["end"] <= a or g["start"] >= b
        else:
            keep = lambda g: True
        fresh = engine.enroll(files[0]["wav"], plaud, keep)
        json.dump(fresh, open(ep, "w", encoding="utf-8"), ensure_ascii=False)

    C = {}
    if job.get("useVoiceprints", True):
        for name, entry in vp_store.items():
            v, n = centroid(entry)
            if v is not None:
                C[name] = v
    for name, d in fresh.items():  # 이번 회의 기준이 있으면 저장된 기준과 합쳐 쓴다
        if name in C:
            entry = vp_store[name]
            items = dict(entry.get("items", {}))
            items["__this__"] = d
            C[name], _ = centroid({"items": items})
        else:
            C[name] = np.array(d["vec"])
    only = set(job.get("speakers") or [])
    if only:
        C = {k: v for k, v in C.items() if k in only}

    if job["mode"] == "enroll":
        return {"segs": [], "stats": {"segments": 0, "enrolled": {k: v["n"] for k, v in fresh.items()}}}, fresh

    # 구간 나누기 (한 번 정하면 저장해서 이어하기 때 같은 구간을 쓴다)
    cp = os.path.join(job_dir, "chunks.json")
    if os.path.exists(cp):
        chunks = json.load(open(cp))
    else:
        progress(4, "말소리 구간 나누는 중")
        chunks = []
        for fi, a, b in targets:
            chunks += [[fi, s, e] for s, e in vad_chunks(files[fi]["wav"], a, b)]
        json.dump(chunks, open(cp, "w"))

    part = os.path.join(job_dir, "partial.jsonl")
    done = {}
    if os.path.exists(part):
        for line in open(part, encoding="utf-8"):
            if line.strip():
                r = json.loads(line)
                done[r["k"]] = r
    tic = time.time()
    n_new = 0
    with open(part, "a", encoding="utf-8") as pf:
        for k, (fi, s, e) in enumerate(chunks):
            if k in done:
                continue
            if should_stop():
                return None, fresh
            wav = files[fi]["wav"]
            txt = engine.transcribe(wav, s, e)
            rec = {"k": k, "file": fi, "start": s, "end": e, "text": txt}
            if is_hallu(txt):
                rec["hallu"] = True
            else:
                votes, whole = engine.match(wav, s, e, C) if C else ({}, {})
                spk, kind, conf = label(votes, whole)
                rec.update(speaker=spk, kind=kind, conf=conf, votes=votes)
            pf.write(json.dumps(rec, ensure_ascii=False) + "\n")
            pf.flush()
            done[k] = rec
            n_new += 1
            el = time.time() - tic
            left = (len(chunks) - len(done)) * el / n_new
            progress(5 + int(len(done) / max(1, len(chunks)) * 94),
                     f"{len(done)}/{len(chunks)} 구간 · 남은 시간 약 {int(left // 60)}분")

    segs, dropped = [], 0
    for k in range(len(chunks)):
        r = done[k]
        if r.get("hallu"):
            dropped += 1
            continue
        segs.append({"i": len(segs) + 1, "file": r["file"], "start": r["start"], "end": r["end"], "text": r["text"],
                     "speaker": r["speaker"], "kind": r["kind"], "conf": r["conf"], "votes": r["votes"]})
    cnt = collections.Counter(g["kind"] for g in segs)
    stats = {"segments": len(segs), "single": cnt["단일"], "mixed": cnt["혼재"], "unknown": cnt["미상"],
             "lowConf": sum(1 for g in segs if g["kind"] == "단일" and g["conf"] < .6),
             "droppedHallucination": dropped, "targetSec": round(tdur, 1),
             "targets": [{"file": fi, "from": round(a, 1), "to": round(b, 1)} for fi, a, b in targets],
             "files": [{"name": f["name"], "dur": round(f["dur"], 1)} for f in files],
             "speakersUsed": sorted(C), "enrolled": {k: v["n"] for k, v in fresh.items()}}
    return {"segs": segs, "stats": stats}, fresh


if __name__ == "__main__":
    if len(sys.argv) >= 3 and sys.argv[1] == "setup":
        setup(sys.argv[2], progress=lambda m: log(m))
    else:
        print("사용법: python -m app.engine setup <models_dir>")
