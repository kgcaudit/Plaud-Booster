"""Plaud 보강 작업대 — 웹 서버 (FastAPI)

실행: python -m app.server  (기본 127.0.0.1:8765)
데이터: PB_DATA (기본 ./data) — 음원·전사·목소리 기준이 들어가므로 저장소에 올리지 않는다(.gitignore).
모델:   PB_MODELS (기본 ./models)
"""
from __future__ import annotations

import io
import json
import os
import re
import secrets
import shutil
import subprocess
import threading
import time
import traceback
import zipfile
from datetime import datetime, timezone

from fastapi import Body, FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles

from . import engine as E
from . import plaud_import

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.abspath(os.environ.get("PB_DATA", os.path.join(ROOT, "data")))
MODELS = os.path.abspath(os.environ.get("PB_MODELS", os.path.join(ROOT, "models")))
JOBS = os.path.join(DATA, "jobs")
UPL = os.path.join(DATA, "uploads")
for d in (DATA, JOBS, UPL):
    os.makedirs(d, exist_ok=True)

LOCK = threading.RLock()


def now():
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def rjson(path, default=None):
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        return default


def wjson(path, obj):
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(obj, f, ensure_ascii=False)
    os.replace(tmp, path)


def safe_name(name: str) -> str:
    name = os.path.basename(name or "file").strip().replace("\x00", "")
    name = re.sub(r'[\\/:*?"<>|]+', "_", name)
    return name[:120] or "file"


def check_id(x: str) -> str:
    if not re.fullmatch(r"[A-Za-z0-9_-]{1,64}", x or ""):
        raise HTTPException(400, "잘못된 식별자")
    return x


def job_dir(jid):
    d = os.path.join(JOBS, check_id(jid))
    if not os.path.isdir(d):
        raise HTTPException(404, "작업이 없습니다")
    return d


def load_job(jid):
    return rjson(os.path.join(job_dir(jid), "job.json"))


def save_job(jid, **upd):
    with LOCK:
        p = os.path.join(job_dir(jid), "job.json")
        j = rjson(p, {})
        j.update(upd)
        j["updatedAt"] = now()
        wjson(p, j)
        return j


# ------------------------------------------------------------------ voiceprints / glossary
VP = os.path.join(DATA, "voiceprints.json")
GL = os.path.join(DATA, "glossary.json")
SETTINGS = os.path.join(DATA, "settings.json")


def vp_load():
    return rjson(VP, {})


def vp_add(fresh: dict, source: str):
    """이름이 정해진 사람만 저장한다(「Speaker 1」 같은 임시 이름은 이번 작업에만 쓴다).
    같은 출처(회의)로 다시 처리하면 덧붙이지 않고 바꿔 넣는다."""
    with LOCK:
        store = vp_load()
        for name, d in fresh.items():
            if E.is_generic(name):
                continue
            ent = store.setdefault(name, {"items": {}, "model": "campplus"})
            ent["items"][source] = {"vec": d["vec"], "n": d["n"], "at": now()}
            ent["updatedAt"] = now()
        wjson(VP, store)


