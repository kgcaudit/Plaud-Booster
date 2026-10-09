# 이 저장소에서 일하는 방식

「감사 녹취 작업대」 — 감사 면담·회의 녹음(출처: Plaud · 소니 녹음기 · 휴대폰·기타)을 화자별 녹취록으로 만드는 개인 웹앱입니다(저장소 이름은 예전 Plaud-Booster). **GitHub Pages 정적 사이트**이고, 전사·화자 맞히기는 브라우저 안
(onnxruntime-web, WebAssembly)에서 돕니다. 서버는 없습니다. 빌드 과정도 없습니다(모듈 그대로 배포).

```
web/index.html, style.css     화면
web/sw.js                     COOP/COEP 머리를 붙이는 서비스 워커(Pages에서 여러 스레드 쓰기용)
web/src/app.js                화면 동작 — 작업 등록·목록·검수·목소리 기준·사전·백업
web/src/worker.js             처리 일꾼(Web Worker) — 모델 받기(Cache Storage)·작업 대기열(한 번에 하나, Web Locks)
web/src/engine.js             작업 실행 논리(대상 구간·기준 만들기·구간별 전사·화자 판정·이어하기, 소니 runSony) — 순수 함수
web/src/diar.js               화자 먼저 나누기(Silero 구간·음량 맞춤·창 묶기·발언 단위·이름 추천·목소리 기준 계산) — 순수 함수
web/src/models.js             Whisper(인코더·디코더 탐욕 디코딩)·CAM++·Silero VAD 실행
web/src/dsp.js                Whisper log-mel·kaldi fbank·말소리 구간 나누기
web/src/audio.js              음원 풀기(MP3·m4a/AAC 프레임 단위 60초 조각, m4a는 ADTS로) → 16kHz Int16 OPFS
web/src/store.js              IndexedDB·OPFS
web/src/plaud.js, zip.js      Plaud 내보내기 전사(TXT·SRT·DOCX·JSON) 읽기
web/src/export.js             통합본(TXT·CSV)·백업 합치기 — 순수 함수
tools/                        prepare_models.py(배포 때 모델 준비) · shrink_decoder.py · ref_*.py(파이썬 기준 구현) · serve.mjs · vendor.mjs
tests/unit/                   node --test — dsp 수치 대조, 전사 파일 읽기, 엔진 규칙, 화자 묶기(diar), 통합본·백업
tests/e2e.mjs                 Chromium 전체 흐름(가짜 엔진 ?fake=1, 합성 음원만)
```

## 변경 절차 — `main`에서 바로, 물어보지 말고 끝까지

1. `git pull origin main`으로 최신 상태에서 시작합니다.
2. 고칩니다. 새 동작을 넣거나 버그를 고치면 `tests/`에 검사를 추가합니다.
3. **밀기 전에 `npm test`** 를 돌립니다(`npm ci && npm run vendor` 먼저). 실패하면 밀지 않습니다.
4. `engine.js`·`models.js`·`dsp.js`·`audio.js`를 건드렸으면 실제 모델로 짧은 구간(1~3분)을 한 번 돌려 결과를 확인합니다.
   (`tools/prepare_models.py`로 `web/models`를 만들고 `npm run serve`. 실제 회의 음원은 저장소 밖에 둡니다.)
5. 커밋하고 `git push origin main`. CI(`verify`)가 빨간불이면 그 자리에서 고쳐 다시 밉니다. `deploy`까지 확인합니다.

되돌릴 때는 `git revert`를 씁니다. 강제 푸시는 쓰지 않습니다.

### 멈추고 묻는 경우
- IndexedDB 저장 형식(jobs·results·edits·voiceprints)이나 백업 JSON 형식 변경 — 기존 데이터·백업과 호환이 깨질 수 있음
- 모델 교체(전사 품질·크기·속도가 바뀜) — Pages 사이트 한도 1GB 안이어야 함
- 사용자가 요청한 범위를 넘는 변경

