// 실제 Chromium으로 화면 전체 흐름을 확인한다(가짜 엔진 ?fake=1 — 모델 없이).
// 합성 음원만 쓴다. 실제 회의 음원·전사는 시험에 쓰지 않는다.
// (한글 경로를 setInputFiles에 바로 주면 일부 환경에서 파일이 비므로, 내용을 읽어 이름과 함께 넘긴다)
import { chromium } from "playwright";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";

const asFile = (p, mimeType) => ({ name: path.basename(p), mimeType, buffer: fs.readFileSync(p) });
const PORT = 8100 + Math.floor(Math.random() * 800);
const BASE = `http://127.0.0.1:${PORT}`;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pb-e2e-"));

function wav(sec, file) {
  const sr = 16000, n = sec * sr, b = Buffer.alloc(44 + n * 2);
  b.write("RIFF", 0); b.writeUInt32LE(36 + n * 2, 4); b.write("WAVE", 8); b.write("fmt ", 12);
  b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(sr, 24); b.writeUInt32LE(sr * 2, 28);
  b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write("data", 36); b.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) {
    const t = i / sr, on = t % 6 < 4; // 4초 말 + 2초 쉼
    b.writeInt16LE(on ? Math.round(9000 * Math.sin(2 * Math.PI * 220 * t) * (1 + 0.5 * Math.sin(2 * Math.PI * 3 * t))) : 0, 44 + i * 2);
  }
  fs.writeFileSync(file, b);
}
/** 두 「사람」이 번갈아 말하는 합성 음원: 4초 말 + 2초 쉼, 짝수 번째는 220Hz, 홀수 번째는 520Hz */
function wav2(sec, file) {
  const sr = 16000, n = sec * sr, b = Buffer.alloc(44 + n * 2);
  b.write("RIFF", 0); b.writeUInt32LE(36 + n * 2, 4); b.write("WAVE", 8); b.write("fmt ", 12);
  b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(sr, 24); b.writeUInt32LE(sr * 2, 28);
  b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write("data", 36); b.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) {
    const t = i / sr, k = Math.floor(t / 6), on = t % 6 < 4, f = k % 2 ? 520 : 220;
    b.writeInt16LE(on ? Math.round(9000 * Math.sin(2 * Math.PI * f * t)) : 0, 44 + i * 2);
  }
  fs.writeFileSync(file, b);
}
const sony1 = path.join(tmp, "251009_1430.wav"), sony2 = path.join(tmp, "251009_1432.wav");
wav2(90, sony1); wav2(60, sony2);
const audioPath = path.join(tmp, "회의.wav");
wav(90, audioPath);
const trPath = path.join(tmp, "plaud.txt");
fs.writeFileSync(trPath, Array.from({ length: 7 }, (_, k) => `00:00:${String(k * 6).padStart(2, "0")} ${k % 2 ? "Speaker 2" : "김응옥 (팀장)"}\n발언 ${k}`).join("\n\n"));
let mp3Path = null;
if (spawnSync("ffmpeg", ["-version"]).status === 0) {
  mp3Path = path.join(tmp, "조각.mp3");
  const wav2 = path.join(tmp, "src2.wav");
  wav(150, wav2);
  spawnSync("ffmpeg", ["-loglevel", "error", "-y", "-i", wav2, "-ar", "44100", "-ac", "2", "-b:a", "128k", mp3Path]);
}