# ------------------------------------------------------------------ worker
class Worker:
    def __init__(self):
        self.q: list[str] = []
        self.cur: str | None = None
        self.stop_flag = False
        self.cv = threading.Condition()
        self.setup_state = {"running": False, "msg": "", "error": None}
        self.engine = None
        threading.Thread(target=self.loop, daemon=True).start()

    def settings(self):
        return rjson(SETTINGS, {}) or {}

    def get_engine(self):
        th = int(self.settings().get("threads") or 0) or None
        if self.engine is None or (th and self.engine.threads != th):
            self.engine = E.Engine(MODELS, th)
        return self.engine

    def enqueue(self, jid):
        with self.cv:
            if jid not in self.q and jid != self.cur:
                self.q.append(jid)
            self.cv.notify()

    def stop(self, jid):
        with self.cv:
            if jid in self.q:
                self.q.remove(jid)
            if jid == self.cur:
                self.stop_flag = True

    def start_setup(self):
        if self.setup_state["running"]:
            return

        def go():
            self.setup_state.update(running=True, error=None, msg="시작")
            try:
                E.setup(MODELS, progress=lambda m: self.setup_state.update(msg=m))
            except Exception as ex:  # noqa: BLE001
                self.setup_state.update(error=str(ex), msg="모델 준비 실패")
            finally:
                self.setup_state["running"] = False
                with self.cv:
                    self.cv.notify()

        threading.Thread(target=go, daemon=True).start()

    def loop(self):
        while True:
            with self.cv:
                while not self.q or not E.models_ready(MODELS):
                    self.cv.wait(timeout=5)
                jid = self.q.pop(0)
                self.cur, self.stop_flag = jid, False
            try:
                self.process(jid)
            except Exception as ex:  # noqa: BLE001
                traceback.print_exc()
                try:
                    save_job(jid, status="오류", error=f"{type(ex).__name__}: {ex}"[:300])
                except Exception:  # noqa: BLE001
                    pass
            finally:
                self.cur = None

    def process(self, jid):
        d = job_dir(jid)
        job = save_job(jid, status="처리중", error=None, startedAt=now(), progress={"pct": 1, "msg": "준비"})
        last = [0.0]

        def prog(pct, msg):
            if time.time() - last[0] > 2 or pct >= 99:
                last[0] = time.time()
                save_job(jid, progress={"pct": pct, "msg": msg})

        result, fresh = E.run_job(self.get_engine(), d, job, vp_load(), prog, lambda: self.stop_flag)
        if result is None:
            pct = (load_job(jid).get("progress") or {}).get("pct", 0)
            save_job(jid, status="중지", progress={"pct": pct, "msg": "중지됨 — 다시 시작하면 이어서 합니다"})
            return
        result["updatedAt"] = now()
        wjson(os.path.join(d, "result.json"), result)
        if fresh:
            vp_add(fresh, job.get("title") or jid)
        save_job(jid, status="완료", stats=result["stats"], finishedAt=now(), progress={"pct": 100, "msg": "완료"})


W = Worker()


def resume_jobs():
    if not E.models_ready(MODELS):
        W.start_setup()
    for jid in sorted(os.listdir(JOBS)):
        j = rjson(os.path.join(JOBS, jid, "job.json"))
        if j and j.get("status") in ("대기", "처리중"):
            W.enqueue(jid)


from contextlib import asynccontextmanager


@asynccontextmanager
async def lifespan(_app):
    resume_jobs()
    yield


app = FastAPI(title="Plaud 보강 작업대", lifespan=lifespan)


# ------------------------------------------------------------------ system
@app.get("/api/system")
def system():
    du = shutil.disk_usage(DATA)
    return {"modelsReady": E.models_ready(MODELS), "setup": W.setup_state, "fake": E.FAKE,
            "cpu": os.cpu_count(), "threads": W.get_engine().threads, "queue": W.q, "current": W.cur,
            "diskFreeGB": round(du.free / 2**30, 1), "codespace": os.environ.get("CODESPACE_NAME")}


@app.post("/api/system/setup")
def system_setup():
    W.start_setup()
    return {"ok": True}


@app.put("/api/settings")
def put_settings(body: dict = Body(...)):
    s = rjson(SETTINGS, {}) or {}
    if "threads" in body:
        s["threads"] = max(0, min(64, int(body["threads"] or 0)))
    wjson(SETTINGS, s)
    return s


# ------------------------------------------------------------------ uploads (조각 올리기)
@app.post("/api/uploads")
def upload_new(body: dict = Body(...)):
    uid = secrets.token_hex(8)
    meta = {"name": safe_name(body.get("name")), "size": int(body.get("size") or 0), "got": 0, "next": 0}
    wjson(os.path.join(UPL, uid + ".json"), meta)
    open(os.path.join(UPL, uid + ".part"), "wb").close()
    return {"id": uid}


@app.put("/api/uploads/{uid}/{idx}")
async def upload_part(uid: str, idx: int, request: Request):
    check_id(uid)
    mp = os.path.join(UPL, uid + ".json")
    meta = rjson(mp)
    if not meta:
        raise HTTPException(404, "올리기 정보가 없습니다")
    if idx != meta["next"]:
        if idx < meta["next"]:
            return meta  # 같은 조각을 다시 보낸 경우
        raise HTTPException(409, f"{meta['next']}번 조각부터 보내야 합니다")
    body = await request.body()
    with open(os.path.join(UPL, uid + ".part"), "ab") as f:
        f.write(body)
    meta["got"] += len(body)
    meta["next"] += 1
    wjson(mp, meta)
    return meta


