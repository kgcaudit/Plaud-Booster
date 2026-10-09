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
  errors.length = 0; foreign.length = 0;
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  ctx.on("request", (r) => { if (!r.url().startsWith(BASE) && !r.url().startsWith("blob:") && !r.url().startsWith("data:")) foreign.push(r.url()); });

  await page.goto(`${BASE}/?fake=1`);
  await page.waitForFunction(() => self.crossOriginIsolated === true, null, { timeout: 15000 });
  await page.waitForSelector("#sysline:has-text('가짜 엔진')");
  console.log("✓ 서비스 워커로 교차 출처 격리(스레드 사용 가능)");

  // ---- 누락 구간 보충(출처 Plaud → 할 일 기본값 「빠진 구간 채우기」)
  await page.click("#btnNew");
  assert.ok(await page.locator("#fsTask").isHidden()); // 출처를 고르기 전에는 할 일이 안 보임
  await page.check("input[name='source'][value='plaud']");
  assert.ok(await page.locator("input[name='mode'][value='gap']").isChecked());
  assert.ok(await page.locator("input[name='mode'][value='diar']").isHidden());
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
  await page.click(".tabs button[data-tab='review']");
  await page.click(".seg button[data-f='all']");
  const first = page.locator("#rvBody tr[data-i='1']");
  await first.locator("select.spk").selectOption("배소정");
  await first.locator("textarea").fill("고친 문장");
  await first.locator("textarea").dispatchEvent("change");
  await page.waitForSelector("#rvSave:has-text('저장됨')");
  // 재생(구간 음원 만들기)
  await first.locator("button.play").click();
  await page.waitForFunction(() => document.getElementById("player").currentSrc.startsWith("blob:"));
  // 전체 녹음 재생 막대: 발언 2초 앞부터 이어 재생, 녹음 전체 길이, ±5초 이동
  assert.ok(await page.locator("#tl").isVisible());
  await page.waitForFunction(() => document.getElementById("player").duration > 80); // 90초 음원 전체
  await page.click("#tlPlay"); // 멈춤
  const t0 = await page.evaluate(() => document.getElementById("player").currentTime);
  await page.click("#tl button[data-j='15']");
  const t1 = await page.evaluate(() => document.getElementById("player").currentTime);
  assert.ok(Math.abs(t1 - t0 - 15) < 1, `${t0} → ${t1}`);
  console.log("✓ 검수 수정·자동 저장·전체 녹음 재생 막대(발언 앞 2초부터·±이동)");

  const dl = page.waitForEvent("download");
  await page.click("#exTxt");
  const txt = fs.readFileSync(await (await dl).path(), "utf8");
  assert.match(txt, /배소정 \(보충\): 고친 문장/);
  assert.match(txt, /김응옥: 발언 0/); // Plaud 전사가 합쳐짐
  assert.match(txt, /진짜 전사/); // 사전 적용
  console.log("✓ 통합본 TXT(Plaud 합치기·검수·사전)");

  // ---- 소니 녹음: 화자 먼저 묶기 → 이름 붙이기 → 전사 → 발언별 수정·되돌리기 → 목소리 기준 저장
  page.on("dialog", (d) => d.accept());
  await page.click(".tabs button[data-tab='jobs']");
  await page.click("#btnNew");
  await page.check("input[name='source'][value='sony']");
  assert.ok(await page.locator("input[name='mode'][value='diar']").isChecked());
  assert.ok(await page.locator("#fsTranscript").isHidden());
  assert.ok(await page.locator("#callWrap").isHidden());
  assert.match(await page.locator("#srcTip summary").textContent(), /소니 녹음기/); // 출처별 녹음 요령
  assert.match(await page.locator("#srcTip").textContent(), /저역 차단/);
  await page.setInputFiles("#audioFiles", [asFile(sony2, "audio/wav"), asFile(sony1, "audio/wav")]); // 거꾸로 골라도
  await page.waitForSelector("#audioList li:first-child:has-text('251009_1430.wav')"); // 녹음 시각 순
  await page.waitForSelector("#audioList li:nth-child(2):has-text('앞 파일과')");
  await page.fill("#attendees", "2");
  await page.fill("#jobTitle", "소니 시험");
  await page.check("#notice");
  await page.click("#btnSubmit");
  await page.waitForSelector(".job:has-text('소니 시험') .badge:has-text('이름 대기')", { timeout: 60000 });
  await page.click(".job:has-text('소니 시험') button[data-a='review']");
  await page.waitForSelector("#spkPanel .cl");
  assert.equal(await page.locator("#spkPanel .cl").count(), 2);
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
  await page.click(".seg button[data-f='all']");
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

  const d4 = page.waitForEvent("download");
  await page.click("#exTxt");
  const t4 = fs.readFileSync(await (await d4).path(), "utf8");
  assert.match(t4, /■ 251009_1430\.wav \(2025-10-09 14:30 녹음\)/);
  assert.match(t4, /녹음 출처: 소니 녹음기 · 할 일: 화자 나누기·전사/);
  assert.match(t4, /녹음 고지: 참석자에게 녹음 사실을 알림/);
  assert.match(t4, /\] 정: /);
  await page.click("#spkPanel button[data-a='vp']");
  await page.click(".tabs button[data-tab='voices']");
  await page.waitForSelector("#vpBody tr[data-n='정']");
  console.log("✓ 통합본(묶음 이름·녹음 시각)·목소리 기준 저장");

  // 휴대폰 폭(접은 폴드 화면 412px)에서 어느 탭도 가로로 넘치지 않는다(긴 발언·긴 이름 포함)
  await page.setViewportSize({ width: 412, height: 900 });
  for (const tab of ["review", "jobs", "voices", "glossary", "settings"]) {
    await page.click(`.tabs button[data-tab='${tab}']`);
    await page.waitForTimeout(300);
    const [sw, cw] = await page.evaluate(() => [document.documentElement.scrollWidth, document.documentElement.clientWidth]);
    assert.ok(sw <= cw, `${tab} 탭이 ${sw - cw}px 넘침`);
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
    console.log("✓ 조각 음원 2개(MP3 2:30 + WAV) 처리·파일별 내보내기");
  }

  // ---- 기기 성능 시험(가짜 엔진) — 결과표가 나오고 휴대폰 폭에서도 넘치지 않는다
  await page.click(".tabs button[data-tab='settings']");
  await page.click("#btnBench");
  await page.waitForSelector("#benchMsg:has-text('끝났습니다')", { timeout: 60000 });
  const bt = await page.locator("#benchOut").textContent();
  assert.match(bt, /그래픽 칩/); assert.match(bt, /1시간 회의 어림/);
  await page.waitForSelector("#benchPrev:has-text('지난 시험')");
  const vp0 = page.viewportSize();
  await page.setViewportSize({ width: 412, height: 900 });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= 412), "성능 시험 결과가 가로로 넘침");
  await page.setViewportSize(vp0);
  console.log("✓ 기기 성능 시험(결과표·지난 기록)");

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