const server = spawn(process.execPath, ["tools/serve.mjs", "web", String(PORT)], { stdio: "ignore" });
await new Promise((r) => setTimeout(r, 600));
const browser = await chromium.launch();
let failed = false;
const errors = [], foreign = [];
try {
  const ctx = await browser.newContext({ acceptDownloads: true });
  const page = await ctx.newPage();
// 검수는 작업에 딸린 단계: 위 탭 「작업」 → 아래 단계 줄 「검수·내보내기」
const goReview = async () => { await page.click(".tabs button[data-tab='jobs']"); await page.click("#subTabs button[data-tab='review']"); };
  errors.length = 0; foreign.length = 0;
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  ctx.on("request", (r) => { if (!r.url().startsWith(BASE) && !r.url().startsWith("blob:") && !r.url().startsWith("data:")) foreign.push(r.url()); });

  await page.goto(`${BASE}/?fake=1`);
  await page.waitForFunction(() => self.crossOriginIsolated === true, null, { timeout: 15000 });
  await page.waitForSelector("#sysline:has-text('가짜 엔진')");
  console.log("✓ 서비스 워커로 교차 출처 격리(스레드 사용 가능)");

  // 결과가 없을 때 검수: 빈 선택 칸·보기 단추·내보내기 대신 안내와 「작업 목록으로」
  await goReview();
  await page.waitForSelector("#rvNone:not(.hidden)");
  assert.ok(await page.locator("#rvBar").isHidden());
  assert.ok(await page.locator("#rvMain").isHidden());
  await page.click("#rvGoJobs");
  await page.waitForSelector("#btnNew", { state: "visible" });
  console.log("✓ 검수할 결과가 없으면 안내와 작업 목록 단추만");

  // ---- 누락 구간 보충(출처 Plaud → 할 일 기본값 「빠진 구간 채우기」)
  await page.click("#btnNew");
  assert.ok(await page.locator("#fsTask").isHidden()); // 출처를 고르기 전에는 할 일이 안 보임
  await page.check("input[name='source'][value='plaud']");
  assert.ok(await page.locator("input[name='mode'][value='gap']").isChecked());
  assert.ok(await page.locator("input[name='mode'][value='diar']").isVisible()); // Plaud에도 화자 나누기·전사
  await page.setInputFiles("#audioFiles", asFile(audioPath, "audio/wav"));
  await page.setInputFiles("#trFile", asFile(trPath, "text/plain"));
  await page.waitForSelector("#trInfo:has-text('7개 발언')");
  await page.waitForSelector("#gapTape .lbl:has-text('빠진')");
  await page.fill("#spkMap input[data-from='Speaker 2']", "배소정");
  await page.fill("#jobTitle", "시험 회의");
  await page.click("#btnSubmit");
  await page.waitForSelector(".job:has-text('시험 회의') .badge.st-완료", { timeout: 60000 });
  console.log("✓ 누락 구간 보충 작업 완료");

  // 목소리 기준: 이름 붙은 사람만 저장
  await page.click(".tabs button[data-tab='voices']");
  await page.waitForSelector("#vpBody tr[data-n='김응옥']");
  assert.equal(await page.locator("#vpBody tr[data-n='배소정']").count(), 1);
  console.log("✓ 목소리 기준 저장(김응옥·배소정)");

  // 검수: 화자 바꾸고 문장 고치기 → 자동 저장
  await page.click(".tabs button[data-tab='glossary']");
  await page.fill("#glBody tr:first-child .f", "가짜");
  await page.fill("#glBody tr:first-child .t", "진짜");
  await page.click("#glSave");
  await goReview();
  await page.click(".scope button[data-f='all']");
  const first = page.locator("#rvBody tr[data-i='1']");
  await first.locator("select.spk").selectOption("배소정");
  await first.locator("textarea").fill("고친 문장");
  await first.locator("textarea").dispatchEvent("change");
  await page.waitForSelector("#rvSave:has-text('저장됨')");
  // 재생(구간 음원 만들기)
  await first.locator("button.play").click();
  await page.waitForFunction(() => document.getElementById("player").currentSrc.startsWith("blob:"));
  // 발언 ▶는 재생·일시정지 겸용, 재생 중인 발언 아래에 조작 줄(처음·−5초·❚❚·+5초·다음)
  await page.waitForFunction(() => { const b = document.querySelector("#rvBody tr[data-i='1'] button.play"); return b && b.textContent === "❚❚"; });
  assert.equal(await first.locator("#segCtl").count(), 1);
  await first.locator("button.play").click();
  await page.waitForFunction(() => document.getElementById("player").paused && document.querySelector("#rvBody tr[data-i='1'] button.play").textContent === "▶");
  const tp0 = await page.evaluate(() => document.getElementById("player").currentTime);
  await page.click("#segCtl [data-x='f5']");
  assert.ok((await page.evaluate(() => document.getElementById("player").currentTime)) > tp0, "+5초가 움직이지 않음");
  await first.locator("button.play").click(); // 이어 듣기
  // 전체 녹음 재생 막대: 발언 시각부터 이어 재생, 녹음 전체 길이, ±5초 이동
  assert.ok(await page.locator("#tl").isVisible());
  await page.waitForFunction(() => document.getElementById("player").duration > 80); // 90초 음원 전체
  await page.click("#tlPlay"); // 멈춤
  const t0 = await page.evaluate(() => document.getElementById("player").currentTime);
  await page.click("#tl button[data-j='15']");
  const t1 = await page.evaluate(() => document.getElementById("player").currentTime);
  assert.ok(Math.abs(t1 - t0 - 15) < 1, `${t0} → ${t1}`);
  // 휴대폰 알림의 재생 카드 제목(Media Session): 앱 이름·작업 제목·파일 이름
  const ms = await page.evaluate(() => { const m = navigator.mediaSession && navigator.mediaSession.metadata; return m ? { title: m.title, artist: m.artist, album: m.album, art: m.artwork.length } : null; });
  assert.ok(ms, "재생 카드 정보 없음");
  assert.equal(ms.album, "Diarized Transcription");
  assert.match(ms.title, /\.(mp3|wav)/);
  assert.ok(ms.art >= 1 && !/chrome-native/.test(ms.title));
  console.log("✓ 검수 수정·자동 저장·발언 ▶ 재생·멈춤 겸용과 조작 줄·전체 녹음 재생 막대(±이동)");

  const dl = page.waitForEvent("download");
  await page.click("#exTxt");
  const txt = fs.readFileSync(await (await dl).path(), "utf8");
  assert.equal(txt.charCodeAt(0), 0xfeff, "통합본 TXT 앞에 UTF-8 표시(BOM)가 없음 — 휴대폰에서 한글이 깨짐");
  assert.match(txt, /배소정 \(보충\): 고친 문장/);
  assert.match(txt, /김응옥: 발언 0/); // Plaud 전사가 합쳐짐
  assert.match(txt, /진짜 전사/); // 사전 적용
  console.log("✓ 통합본 TXT(Plaud 합치기·검수·사전)");

  // ---- 소니 녹음: 화자 먼저 묶기 → 이름 붙이기 → 전사 → 발언별 수정·되돌리기 → 목소리 기준 저장
  page.on("dialog", (d) => d.accept());
  // 검수에서 재생하던 중에 작업 탭으로 가도 재생은 멈추고 새 작업을 만들 수 있다
  await page.click("#tlPlay");
  await page.waitForFunction(() => !document.getElementById("player").paused);
  await page.click(".tabs button[data-tab='jobs']");
  assert.ok(await page.evaluate(() => document.getElementById("player").paused), "작업 탭으로 갔는데 재생이 계속됨");
  await page.click("#btnNew");
  assert.ok(await page.locator("#newJob").isVisible());
  // Plaud 출처에도 화자 나누기·전사가 있고, 고르면 Plaud 전사 파일 칸은 숨는다
  await page.check("input[name='source'][value='plaud']");
  assert.ok(await page.locator("input[name='mode'][value='diar']").isVisible());
  await page.check("input[name='mode'][value='diar']");
  assert.ok(await page.locator("#fsTranscript").isHidden());
  assert.ok(await page.locator("#audioFiles").evaluate((e) => e.multiple));
  await page.check("input[name='mode'][value='gap']");
  assert.ok(await page.locator("#fsTranscript").isVisible());
  await page.check("input[name='source'][value='sony']");
  assert.ok(await page.locator("input[name='mode'][value='gap']").isHidden());
  assert.ok(await page.locator("input[name='mode'][value='diar']").isChecked());
  assert.ok(await page.locator("#fsTranscript").isHidden());
  assert.ok(await page.locator("#callWrap").isHidden());
  assert.match(await page.locator("#srcTip summary").textContent(), /소니 녹음기/); // 출처별 녹음 요령
  assert.match(await page.locator("#srcTip").textContent(), /저역 차단/);
  await page.setInputFiles("#audioFiles", [asFile(sony2, "audio/wav"), asFile(sony1, "audio/wav")]); // 거꾸로 골라도
  await page.waitForSelector("#audioList li:first-child:has-text('251009_1430.wav')"); // 녹음 시각 순
  await page.waitForSelector("#audioList li:nth-child(2):has-text('앞 파일과')");
  // 작업 이름은 고른 파일 이름(녹음 시각)을 다듬어 저절로 채워짐
  assert.equal(await page.locator("#jobTitle").inputValue(), "25년 10월 9일 오후 2시 30분 외 1개");
  await page.fill("#attendees", "2");
  await page.fill("#jobTitle", "소니 시험");
  await page.check("#notice");
  await page.click("#btnSubmit");
  await page.waitForSelector(".job:has-text('소니 시험') .badge:has-text('이름 대기')", { timeout: 60000 });
  await page.click(".job:has-text('소니 시험') button[data-a='review']");
  await page.waitForSelector("#spkPanel .cl");
  assert.equal(await page.locator("#spkPanel .cl").count(), 2);
  // 이름 대기 중 「둘로 나누기」(두 사람이 한 묶음으로 잡혔을 때) → 묶음 3개, 되돌리기로 2개
  await page.locator("#spkPanel .cl").first().locator("button[data-a='split2']").click();
  await page.waitForFunction(() => document.querySelectorAll("#spkPanel .cl").length === 3);
  await page.click("#spkPanel button[data-a='undo']");
  await page.waitForFunction(() => document.querySelectorAll("#spkPanel .cl").length === 2);
  // 구간 손보기: 대표 구간 → 파형에서 끝 옮기기 → 새 사람으로 → 묶음 3개 → 되돌리기
  await page.locator("#spkPanel .cl").first().locator("button.rgbtn").first().click();
  await page.waitForSelector("#rgSheet:not(.hidden)");
  const s0 = await page.locator("#rgS").textContent();
  await page.click("#rgSheet button[data-rg='s+']");
  assert.notEqual(await page.locator("#rgS").textContent(), s0);
  const box = await page.locator("#rgWave").boundingBox();
  await page.mouse.move(box.x + box.width * 0.3, box.y + box.height / 2); await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.6, box.y + box.height / 2, { steps: 5 }); await page.mouse.up(); // 끌어서 새로 고르기
  assert.ok(await page.locator("#rgSheet button[data-rg='apply']").isDisabled()); // 누구인지 고르기 전
  await page.click("#rgWho button[data-to='new']");
  if (process.env.SHOTS) { await page.setViewportSize({ width: 412, height: 900 }); await page.locator("#rgSheet .rg-in").screenshot({ path: path.join(process.env.SHOTS, "range.png") }); await page.setViewportSize({ width: 1280, height: 720 }); }
  await page.click("#rgSheet button[data-rg='apply']");
  await page.waitForFunction(() => document.querySelectorAll("#spkPanel .cl").length === 3);
  if (!(await page.locator("#rgSheet").isHidden())) await page.click("#rgSheet #rgSim button[data-rg='close']");
  await page.click("#spkPanel button[data-a='undo']");
  await page.waitForFunction(() => document.querySelectorAll("#spkPanel .cl").length === 2);
  assert.ok(await page.locator("#rvMain").isHidden());
  await page.locator("#spkPanel .cl").first().locator("button.play").first().click();
  await page.waitForFunction(() => document.getElementById("player").currentSrc.startsWith("blob:"));
  const cards = page.locator("#spkPanel .cl");
  const ids = [await cards.nth(0).getAttribute("data-c"), await cards.nth(1).getAttribute("data-c")];
  await page.fill(`#spkPanel .cl[data-c='${ids[0]}'] input[data-a='name']`, "갑");
  await page.locator(`#spkPanel .cl[data-c='${ids[0]}'] input[data-a='name']`).dispatchEvent("change");
  await page.fill(`#spkPanel .cl[data-c='${ids[1]}'] input[data-a='name']`, "을");
  await page.locator(`#spkPanel .cl[data-c='${ids[1]}'] input[data-a='name']`).dispatchEvent("change");
  await page.click("#spkPanel button[data-a='go']");
  await page.waitForSelector(".job:has-text('소니 시험') .badge.st-완료", { timeout: 90000 });
  console.log("✓ 소니 녹음: 파일 순서·화자 묶음 2개·이름 붙이고 전사");

  await page.click(".job:has-text('소니 시험') button[data-a='review']");
  await page.click(".scope button[data-f='all']");
  await page.waitForSelector("#rvBody button.spkbtn");
  const names0 = await page.locator("#rvBody button.spkbtn").allTextContents();
  assert.ok(names0.includes("갑") && names0.includes("을"), names0.join(","));
  // 발언 하나만 바꾸기(이름 붙은 묶음이라 「이 발언만」이 기본)
  const row = page.locator("#rvBody tr").first();
  const was = await row.locator("button.spkbtn").textContent();
  await row.locator("button.spkbtn").click();
  await page.waitForSelector("#spkPop:not(.hidden)");
  assert.ok(await page.locator("#spkPop input[value='one']").isChecked());
  await page.fill("#popName", "병");
  await page.click("#spkPop button[data-a='save']");
  assert.equal(await page.locator("#rvBody tr").first().locator("button.spkbtn").textContent(), "병");
  assert.equal((await page.locator("#rvBody button.spkbtn").allTextContents()).filter((x) => x === "병").length, 1);
  await page.click("#spUndo");
  assert.equal(await page.locator("#rvBody tr").first().locator("button.spkbtn").textContent(), was);
  // 묶음 전체 이름 바꾸기
  await page.locator("#rvBody tr").first().locator("button.spkbtn").click();
  await page.check("#spkPop input[value='all']");
  await page.fill("#popName", "정");
  await page.click("#spkPop button[data-a='save']");
  const names1 = await page.locator("#rvBody button.spkbtn").allTextContents();
  assert.ok(!names1.includes(was) && names1.includes("정"), names1.join(","));
  await page.waitForSelector("#rvSave:has-text('저장됨')");
  console.log("✓ 발언별 화자 창(이 발언만·묶음 전체)·되돌리기");

  // 검수 단계: 범위(전체 ⊃ 확인함·미검수 ⊃ 확인 필요·판정 확실) · 확인 단추 · 한꺼번에 확인 · 발언 나누기
  const cnt = async (f) => +(await page.locator(`.scope b[data-n='${f}']`).textContent());
  const all0 = await cnt("all");
  assert.equal((await cnt("ok")) + (await cnt("todo")), all0);
  assert.equal((await cnt("need")) + (await cnt("sure")), await cnt("todo"));
  assert.match(await page.locator("#stNames [data-no]").textContent(), /1/);
  assert.match(await page.locator("#stExport [data-no]").textContent(), /3/);
  const ok0 = await cnt("ok");
  const r2 = page.locator("#rvBody tr[data-i]").nth(1);
  if (!(await r2.locator("button.okbtn.done").count())) { await r2.locator("button.okbtn").click(); assert.equal(await cnt("ok"), ok0 + 1); }
  await page.click(".scope button[data-f='todo']");
  await page.click("#rvAllOk");
  assert.equal(await cnt("todo"), 0);
  assert.ok(await page.locator("#exWarn").isHidden());
  await page.click("#rvUndo");
  assert.ok((await cnt("todo")) > 0);
  // 한 발언에 두 사람: 커서 위치에서 나누고 뒤 조각 화자를 바꿈 → 통합본에 두 줄
  await page.click(".scope button[data-f='all']");
  const r0 = page.locator("#rvBody tr[data-i]").first();
  await r0.locator("button[data-a='split']").click();
  const ta = page.locator("#rvBody textarea.splitta");
  await ta.fill("앞사람 말입니다 뒷사람 대답입니다");
  await ta.evaluate((t) => { const p = t.value.indexOf("뒷사람"); t.setSelectionRange(p, p); t.dispatchEvent(new Event("select", { bubbles: true })); });
  await page.click("#rvBody button[data-a='doSplit']");
  await page.waitForSelector("#rvBody tr[data-i] .part:nth-child(2)");
  assert.equal(await page.locator("#rvBody .part").count(), 2);
  const pick = page.locator("#rvBody .part").nth(1).locator("select.pspk");
  const cur = await pick.inputValue();
  const other = (await pick.locator("option").allTextContents()).find((n) => n !== cur && n !== "직접 입력…");
  await pick.selectOption(other);
  await page.waitForSelector("#rvSave:has-text('저장됨')");
  console.log("✓ 검수 범위(포함 관계)·확인·한꺼번에 확인·되돌리기·발언 나누기");
  if (process.env.SHOTS) { // 손으로 볼 화면 사진(휴대폰 폭) — 시험 판정에는 쓰지 않음
    const vp = page.viewportSize();
    await page.setViewportSize({ width: 412, height: 900 });
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({ path: path.join(process.env.SHOTS, "review-top.png"), fullPage: true });
    await page.locator("#rvBody tr[data-i]").nth(1).locator("button[data-a='split']").click();
    await page.locator("#rvBody textarea.splitta").evaluate((t) => { t.setSelectionRange(3, 3); t.dispatchEvent(new Event("select", { bubbles: true })); });
    await page.locator("#rvBody tr.splitting").screenshot({ path: path.join(process.env.SHOTS, "review-split.png") });
    await page.click("#rvBody button[data-a='splitCancel']");
    await page.click("#stNames .fold");
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({ path: path.join(process.env.SHOTS, "review-folded.png"), fullPage: true });
    await page.click("#stNames .fold");
    await page.setViewportSize(vp);
  }

  const d4 = page.waitForEvent("download");
  await page.click("#exTxt");
  const t4 = fs.readFileSync(await (await d4).path(), "utf8");
  assert.match(t4, /■ 251009_1430\.wav \(2025-10-09 14:30 녹음\)/);
  assert.match(t4, /녹음 출처: 소니 녹음기 · 할 일: 화자 나누기·전사/);
  assert.match(t4, /녹음 고지: 참석자에게 녹음 사실을 알림/);
  assert.match(t4, /\] 정: /);
  assert.match(t4, new RegExp(`: 앞사람 말입니다\\n.*\\] ${other}: 뒷사람 대답입니다`)); // 나눈 발언은 조각마다 한 줄
  await page.click("#spkPanel button[data-a='vp']");
  await page.click(".tabs button[data-tab='voices']");
  await page.waitForSelector("#vpBody tr[data-n='정']");
  console.log("✓ 통합본(묶음 이름·녹음 시각)·목소리 기준 저장");

  // 휴대폰 폭(접은 폴드 화면 412px)에서 어느 탭도 가로로 넘치지 않는다(긴 발언·긴 이름 포함)
  await page.setViewportSize({ width: 412, height: 900 });
  for (const tab of ["review", "jobs", "voices", "glossary", "settings"]) {
    if (tab === "review") await goReview(); else await page.click(`.tabs button[data-tab='${tab}']`);
    await page.waitForTimeout(300);
    const [sw, cw] = await page.evaluate(() => [document.documentElement.scrollWidth, document.documentElement.clientWidth]);
    assert.ok(sw <= cw, `${tab} 탭이 ${sw - cw}px 넘침`);
    // 낱말이 줄 끝에서 쪼개지지 않는다(「고태\n준」·「합치\n기」 같은 꼴), 버튼 글은 한 줄
    const broken = await page.evaluate(() => {
      const bad = [], rng = document.createRange();
      // 줄 수: 위치(top)가 8px 넘게 다른 덩어리를 다른 줄로 본다(작은 글자 배지 같은 몇 px 차이는 같은 줄)
      const lines = (r) => { const ts = [...r.getClientRects()].filter((x) => x.width > 0).map((x) => x.top).sort((a, b) => a - b); let n = ts.length ? 1 : 0; for (let i = 1; i < ts.length; i++) if (ts[i] - ts[i - 1] > 8) n++; return n; };
      const tw = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      while (tw.nextNode()) {
        const t = tw.currentNode, el = t.parentElement;
        if (!el || !el.getClientRects().length || el.closest("textarea, select, option, script, style, .tx, .tl-now")) continue;
        const re = /[^\s()（）·\/,「」\[\]—-]+/g; let m; // 괄호·가운뎃점 등에서 넘기는 건 정상
        while ((m = re.exec(t.data))) {
          if (m[0].length < 2 || m[0].length > 16) continue; // 파일 이름 같은 아주 긴 덩어리는 쪼개져도 된다
          rng.setStart(t, m.index); rng.setEnd(t, m.index + m[0].length);
          if (lines(rng) > 1) bad.push(`「${m[0]}」 ${el.tagName.toLowerCase()}.${el.className}`);
        }
      }
      for (const b of document.querySelectorAll("button")) {
        if (!b.getClientRects().length || b.closest(".sug, .merged") || b.matches(".sug, .merged")) continue;
        if (b.closest(".scope")) { // 보기 범위 단추는 일부러 숫자·이름 두 줄 — 각 줄이 다시 꺾이지만 않으면 됨
          for (const c of b.children) { rng.selectNodeContents(c); if (lines(rng) > 1) bad.push(`버튼 줄 꺾임: 「${c.textContent.trim()}」`); }
          continue;
        }
        rng.selectNodeContents(b);
        if (lines(rng) > 1) bad.push(`버튼 두 줄: 「${b.textContent.trim()}」`);
      }
      return bad;
    });
    assert.deepEqual(broken, [], `${tab} 탭 글자 쪼개짐:\n${broken.join("\n")}`);
    if (process.env.SHOTS) await page.screenshot({ path: `${process.env.SHOTS}/${tab}.png`, fullPage: true });
  }
  await page.setViewportSize({ width: 1280, height: 720 });
  console.log("✓ 휴대폰 폭(412px) 모든 탭 가로 넘침 없음");

  // ---- 조각 음원(MP3 프레임 단위 풀기)
  if (mp3Path) {
    await page.click(".tabs button[data-tab='jobs']");
    await page.click("#btnNew");
    await page.check("input[name='source'][value='phone']");
    await page.check("input[name='mode'][value='diar']");
    assert.ok(await page.locator("#callWrap").isVisible()); // 휴대폰 + 화자 나누기면 「통화 녹음」 선택
    await page.check("#isCall");
    assert.equal(await page.inputValue("#attendees"), "2");
    await page.check("input[name='mode'][value='fragment']");
    assert.ok(await page.locator("#callWrap").isHidden());
    await page.setInputFiles("#audioFiles", [asFile(mp3Path, "audio/mpeg"), asFile(audioPath, "audio/wav")]);
    await page.fill("#jobTitle", "조각 시험");
    await page.selectOption("#jobLang", "en"); // 영어 회의
    await page.click("#btnSubmit");
    await page.waitForSelector(".job:has-text('조각 시험') .badge.st-완료", { timeout: 90000 });
    const meta = await page.locator(".job:has-text('조각 시험') .info").first().textContent();
    assert.match(meta, /조각\.mp3 \(2:30\)/, meta);
    assert.match(meta, /휴대폰·기타 기기 · 저장된 목소리로 바로 맞히기/, meta);
    const d2 = page.waitForEvent("download");
    await page.click(".job:has-text('조각 시험') button[data-a='review']");
    await page.click("#exTxt");
    const t2 = fs.readFileSync(await (await d2).path(), "utf8");
    assert.match(t2, /■ 조각\.mp3/);
    assert.match(t2, /■ 회의\.wav/);
    assert.match(t2, /언어: 영어/); // 통합본 머리에 언어
    assert.match(t2, /fake transcript/); // 일꾼이 작업의 언어로 받아 적음
    console.log("✓ 조각 음원 2개(MP3 2:30 + WAV) 처리·파일별 내보내기");
  }

  // ---- 그래픽 칩 시험 구간 중 꺼진 흔적이 있으면 묻고, 고른 대로 한다(자동으로 끄지 않음)
  // 시험 표시 시각을 미래로 두어, 새로 고침이 남기는 정상 종료 기록보다 뒤 → 「꺼진 흔적」으로 보이게 한다
  await page.evaluate(async () => {
    const db = await new Promise((r) => { const q = indexedDB.open("plaud-booster"); q.onsuccess = () => r(q.result); });
    await new Promise((r) => { const tx = db.transaction("kv", "readwrite"); tx.objectStore("kv").put({ v: 2, level: 4, at: new Date(Date.now() + 3600e3).toISOString() }, "gpuLoading"); tx.oncomplete = r; });
  });
  await page.reload();
  await page.waitForSelector("#sysline:has-text('가짜 엔진')");
  await page.click(".tabs button[data-tab='settings']");
  await page.click("#btnBench");
  await page.waitForSelector("#gpuAsk:not(.hidden)", { timeout: 15000 });
  assert.ok(await page.locator("#benchMsg:has-text('끝났습니다')").count() === 0); // 답하기 전에는 진행하지 않음
  // 그때 쓰던 단계(전부 4/4)를 알리고 「한 단계 낮추기(절반) · CPU로 · 그대로」를 고르게 한다
  assert.deepEqual(await page.locator("#gpuAsk button").evaluateAll((bs) => bs.map((b) => b.dataset.level)), ["2", "0", "4"]);
  assert.match(await page.locator("#gpuAskNow").textContent(), /사용 - 빠름/);
  await page.click("#gpuAsk button[data-level='0']");
  await page.waitForSelector("#benchMsg:has-text('끝났습니다')", { timeout: 60000 });
  const setGpu = await page.evaluate(async () => { const db = await new Promise((r) => { const q = indexedDB.open("plaud-booster"); q.onsuccess = () => r(q.result); }); return new Promise((r) => { const q = db.transaction("kv").objectStore("kv").get("settings"); q.onsuccess = () => r(q.result && q.result.gpuLevel); }); });
  assert.equal(setGpu, 0);
  // 설정의 가속 단계: 자동(기기 성능 자료) + 빠름·보통·느림·끔, 고른 값이 반영됨
  assert.equal(await page.locator("#gpuLevel").inputValue(), "0");
  assert.equal(await page.locator("#gpuLevel option").count(), 5);
  assert.match(await page.locator("#devInfo").textContent(), /^이 기기: .* → 자동: /);
  // 모델을 올린 뒤 단계를 바꾸면 「새로 고쳐야 적용」을 알리고, 지금 실제 단계를 함께 보인다
  await page.selectOption("#gpuLevel", "4");
  await page.waitForSelector("#levelNow #btnReload");
  assert.match(await page.locator("#levelNow").textContent(), /새로 고쳐야 사용 - 빠름으로 바뀝니다\(지금은 끔/);
  await page.selectOption("#gpuLevel", "auto");
  await page.waitForFunction(() => !document.querySelector("#levelNow #btnReload"));
  assert.equal((await page.locator("#levelNow").textContent()).trim(), ""); // 평소에는 비워 둠
  const lv = await page.evaluate(async () => { const db = await new Promise((r) => { const q = indexedDB.open("plaud-booster"); q.onsuccess = () => r(q.result); }); return new Promise((r) => { const q = db.transaction("kv").objectStore("kv").get("settings"); q.onsuccess = () => r(q.result && ("gpuLevel" in q.result)); }); });
  assert.equal(lv, false);
  assert.ok(await page.locator("#gpuAsk").isHidden());
  console.log("✓ 그래픽 칩 꺼짐 흔적 → 묻고 고른 대로(CPU로)·가속 단계 설정(자동·전부·절반·1/4·끄기)");

  // ---- 기기 성능 시험(가짜 엔진) — 결과표가 나오고 휴대폰 폭에서도 넘치지 않는다
  await page.click("#btnBench");
  await page.waitForSelector("#benchMsg:has-text('끝났습니다')", { timeout: 60000 });
  const bt = await page.locator("#benchOut").textContent();
  assert.match(bt, /그래픽 칩/); assert.match(bt, /1시간 회의 어림/); assert.match(bt, /가속 단계/); assert.match(bt, /기기/);
  // 시험 기록 목록: 시각·가속 단계·전사 창·어림·느려짐(최근 것부터)
  await page.waitForSelector("#benchHist table.bh tbody tr");
  assert.ok(await page.locator("#benchHist tbody tr").count() >= 2);
  const vp0 = page.viewportSize();
  await page.setViewportSize({ width: 412, height: 900 });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= 412), "성능 시험 결과가 가로로 넘침");
  await page.setViewportSize(vp0);
  // 화면 꺼짐 방지: 처리할 것이 없으면 이유가 하나도 남지 않는다(시험·작업이 끝나면 놓음)
  await page.waitForFunction(() => document.body.dataset.awake === "", null, { timeout: 15000 });
  // 새로 고치면 자세한 결과는 비우고 기록 목록만 보인다(지난 결과를 지금 결과처럼 보이지 않게)
  await page.reload();
  await page.waitForSelector("#sysline:has-text('가짜 엔진')");
  await page.click(".tabs button[data-tab='settings']");
  await page.waitForSelector("#benchHist table.bh tbody tr");
  assert.equal(await page.locator("#benchOut").innerHTML(), "");
  const vp1 = page.viewportSize();
  await page.setViewportSize({ width: 412, height: 900 });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= 412), "시험 기록 표가 가로로 넘침");
  if (process.env.SHOTS) await page.locator("#benchHist").screenshot({ path: `${process.env.SHOTS}/benchhist.png` });
  await page.setViewportSize(vp1);
  console.log("✓ 기기 성능 시험(결과표·시험 기록 목록)·화면 켜 둠 해제");

  // ---- 중간 결과(이어서 하기): 기록 하나씩 저장, 예전 한 덩어리 기록도 읽고, 지울 때 둘 다
  const pr = await page.evaluate(async () => {
    const S = await import("/src/store.js");
    await S.put("partials", "J1", { 0: { k: 0, text: "예전" }, 1: { k: 1, text: "예전1" } }); // 예전 형식
    await S.put("partials", "J10", { 0: { k: 0, text: "다른 작업" } }); // 이름이 겹치는 다른 작업
    await S.savePartial("J1", { k: 1, text: "새로" });
    await S.savePartial("J1", { k: "e0", v: [Float32Array.of(0.5, -0.25)] });
    const a = await S.loadPartials("J1");
    await S.clearPartials("J1");
    const b = await S.loadPartials("J1"), other = await S.loadPartials("J10");
    return { keys: Object.keys(a).sort(), t0: a[0].text, t1: a[1].text, typed: a.e0.v[0] instanceof Float32Array && a.e0.v[0][1] === -0.25, left: Object.keys(b).length, other: Object.keys(other).length };
  });
  assert.deepEqual(pr, { keys: ["0", "1", "e0"], t0: "예전", t1: "새로", typed: true, left: 0, other: 1 });
  console.log("✓ 중간 결과 기록 하나씩 저장·예전 기록 읽기·지우기");

  // ---- 지운 작업에 늦게 온 상태 저장이 유령 작업을 만들지 않음
  const ghost = await page.evaluate(async () => {
    const S = await import("/src/store.js");
    const r = await S.saveJob("없는작업", { status: "대기", progress: { pct: 5 } });
    return { r: r === undefined, left: (await S.get("jobs", "없는작업")) === undefined };
  });
  assert.deepEqual(ghost, { r: true, left: true });
  console.log("✓ 지운 작업은 상태 저장으로 되살아나지 않음");

  // ---- 두 번째 탭에서 「처음부터 다시」 → 처리는 첫 탭(처리 맡은 탭)이 한다
  const page2 = await ctx.newPage();
  page2.on("dialog", (d) => d.accept());
  page2.on("pageerror", (e) => errors.push(String(e)));
  await page2.goto(`${BASE}/?fake=1`);
  await page2.waitForSelector("#sysline:has-text('다른 탭')", { timeout: 20000 });
  await page2.click(".tabs button[data-tab='jobs']");
  await page2.click(".job:has-text('시험 회의') button[data-a='fresh']");
  await page.click(".tabs button[data-tab='jobs']");
  await page2.waitForSelector(".job:has-text('시험 회의') .badge.st-완료", { timeout: 60000 });
  await page2.close();
  console.log("✓ 다른 탭에서 넣은 작업도 처리 탭이 받아 처리");

  // ---- 백업 → 모두 지우기 → 복원
  await page.click(".tabs button[data-tab='settings']");
  const d3 = page.waitForEvent("download");
  await page.click("#btnBackup");
  const bkPath = await (await d3).path();
  const bk = JSON.parse(fs.readFileSync(bkPath, "utf8"));
  assert.equal(bk.format, "plaud-booster-backup");
  assert.ok(!JSON.stringify(bk).includes("RIFF"));
  await page.evaluate(async () => { indexedDB.deleteDatabase("plaud-booster"); });
  await page.reload();
  await page.waitForSelector("#sysline:has-text('가짜 엔진')");
  await page.click(".tabs button[data-tab='settings']");
  const bkFile = path.join(tmp, "backup.json");
  fs.copyFileSync(bkPath, bkFile);
  await page.setInputFiles("#restoreFile", asFile(bkFile, "application/json"));
  await page.waitForSelector("#restoreMsg:has-text('합쳐 넣음')");
  await page.click(".tabs button[data-tab='jobs']");
  await page.waitForSelector(".job:has-text('시험 회의'):has-text('음원 지움')");
  console.log("✓ 백업·복원(음원 제외)");

  assert.deepEqual(foreign, [], "바깥으로 나간 요청: " + foreign.join(", "));
  assert.deepEqual(errors.filter((e) => !/favicon/.test(e)), []);
  console.log("✓ 바깥 요청 없음, 화면 오류 없음");
} catch (e) {
  failed = true;
  console.error("✗", e); console.error("page errors:", errors);
} finally {
  await browser.close();
  server.kill();
  fs.rmSync(tmp, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);