def upload_path(uid):
    check_id(uid)
    p = os.path.join(UPL, uid + ".part")
    meta = rjson(os.path.join(UPL, uid + ".json"))
    if not meta or not os.path.exists(p):
        raise HTTPException(404, "올린 파일이 없습니다")
    if meta["size"] and meta["got"] != meta["size"]:
        raise HTTPException(400, f"{meta['name']}: 덜 올라갔습니다({meta['got']}/{meta['size']})")
    return p, meta


def probe_duration(path) -> float | None:
    try:
        r = subprocess.run([E.ffmpeg_bin(), "-hide_banner", "-i", path], capture_output=True, text=True, timeout=60)
        m = re.search(r"Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)", r.stderr)
        return int(m.group(1)) * 3600 + int(m.group(2)) * 60 + float(m.group(3)) if m else None
    except Exception:  # noqa: BLE001
        return None


@app.post("/api/uploads/{uid}/probe")
def upload_probe(uid: str):
    p, meta = upload_path(uid)
    return {"name": meta["name"], "bytes": meta["got"], "durationSec": probe_duration(p)}


@app.post("/api/uploads/{uid}/transcript")
def upload_transcript(uid: str):
    p, meta = upload_path(uid)
    try:
        r = plaud_import.parse(meta["name"], open(p, "rb").read())
    except Exception as ex:  # noqa: BLE001
        raise HTTPException(400, f"전사 파일을 읽지 못했습니다: {ex}")
    wjson(os.path.join(UPL, uid + ".plaud.json"), r["segs"])
    return {"name": meta["name"], "count": len(r["segs"]), "speakers": r["speakers"], "endSec": r["endSec"],
            "warnings": r["warnings"], "preview": r["segs"][:5]}


# ------------------------------------------------------------------ jobs
@app.get("/api/jobs")
def jobs():
    out = []
    for jid in os.listdir(JOBS):
        j = rjson(os.path.join(JOBS, jid, "job.json"))
        if j:
            j["id"] = jid
            j["hasResult"] = os.path.exists(os.path.join(JOBS, jid, "result.json"))
            out.append(j)
    out.sort(key=lambda j: j.get("createdAt", ""), reverse=True)
    return out


@app.post("/api/jobs")
def create_job(body: dict = Body(...)):
    mode = body.get("mode")
    if mode not in ("gap", "range", "fragment", "enroll"):
        raise HTTPException(400, "작업 유형이 잘못됐습니다")
    ups = body.get("audio") or []
    if not ups:
        raise HTTPException(400, "음원을 올려 주세요")
    if mode in ("gap", "range", "enroll") and len(ups) != 1:
        raise HTTPException(400, "이 유형은 음원 1개만 받습니다(여러 조각은 「조각 음원」 유형)")
    tr = body.get("transcript")
    if mode in ("gap", "enroll") and not tr:
        raise HTTPException(400, "이 유형은 Plaud 전사 파일이 필요합니다")
    if mode == "range":
        r = body.get("range") or {}
        if float(r.get("to", 0)) <= float(r.get("from", 0)):
            raise HTTPException(400, "구간의 끝이 시작보다 뒤여야 합니다")
    jid = datetime.now().strftime("%Y%m%d-%H%M%S") + "-" + secrets.token_hex(2)
    d = os.path.join(JOBS, jid)
    os.makedirs(os.path.join(d, "src"))
    names = []
    for i, u in enumerate(ups):
        p, meta = upload_path(u["id"])
        nm = f"{i}_{meta['name']}"
        shutil.move(p, os.path.join(d, "src", nm))
        names.append(nm)
    tinfo = None
    if tr:
        pj = os.path.join(UPL, check_id(tr["id"]) + ".plaud.json")
        segs = rjson(pj)
        if segs is None:
            raise HTTPException(400, "전사 파일을 먼저 읽어 주세요")
        wjson(os.path.join(d, "plaud.json"), segs)
        tinfo = {"name": tr.get("name"), "count": len(segs), "endSec": max((g["end"] for g in segs), default=0)}
    job = {
        "title": (body.get("title") or "").strip() or names[0][2:],
        "mode": mode, "status": "대기", "createdAt": now(), "updatedAt": now(),
        "audioFiles": names, "transcript": tinfo,
        "transcriptEndSec": float(body.get("transcriptEndSec") or (tinfo or {}).get("endSec") or 0),
        "range": body.get("range"), "speakerMap": body.get("speakerMap") or {},
        "speakers": body.get("speakers") or [], "useVoiceprints": bool(body.get("useVoiceprints", True)),
        "note": body.get("note") or "", "progress": {"pct": 0, "msg": "대기"},
    }
    wjson(os.path.join(d, "job.json"), job)
    for u in ups + ([tr] if tr else []):
        for ext in (".json", ".part", ".plaud.json"):
            try:
                os.remove(os.path.join(UPL, u["id"] + ext))
            except FileNotFoundError:
                pass
    W.enqueue(jid)
    return {"id": jid}


