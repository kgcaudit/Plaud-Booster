"""Plaud에서 내보낸 전사 파일(TXT·SRT·DOCX·JSON)을 [{start,end,speaker,text}] (초)로 읽는다.

Plaud 내보내기는 시간·화자 표시를 켜고 끌 수 있고 형식도 조금씩 달라서, 흔한 배치를 모두 받는다.
  00:01:05 김응옥            (시간 다음 화자, 다음 줄부터 발언)
  김응옥 00:01:05            (화자 다음 시간)
  [00:01:05] 김응옥: 발언     (한 줄)
  김응옥 (01:05): 발언
  00:01:05 - 00:01:12 김응옥 (구간)
  SRT 블록 (본문이 「화자: 발언」이면 화자를 뗀다)
  Plaud 커넥터 JSON (start_time/end_time 밀리초, speaker, content)
시간이 없으면 화자 기준을 만들 수 없으므로, 그런 파일은 오류 대신 경고를 돌려준다.
"""
from __future__ import annotations

import io
import json
import re
import zipfile

TS = r"(?:\d{1,2}:)?\d{1,2}:\d{2}(?:[.,]\d{1,3})?"
RE_SRT_TIME = re.compile(rf"^\s*({TS})\s*-->\s*({TS})")
RE_RANGE = re.compile(rf"^\s*\[?({TS})\]?\s*[-~–]\s*\[?({TS})\]?\s*(.*)$")
RE_TS_FIRST = re.compile(rf"^\s*[\[(]?({TS})[\])]?\s*[-|·]?\s*(.*)$")
RE_TS_LAST = re.compile(rf"^\s*(.+?)\s*[\[(]?({TS})[\])]?\s*:?\s*$")
RE_SPK_TS_TEXT = re.compile(rf"^\s*(.{{1,40}}?)\s*[\[(]({TS})[\])]\s*[:：]\s*(.+)$")
RE_SPK_TEXT = re.compile(r"^\s*([^:：\s][^:：]{0,30}?)\s*[:：]\s*(.+)$")


def ts(s: str) -> float:
    s = s.replace(",", ".")
    parts = s.split(":")
    v = 0.0
    for p in parts:
        v = v * 60 + float(p)
    return v


def _looks_like_speaker(s: str) -> bool:
    s = s.strip()
    return 0 < len(s) <= 30 and not re.search(r"[.?!。]$", s) and len(s.split()) <= 4


def _finish(segs: list[dict]) -> list[dict]:
    segs = [g for g in segs if g.get("text", "").strip()]
    segs.sort(key=lambda g: g["start"])
    for i, g in enumerate(segs):
        if g.get("end") is None or g["end"] <= g["start"]:
            nxt = segs[i + 1]["start"] if i + 1 < len(segs) else None
            if nxt and nxt > g["start"]:
                g["end"] = min(nxt, g["start"] + 60.0)   # 다음 발언 시작까지(Plaud 발언은 대개 이어 붙어 있다)
            else:
                g["end"] = g["start"] + min(30.0, max(2.0, len(g["text"]) * 0.18))
        g["text"] = re.sub(r"\s+", " ", g["text"]).strip()
        # Plaud는 「김응옥 (법제팀장)」처럼 직함을 괄호로 붙인다 — 목소리 기준은 이름으로 모은다
        g["speaker"] = re.sub(r"\s*[(（][^()（）]*[)）]\s*$", "", (g.get("speaker") or "").strip())
        g["start"], g["end"] = round(g["start"], 2), round(g["end"], 2)
    return segs


def parse_srt(text: str) -> list[dict]:
    segs = []
    for block in re.split(r"\n\s*\n", text.strip()):
        lines = [l for l in block.strip().splitlines() if l.strip()]
        if lines and lines[0].strip().isdigit():
            lines = lines[1:]
        if not lines:
            continue
        m = RE_SRT_TIME.match(lines[0])
        if not m:
            continue
        body = " ".join(lines[1:]).strip()
        spk = ""
        mm = re.match(r"^\[([^\]]{1,30})\]\s*[:：]?\s*(.+)$", body) or re.match(r"^([^:：]{1,30}?)\s*[:：]\s*(.+)$", body)
        if mm:
            spk, body = mm.group(1), mm.group(2)
        segs.append({"start": ts(m.group(1)), "end": ts(m.group(2)), "speaker": spk, "text": body})
    return _finish(segs)


