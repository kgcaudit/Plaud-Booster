# 이 저장소에서 일하는 방식

Plaud 녹음 보강용 개인 웹앱입니다. GitHub Codespaces에서 `python -m app.server`(포트 8765)로 돌고,
사용자는 브라우저로 접속해 씁니다. 빌드 과정은 없습니다.

```
app/engine.py        전사(Whisper turbo)·화자 맞히기(CAM++)·작업 실행(이어하기 포함)
app/plaud_import.py  Plaud 내보내기 전사(TXT·SRT·DOCX·JSON) 읽기
app/server.py        FastAPI — 올리기(8MB 조각), 작업 대기열(한 번에 하나), 검수·내보내기·목소리 기준·사전·백업
app/static/          화면(index.html·app.js·style.css, 빌드 없음)
scripts/             setup.sh(Codespace 생성 시) · start.sh(켤 때마다) · stop.sh
tests/               pytest — PB_FAKE_ENGINE=1 로 모델 없이 전체 흐름 확인
```

## 변경 절차 — `main`에서 바로, 물어보지 말고 끝까지

1. `git pull origin main`으로 최신 상태에서 시작합니다.
2. 고칩니다. 새 동작을 넣거나 버그를 고치면 `tests/`에 검사를 추가합니다.
3. **밀기 전에 `PB_FAKE_ENGINE=1 python -m pytest -q`** 를 돌립니다. 실패하면 밀지 않습니다.
4. 엔진(`engine.py`)을 건드렸으면 실제 모델로 짧은 구간(2~3분)을 한 번 돌려 결과를 확인합니다.
5. 커밋하고 `git push origin main`. CI(`test`)가 빨간불이면 그 자리에서 고쳐 다시 밉니다.
6. Codespace에서 쓰는 중이면 `bash scripts/stop.sh && bash scripts/start.sh`로 서버를 다시 켭니다.

되돌릴 때는 `git revert`를 씁니다. 강제 푸시는 쓰지 않습니다.

### 멈추고 묻는 경우
- `data/` 안 파일 형식(job.json·result.json·edits.json·voiceprints.json) 변경 — 기존 데이터·백업과 호환이 깨질 수 있음
- 사용자가 요청한 범위를 넘는 변경

## 지켜야 할 불변 사항

- **회의 데이터는 저장소에 들어가지 않습니다.** `data/`·`models/`는 `.gitignore`에 있습니다. 시험용으로도 실제
  회의 음원·전사·목소리 기준·실명을 커밋하지 마세요(시험은 합성 음원만).
- 서버는 `127.0.0.1`에만 붙습니다. Codespaces 포트는 Private으로 둡니다.
- 전사는 sherpa-onnx Whisper에 **tokens-hex.txt 우회**를 씁니다. 이 우회를 빼면 한글 글자가 빠집니다.
  Whisper 입력은 30초를 넘으면 잘리므로 25초 이하로 나눕니다.
- 화자는 **기준 맞히기**(Plaud 이름 구간 → 사람별 평균 특징 → 3초 창 투표)로 정합니다. 처음부터 N명으로
  묶는 방식은 소수 화자가 사라져서 쓰지 않습니다(시험: 기준 맞히기 92.6% vs 묶기 79.6%).
- 「Speaker 1」 같은 임시 이름은 그 작업에만 쓰고 목소리 기준으로 저장하지 않습니다.
- 목소리 기준은 사람 → 출처(회의)별 `{vec, n}`으로 쌓고, 같은 출처로 다시 처리하면 덧붙이지 않고 바꿉니다.
- 처리 중 멈춰도(Codespace 정지 등) `partial.jsonl`로 이어서 합니다. 이 구조를 유지하세요.