@app.get("/api/jobs/{jid}")
def get_job(jid: str):
    j = load_job(jid)
    j["id"] = jid
    return j


@app.patch("/api/jobs/{jid}")
def patch_job(jid: str, body: dict = Body(...)):
    allowed = {k: body[k] for k in ("title", "note") if k in body}
    return save_job(jid, **allowed)


@app.post("/api/jobs/{jid}/stop")
def stop_job(jid: str):
    j = load_job(jid)
    W.stop(jid)
    if j.get("status") == "대기":
        save_job(jid, status="중지")
    return {"ok": True}


@app.post("/api/jobs/{jid}/start")
def start_job(jid: str, body: dict = Body(default={})):
    d = job_dir(jid)
    if body.get("fresh"):  # 처음부터 다시
        for f in ("partial.jsonl", "chunks.json", "result.json", "enroll.json"):
            try:
                os.remove(os.path.join(d, f))
            except FileNotFoundError:
                pass
    save_job(jid, status="대기", error=None, progress={"pct": 0, "msg": "대기"})
    W.enqueue(jid)
    return {"ok": True}


@app.delete("/api/jobs/{jid}")
def delete_job(jid: str):
    d = job_dir(jid)
    W.stop(jid)
    for _ in range(20):
        if W.cur != jid:
            break
        time.sleep(0.5)
    shutil.rmtree(d, ignore_errors=True)
    return {"ok": True}


@app.delete("/api/jobs/{jid}/audio")
def delete_job_audio(jid: str):
    """결과는 남기고 음원만 지운다(용량·보안)."""
    d = job_dir(jid)
    for sub in ("src", "wav"):
        shutil.rmtree(os.path.join(d, sub), ignore_errors=True)
    save_job(jid, audioDeleted=True)
    return {"ok": True}


@app.get("/api/jobs/{jid}/result")
def get_result(jid: str):
    d = job_dir(jid)
    res = rjson(os.path.join(d, "result.json"))
    if res is None:
        raise HTTPException(404, "아직 결과가 없습니다")
    return {"result": res, "edits": rjson(os.path.join(d, "edits.json"), {"e": {}}),
            "plaud": rjson(os.path.join(d, "plaud.json"), []), "job": load_job(jid)}


@app.put("/api/jobs/{jid}/edits")
def put_edits(jid: str, body: dict = Body(...)):
    d = job_dir(jid)
    e = body.get("e") or {}
    clean = {}
    for k, v in e.items():
        if not str(k).isdigit() or not isinstance(v, dict):
            continue
        clean[str(k)] = {x: v[x] for x in ("speaker", "text", "ok") if x in v}
    wjson(os.path.join(d, "edits.json"), {"e": clean, "updatedAt": now()})
    return {"ok": True}


@app.get("/api/jobs/{jid}/clip")
def clip(jid: str, file: int = 0, start: float = 0, end: float = 0):
    d = job_dir(jid)
    wav = os.path.join(d, "wav", f"{int(file)}.wav")
    if not os.path.exists(wav):
        raise HTTPException(404, "음원이 없습니다(지웠거나 아직 변환 전)")
    end = max(end, start + 0.5)
    if end - start > 120:
        end = start + 120
    return Response(E.clip_wav_bytes(wav, start, end), media_type="audio/wav", headers={"Cache-Control": "max-age=3600"})


def hms(t):
    t = int(round(t))
    return f"{t // 3600:02d}:{t % 3600 // 60:02d}:{t % 60:02d}"


def apply_glossary(text, pairs):
    for p in pairs:
        if p.get("from"):
            text = text.replace(p["from"], p.get("to", ""))
    return text


