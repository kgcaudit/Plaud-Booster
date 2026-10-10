# 이 저장소에서 일하는 방식

「Diarized Transcription」 — 감사 면담·회의 녹음(출처: Plaud · 소니 녹음기 · 휴대폰·기타)을 화자별 녹취록으로 만드는 개인 웹앱입니다(저장소 이름은 예전 Plaud-Booster). **GitHub Pages 정적 사이트**이고, 전사·화자 맞히기는 브라우저 안
(onnxruntime-web, WebAssembly)에서 돕니다. 서버는 없습니다. 빌드 과정도 없습니다(모듈 그대로 배포).

```
web/index.html, style.css     화면
web/sw.js                     COOP/COEP 머리를 붙이는 서비스 워커(Pages에서 여러 스레드 쓰기용)
web/src/app.js                화면 동작 — 작업 등록·목록·검수·목소리 기준·사전·백업
web/src/worker.js             처리 일꾼(Web Worker) — 모델 받기(Cache Storage)·작업 대기열(한 번에 하나, Web Locks)
web/src/devices.js            기기·그래픽 칩 알아보기, 성능 점수 표 → 가속 단계 — 순수 함수
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
- 주 사용 기기는 휴대폰(갤럭시 폴드, 접은 화면 약 412px)입니다. 어느 탭도 가로로 넘치면 안 됩니다(e2e가 412px에서 검사).
  격자·가로줄 칸은 min-width:0, 격자 최소 폭은 min(100%, …), 긴 글은 줄바꿈, 검수 표는 720px 이하에서 발언 카드로 쌓습니다.
- 탭은 위계로 둡니다: 위 줄 「작업 · 목소리 · 사전 · 설정」, 작업 아래 단계 줄(#subTabs) 「1 작업 목록 › 2 검수·내보내기」. 검수는 작업에 딸린 화면입니다.
  검수를 떠나면 재생을 멈춥니다(재생 막대가 검수에만 있어 다른 화면에서는 멈출 방법이 없었음). 작업 목록은 결과 저장소를 키만 읽고(S.keys),
  진행률 알림은 그 카드의 진행 막대만 고칩니다(전사 중 탭 이동이 굼뜨던 원인: 1.5초·5초마다 모든 전사문을 읽어 다시 그림).
- 틀 고정: 위는 탭 줄(모든 탭)+검수의 [작업 선택·보기] 줄(#rvBar), 아래는 전체 재생 막대(#tl, 접기 가능). 높이는 syncSticky()가
  CSS 변수(--tabs-h·--rvbar-h·--tl-h)로 알려 표 머리·스크롤 여백에 씁니다. 손가락 조작(pointer: coarse)에서 누르는 곳은 44px 이상.
- 화면 꺼짐 방지(Screen Wake Lock): 처리 이유(AWAKE: job·model·prep·bench)가 하나라도 있으면 화면을 켜 두고, 탭이 다시 보이면 곧바로 다시 겁니다.
  이유가 없으면 놓습니다(body[data-awake]로 확인). 화면이 꺼지거나 다른 앱으로 가면 브라우저가 계산을 멈추므로 이 탭을 앞에 둬야 합니다.
- sw.js는 html·js·css를 매번 서버와 대조(no-cache)합니다 — 고친 화면이 휴대폰 캐시로 늦게 반영되지 않게.
- 전사 입력은 늘 30초(3000프레임)로 채웁니다. 짧게 줄이면 한국어 전사가 크게 망가집니다(시험으로 확인).
  Whisper는 30초 넘는 입력을 자르므로 구간은 25초 이하로 나눕니다.
- Plaud 이름이 있으면 화자는 **기준 맞히기**(Plaud 이름 구간 → 사람별 평균 특징 → 3초 창 투표)로 정합니다. 처음부터 N명으로
  묶는 방식은 소수 화자가 사라져서 쓰지 않습니다(시험: 기준 맞히기 92.6% vs 묶기 79.6%).
- Plaud 이름이 없는 소니 녹음은 **인원 수를 정하지 않는 임계값 묶기**(창마다 평균 연결, cut 0.35)를 씁니다. 인원 수는 「인원 + 2」
  상한으로만(그대로 걸면 닮은 두 사람이 합쳐짐 93.7%). 저장된 기준은 묶은 뒤 **추천만**(먼저 떼어 두면 97.8%→96.6%로 낮아짐).
  기준값을 바꾸면 10-08 회의(Plaud 이름 숨김)로 다시 재서 98% 안팎·5명 모두 따로인지 확인합니다(실제 음원은 저장소 밖).
- 새 작업은 **출처(job.source: plaud·sony·phone) → 할 일(job.mode)**. 소니·휴대폰의 화자 나누기는 mode `diar`(예전 작업의 `sony`도 같은 것으로 읽음, isDiar).
  Plaud 출처는 gap·range·enroll(Plaud 전사 파일 사용)에 diar·fragment까지, 다른 출처는 diar·fragment(data-src="plaud dev"). 출처가 없는 예전 작업은 sourceOf()로 짐작합니다.
- 테스트용 Chromium은 AAC를 못 풀어 m4a는 e2e로 못 돌립니다. m4a→ADTS 변환은 tests/unit/audio.test.mjs에서 ffmpeg로 확인하고, 실제 풀이는 Chrome에서 확인합니다.
- 소니 발언 번호 `i`는 단위 번호 + 1로 고정입니다(묶음을 빼고 넣어도 검수 수정이 그대로 붙게). 이름은 edits.names(묶음 → 이름),
  발언별 수정은 edits.e[i].speaker — 우선순위는 발언별 > 묶음 이름 > Speaker N. 소니 목소리 기준은 사람이 「목소리 기준 저장」을 눌렀을 때만 저장합니다.
- 말소리 구간은 Silero에 **음량을 맞춰** 넣습니다(그냥 넣으면 멀리 앉은 사람 말을 놓침). Silero(16kHz 모델)는 8kHz 전화 음질을 말소리로 못 봐서
  (10-08을 8kHz로 낮추면 69%→2%), 10분 묶음마다 Silero가 에너지 기준의 40%도 못 찾으면 에너지 기준으로 대신합니다.
- 화자 나누기는 녹음의 대역 비(4.2~7.8kHz ÷ 0.3~3.4kHz)가 -47dB보다 낮으면 「전화 음질」로 보고 cut 0.45를 씁니다
  (전화 음질에서 0.35면 5명 중 3명만 남음 81% → 0.45에서 93%·5명). 넓은 대역 회의는 -36dB 안팎, 전화 음질은 -55dB 아래. 모델 캐시는 파일별(pb-m-<sha>)이라 모델을 더해도 나머지는 다시 받지 않습니다.
- 「Speaker 1」 같은 임시 이름은 그 작업에만 쓰고 목소리 기준으로 저장하지 않습니다.
- 목소리 기준은 사람 → 출처(회의)별 `{vec, n}`으로 쌓고, 같은 출처로 다시 처리하면 덧붙이지 않고 바꿉니다.
- 처리 중 멈춰도(탭 닫기 등) `partials`·`chunks`·`enroll`로 이어서 합니다. 이 구조를 유지하세요.
- 화자 나누기 작업의 전사는 **같은 묶음(화자)끼리만** 10초 이하 발언을 0.6초 사이를 두고 24초 창까지 묶어, 시각 토큰으로 다시 나눕니다
  (packGroups·assignPack·Whisper.transcribeTs). 다른 화자와 섞어 묶으면 글이 이웃 화자 발언으로 옮겨 갑니다. 사이 1.2초는 더 나빴습니다.
  10-08: 창 641→381, 글자 오류율 31.8→30.8%·43.2→35.5%. 묶은 창에서 글을 못 받은 발언은 혼자 다시 전사합니다(버리지 않음).
  **통화·전화 음질(diar.narrow·job.call)은 묶지 않습니다** — 짧게 주고받는 통화에서 발언이 통째로 빠졌습니다(2026-09-14 통화, 사용자 확인).
- Whisper 대화체 줄표(「- 아, 됐어. - 응.」·「- -」)는 cleanText로 걷어 냅니다.
- 에너지 말소리 구간(vadChunks)의 기준은 **앞뒤 5초 소음 바닥 + 6dB**입니다(녹음 전체 하위 20% + 6dB는 쉼 없는 통화에서 작게 들리는
  상대방 말을 버렸음: 9/14 통화 205초 중 98초 → 203초, 10-08 전화 음질 놓침 7 → 3).
- 화자 나누기 단계(이름 대기까지)는 Silero·CAM++만 올리고 Whisper는 전사 단계에서 올립니다(ensureModels("diar"|"all")).
- 메모리: 휴대폰 탭은 메모리가 넘치면 「앗, 이런!」으로 꺼집니다. 모델은 **하나씩 읽어 세션을 만든 뒤 바로 놓습니다**(Whisper.create에 읽기 함수를 넘김) —
  한꺼번에 읽으면 렌더러 최대 3.1GB, 하나씩이면 2.5GB(CPU 경로 실측). 인코더는 **블록 경계에서 4조각**(tools/split_encoder.py, manifest
  encoderParts)으로 나눠 조각마다 세션을 만들고 차례로 잇습니다(Whisper.encode, 결과는 나누기 전과 똑같음 — 차이 0.0).
  그래픽 칩 경로 렌더러 최대 2.48GB → 1.86GB. 그래픽 칩 「시험 구간」(올리기 ~ 첫 계산 끝, kv gpuLoading {v:2, at})에 탭이 꺼진 흔적이 있으면
  (그 뒤 정상 종료 기록 localStorage pb-clean-exit가 없으면 — gpuCrashed) **자동으로 끄지 않고 사용자에게 묻습니다**(#gpuAsk, 답할 때까지 처리 대기).
  브라우저가 꺼진 것과 사람이 닫은 것을 확실히 가를 수 없기 때문입니다(갤럭시 Z 플립3·Adreno 660은 첫 계산에서 크롬이 꺼짐).
  「모델 받기」는 캐시에만 받고(downloadAll) 메모리에 올리지 않습니다. 화면은 인터넷에서 받는 중과 저장된 모델을 불러오는 중을 나눠 보입니다.
- **그래픽 칩 가속 단계**(settings.gpuLevel: 없음=자동 / 4·2·1·0 = 그래픽 칩에 올릴 인코더 조각 수, 앞 조각부터): 자동은 web/src/devices.js가
  WebGL 그래픽 칩 이름(UNMASKED_RENDERER)으로 표의 성능 점수(3DMark Wild Life Extreme Unlimited)를 찾아 정합니다 —
  4,000 이상 전부 · 2,500 이상 절반 · 그 밑 끄기, 이름을 모르면 WebGPU 세대(adreno-8xx 전부·7xx 절반). 모델 번호(클라이언트 힌트)는 기기 이름 표시용.
  기준점: Adreno 840(폴드8) 전부 4/4 30초 창 4.7초 · Adreno 660(플립3) 전부에서 크롬 꺼짐. 화면이 기기를 알아본 뒤 단계를 일꾼에 알리고(env level),
  일꾼은 받을 때까지(최대 4초) 기다립니다. 꺼짐 흔적이 있으면 그때 단계를 알리고 「한 단계 낮추기·CPU로·그대로」를 묻습니다.
  기기 정보는 브라우저 안에서만 씁니다(바깥으로 보내지 않음).
- 인코더는 **8비트 블록 양자화(MatMulNBits, 블록 128, 약 700MB)** 입니다(tools/to_nbits.py, 배포 때 int8에서 변환). 그래픽 칩(WebGPU)이 있으면
  인코더만 WebGPU로, 디코더·CAM++·Silero는 wasm으로 돕니다(설정 「그래픽 칩 가속」, settings.gpu). 10-08 두 구간 글자 오류율(묶어 전사):
  int8 30.8%·35.5% → 8비트 28.9%·32.7%. 4비트(444MB)는 반복 헛말이 늘어 40~45분 구간 44.0%로 나빠 쓰지 않았습니다.
  WASM에서는 int8(MatMulInteger) 인코더가 4비트(MatMulNBits)보다 빨랐습니다(2스레드 30초 창: 60초 vs 100초) — CPU만 있는 기기는 조금 느려질 수 있습니다.
