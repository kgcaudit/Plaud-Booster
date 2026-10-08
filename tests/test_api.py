"""가짜 엔진(PB_FAKE_ENGINE=1)으로 올리기 → 작업 → 결과 → 검수 → 내보내기 → 백업까지 확인한다."""
import io
import json
import os
import time
import zipfile

import numpy as np
import pytest


@pytest.fixture()
def client(tmp_path, monkeypatch):
    monkeypatch.setenv("PB_FAKE_ENGINE", "1")
    monkeypatch.setenv("PB_DATA", str(tmp_path / "data"))
    monkeypatch.setenv("PB_MODELS", str(tmp_path / "models"))
    import importlib
    from app import engine, server
    importlib.reload(engine)
    importlib.reload(server)
    from fastapi.testclient import TestClient
    with TestClient(server.app) as c:
        yield c


def make_wav(path, seconds=90):
    import soundfile as sf
    sr = 16000
    t = np.arange(int(seconds * sr)) / sr
    a = np.zeros_like(t)
    for s in range(0, seconds, 6):  # 4초 말소리 + 2초 쉼
        m = (t >= s) & (t < s + 4)
        a[m] = 0.3 * np.sin(2 * np.pi * 220 * t[m]) * (1 + 0.5 * np.sin(2 * np.pi * 3 * t[m]))
    sf.write(path, a.astype("float32"), sr)