def merged_lines(jid, use_plaud=True, use_gl=True):
    d = job_dir(jid)
    res = rjson(os.path.join(d, "result.json"))
    if res is None:
        raise HTTPException(404, "아직 결과가 없습니다")
    job = load_job(jid)
    edits = (rjson(os.path.join(d, "edits.json"), {}) or {}).get("e", {})
    pairs = (rjson(GL, {}) or {}).get("pairs", []) if use_gl else []
    smap = job.get("speakerMap") or {}
    lines = []
    targets = res["stats"].get("targets", [])
    multi = len(job.get("audioFiles", [])) > 1
    if use_plaud and job["mode"] in ("gap", "range"):
        def inside(g):
            return any(t["from"] <= g["start"] < t["to"] for t in targets if t["file"] == 0)
        for g in rjson(os.path.join(d, "plaud.json"), []):
            if not inside(g):
                lines.append({"t": g["start"], "file": 0, "spk": smap.get(g["speaker"], g["speaker"]) or "화자 미상",
                              "text": g["text"], "src": "Plaud"})
    for g in res["segs"]:
        ed = edits.get(str(g["i"]), {})
        spk = ed.get("speaker") or g["speaker"]
        tag = "보충" if job["mode"] in ("gap", "range") else ""
        if not ed.get("speaker") and g["kind"] == "혼재":
            tag = (tag + "·화자 혼재").strip("·")
        lines.append({"t": g["start"], "file": g.get("file", 0), "spk": spk, "text": ed.get("text") or g["text"], "src": tag})
    lines.sort(key=lambda x: (x["file"], x["t"]))
    for x in lines:
        x["text"] = apply_glossary(x["text"], pairs)
        x["spk"] = apply_glossary(x["spk"], pairs)
        x["multi"] = multi
    return job, lines


@app.get("/api/jobs/{jid}/export")
def export(jid: str, fmt: str = "txt", plaud: int = 1, glossary: int = 1):
    job, lines = merged_lines(jid, bool(plaud), bool(glossary))
    files = [n[2:] for n in job.get("audioFiles", [])]
    base = safe_name(job.get("title") or jid)
    if fmt == "csv":
        import csv
        buf = io.StringIO()
        w = csv.writer(buf)
        w.writerow(["파일", "시각", "화자", "발언", "출처"])
        for x in lines:
            w.writerow([files[x["file"]] if x["file"] < len(files) else x["file"], hms(x["t"]), x["spk"], x["text"], x["src"]])
        data, ext, mt = ("﻿" + buf.getvalue()).encode("utf-8"), "csv", "text/csv"
    else:
        out = [f"{job.get('title')}", f"내보낸 시각: {datetime.now().strftime('%Y-%m-%d %H:%M')}", ""]
        cur_file = None
        for x in lines:
            if x["multi"] and x["file"] != cur_file:
                cur_file = x["file"]
                out += ["", f"■ {files[cur_file] if cur_file < len(files) else cur_file}", ""]
            tag = f" ({x['src']})" if x["src"] and x["src"] != "Plaud" else ""
            out.append(f"[{hms(x['t'])}] {x['spk']}{tag}: {x['text']}")
        data, ext, mt = ("\n".join(out) + "\n").encode("utf-8"), "txt", "text/plain; charset=utf-8"
    from urllib.parse import quote
    fn = quote(f"{base}_통합본.{ext}")
    return Response(data, media_type=mt, headers={"Content-Disposition": f"attachment; filename*=UTF-8''{fn}"})


# ------------------------------------------------------------------ voiceprints
@app.get("/api/voiceprints")
def voiceprints():
    out = []
    for name, ent in sorted(vp_load().items()):
        items = ent.get("items", {})
        out.append({"name": name, "n": sum(i["n"] for i in items.values()), "updatedAt": ent.get("updatedAt"),
                    "sources": [{"source": s, "n": i["n"], "at": i.get("at")} for s, i in items.items()]})
    return out


@app.delete("/api/voiceprints/{name}")
def vp_delete(name: str, source: str | None = None):
    with LOCK:
        store = vp_load()
        if name not in store:
            raise HTTPException(404, "없는 이름")
        if source:
            store[name]["items"].pop(source, None)
            if not store[name]["items"]:
                store.pop(name)
        else:
            store.pop(name)
        wjson(VP, store)
    return {"ok": True}


@app.post("/api/voiceprints/rename")
def vp_rename(body: dict = Body(...)):
    a, b = (body.get("from") or "").strip(), (body.get("to") or "").strip()
    if not a or not b:
        raise HTTPException(400, "이름을 넣어 주세요")
    with LOCK:
        store = vp_load()
        if a not in store:
            raise HTTPException(404, "없는 이름")
        ent = store.pop(a)
        if b in store:  # 같은 사람이면 합친다
            store[b]["items"].update(ent["items"])
        else:
            store[b] = ent
        store[b]["updatedAt"] = now()
        wjson(VP, store)
    return {"ok": True}


