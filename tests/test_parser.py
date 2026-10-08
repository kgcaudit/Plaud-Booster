from app import plaud_import as P


def names(segs):
    return [(round(g["start"]), g["speaker"], g["text"]) for g in segs]


def test_ts_then_speaker_block():
    t = "00:00:01 김응옥\n안녕하세요 시작하겠습니다.\n\n00:00:15 Speaker 2\n네 좋습니다.\n추가로 말씀드리면\n"
    r = P.parse("a.txt", t.encode())
    assert names(r["segs"]) == [(1, "김응옥", "안녕하세요 시작하겠습니다."), (15, "Speaker 2", "네 좋습니다. 추가로 말씀드리면")]
    assert r["segs"][0]["end"] == 15


def test_speaker_then_ts_block():
    t = "Speaker 1 00:01:05\n첫 발언입니다.\nSpeaker 2 00:01:20\n둘째 발언."
    r = P.parse("a.txt", t.encode())
    assert names(r["segs"]) == [(65, "Speaker 1", "첫 발언입니다."), (80, "Speaker 2", "둘째 발언.")]


def test_one_line_bracket():
    t = "[00:00:03] 배소정: 금액이 너무 커요\n[00:00:09] 하상수: 네 맞습니다"
    r = P.parse("a.txt", t.encode())
    assert names(r["segs"]) == [(3, "배소정", "금액이 너무 커요"), (9, "하상수", "네 맞습니다")]


def test_speaker_paren_ts():
    t = "김응옥 (01:05): 이건 이렇게\n고태준 (1:01:07): 그렇죠"
    r = P.parse("a.txt", t.encode())
    assert names(r["segs"]) == [(65, "김응옥", "이건 이렇게"), (3667, "고태준", "그렇죠")]


def test_range_lines():
    t = "00:00:01 - 00:00:04 Speaker 1\n가나다\n00:00:05 - 00:00:09 Speaker 2: 라마바"
    r = P.parse("a.txt", t.encode())
    assert [(g["start"], g["end"], g["speaker"], g["text"]) for g in r["segs"]] == [(1, 4, "Speaker 1", "가나다"), (5, 9, "Speaker 2", "라마바")]


def test_srt_with_speaker():
    t = "1\n00:00:01,000 --> 00:00:04,500\n김응옥: 안녕하세요\n\n2\n00:00:05,000 --> 00:00:08,000\n[Speaker 2] 네\n"
    r = P.parse("a.srt", t.encode())
    assert [(g["start"], g["end"], g["speaker"], g["text"]) for g in r["segs"]] == [(1, 4.5, "김응옥", "안녕하세요"), (5, 8, "Speaker 2", "네")]


def test_cp949_and_bom():
    t = "00:00:01 김응옥\n한글 인코딩"
    assert P.parse("a.txt", t.encode("cp949"))["segs"][0]["text"] == "한글 인코딩"
    assert P.parse("a.txt", ("﻿" + t).encode())["segs"][0]["speaker"] == "김응옥"


def test_json_connector_dedupe():
    import json
    d = [{"start_time": 1000, "end_time": 3000, "speaker": "김응옥", "content": "가"},
         {"start_time": 1000, "end_time": 3000, "speaker": "김응옥", "content": "가"},
         {"start_time": 4000, "end_time": 6000, "speaker": "배소정", "content": "나"}]
    r = P.parse("a.json", json.dumps(d).encode())
    assert names(r["segs"]) == [(1, "김응옥", "가"), (4, "배소정", "나")]


def test_docx():
    import io, zipfile
    xml = ('<w:document xmlns:w="x"><w:body><w:p><w:r><w:t>00:00:02 김응옥</w:t></w:r></w:p>'
           '<w:p><w:r><w:t>문서 &amp; 발언</w:t></w:r></w:p></w:body></w:document>')
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        z.writestr("word/document.xml", xml)
    r = P.parse("a.docx", buf.getvalue())
    assert names(r["segs"]) == [(2, "김응옥", "문서 & 발언")]


def test_no_timestamps_warns():
    r = P.parse("a.txt", "김응옥: 시간 없는 발언\n배소정: 또".encode())
    assert r["segs"] == [] and r["warnings"]


def test_role_suffix_stripped():
    r = P.parse("a.txt", "00:00:01 김응옥 (법제팀장)\n발언".encode())
    assert r["segs"][0]["speaker"] == "김응옥"