def upload(c, name, data):
    uid = c.post("/api/uploads", json={"name": name, "size": len(data)}).json()["id"]
    step = 50_000
    for i in range(0, max(1, (len(data) + step - 1) // step)):
        r = c.put(f"/api/uploads/{uid}/{i}", content=data[i * step:(i + 1) * step])
        assert r.status_code == 200, r.text
    return uid


def wait(c, jid, timeout=60):
    t0 = time.time()
    while time.time() - t0 < timeout:
        j = c.get(f"/api/jobs/{jid}").json()
        if j["status"] in ("완료", "오류"):
            return j
        time.sleep(0.3)
    raise AssertionError("작업이 끝나지 않음")


def test_gap_job_flow(client, tmp_path):
    c = client
    wav = tmp_path / "m.wav"
    make_wav(wav)
    aid = upload(c, "회의.wav", wav.read_bytes())
    assert c.post(f"/api/uploads/{aid}/probe").json()["durationSec"] == pytest.approx(90, abs=1)
    tr = "\n".join(f"00:00:{s:02d} {'김응옥' if s % 12 == 0 else 'Speaker 2'}\n발언 {s}" for s in range(0, 40, 6))
    tid = upload(c, "plaud.txt", tr.encode())
    info = c.post(f"/api/uploads/{tid}/transcript").json()
    assert info["count"] == 7 and "김응옥" in info["speakers"]

    r = c.post("/api/jobs", json={"mode": "gap", "title": "시험 회의", "audio": [{"id": aid}], "transcript": {"id": tid},
                                  "speakerMap": {"Speaker 2": "배소정"}})
    assert r.status_code == 200, r.text
    jid = r.json()["id"]
    j = wait(c, jid)
    assert j["status"] == "완료", j.get("error")
    res = c.get(f"/api/jobs/{jid}/result").json()
    segs = res["result"]["segs"]
    assert segs and all(g["start"] >= info["endSec"] - 15.5 for g in segs)  # 전사 끝 - 15초 이후만
    assert set(res["result"]["stats"]["enrolled"]) == {"김응옥", "배소정"}

    vps = {v["name"]: v for v in c.get("/api/voiceprints").json()}
    assert set(vps) == {"김응옥", "배소정"} and vps["김응옥"]["sources"][0]["source"] == "시험 회의"

    # 검수 수정 → 내보내기에 반영, 사전 적용
    c.put("/api/glossary", json={"pairs": [{"from": "가짜", "to": "진짜"}]})
    c.put(f"/api/jobs/{jid}/edits", json={"e": {"1": {"speaker": "고태준", "text": "고친 문장", "ok": True}}})
    txt = c.get(f"/api/jobs/{jid}/export?fmt=txt").content.decode()
    assert "고태준 (보충): 고친 문장" in txt
    assert "진짜 전사" in txt and "발언 0" in txt  # Plaud 전사도 합쳐짐
    csv = c.get(f"/api/jobs/{jid}/export?fmt=csv").content.decode("utf-8-sig")
    assert csv.splitlines()[0] == "파일,시각,화자,발언,출처"

    clip = c.get(f"/api/jobs/{jid}/clip?file=0&start=30&end=33")
    assert clip.status_code == 200 and clip.content[:4] == b"RIFF"

    # 같은 출처로 다시 처리하면 기준이 늘지 않고 바뀐다
    c.post(f"/api/jobs/{jid}/start", json={"fresh": True})
    wait(c, jid)
    vps2 = {v["name"]: v for v in c.get("/api/voiceprints").json()}
    assert len(vps2["김응옥"]["sources"]) == 1

    # 백업 → 새 저장소에 복원
    bk = c.get("/api/backup").content
    names = zipfile.ZipFile(io.BytesIO(bk)).namelist()
    assert "voiceprints.json" in names and f"jobs/{jid}/result.json" in names
    assert not any(n.endswith((".wav", ".mp3")) for n in names)
    c.delete(f"/api/jobs/{jid}")
    c.delete("/api/voiceprints/김응옥")
    r = c.post("/api/restore", content=bk, headers={"Content-Type": "application/zip"}).json()
    assert r["jobs"] == 1 and r["voiceprints"] >= 1
    j = c.get(f"/api/jobs/{jid}").json()
    assert j["audioDeleted"] is True


def test_fragment_job_uses_voiceprints(client, tmp_path):
    c = client
    ids = []
    for k in range(2):
        p = tmp_path / f"f{k}.wav"
        make_wav(p, 20)
        ids.append({"id": upload(c, f"조각{k}.wav", p.read_bytes())})
    r = c.post("/api/jobs", json={"mode": "fragment", "audio": ids})
    j = wait(c, r.json()["id"])
    assert j["status"] == "완료"
    res = c.get(f"/api/jobs/{r.json()['id']}/result").json()["result"]
    assert {g["file"] for g in res["segs"]} == {0, 1}
    assert all(g["kind"] == "미상" for g in res["segs"])  # 저장된 기준이 없으면 미상
    txt = c.get(f"/api/jobs/{r.json()['id']}/export").content.decode()
    assert "■ 조각0.wav" in txt and "■ 조각1.wav" in txt


def test_validation(client):
    c = client
    assert c.post("/api/jobs", json={"mode": "gap", "audio": []}).status_code == 400
    assert c.get("/api/jobs/../../etc").status_code in (400, 404)
    uid = c.post("/api/uploads", json={"name": "../../x.mp3", "size": 10}).json()["id"]
    assert c.put(f"/api/uploads/{uid}/1", content=b"x").status_code == 409


def test_resume_after_stop(client, tmp_path, monkeypatch):
    """중간에 멈춘 작업은 이미 처리한 구간을 다시 하지 않고 이어서 끝낸다."""
    from app import engine, server
    c = client
    p = tmp_path / "long.wav"
    make_wav(p, 120)
    aid = upload(c, "긴.wav", p.read_bytes())
    calls = []
    real = engine.Engine.transcribe

    def slow(self, wav, s, e):
        calls.append(s)
        if len(calls) == 3:
            server.W.stop_flag = True  # 세 번째 구간 뒤 멈춤 요청
        return real(self, wav, s, e)

    monkeypatch.setattr(engine.Engine, "transcribe", slow)
    jid = c.post("/api/jobs", json={"mode": "fragment", "audio": [{"id": aid}]}).json()["id"]
    t0 = time.time()
    while c.get(f"/api/jobs/{jid}").json()["status"] != "중지":
        assert time.time() - t0 < 30
        time.sleep(0.2)
    first = list(calls)
    c.post(f"/api/jobs/{jid}/start", json={})
    j = wait(c, jid)
    assert j["status"] == "완료"
    n = len(c.get(f"/api/jobs/{jid}/result").json()["result"]["segs"])
    assert len(calls) == n and len(set(calls)) == n  # 같은 구간을 두 번 전사하지 않음
    assert first == calls[:len(first)]