# ------------------------------------------------------------------ glossary
@app.get("/api/glossary")
def glossary():
    return rjson(GL, {"pairs": []})


@app.put("/api/glossary")
def put_glossary(body: dict = Body(...)):
    pairs = [{"from": str(p.get("from", "")).strip(), "to": str(p.get("to", "")).strip()}
             for p in body.get("pairs", []) if str(p.get("from", "")).strip()]
    wjson(GL, {"pairs": pairs, "updatedAt": now()})
    return {"pairs": pairs}


# ------------------------------------------------------------------ backup / restore
@app.get("/api/backup")
def backup():
    """음원을 뺀 전부(목소리 기준·사전·작업·결과·검수)를 zip으로 내려준다.
    Codespace는 오래 안 쓰면 지워지므로 가끔 받아 두고, 새 Codespace에서 올리면 된다."""
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        for f in ("voiceprints.json", "glossary.json", "settings.json"):
            p = os.path.join(DATA, f)
            if os.path.exists(p):
                z.write(p, f)
        for jid in os.listdir(JOBS):
            for f in ("job.json", "result.json", "edits.json", "plaud.json"):
                p = os.path.join(JOBS, jid, f)
                if os.path.exists(p):
                    z.write(p, f"jobs/{jid}/{f}")
    fn = f"plaud-booster-backup-{datetime.now().strftime('%Y%m%d-%H%M')}.zip"
    return Response(buf.getvalue(), media_type="application/zip",
                    headers={"Content-Disposition": f"attachment; filename={fn}"})


@app.post("/api/restore")
async def restore(request: Request):
    """백업 zip을 합쳐 넣는다. 목소리 기준은 이름·출처별로 합치고, 같은 작업은 건너뛴다."""
    data = await request.body()
    try:
        z = zipfile.ZipFile(io.BytesIO(data))
    except zipfile.BadZipFile:
        raise HTTPException(400, "백업 zip이 아닙니다")
    added = {"voiceprints": 0, "glossary": 0, "jobs": 0}
    with LOCK:
        names = z.namelist()
        if "voiceprints.json" in names:
            store = vp_load()
            for name, ent in json.loads(z.read("voiceprints.json")).items():
                cur = store.setdefault(name, {"items": {}, "model": "campplus"})
                for s, it in ent.get("items", {}).items():
                    if s not in cur["items"]:
                        cur["items"][s] = it
                        added["voiceprints"] += 1
                cur["updatedAt"] = now()
            wjson(VP, store)
        if "glossary.json" in names:
            g = rjson(GL, {"pairs": []})
            have = {(p["from"], p["to"]) for p in g["pairs"]}
            for p in json.loads(z.read("glossary.json")).get("pairs", []):
                if (p["from"], p["to"]) not in have:
                    g["pairs"].append(p)
                    added["glossary"] += 1
            wjson(GL, g)
        for n in names:
            m = re.fullmatch(r"jobs/([A-Za-z0-9_-]{1,64})/(job|result|edits|plaud)\.json", n)
            if not m:
                continue
            d = os.path.join(JOBS, m.group(1))
            if m.group(2) == "job":
                if os.path.exists(os.path.join(d, "job.json")):
                    continue
                added["jobs"] += 1
            elif os.path.exists(os.path.join(d, n.split("/")[-1])):
                continue
            os.makedirs(d, exist_ok=True)
            obj = json.loads(z.read(n))
            if m.group(2) == "job":
                obj["audioDeleted"] = True
                if obj.get("status") in ("대기", "처리중"):
                    obj["status"] = "중지"
            wjson(os.path.join(d, n.split("/")[-1]), obj)
    return added


# ------------------------------------------------------------------ static
STATIC = os.path.join(os.path.dirname(os.path.abspath(__file__)), "static")


@app.get("/")
def index():
    return FileResponse(os.path.join(STATIC, "index.html"), headers={"Cache-Control": "no-cache"})


app.mount("/static", StaticFiles(directory=STATIC), name="static")


@app.exception_handler(HTTPException)
async def http_err(_, exc: HTTPException):
    return JSONResponse({"error": exc.detail}, status_code=exc.status_code)


def main():
    import uvicorn
    host = os.environ.get("PB_HOST", "127.0.0.1")
    port = int(os.environ.get("PB_PORT", "8765"))
    uvicorn.run(app, host=host, port=port, log_level="warning")


if __name__ == "__main__":
    main()