## 지켜야 할 불변 사항

- **회의 데이터는 브라우저 밖으로 나가지 않습니다.** CSP `connect-src 'self'`를 약하게 하지 마세요. e2e 시험이
  같은 출처 밖 요청을 한 건이라도 감지하면 실패합니다. 저장소에도 실제 회의 음원·전사·목소리 기준·실명을 넣지 않습니다.
- 인라인 `<script>`·`style=""`을 쓰지 않습니다(CSP). 너비·위치는 `data-w`/`data-left` → `applyGeom()`.
- 전사 입력은 늘 30초(3000프레임)로 채웁니다. 짧게 줄이면 한국어 전사가 크게 망가집니다(시험으로 확인).
  Whisper는 30초 넘는 입력을 자르므로 구간은 25초 이하로 나눕니다.
- Plaud 이름이 있으면 화자는 **기준 맞히기**(Plaud 이름 구간 → 사람별 평균 특징 → 3초 창 투표)로 정합니다. 처음부터 N명으로
  묶는 방식은 소수 화자가 사라져서 쓰지 않습니다(시험: 기준 맞히기 92.6% vs 묶기 79.6%).
- Plaud 이름이 없는 소니 녹음은 **인원 수를 정하지 않는 임계값 묶기**(창마다 평균 연결, cut 0.35)를 씁니다. 인원 수는 「인원 + 2」
  상한으로만(그대로 걸면 닮은 두 사람이 합쳐짐 93.7%). 저장된 기준은 묶은 뒤 **추천만**(먼저 떼어 두면 97.8%→96.6%로 낮아짐).
  기준값을 바꾸면 10-08 회의(Plaud 이름 숨김)로 다시 재서 98% 안팎·5명 모두 따로인지 확인합니다(실제 음원은 저장소 밖).
- 새 작업은 **출처(job.source: plaud·sony·phone) → 할 일(job.mode)**. 소니·휴대폰의 화자 나누기는 mode `diar`(예전 작업의 `sony`도 같은 것으로 읽음, isDiar).
  Plaud 출처만 gap·range·enroll, 다른 출처는 diar·fragment. 출처가 없는 예전 작업은 sourceOf()로 짐작합니다.
- 테스트용 Chromium은 AAC를 못 풀어 m4a는 e2e로 못 돌립니다. m4a→ADTS 변환은 tests/unit/audio.test.mjs에서 ffmpeg로 확인하고, 실제 풀이는 Chrome에서 확인합니다.
- 소니 발언 번호 `i`는 단위 번호 + 1로 고정입니다(묶음을 빼고 넣어도 검수 수정이 그대로 붙게). 이름은 edits.names(묶음 → 이름),
  발언별 수정은 edits.e[i].speaker — 우선순위는 발언별 > 묶음 이름 > Speaker N. 소니 목소리 기준은 사람이 「목소리 기준 저장」을 눌렀을 때만 저장합니다.
- 말소리 구간은 Silero에 **음량을 맞춰** 넣습니다(그냥 넣으면 멀리 앉은 사람 말을 놓침). 모델 캐시는 파일별(pb-m-<sha>)이라 모델을 더해도 나머지는 다시 받지 않습니다.
- 「Speaker 1」 같은 임시 이름은 그 작업에만 쓰고 목소리 기준으로 저장하지 않습니다.
- 목소리 기준은 사람 → 출처(회의)별 `{vec, n}`으로 쌓고, 같은 출처로 다시 처리하면 덧붙이지 않고 바꿉니다.
- 처리 중 멈춰도(탭 닫기 등) `partials`·`chunks`·`enroll`로 이어서 합니다. 이 구조를 유지하세요.
- WASM에서는 int8(MatMulInteger) 인코더가 4비트(MatMulNBits)보다 빨랐습니다(2스레드 30초 창: 60초 vs 100초).
