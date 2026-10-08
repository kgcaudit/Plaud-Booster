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

  // ---- 누락 구간 보충
  await page.click("#btnNew");
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
  console.log("✓ 검수 수정·자동 저장·구간 재생");

  const dl = page.waitForEvent("download");
  await page.click("#exTxt");
  const txt = fs.readFileSync(await (await dl).path(), "utf8");
  assert.match(txt, /배소정 \(보충\): 고친 문장/);
  assert.match(txt, /김응옥: 발언 0/); // Plaud 전사가 합쳐짐
  assert.match(txt, /진짜 전사/); // 사전 적용
  console.log("✓ 통합본 TXT(Plaud 합치기·검수·사전)");

  // ---- 조각 음원(MP3 프레임 단위 풀기)
  if (mp3Path) {
    await page.click(".tabs button[data-tab='jobs']");
    await page.click("#btnNew");
    await page.check("input[name='mode'][value='fragment']");
    await page.setInputFiles("#audioFiles", [asFile(mp3Path, "audio/mpeg"), asFile(audioPath, "audio/wav")]);
    await page.fill("#jobTitle", "조각 시험");
    await page.click("#btnSubmit");
    await page.waitForSelector(".job:has-text('조각 시험') .badge.st-완료", { timeout: 90000 });
    const meta = await page.locator(".job:has-text('조각 시험') .meta").first().textContent();
    assert.match(meta, /조각\.mp3 \(2:30\)/, meta);
    const d2 = page.waitForEvent("download");
    await page.click(".job:has-text('조각 시험') button[data-a='review']");
    await page.click("#exTxt");
    const t2 = fs.readFileSync(await (await d2).path(), "utf8");
    assert.match(t2, /■ 조각\.mp3/);
    assert.match(t2, /■ 회의\.wav/);
    console.log("✓ 조각 음원 2개(MP3 2:30 + WAV) 처리·파일별 내보내기");
  }

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