def parse_txt(text: str) -> list[dict]:
    lines = [l.rstrip() for l in text.replace("\r\n", "\n").replace("﻿", "").split("\n")]
    segs: list[dict] = []
    cur = None

    def start(t0, spk, body="", t1=None):
        nonlocal cur
        cur = {"start": t0, "end": t1, "speaker": spk or (cur["speaker"] if cur else ""), "text": body}
        segs.append(cur)

    for raw in lines:
        line = raw.strip()
        if not line:
            continue
        m = RE_SPK_TS_TEXT.match(line)              # 김응옥 (01:05): 발언
        if m and _looks_like_speaker(m.group(1)):
            start(ts(m.group(2)), m.group(1), m.group(3))
            continue
        m = RE_RANGE.match(line)                    # 00:01:05 - 00:01:12 김응옥[: 발언]
        if m:
            rest = m.group(3).strip()
            mm = RE_SPK_TEXT.match(rest)
            if mm:
                start(ts(m.group(1)), mm.group(1), mm.group(2), ts(m.group(2)))
            else:
                start(ts(m.group(1)), rest if _looks_like_speaker(rest) else "", "" if _looks_like_speaker(rest) else rest,
                      ts(m.group(2)))
            continue
        m = RE_TS_FIRST.match(line)                 # [00:01:05] 김응옥: 발언 / 00:01:05 김응옥
        if m:
            rest = m.group(2).strip()
            mm = RE_SPK_TEXT.match(rest)
            if mm and _looks_like_speaker(mm.group(1)):
                start(ts(m.group(1)), mm.group(1), mm.group(2))
            elif not rest or _looks_like_speaker(rest):
                start(ts(m.group(1)), rest)
            else:
                start(ts(m.group(1)), "", rest)
            continue
        m = RE_TS_LAST.match(line)                  # 김응옥 00:01:05
        if m and _looks_like_speaker(m.group(1)):
            start(ts(m.group(2)), m.group(1))
            continue
        if cur is not None:
            cur["text"] = (cur["text"] + " " + line).strip()
        else:
            mm = RE_SPK_TEXT.match(line)            # 시간 없는 「화자: 발언」
            if mm:
                segs.append({"start": None, "end": None, "speaker": mm.group(1), "text": mm.group(2)})
    if segs and all(g["start"] is None for g in segs):
        return []
    return _finish([g for g in segs if g["start"] is not None])


def docx_text(data: bytes) -> str:
    with zipfile.ZipFile(io.BytesIO(data)) as z:
        xml = z.read("word/document.xml").decode("utf-8")
    out = []
    for p in re.findall(r"<w:p[ >].*?</w:p>", xml, flags=re.S):
        p = re.sub(r"<w:tab/>", "\t", p)
        p = re.sub(r"<w:br/>", "\n", p)
        t = "".join(re.findall(r"<w:t(?: [^>]*)?>(.*?)</w:t>", p, flags=re.S))
        t = t.replace("&lt;", "<").replace("&gt;", ">").replace("&quot;", '"').replace("&apos;", "'").replace("&amp;", "&")
        out.append(t)
    return "\n".join(out)


def parse_json(data) -> list[dict]:
    if isinstance(data, dict):
        data = data.get("segments") or data.get("segs") or data.get("data") or []
    segs = []
    for g in data:
        if "start_time" in g:
            segs.append({"start": g["start_time"] / 1000, "end": g.get("end_time", 0) / 1000,
                         "speaker": g.get("speaker", ""), "text": g.get("content") or g.get("text", "")})
        else:
            segs.append({"start": float(g["start"]), "end": float(g.get("end") or 0),
                         "speaker": g.get("speaker", ""), "text": g.get("text", "")})
    # 커넥터 응답은 같은 구간이 겹쳐 나올 때가 있다
    uniq = {}
    for g in segs:
        uniq[(round(g["start"], 2), g["speaker"])] = g
    return _finish(list(uniq.values()))


def parse(filename: str, data: bytes) -> dict:
    name = filename.lower()
    warn = []
    if name.endswith(".docx"):
        text = docx_text(data)
        segs = parse_srt(text) if RE_SRT_TIME.search(text) else parse_txt(text)
    elif name.endswith(".json"):
        segs = parse_json(json.loads(data.decode("utf-8")))
    elif name.endswith(".pdf"):
        raise ValueError("PDF는 읽지 않습니다. Plaud에서 TXT·SRT·DOCX로 내보내 주세요.")
    else:
        for enc in ("utf-8-sig", "cp949", "utf-16"):
            try:
                text = data.decode(enc)
                break
            except UnicodeDecodeError:
                continue
        else:
            raise ValueError("글자 인코딩을 알 수 없습니다.")
        segs = parse_srt(text) if (name.endswith(".srt") or RE_SRT_TIME.search(text)) else parse_txt(text)
    if not segs:
        warn.append("시간 표시를 찾지 못했습니다. Plaud에서 내보낼 때 「타임스탬프」와 「화자」를 켜 주세요.")
    elif not any(g["speaker"] for g in segs):
        warn.append("화자 표시가 없습니다. 이 전사로는 목소리 기준을 만들 수 없습니다.")
    speakers = {}
    for g in segs:
        if g["speaker"]:
            speakers[g["speaker"]] = speakers.get(g["speaker"], 0) + 1
    return {"segs": segs, "warnings": warn, "speakers": speakers,
            "endSec": max((g["end"] for g in segs), default=0)}
