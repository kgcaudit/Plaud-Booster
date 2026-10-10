// Diarized Transcription — 화면 (빌드 없음). 처리는 worker.js, 저장은 store.js.
import * as S from "./store.js";
import { parse as parseTranscript } from "./plaud.js";
import { decodeFile, wavHeader, embeddedTime } from "./audio.js";
import { exportTxt, exportCsv, mergeBackup, speakerOf, hms as hmsLong, MODE_LABEL, SOURCE_LABEL, LANG_LABEL, sourceOf, isDiar } from "./export.js";
import { orderFiles, printsFromReview, recordedAt, titleFromFiles, splitCluster, relabelRange, similarRegions, mixSuspects } from "./diar.js";
import { isGeneric, knownPrints } from "./engine.js";
import { SCOPES, inScope, scopeCounts, isEdited, splitPart, mergeParts, partEnd } from "./review.js";
import { describeDevice, LEVELS, levelLabel, lowerLevel } from "./devices.js";

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const MULTI = (m) => m === "fragment" || isDiar(m);
const jobKind = (j) => `${SOURCE_LABEL[sourceOf(j)]} · ${MODE_LABEL[j.mode] || j.mode}${LANG_LABEL[j.lang] ? " · " + LANG_LABEL[j.lang] : ""}`;
const FAKE = new URLSearchParams(location.search).get("fake") === "1";
const hms = (t) => hmsLong(t, false);
const parseHms = (s) => { s = String(s || "").trim(); return s ? s.split(":").reduce((a, p) => a * 60 + Number(p), 0) : NaN; };
let toastT;
function toast(msg) { const t = $("#toast"); t.textContent = msg; t.classList.add("on"); clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove("on"), 2800); }
function download(name, blob) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob); a.download = name; document.body.appendChild(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}
/** CSP(인라인 style 금지) 때문에 너비·위치는 data-* 로 받아 CSSOM으로 넣는다 */
function applyGeom(root) {
  root.querySelectorAll("[data-w]").forEach((el) => { el.style.width = el.dataset.w + "%"; });
  root.querySelectorAll("[data-left]").forEach((el) => { el.style.left = el.dataset.left + "%"; });
}
const safeName = (s) => String(s || "작업").replace(/[\\/:*?"<>|]+/g, "_").slice(0, 80);

/* ================================================================== 교차 출처 격리(스레드용) */
async function ensureIsolation() {
  if (self.crossOriginIsolated || !("serviceWorker" in navigator)) return true;
  await navigator.serviceWorker.register("sw.js");
  await navigator.serviceWorker.ready;
  if (!sessionStorage.getItem("pb-reloaded")) { sessionStorage.setItem("pb-reloaded", "1"); location.reload(); return false; }
  return true;
}

/* ================================================================== 일꾼 */
let worker = null, WSTATE = { models: null, busy: false, owner: true, coi: false };
function startWorker() {
  worker = new Worker(new URL("./worker.js" + (FAKE ? "?fake=1" : ""), import.meta.url), { type: "module" });
  // 지난번에 정상적으로 닫았는지(새로 고침·탭 닫기) 알려 준다 — 그래픽 칩 계산 중 브라우저가 꺼진 것과 구분하려고
  let clean = 0; try { clean = +localStorage.getItem("pb-clean-exit") || 0; } catch { /* 저장 안 됨 */ }
  worker.postMessage({ type: "env", cleanExitAt: clean });
  sendLevel(); // 기기를 알아본 뒤 가속 단계를 알려 준다(일꾼은 받을 때까지 모델을 올리지 않고 기다림)
  worker.onmessage = (ev) => {
    const m = ev.data;
    if (m.type === "hello") { WSTATE.owner = m.owner; worker.postMessage({ type: "status" }); kick(); }
    if (m.type === "status") { Object.assign(WSTATE, m); if (m.busy) keepAwake("job", true); renderSys(); }
    if (m.type === "models") {
      keepAwake("model", m.phase === "download" || m.phase === "load");
      if (m.phase === "download") WSTATE.dl = m;
      if (m.phase === "load") WSTATE.dl = { ...(WSTATE.dl || {}), loading: true };
      if (m.phase === "stored") { WSTATE.dl = null; toast("모델을 이 기기에 저장했습니다 — 다음부터는 받지 않습니다"); worker.postMessage({ type: "status" }); }
      if (m.phase === "ready") { if (!WSTATE.engineLoaded) { WSTATE.engineLoaded = true; WSTATE.loadedLevel = SENT_LEVEL; } if (!m.partial) WSTATE.whisperLoaded = true; WSTATE.dl = null; WSTATE.threads = m.threads; if (m.device) { WSTATE.device = m.device; WSTATE.gpuParts = m.gpuParts; WSTATE.nParts = m.nParts; } if (m.gpuError) toast("그래픽 칩 가속을 켜지 못해 CPU로 전사합니다"); worker.postMessage({ type: "status" }); renderLevelNow(); }
      renderSys();
    }
    if (m.type === "job") {
      wakeLock(true);
      // 진행률만 바뀐 알림은 그 작업 카드의 진행 막대만 고친다(목록 전체를 다시 그리지 않음)
      const card = m.pct != null && !m.done && !m.naming ? document.querySelector(`.job[data-id="${CSS.escape(m.id)}"] .prog`) : null;
      if (card) { const i = card.querySelector(".pbar i"); if (i) { i.dataset.w = m.pct; applyGeom(card); } const t = card.querySelector("span:last-child"); if (t) t.textContent = `${m.pct}% · ${m.msg || ""}`; }
      else if ($("#tab-jobs").classList.contains("on")) loadJobs();
      if (m.done) toast("작업이 끝났습니다");
    }
    if (m.type === "idle") { WSTATE.busy = false; wakeLock(false); loadJobs(); } // 「처리 중」 상태는 일꾼이 쉬면 풀린다
    if (m.type === "bench") onBench(m);
    if (m.type === "error") { keepAwake("model", false); toast(m.message); }
    if (m.type === "notice") toast(m.message);
    if (m.type === "gpuAsk") showGpuAsk(m.level);
  };
}
const kick = () => worker && worker.postMessage({ type: "kick" });

/* ================================================================== 기기·가속 단계 */
// 브라우저가 알려 주는 그래픽 칩 이름(WebGL)·세대(WebGPU)·모델 번호(클라이언트 힌트)로 기기를 알아보고, 성능 자료로 기본 단계를 정한다.
// 이 값들은 이 브라우저 안에서만 쓰고 바깥으로 보내지 않는다.
let DEV = null;
async function detectDevice() {
  if (DEV) return DEV;
  const raw = { webgpu: false };
  try {
    const ad = navigator.gpu && (await navigator.gpu.requestAdapter());
    if (ad) { raw.webgpu = true; const i = ad.info || {}; raw.arch = i.architecture || ""; raw.vendor = i.vendor || ""; }
  } catch { /* 없음 */ }
  try {
    const gl = document.createElement("canvas").getContext("webgl");
    if (gl) {
      const ext = gl.getExtension("WEBGL_debug_renderer_info");
      raw.renderer = String(gl.getParameter(ext ? ext.UNMASKED_RENDERER_WEBGL : gl.RENDERER) || "");
      const lose = gl.getExtension("WEBGL_lose_context"); if (lose) lose.loseContext();
    }
  } catch { /* 없음 */ }
  try {
    if (navigator.userAgentData && navigator.userAgentData.getHighEntropyValues) raw.model = (await navigator.userAgentData.getHighEntropyValues(["model"])).model || "";
  } catch { /* 없음 */ }
  DEV = { ...describeDevice(raw), raw };
  return DEV;
}
/** 설정값 → 실제 단계. 「자동」(기본)은 기기 성능 자료로 정한 단계, 예전 설정(가속 끔)은 0 */
function effectiveLevel(set, dev) {
  if (typeof set.gpuLevel === "number") return set.gpuLevel;
  if (set.gpu === false) return 0;
  return dev ? dev.level : 0;
}
let SENT_LEVEL = null; // 일꾼에 마지막으로 알린 단계
async function sendLevel() {
  const dev = await detectDevice();
  const set = (await S.get("kv", "settings")) || {};
  SENT_LEVEL = effectiveLevel(set, dev);
  if (worker) worker.postMessage({ type: "env", level: SENT_LEVEL });
}
/** 설정한 단계와 지금 실제로 쓰는 단계를 함께 보인다(모델을 이미 올린 뒤 바꿨으면 새로 고침 안내) */
async function renderLevelNow() {
  const el = $("#levelNow");
  if (!el) return;
  const want = effectiveLevel((await S.get("kv", "settings")) || {}, await detectDevice());
  // 평소에는 비워 두고, 설정과 지금 올라간 단계가 달라 새로 고쳐야 할 때·그래픽 칩을 못 켰을 때만 한 줄로 알린다
  let html = "";
  if (WSTATE.engineLoaded && WSTATE.loadedLevel !== want) html = `새로 고쳐야 <b>${esc(levelLabel(want))}</b>으로 바뀝니다(지금은 ${esc(levelLabel(WSTATE.loadedLevel ?? 0))}). <button type="button" id="btnReload">새로 고침</button>`;
  else if (WSTATE.whisperLoaded && WSTATE.device !== "gpu" && want > 0) html = '<span class="err">그래픽 칩을 켜지 못해 CPU로 돌고 있습니다.</span>';
  el.innerHTML = html;
  const b = $("#btnReload"); if (b) b.addEventListener("click", () => location.reload());
}
const devText = (d) => [d.name ? `${d.name}${d.model ? `(${d.model})` : ""}` : d.model, d.soc, d.gpu].filter(Boolean).join(" · ") || "알 수 없는 기기";
/* 화면 꺼짐 방지: 이 페이지가 무언가 처리하는 동안(전사·화자 나누기·모델 받기/열기·음원 준비·성능 시험) 화면을 켜 둔다.
   브라우저는 탭이 가려지면 이 잠금을 풀기 때문에, 다시 보이면 곧바로 다시 건다. 처리할 것이 없으면 놓는다. */
const AWAKE = new Set();
let lock = null, lockBusy = false;
async function syncAwake() {
  document.body.dataset.awake = [...AWAKE].sort().join(",");
  if (lockBusy) return;
  lockBusy = true;
  try {
    const want = AWAKE.size > 0 && document.visibilityState === "visible";
    if (want && !lock && navigator.wakeLock) {
      lock = await navigator.wakeLock.request("screen");
      lock.addEventListener("release", () => { lock = null; renderSys(); });
    }
    if (!want && lock && !AWAKE.size) { await lock.release(); lock = null; }
  } catch { /* 지원 안 함·배터리 절약 모드 등 */ } finally { lockBusy = false; renderSys(); }
}
function keepAwake(reason, on) {
  const had = AWAKE.has(reason);
  if (on) AWAKE.add(reason); else AWAKE.delete(reason);
  if (had !== on || (on && !lock)) syncAwake();
}
const wakeLock = (on) => keepAwake("job", on);
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") syncAwake(); });
// 정상 종료 표시(새로 고침·탭 닫기·다른 주소로 이동 때 불림 — 브라우저가 꺼질 때는 불리지 않음)
window.addEventListener("pagehide", () => { try { localStorage.setItem("pb-clean-exit", String(Date.now())); } catch { /* 저장 안 됨 */ } });

function renderSys() {
  const m = WSTATE.models;
  let eng;
  if (WSTATE.fake) eng = '<span class="bad">시험용 가짜 엔진</span>';
  else if (!m) eng = "엔진 확인 중";
  // 인터넷에서 받는 중인지, 이 기기에 저장된 모델을 메모리로 불러오는 중인지 나눠 보여 준다
  else if (WSTATE.dl && !WSTATE.dl.loading) eng = `${WSTATE.dl.net ? "모델 받는 중" : "저장된 모델 불러오는 중"} ${Math.round((WSTATE.dl.got / WSTATE.dl.total) * 100)}%`;
  else if (WSTATE.dl && WSTATE.dl.loading) eng = "모델 여는 중";
  else if (m.ready) eng = '<span class="ok">엔진 준비됨</span>';
  else eng = `<span class="bad">모델 없음</span> (받은 양 ${Math.round((m.cachedBytes / Math.max(1, m.totalBytes)) * 100)}%)`;
  const th = (WSTATE.threads ? ` · 스레드 ${WSTATE.threads}` : "") + (WSTATE.device === "gpu" ? ` · 그래픽 칩 가속 ${WSTATE.gpuParts || "?"}/${WSTATE.nParts || 4}` : "") + (lock ? ' · <span class="ok">화면 켜 둠</span>' : "");
  $("#sysline").innerHTML = `${eng}${th}` + (WSTATE.coi ? "" : ' · <span class="bad">스레드 꺼짐(느림)</span>') + (WSTATE.owner ? "" : ' · <span class="bad">다른 탭에서 처리 중</span>');
  $("#engState").innerHTML = eng + (m && !m.ready && !WSTATE.fake ? "<br><small>모델을 받아 두면 대기 중인 작업이 바로 시작됩니다. 작업을 등록하면 자동으로 받습니다.</small>" : "");
  const pct = WSTATE.dl && WSTATE.dl.total ? (WSTATE.dl.got / WSTATE.dl.total) * 100 : m ? (m.cachedBytes / Math.max(1, m.totalBytes)) * 100 : 0;
  $("#dlBar").style.width = (WSTATE.fake ? 100 : pct) + "%";
  $("#btnModels").disabled = !!(m && m.ready) || !!WSTATE.dl || WSTATE.fake;
}

/* ================================================================== 탭 */
$$(".tabs button").forEach((b) => b.addEventListener("click", () => showTab(b.dataset.tab || b.dataset.sub)));
function showTab(name) {
  // 위 줄: 작업(작업 목록·검수 모두 여기 속함)·목소리·사전·설정 / 아래 줄: 작업 단계(작업 목록 › 검수)
  const work = name === "jobs" || name === "review";
  $$(".tabs .trow:not(.sub) button").forEach((x) => x.classList.toggle("on", x.dataset.tab === name || (work && x.dataset.tab === "jobs")));
  $$("#subTabs button").forEach((x) => x.classList.toggle("on", (x.dataset.sub || x.dataset.tab) === name));
  $("#subTabs").classList.toggle("hidden", !work);
  // 검수를 떠나면 재생을 멈춘다(재생 막대는 검수 화면에만 있어 다른 화면에서는 멈출 방법이 없음)
  if (name !== "review" && !player.paused) player.pause();
  $$(".tab").forEach((x) => x.classList.toggle("on", x.id === "tab-" + name));
  history.replaceState(null, "", location.pathname + location.search + "#" + name);
  syncSticky();
  if (name === "jobs") loadJobs();
  if (name === "review") loadReviewJobs();
  if (name === "voices") loadVoices();
  if (name === "glossary") loadGlossary();
  if (name === "settings") loadSettings();
}

function showGpuAsk(level) {
  const lv = typeof level === "number" ? level : 4, low = lowerLevel(lv);
  $("#gpuAskNow").textContent = levelLabel(lv);
  const btn = (v, text, primary) => `<button type="button" data-level="${v}"${primary ? ' class="primary"' : ""}>${text}</button>`;
  $("#gpuAskBtns").innerHTML = [
    low > 0 ? btn(low, `한 단계 낮추기 → ${levelLabel(low)}`, true) : "",
    btn(0, "CPU로 바꾸기(가속 끄기)", low === 0),
    lv > 0 ? btn(lv, `그대로 쓰기(${levelLabel(lv)})`, false) : "",
  ].join(" ");
  $("#gpuAsk").classList.remove("hidden");
  $("#gpuAsk").scrollIntoView({ block: "start" });
}
$("#gpuAsk").addEventListener("click", async (ev) => {
  const b = ev.target.closest("button[data-level]");
  if (!b) return;
  const v = +b.dataset.level;
  $("#gpuAsk").classList.add("hidden");
  worker.postMessage({ type: "gpuAnswer", level: v });
  if ($("#gpuLevel").options.length) $("#gpuLevel").value = String(v);
  toast(v ? `그래픽 칩 가속 「${levelLabel(v)}」으로 이어 갑니다` : "이 기기는 CPU로 전사합니다(설정에서 다시 바꿀 수 있음)");
});

/* ================================================================== 새 작업 */
// 1. 녹음 출처(Plaud · 소니 녹음기 · 휴대폰·기타) → 2. 출처에 맞는 할 일 → 3. 파일 → 4. Plaud 전사(Plaud만) → 5. 참석자 → 6. 이름·고지
const F = { audio: [], tr: null, voices: [], picked: new Set() };
const source = () => ($('input[name="source"]:checked') || {}).value || "";
const mode = () => ($('input[name="mode"]:checked') || {}).value || "";
const DEFAULT_TASK = { plaud: "gap", sony: "diar", phone: "diar" };

$("#btnNew").addEventListener("click", async () => {
  if (!player.paused) player.pause();
  resetForm();
  $("#newJob").classList.remove("hidden");
  $("#btnNew").classList.add("hidden");
  F.voices = (await S.all("voiceprints")).map(([name]) => name);
  renderChips();
});
$("#btnCancel").addEventListener("click", () => { $("#newJob").classList.add("hidden"); $("#btnNew").classList.remove("hidden"); });
function resetForm() {
  $("#newJob").reset();
  $("#jobTitle").dataset.auto = "1";
  F.audio = []; F.tr = null; F.picked = new Set();
  $("#audioList").innerHTML = ""; $("#trInfo").innerHTML = ""; $("#spkMap").innerHTML = ""; $("#gapTape").classList.add("hidden");
  setMsg("");
  applyMode();
}
function setMsg(t, err = false) { $("#formMsg").textContent = t; $("#formMsg").classList.toggle("err", err); }
$$('input[name="source"]').forEach((r) => r.addEventListener("change", () => {
  const src = source(), cur = $('input[name="mode"]:checked');
  const ok = cur && srcOk(cur.closest(".mode"), src);
  if (!ok) $(`input[name="mode"][value="${DEFAULT_TASK[src]}"]`).checked = true;
  applyMode();
}));
$$('input[name="mode"]').forEach((r) => r.addEventListener("change", applyMode));
$("#isCall").addEventListener("change", () => { if ($("#isCall").checked) $("#attendees").value = 2; });
const SRC_TIPS = {
  plaud: ["내보낼 때 「시간」과 「화자」를 켜 두세요 — 화자 맞히기의 기준이 됩니다.",
    "Plaud에서 화자 이름을 몇 명이라도 붙여 두면 그 사람의 목소리 기준이 정확해집니다.",
    "음원(MP3)은 전사와 같은 녹음의 원본을 받으세요."],
  sony: ["녹음 방식은 MP3 192kbps 이상 또는 LPCM(WAV)으로 두세요.",
    "저역 차단(LOW CUT)을 켜면 에어컨·책상 울림이 줄어 말소리 찾기가 정확해집니다.",
    "녹음기는 탁자 가운데, 모든 사람에게서 비슷한 거리에 두세요.",
    "잠깐 쉴 때는 일시정지 대신 트랙 마크를 쓰면 파일이 잘게 나뉘지 않습니다."],
  phone: ["녹음 앱의 음질을 「높음」(또는 48kHz)으로 두세요.",
    "통화 녹음은 전화 음질(8kHz)이라 대면 녹음보다 전사·화자 구분이 덜 정확합니다.",
    "휴대폰은 화면을 아래로 해 탁자 가운데에 두고, 알림·진동은 꺼 두세요.",
    "녹음 중 다른 앱으로 오래 넘어가면 기종에 따라 녹음이 끊길 수 있습니다."],
};
// 할 일 카드의 data-src: "plaud"(Plaud만) · "plaud dev"(모든 출처). dev = 소니·휴대폰
const srcOk = (label, src) => (label.dataset.src || "").split(" ").includes(src === "plaud" ? "plaud" : "dev");
const NEEDS_TR = (m) => m === "gap" || m === "range" || m === "enroll"; // Plaud 전사 파일을 쓰는 할 일
function applyMode() {
  const src = source(), m = mode(), dev = src && !NEEDS_TR(m);
  $("#fsTask").classList.toggle("hidden", !src);
  $$("#fsTask .mode").forEach((l) => l.classList.toggle("hidden", !src || !srcOk(l, src)));
  $$("#newJob .after-src").forEach((f) => f.classList.toggle("hidden", !src));
  $("#callWrap").classList.toggle("hidden", !(src === "phone" && isDiar(m)));
  $("#srcTip").classList.toggle("hidden", !src);
  if (src) $("#srcTip").innerHTML = `<summary>녹음 요령 — ${SOURCE_LABEL[src]} (전사·화자 정확도 높이기)</summary><ul class="tips">${SRC_TIPS[src].map((t) => `<li>${t}</li>`).join("")}</ul>`;
  if (!src) return;
  $("#audioFiles").multiple = MULTI(m);
  $("#audioHint").textContent = src === "sony" ? "MP3·WAV 여러 개 가능 — 파일 이름의 녹음 시각 순으로 자동 정렬"
    : src === "phone" ? "m4a·mp3·wav 등 여러 개 가능 — 녹음 시각(파일 이름 → 파일 정보 → 저장 시각) 순으로 자동 정렬"
      : MULTI(m) ? "Plaud에서 내려받은 음원(MP3·WAV) — 여러 개 가능, 녹음 시각 순으로 자동 정렬" : "Plaud에서 내려받은 음원(MP3) 1개";
  $("#fsRange").classList.toggle("hidden", m !== "range");
  $("#fsSpeakers").classList.toggle("hidden", m === "enroll");
  $("#fsTranscript").classList.toggle("hidden", dev);
  $("#spkLegend").textContent = isDiar(m) ? "참석자(선택)" : "화자 후보";
  $("#spkHint").textContent = isDiar(m) ? "고르면 그 사람들의 목소리 기준으로만 이름을 추천합니다. 인원 수는 묶음이 지나치게 많아지지 않게 하는 데만 씁니다."
    : m === "fragment" ? "고르지 않으면 저장된 사람 전원 중에서 맞힙니다" : "고르지 않으면 저장된 사람 전원 + 이 회의 전사의 사람 중에서 맞힙니다";
  $("#attWrap").classList.toggle("hidden", !isDiar(m));
  $("#useVpWrap").classList.toggle("hidden", isDiar(m));
  // 단계 번호: Plaud 전사를 쓰는 할 일은 4번이 전사 파일, 그 밖에는 전사 파일 단계가 없다
  const nums = $$("#newJob legend .num");
  nums.forEach((n, i) => { n.textContent = (i < 3 ? i + 1 : dev && i >= 4 ? i : i + 1) + "."; });
  if (MULTI(m) && F.audio.length > 1) { F.audio = orderFiles(F.audio); renderAudioList(); }
  $("#trHint").textContent = m === "gap" || m === "enroll" ? "필수 — Plaud에서 TXT·SRT·DOCX로 내보낸 파일(타임스탬프·화자 켜기)"
    : "권장 — 같은 녹음의 전사가 있으면 그 사람들 목소리로 화자를 맞힙니다";
  drawTape();
}

const pad2 = (n) => String(n).padStart(2, "0");
const localIso = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}T${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
/** 녹음 시각: 파일 이름 → 파일 안 정보(m4a 생성 시각) → 저장 시각 − 길이(추정) */
async function stampTimes() {
  for (const a of F.audio) {
    if (a.timeSrc) continue;
    const r = recordedAt(a.file.name);
    if (r) { a.recordedAt = r.at; a.timeSrc = "name"; continue; }
    const t = await embeddedTime(a.file);
    if (t) { a.recordedAt = localIso(t); a.timeSrc = "file"; continue; }
    if (a.dur && a.file.lastModified) { a.recordedAt = localIso(new Date(a.file.lastModified - a.dur * 1000)); a.timeSrc = "saved"; }
  }
}

function mediaDuration(file) {
  return new Promise((res) => {
    const a = document.createElement("audio");
    a.preload = "metadata";
    a.src = URL.createObjectURL(file);
    a.onloadedmetadata = () => { res(isFinite(a.duration) ? a.duration : null); URL.revokeObjectURL(a.src); };
    a.onerror = () => { res(null); URL.revokeObjectURL(a.src); };
  });
}
$("#audioFiles").addEventListener("change", async (ev) => {
  F.audio = [...ev.target.files].map((file) => ({ file, dur: null, name: file.name }));
  renderAudioList();
  autoTitle();
  for (const a of F.audio) { a.dur = await mediaDuration(a.file); renderAudioList(); }
  if (source() !== "plaud" || MULTI(mode())) { await stampTimes(); if (MULTI(mode())) F.audio = orderFiles(F.audio); renderAudioList(); autoTitle(); }
  drawTape();
});
// 작업 이름: 사람이 직접 쓰기 전까지는 고른 파일 이름을 다듬어 채운다(직접 쓰면 그대로 둠)
function autoTitle() {
  const el = $("#jobTitle");
  if (el.dataset.auto !== "1" && el.value.trim()) return;
  el.value = titleFromFiles(F.audio.map((a) => a.file.name));
  el.dataset.auto = "1";
}
$("#jobTitle").addEventListener("input", (e) => { e.target.dataset.auto = e.target.value.trim() ? "" : "1"; });
/** 앞 파일 녹음 끝과 이 파일 녹음 시작 사이(초). 시각을 모르면 null */
function gapBefore(i) {
  const a = F.audio[i - 1], b = F.audio[i];
  if (!a || !b || !a.recordedAt || !b.recordedAt || !a.dur) return null;
  return (Date.parse(b.recordedAt) - Date.parse(a.recordedAt)) / 1000 - a.dur;
}
function renderAudioList() {
  $("#audioList").innerHTML = F.audio.map((a, i) => {
    const g = gapBefore(i);
    const gap = g == null ? "" : g > 5 ? ` · 앞 파일과 ${hms(g)} 비어 있음` : g < -5 ? " · ⚠ 앞 파일과 시각이 겹칩니다" : " · 앞 파일에 이어짐";
    return `<li><span>${i + 1}. ${esc(a.file.name)}</span>
    <span class="msg">${(a.file.size / 1048576).toFixed(1)}MB${a.dur ? " · 길이 " + hms(a.dur) : ""}${a.recordedAt ? " · " + a.recordedAt.replace("T", " ").slice(0, 16) + " 녹음" + ({ file: "(파일 정보)", saved: "(저장 시각으로 추정)" }[a.timeSrc] || "") : ""}${gap}</span>
    <span class="pbar"><i data-w="${Math.round((a.prog || 0) * 100)}"></i></span></li>`;
  }).join("");
  applyGeom($("#audioList"));
}

$("#trFile").addEventListener("change", async (ev) => {
  const f = ev.target.files[0];
  if (!f) return;
  $("#trInfo").textContent = "읽는 중…";
  try {
    const r = await parseTranscript(f.name, new Uint8Array(await f.arrayBuffer()));
    F.tr = { name: f.name, ...r };
    const sp = Object.entries(r.speakers);
    $("#trInfo").innerHTML = `<b>${r.segs.length}개 발언</b> · 마지막 ${hms(r.endSec)} · 화자 ${sp.length}명`
      + r.warnings.map((w) => `<div class="warn">⚠ ${esc(w)}</div>`).join("")
      + (r.segs.length ? `<div class="msg">첫 발언: [${hms(r.segs[0].start)}] ${esc(r.segs[0].speaker)} — ${esc(r.segs[0].text.slice(0, 60))}</div>` : "");
    renderSpkMap(sp);
  } catch (e) { F.tr = null; $("#trInfo").innerHTML = `<span class="msg err">전사 파일을 읽지 못했습니다: ${esc(e.message)}</span>`; }
  drawTape(); renderChips();
});
function renderSpkMap(sp) {
  if (!sp.length) { $("#spkMap").innerHTML = ""; return; }
  $("#spkMap").innerHTML = `<b>전사의 화자</b><b>실제 이름(바꿀 때만)</b><b>발언 수</b>` + sp.map(([s, n]) =>
    `<span>${esc(s)}</span><input data-from="${esc(s)}" list="vpNames" placeholder="${/^(speaker|화자)\s*\d+$/i.test(s) ? "이름을 넣으면 목소리 기준으로 저장" : "그대로"}"><span>${n}</span>`).join("")
    + `<datalist id="vpNames">${F.voices.map((n) => `<option value="${esc(n)}">`).join("")}</datalist>`;
  $$("#spkMap input").forEach((i) => i.addEventListener("input", renderChips));
}
function speakerMap() { const m = {}; $$("#spkMap input").forEach((i) => { if (i.value.trim()) m[i.dataset.from] = i.value.trim(); }); return m; }
function renderChips() {
  const set = new Set(F.voices);
  if (F.tr) { const sm = speakerMap(); Object.keys(F.tr.speakers).forEach((s) => set.add(sm[s] || s)); }
  const all = [...set].sort((a, b) => a.localeCompare(b, "ko"));
  $("#spkChips").innerHTML = all.length ? all.map((n) => `<span class="chip ${F.picked.has(n) ? "on" : ""}" data-n="${esc(n)}">${esc(n)}</span>`).join("")
    : '<span class="msg">저장된 목소리 기준이 없습니다.</span>';
  $$("#spkChips .chip").forEach((c) => c.addEventListener("click", () => { const n = c.dataset.n; F.picked.has(n) ? F.picked.delete(n) : F.picked.add(n); c.classList.toggle("on"); }));
}
function drawTape() {
  const tape = $("#gapTape"), a = F.audio[0];
  if (MULTI(mode()) || !a || !a.dur || !F.tr) { tape.classList.add("hidden"); return; }
  tape.classList.remove("hidden");
  if (F.tr.endSec > a.dur + 30) { tape.innerHTML = `<span class="lbl err">⚠ 전사(${hms(F.tr.endSec)})가 음원(${hms(a.dur)})보다 깁니다 — 같은 녹음인지 확인하세요</span>`; return; }
  const end = Math.min(F.tr.endSec, a.dur), pct = (end / a.dur) * 100, gap = a.dur - end;
  tape.innerHTML = `<div class="cov" data-w="${pct}"></div>` + (gap > 20
    ? `<div class="gap" data-left="${pct}"></div><span class="lbl" data-left="${Math.min(pct, 60)}">전사 끝 ${hms(end)} → 녹음 끝 ${hms(a.dur)} (빠진 ${hms(gap)})</span>`
    : `<span class="lbl">전사가 녹음 끝(${hms(a.dur)})까지 있습니다</span>`);
  applyGeom(tape);
}

$("#newJob").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const m = mode(), src = source();
  if (!src) return setMsg("녹음 출처를 골라 주세요.", true);
  if (!m) return setMsg("할 일을 골라 주세요.", true);
  if (!F.audio.length) return setMsg("음원을 골라 주세요.", true);
  if (!MULTI(m) && F.audio.length !== 1) return setMsg("이 유형은 음원 1개만 받습니다.", true);
  if ((m === "gap" || m === "enroll") && !F.tr) return setMsg("Plaud 전사 파일이 필요합니다.", true);
  let range = null;
  if (m === "range") {
    const a = parseHms($("#rFrom").value), b = parseHms($("#rTo").value);
    if (!(b > a)) return setMsg("구간을 「1:04:00」처럼 넣어 주세요(끝이 시작보다 뒤).", true);
    range = { from: a, to: b };
  }
  const id = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14) + "-" + Math.random().toString(36).slice(2, 6);
  const tr = !MULTI(m) ? F.tr : null;
  const att = Math.max(0, Math.min(30, Math.round(+$("#attendees").value || 0)));
  const job = {
    title: $("#jobTitle").value.trim() || F.audio[0].file.name.replace(/\.[^.]+$/, ""),
    source: src, mode: m, status: "준비", notice: $("#notice").checked, createdAt: S.now(), audioFiles: [],
    ...($("#jobLang").value !== "ko" ? { lang: $("#jobLang").value } : {}), // 말하는 언어(없으면 한국어)
    transcript: tr ? { name: tr.name, count: tr.segs.length, endSec: tr.endSec } : null,
    transcriptEndSec: tr ? tr.endSec : 0, range, speakerMap: speakerMap(), speakers: [...F.picked],
    useVoiceprints: $("#useVp").checked, note: $("#jobNote").value.trim(), progress: { pct: 0, msg: "음원 준비 중" },
    ...(isDiar(m) ? { attendees: ($("#isCall").checked && src === "phone" ? 2 : att) || null, call: $("#isCall").checked && src === "phone", stage: "diar", skip: [] } : {}),
  };
  $("#btnSubmit").disabled = true;
  keepAwake("prep", true); // 긴 음원을 16kHz로 바꿔 저장하는 동안에도 화면을 켜 둔다
  try {
    await S.put("jobs", id, { ...job, updatedAt: S.now() });
    if (tr) await S.put("plaud", id, tr.segs);
    for (let i = 0; i < F.audio.length; i++) {
      const a = F.audio[i];
      setMsg(`음원 준비 중 ${i + 1}/${F.audio.length}: ${a.file.name}`);
      const w = await S.audioWriter(id, i);
      try {
        const dur = await decodeFile(a.file, (pcm) => w.write(pcm), (p) => { a.prog = p; renderAudioList(); });
        await w.close();
        job.audioFiles.push({ name: a.file.name, dur, ...(a.recordedAt ? { recordedAt: a.recordedAt, timeSrc: a.timeSrc } : {}) });
      } catch (e) { await w.abort(); throw new Error(`${a.file.name}: 음원을 열지 못했습니다 (${e.message})`); }
    }
    await S.saveJob(id, { audioFiles: job.audioFiles, status: "대기", progress: { pct: 0, msg: "대기" } });
    toast("작업을 등록했습니다");
    $("#newJob").classList.add("hidden"); $("#btnNew").classList.remove("hidden");
    kick(); loadJobs();
  } catch (e) {
    setMsg(e.message, true);
    await S.deleteJob(id);
  } finally { $("#btnSubmit").disabled = false; keepAwake("prep", false); }
});

/* ================================================================== 작업 목록 */
let JOBS = [];
// 오래 돌리는 작업은 충전기에 꽂아 두는 편이 빠르고 안전하다(배터리 절약 모드가 CPU를 늦춤). 지원하는 브라우저에서만.
const BATT = { warn: "" };
(async () => {
  try {
    if (!navigator.getBattery) return;
    const b = await navigator.getBattery();
    const upd = () => {
      const pct = Math.round(b.level * 100);
      BATT.warn = b.charging ? "" : `충전기가 연결되어 있지 않습니다(배터리 ${pct}%). 긴 녹음은 충전하면서 처리하면 느려지거나 멈추지 않습니다.`;
    };
    upd(); b.addEventListener("chargingchange", upd); b.addEventListener("levelchange", upd);
  } catch { /* 지원 안 함 */ }
})();
async function jobsList() {
  const rows = await S.all("jobs");
  // 결과(전사문 전체)는 읽지 않고 키만 본다 — 전사 중 5초·1.5초마다 모든 작업의 전사문을 읽어 화면이 굼떴다
  const res = new Set(await S.keys("results"));
  return rows.map(([id, j]) => ({ ...j, id, hasResult: res.has(id) })).sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}
async function loadJobs() {
  JOBS = await jobsList();
  const el = $("#jobList");
  if (!JOBS.length) { el.dataset.last = ""; el.innerHTML = '<p class="empty">아직 작업이 없습니다. 「새 작업」으로 시작하세요.</p>'; return; }
  const html = JOBS.map((j) => {
    const p = j.progress || {}, s = j.stats || {};
    const busy = j.status === "처리중" || j.status === "대기" || j.status === "준비";
    const naming = j.status === "이름 대기";
    const result = isDiar(j.mode) ? (s.clusters ? `화자 묶음 ${s.clusters}개` + (s.segments != null ? ` · 발언 ${s.segments} · 확인 필요 ${s.lowConf ?? 0} · 환각 제거 ${s.droppedHallucination ?? 0}` : ` · 전사할 발언 ${s.units ?? "-"}`) : "")
      : j.hasResult && j.mode !== "enroll" ? `발언 ${s.segments ?? "-"} · 혼재 ${s.mixed ?? 0} · 미상 ${s.unknown ?? 0} · 저신뢰 ${s.lowConf ?? 0} · 환각 제거 ${s.droppedHallucination ?? 0}` : "";
    const enrolled = !!(s.enrolled && Object.keys(s.enrolled).length);
    const files = (j.audioFiles || []).map((f) => f.name + (f.dur ? ` (${hms(f.dur)})` : "")).join(", ");
    // 카드 구성: [제목·상태 | 버튼] 위 한 줄, 아래는 전체 폭 정보표(항목명 열 + 내용 열), 맨 아래 진행 막대
    const info = [
      ["유형", esc(jobKind(j))],
      ["음원", esc(files) + (j.range ? ` · 구간 ${hms(j.range.from)}~${hms(j.range.to)}` : "") + (j.audioDeleted ? " · 음원 지움" : "")],
      ["등록", esc((j.createdAt || "").replace("T", " ").slice(0, 16))],
      ...(result ? [["결과", result]] : []),
      ...(enrolled ? [["목소리 기준", esc(Object.keys(s.enrolled).join(", ")) + " 등록"]] : []),
      ...(j.error ? [["오류", `<span class="err">${esc(j.error)}</span>`]] : []),
    ];
    return `<div class="job" data-id="${esc(j.id)}">
      <div class="hd"><span class="t">${esc(j.title)}</span><span class="badge st-${esc(String(j.status).replace(/\s/g, ""))}">${esc(j.status)}</span></div>
      <dl class="info">${info.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join("")}</dl>
      <div class="acts">
        ${naming ? '<button type="button" data-a="review" class="primary">화자 이름 붙이기</button>' : ""}
        ${j.hasResult && j.mode !== "enroll" ? '<button type="button" data-a="review" class="primary">검수</button>' : ""}
        ${busy && j.status !== "준비" ? '<button type="button" data-a="stop">중지</button>' : ""}
        ${!busy && !naming && j.status !== "완료" && !j.audioDeleted ? '<button type="button" data-a="resume">이어서 처리</button>' : ""}
        ${!busy && !j.audioDeleted ? '<button type="button" data-a="fresh">처음부터 다시</button>' : ""}
        ${!busy && !j.audioDeleted ? '<button type="button" data-a="delaudio">음원 지우기</button>' : ""}
        ${!busy || j.status === "준비" ? '<button type="button" data-a="del">삭제</button>' : ""}
      </div>
      ${busy && j.status === "처리중" && BATT.warn ? `<p class="note batt">${BATT.warn}</p>` : ""}
      ${busy ? `<div class="prog"><span class="pbar"><i data-w="${p.pct || 0}"></i></span><span>${p.pct || 0}% · ${esc(p.msg || "")}</span></div>` : ""}
    </div>`;
  }).join("");
  if (html === el.dataset.last) return; // 바뀐 게 없으면 다시 그리지 않는다
  el.dataset.last = html.length > 200000 ? "" : html;
  el.innerHTML = html;
  applyGeom(el);
}
$("#jobList").addEventListener("click", async (ev) => {
  const b = ev.target.closest("button[data-a]");
  if (!b) return;
  const id = b.closest(".job").dataset.id, a = b.dataset.a;
  try {
    if (a === "review") { REVIEW.want = id; showTab("review"); return; }
    if (a === "stop") {
      const j = await S.get("jobs", id);
      if (j.status === "대기") await S.saveJob(id, { status: "중지" });
      worker.postMessage({ type: "stop", id });
    }
    if (a === "resume") { await S.saveJob(id, { status: "대기", error: null }); kick(); }
    if (a === "fresh") {
      const j = await S.get("jobs", id);
      if (isDiar(j.mode)) {
        if (!confirm("화자 묶기부터 다시 할까요? 붙여 둔 화자 이름과 검수 수정이 지워집니다.")) return;
        await S.del("edits", id);
      } else if (!confirm("결과를 지우고 처음부터 다시 처리할까요? 검수 수정 내용은 남지만 발언 번호가 바뀔 수 있습니다.")) return;
      await S.resetJob(id);
      await S.saveJob(id, { status: "대기", error: null, stats: null, progress: { pct: 0, msg: "대기" }, ...(isDiar(j.mode) ? { stage: "diar", skip: [] } : {}) }); kick();
    }
    if (a === "delaudio") { if (!confirm("이 작업의 음원을 지울까요? 결과는 남고, 검수 화면의 재생은 안 됩니다.")) return; await S.deleteAudio(id); await S.saveJob(id, { audioDeleted: true }); }
    if (a === "del") { if (!confirm("작업과 결과를 모두 지울까요? (목소리 기준은 남습니다)")) return; await S.deleteJob(id); }
    loadJobs();
  } catch (e) { toast(e.message); }
});

/* ================================================================== 검수 */
// 할 일 순서대로 세 단계: ① 화자 이름 정하기(화자 나누기 작업만) → ② 발언 검수 → ③ 내보내기.
// 보기 범위는 포함 관계(전체 ⊃ 확인함·미검수, 미검수 ⊃ 확인 필요·판정 확실) — 규칙은 review.js.
const REVIEW = { id: null, want: null, data: null, edits: {}, filter: "need", editedOnly: false, saveT: null, gl: [], split: null, visible: [], fold: {} };
async function loadReviewJobs() {
  JOBS = await jobsList();
  const done = JOBS.filter((j) => (j.hasResult && j.mode !== "enroll") || j.status === "이름 대기");
  const sel = $("#rvJob");
  sel.innerHTML = done.length ? done.map((j) => `<option value="${esc(j.id)}">${esc(j.title)} (${esc(jobKind(j))}${j.status === "이름 대기" ? " · 이름 대기" : ""})</option>`).join("") : '<option value="">검수할 결과가 없습니다</option>';
  const id = REVIEW.want && done.some((j) => j.id === REVIEW.want) ? REVIEW.want : REVIEW.id && done.some((j) => j.id === REVIEW.id) ? REVIEW.id : done[0]?.id;
  REVIEW.want = null;
  // 결과가 하나도 없으면 빈 선택 칸·단계 상자 대신 안내와 「작업 목록으로」만 보인다
  const none = !done.length;
  $("#rvNone").classList.toggle("hidden", !none);
  for (const q of ["#rvBar", "#stNames", "#rvMain", "#stExport"]) $(q).classList.toggle("hidden", none);
  if (id) { sel.value = id; await openReview(id); }
  else {
    REVIEW.id = null; REVIEW.data = null;
    if (!player.paused) player.pause();
    $("#rvBody").innerHTML = ""; $("#rvStats").innerHTML = ""; $("#tl").classList.add("hidden");
  }
  syncSticky();
}
$("#rvGoJobs").addEventListener("click", () => showTab("jobs"));
$("#rvJob").addEventListener("change", (e) => openReview(e.target.value));
$$(".scope button[data-f]").forEach((b) => b.addEventListener("click", () => { REVIEW.filter = b.dataset.f; REVIEW.only = null; REVIEW.split = null; renderReview(); }));
$("#rvEdited").addEventListener("change", (e) => { REVIEW.editedOnly = e.target.checked; renderReview(); });
$("#rvPlaud").addEventListener("change", renderReview);
// 단계 접기·펼치기(작업마다 기억)
$$(".step .fold").forEach((b) => b.addEventListener("click", () => {
  const st = b.dataset.fold, f = (REVIEW.fold[REVIEW.id] = REVIEW.fold[REVIEW.id] || {});
  f[st] = !$("#" + st).classList.contains("folded");
  applyStepFold();
}));
function applyStepFold() {
  const f = REVIEW.fold[REVIEW.id] || {};
  for (const st of ["stNames", "rvMain"]) {
    const el = $("#" + st), folded = !!f[st];
    el.classList.toggle("folded", folded);
    const b = $(".fold", el); b.textContent = folded ? "펼치기 ▾" : "접기 ▴"; b.setAttribute("aria-expanded", String(!folded));
  }
}
// 보이는 단계에 차례로 1·2·3
function numberSteps() {
  let n = 0;
  for (const st of ["#stNames", "#rvMain", "#stExport"]) { const el = $(st); if (!el.classList.contains("hidden")) $("[data-no]", el).textContent = ++n; }
}
async function reviewData(id) {
  const [job, result, edits, plaud, gl] = await Promise.all([S.get("jobs", id), S.get("results", id), S.get("edits", id), S.get("plaud", id), S.get("kv", "glossary")]);
  return { job: { ...job, id }, result, edits: { e: {}, ...(edits || {}) }, plaud: plaud || [], glossary: (gl && gl.pairs) || [] };
}
async function openReview(id) {
  REVIEW.id = id;
  REVIEW.data = await reviewData(id);
  REVIEW.edits = REVIEW.data.edits.e || {};
  REVIEW.names = REVIEW.data.edits.names || {};
  REVIEW.gl = REVIEW.data.glossary;
  REVIEW.undo = [];
  REVIEW.split = null;
  REVIEW.diar = isDiar(REVIEW.data.job.mode) ? await S.get("chunks", id) : null;
  const plaudish = REVIEW.data.job.mode === "gap" || REVIEW.data.job.mode === "range";
  $("#rvPlaudWrap").classList.toggle("hidden", !plaudish);
  $("#exPlaudWrap").classList.toggle("hidden", !plaudish);
  REVIEW.vpNames = (await S.all("voiceprints")).map(([n]) => n);
  REVIEW.page = {};
  $("#rvSave").textContent = "";
  // ① 이름을 다 붙였고 전사가 끝났으면 처음부터 접어 둔다(이름 대기 중이면 펼침)
  if (!REVIEW.fold[id]) REVIEW.fold[id] = { stNames: !!(REVIEW.data.result && namesDone().done) };
  applyStepFold();
  updUndo();
  renderReview();
}
const gloss = (t) => { for (const p of REVIEW.gl || []) if (p.from) t = t.split(p.from).join(p.to); return t; };
const isNeed = (g) => {
  if (g.cluster) { // 소니 녹음: 이름 없는 묶음 · 묶음과 덜 닮음 · 다른 묶음과 차이 작음 · 2초 미만
    const e = REVIEW.edits[g.i];
    const named = (e && (e.speaker || (e.parts && e.parts.every((p) => p.speaker)))) || (REVIEW.names[g.cluster] && !isGeneric(REVIEW.names[g.cluster]));
    return !named || g.conf < 0.5 || g.margin < 0.1 || g.end - g.start < 2;
  }
  return g.kind !== "단일" || g.conf < 0.6;
};
// ① 진행: 전사할 묶음 중 이름(임시 이름 제외)이 붙은 수
function namesDone() {
  const skip = new Set((REVIEW.data && REVIEW.data.job.skip) || []);
  const cl = clustersOf().filter((c) => !skip.has(c.id));
  const named = cl.filter((c) => REVIEW.names[c.id] && !isGeneric(REVIEW.names[c.id])).length;
  return { total: cl.length, named, done: cl.length > 0 && named === cl.length };
}
function renderNamesStep() {
  const d = REVIEW.data, show = d && isDiar(d.job.mode);
  $("#stNames").classList.toggle("hidden", !show);
  if (!show) return;
  const { total, named, done } = namesDone();
  $("#stNamesProg").textContent = done ? `${total}묶음 모두 이름 붙음` : `${total}묶음 중 ${named}개 이름 붙음`;
  $("#stNames [data-no]").classList.toggle("done", done);
  // 접혔을 때: 사람별 발언 수만
  const cnt = {};
  for (const g of (d.result && d.result.segs) || []) { const n = speakerOf(g, { e: REVIEW.edits, names: REVIEW.names }); cnt[n] = (cnt[n] || 0) + 1; }
  $("#stNamesMini").innerHTML = Object.entries(cnt).sort((a, b) => b[1] - a[1]).map(([n, k]) => `<span>${esc(n)} ${k}</span>`).join("");
}
// ② 머리·범위 개수·③ 안내 — 확인 단추를 누를 때는 이것만 다시 그린다(행은 그대로)
function renderScope() {
  const d = REVIEW.data;
  if (!d || !d.result) return;
  const c = scopeCounts(d.result.segs, REVIEW.edits, isNeed);
  for (const f of SCOPES) $(`.scope b[data-n='${f}']`).textContent = c[f];
  $$(".scope button[data-f]").forEach((b) => b.classList.toggle("on", !REVIEW.only && b.dataset.f === REVIEW.filter));
  $("#rvProg").textContent = `${c.ok} / ${c.all} 확인`;
  $("#rvPbar").dataset.w = c.all ? (100 * c.ok) / c.all : 0;
  $("#rvEditedN").textContent = `(${c.edited})`;
  const left = REVIEW.visible.filter((i) => !(REVIEW.edits[i] && REVIEW.edits[i].ok)).length;
  $("#rvAllOk").textContent = `✓ 모두 확인 ${left}`;
  $("#rvAllOk").disabled = !left;
  $("#exWarn").textContent = `아직 확인 안 한 발언 ${c.todo}개 — 그대로 내보낼 수 있습니다`;
  $("#exWarn").classList.toggle("hidden", !c.todo);
  $("#exGlN").textContent = REVIEW.gl.length ? `(용어 ${REVIEW.gl.length}쌍)` : "";
  renderNamesStep();
  applyGeom($("#rvMain"));
}
function renderReview() {
  const d = REVIEW.data;
  if (!d) return;
  renderPanel();
  tlOpen();
  const sony = isDiar(d.job.mode);
  $("#rvMain").classList.toggle("hidden", !d.result);
  $("#stExport").classList.toggle("hidden", !d.result);
  renderNamesStep();
  numberSteps();
  if (!d.result) { $("#rvStats").innerHTML = ""; $("#rvBody").innerHTML = ""; REVIEW.visible = []; return; }
  const segs = d.result.segs, s = d.result.stats, job = d.job, smap = job.speakerMap || {};
  const names = new Set(s.speakersUsed || []);
  segs.forEach((g) => { if (g.kind === "단일") names.add(g.speaker); });
  Object.values(REVIEW.edits).forEach((e) => { e.speaker && names.add(e.speaker); (e.parts || []).forEach((p) => p.speaker && names.add(p.speaker)); });
  Object.values(REVIEW.names).forEach((n) => n && names.add(n));
  const nameList = [...names].filter(Boolean).sort((a, b) => a.localeCompare(b, "ko"));
  const multi = (s.files || []).length > 1;
  // 범위와 상관없는 처리 정보는 작게 한 줄
  $("#rvStats").textContent = [
    ...(sony ? [["전사 제외", s.skipped], ["환각 제거", s.droppedHallucination]] : [["혼재", s.mixed], ["미상", s.unknown], ["저신뢰", s.lowConf], ["환각 제거", s.droppedHallucination]])
      .filter(([, v]) => v).map(([k, v]) => `${k} ${v}`),
    ...(s.targets ? ["대상 " + s.targets.map((t) => (multi ? t.file + 1 + "번 " : "") + hms(t.from) + "~" + hms(t.to)).join(", ")] : []),
  ].join(" · ");
  let rows = segs.map((g) => ({ g, e: REVIEW.edits[g.i] || {} }));
  if (REVIEW.only) rows = rows.filter((r) => r.g.cluster === REVIEW.only);
  else rows = rows.filter((r) => inScope(REVIEW.filter, r.e, isNeed(r.g)));
  if (REVIEW.editedOnly) rows = rows.filter((r) => isEdited(r.e));
  REVIEW.visible = rows.map((r) => r.g.i);
  const items = rows.map((r) => ({ t: r.g.start, file: r.g.file || 0, r }));
  if ($("#rvPlaud").checked && !MULTI(job.mode)) {
    const tg = s.targets || [];
    for (const p of d.plaud) {
      const near = tg.some((t) => p.start >= t.from - 180 && p.start < t.to + 180); // 대상 구간 앞뒤 3분만 맥락으로
      if (near && !tg.some((t) => t.from <= p.start && p.start < t.to)) items.push({ t: p.start, file: 0, p });
    }
  }
  items.sort((a, b) => a.file - b.file || a.t - b.t);
  $("#rvEmpty").classList.toggle("hidden", items.length > 0);
  const canPlay = !job.audioDeleted;
  const playBtn = (f, s0, e0) => (canPlay ? `<button type="button" class="play" title="듣기" data-s="${s0}" data-e="${e0}" data-f="${f}">▶</button>` : "");
  const optsFor = (cur) => (nameList.includes(cur) ? nameList : [cur, ...nameList]).map((n) => `<option ${n === cur ? "selected" : ""}>${esc(n)}</option>`).join("") + '<option value="__new">직접 입력…</option>';
  const sp = REVIEW.split;
  $("#rvBody").innerHTML = items.map((it) => {
    if (it.p) return `<tr class="plaud"><td class="c-t">${hms(it.p.start)}</td><td></td><td>${esc(smap[it.p.speaker] || it.p.speaker)}</td><td>${esc(gloss(it.p.text))}</td><td><span class="msg">Plaud</span></td><td></td></tr>`;
    const { g, e } = it.r, f = g.file || 0;
    const spk = speakerOf(g, { e: REVIEW.edits, names: REVIEW.names });
    const parts = e.parts && e.parts.length ? e.parts : null;
    const splitting = sp && String(sp.i) === String(g.i);
    const splitBox = () => {
      const pe = parts ? partEnd(g, parts, sp.k) : g.end, ps = parts ? parts[sp.k].start : g.start;
      return `<div class="splitbox"><div class="spv">글에서 나눌 곳을 누르면 커서가 놓입니다.</div>
        <div class="row2"><button type="button" class="primary" data-a="doSplit">커서 위치에서 나누기</button>
        <button type="button" data-a="doSplitPlay" data-s="${ps}" data-e="${pe}">재생 위치에서</button></div>
        <button type="button" data-a="splitCancel">취소</button></div>`;
    };
    let body;
    if (parts) {
      body = `<div class="parts">${parts.map((p, k) => {
        const pspk = p.speaker || spk, on = splitting && sp.k === k;
        return `<div class="part" data-k="${k}"><span class="pt">${hms(p.start)}</span>
          <select class="pspk" aria-label="조각 화자">${optsFor(pspk)}</select>${playBtn(f, p.start, partEnd(g, parts, k))}
          <button type="button" class="act" data-a="split" data-k="${k}" title="이 조각을 다시 나누기">✂</button>
          <textarea class="ptx${on ? " splitta" : ""}" rows="1" aria-label="조각 발언">${esc(p.text)}</textarea>${on ? splitBox() : ""}</div>`;
      }).join("")}</div>`;
    } else body = `<textarea rows="1" aria-label="발언"${splitting ? ' class="splitta"' : ""}>${esc(e.text ?? gloss(g.text))}</textarea>${splitting ? splitBox() : ""}`;
    let spkCell, judge;
    if (parts) spkCell = `<span class="msg">${parts.length}조각으로 나눔</span>`;
    else if (sony) spkCell = `<button type="button" class="spkbtn cc${clusterIndex(g.cluster) % 8}${e.speaker ? " own" : ""}" title="${esc(clusterLabel(g.cluster))}${e.speaker ? " · 이 발언만 따로 지정" : ""}">${esc(spk)}</button>`;
    else spkCell = `<select class="spk" aria-label="화자">${optsFor(spk)}</select>`;
    if (sony) {
      const why = [];
      if (g.conf < 0.5) why.push("묶음과 덜 닮음");
      if (g.margin < 0.1) why.push("다른 묶음과 비슷");
      if (g.end - g.start < 2) why.push("짧음");
      judge = `<span class="kind ${why.length ? "k-저신뢰" : "k-단일"}">${esc(clusterLabel(g.cluster).replace("Speaker ", "S"))} ${Math.round(g.conf * 100)}%</span><span class="votes">${esc(why.join(" · "))}</span>`;
    } else {
      const kl = g.kind === "단일" && g.conf < 0.6 ? "저신뢰" : g.kind;
      const votes = Object.entries(g.votes || {}).slice(0, 3).map(([k, v]) => `${k} ${Math.round(v * 100)}%`).join(" · ");
      judge = `<span class="kind k-${kl}">${kl} ${Math.round(g.conf * 100)}%</span><span class="votes">${esc(votes)}</span>`;
    }
    const act = parts ? '<button type="button" class="act" data-a="merge" title="나눈 조각을 다시 한 발언으로">↺ 합치기</button>'
      : splitting ? "" : '<button type="button" class="act" data-a="split" data-k="0" title="한 발언에 여러 사람 말이 섞였을 때">✂ 나누기</button>';
    const cls = [isEdited(e) ? "edited" : "", isNeed(g) && !e.ok ? "need" : "", splitting ? "splitting" : ""].filter(Boolean).join(" ");
    return `<tr data-i="${g.i}" class="${cls}">
      <td class="c-t">${(multi ? `<small>${f + 1}번</small> ` : "") + hms(g.start)}</td>
      <td>${playBtn(f, g.start, g.end)}</td>
      <td>${spkCell}</td>
      <td>${body}</td>
      <td><div class="judge">${judge}<span class="spacer"></span>${act}</div></td>
      <td class="c-ok"><button type="button" class="okbtn${e.ok ? " done" : ""}" data-a="ok" aria-pressed="${!!e.ok}" title="이 발언을 사람이 확인함 — 미검수에서 빠집니다">${e.ok ? "✓ 확인함" : "✓ 확인"}</button></td></tr>`;
  }).join("");
  $$("#rvBody textarea").forEach(fitTa);
  renderScope();
  if (sp) { const ta = $(`#rvBody tr[data-i="${sp.i}"] textarea.splitta`); if (ta) { ta.focus(); splitPreview(ta); } }
  TL.cur = null; tlDraw();
}
const editOf = (i) => (REVIEW.edits[i] = REVIEW.edits[i] || {});
const segOf = (i) => REVIEW.data.result.segs.find((x) => String(x.i) === String(i));
$("#rvBody").addEventListener("change", (ev) => {
  const tr = ev.target.closest("tr[data-i]");
  if (!tr) return;
  const i = tr.dataset.i, g = segOf(i), part = ev.target.closest(".part");
  if (ev.target.matches("select.spk, select.pspk")) {
    pushUndo();
    let v = ev.target.value;
    if (v === "__new") { v = (prompt("화자 이름") || "").trim(); if (!v) { REVIEW.undo.pop(); renderReview(); return; } }
    const e = editOf(i);
    if (part) { // 나눈 조각의 화자
      const p = e.parts[+part.dataset.k], base = speakerOf(g, { e: { ...REVIEW.edits, [i]: { ...e, speaker: e.speaker } }, names: REVIEW.names });
      if (v === base) delete p.speaker; else p.speaker = v;
    } else if (v === g.speaker) delete e.speaker; else e.speaker = v;
    e.ok = true;
    saveEdits(); renderReview(); return;
  }
  if (ev.target.matches("textarea")) {
    if (REVIEW.split) return; // 나누는 중에는 나눌 때 함께 반영
    pushUndo();
    const e = editOf(i), v = ev.target.value.trim();
    if (part) e.parts[+part.dataset.k].text = v;
    else if (v === gloss(g.text).trim()) delete e.text; else e.text = v;
  }
  tr.classList.toggle("edited", isEdited(REVIEW.edits[i]));
  saveEdits(); renderScope();
});
// 확인 · 나누기 · 합치기
function playPosIn(f, s0, e0) { return TL.loaded === f && player.currentTime > s0 + 0.1 && player.currentTime < e0 - 0.1 ? player.currentTime : null; }
function splitPreview(ta) {
  const tr = ta.closest("tr"), box = $(".splitbox", tr);
  if (!box) return;
  const pos = ta.selectionStart, v = ta.value, a = v.slice(0, pos).trim(), b = v.slice(pos).trim();
  const short = (x) => (x.length > 14 ? x.slice(0, 14) + "…" : x);
  $(".spv", box).textContent = a && b ? `앞: 「${short(a)}」 · 뒤: 「${short(b)}」` : "글에서 나눌 곳을 누르면 커서가 놓입니다.";
  $("[data-a='doSplit']", box).disabled = !(a && b);
  const pb = $("[data-a='doSplitPlay']", box), g = segOf(tr.dataset.i), t = playPosIn(g.file || 0, +pb.dataset.s, +pb.dataset.e);
  pb.disabled = !(a && b) || t == null;
  pb.textContent = t == null ? "재생 위치에서(이 구간 재생 중일 때)" : `재생 위치 ${hms(t)}에서`;
}
const fitTa = (t) => { t.style.height = "auto"; t.style.height = t.scrollHeight + 2 + "px"; };
$("#rvBody").addEventListener("input", (ev) => { if (ev.target.matches("textarea")) fitTa(ev.target); });
for (const evn of ["keyup", "click", "select", "input"]) $("#rvBody").addEventListener(evn, (ev) => { if (ev.target.matches("textarea.splitta")) splitPreview(ev.target); });
// player는 아래(재생 막대)에서 만들어지므로 모듈을 다 읽은 뒤 건다
queueMicrotask(() => player.addEventListener("timeupdate", () => { const ta = $("#rvBody textarea.splitta"); if (ta) splitPreview(ta); }));
$("#rvBody").addEventListener("click", (ev) => {
  const b = ev.target.closest("button[data-a]");
  if (!b) return;
  const tr = b.closest("tr[data-i]"), i = tr.dataset.i, g = segOf(i), a = b.dataset.a;
  if (a === "ok") {
    const e = editOf(i); e.ok = !e.ok;
    b.classList.toggle("done", e.ok); b.textContent = e.ok ? "✓ 확인함" : "✓ 확인"; b.setAttribute("aria-pressed", String(e.ok));
    tr.classList.toggle("need", isNeed(g) && !e.ok);
    saveEdits(); renderScope(); return;
  }
  if (a === "split") { REVIEW.split = { i: g.i, k: +b.dataset.k }; renderReview(); return; }
  if (a === "splitCancel") { REVIEW.split = null; renderReview(); return; }
  if (a === "doSplit" || a === "doSplitPlay") {
    const ta = $("textarea.splitta", tr), e = editOf(i), k = REVIEW.split.k;
    const at = a === "doSplitPlay" ? playPosIn(g.file || 0, +b.dataset.s, +b.dataset.e) : undefined;
    const parts = splitPart(g, e.parts, k, ta.value, ta.selectionStart, at ?? undefined);
    if (!parts) { toast("나눌 곳을 글 중간에 두세요"); return; }
    pushUndo();
    e.parts = parts; delete e.text;
    REVIEW.split = null;
    saveEdits(); renderReview(); toast("나눴습니다 — 조각마다 화자를 고르세요");
    return;
  }
  if (a === "merge") {
    const e = editOf(i);
    pushUndo();
    const m = mergeParts(e.parts);
    delete e.parts;
    if (m.text !== gloss(g.text).trim()) e.text = m.text; else delete e.text;
    if (m.speaker) e.speaker = m.speaker;
    saveEdits(); renderReview(); toast("한 발언으로 합쳤습니다");
  }
});
$("#rvAllOk").addEventListener("click", () => {
  const todo = REVIEW.visible.filter((i) => !(REVIEW.edits[i] && REVIEW.edits[i].ok));
  if (!todo.length) return;
  pushUndo();
  for (const i of todo) editOf(i).ok = true;
  saveEdits(); renderReview(); toast(`${todo.length}개를 확인했습니다 — 「되돌리기」로 되돌릴 수 있습니다`);
});
$("#rvUndo").addEventListener("click", () => undo());
function saveEdits() {
  $("#rvSave").textContent = "저장 대기…";
  clearTimeout(REVIEW.saveT);
  const id = REVIEW.id;
  REVIEW.saveT = setTimeout(async () => {
    try { await S.put("edits", id, { e: REVIEW.edits, names: REVIEW.names, updatedAt: S.now() }); $("#rvSave").textContent = "저장됨 " + new Date().toLocaleTimeString("ko-KR"); }
    catch (e) { $("#rvSave").textContent = "저장 실패: " + e.message; }
  }, 400);
}
/* ================================================================== 고정 영역(틀 고정) 높이 */
// 위: 탭 줄(모든 화면) + 검수 화면의 작업 선택·보기 줄, 아래: 전체 재생 막대. 높이가 바뀌면(접힘·화면 회전·폴드 펼침)
// CSS 변수로 알려 표 머리·스크롤 여백이 가려지지 않게 한다.
const REDUCE_MOTION = matchMedia("(prefers-reduced-motion: reduce)").matches;
function syncSticky() {
  const root = document.documentElement.style;
  root.setProperty("--tabs-h", $(".tabs").offsetHeight + "px");
  root.setProperty("--rvbar-h", ($("#tab-review").classList.contains("on") ? $("#rvBar").offsetHeight : 0) + "px");
  root.setProperty("--tl-h", ($("#tab-review").classList.contains("on") && !$("#tl").classList.contains("hidden") ? $("#tl").offsetHeight : 0) + "px");
}
if (window.ResizeObserver) { const ro = new ResizeObserver(syncSticky); [".tabs", "#rvBar", "#tl"].forEach((q) => ro.observe($(q))); }
window.addEventListener("resize", syncSticky);
let tlFolded = false;
try { tlFolded = localStorage.getItem("pb-tl-folded") === "1"; } catch { /* 저장 불가 */ }
function applyFold() {
  $("#tl").classList.toggle("folded", tlFolded);
  $("#tlFold").textContent = tlFolded ? "펼치기" : "접기";
  $("#tlFold").setAttribute("aria-expanded", String(!tlFolded));
  syncSticky(); tlDraw();
}
$("#tlFold").addEventListener("click", () => { tlFolded = !tlFolded; try { localStorage.setItem("pb-tl-folded", tlFolded ? "1" : "0"); } catch { /* 저장 불가 */ } applyFold(); });

/* ================================================================== 전체 음원 재생 막대 */
// 검수 화면 아래에 녹음 전체를 펼쳐 둔다. 위 띠는 지금 위치 앞뒤 ±45초(화자별 색·발언 경계·소리 크기),
// 아래 띠는 녹음 전체. 발언의 ▶는 그 발언 시각부터 이어서 재생하고, 띠를 끌면 앞뒤로 옮겨진다.
// 음원은 메모리에 올리지 않고 저장된 파일(16kHz)에 WAV 머리만 붙여 가리킨다(2시간 녹음도 휴대폰에서 가볍게).
const player = $("#player");
/* 휴대폰 알림·잠금 화면의 재생 카드(Media Session): 앱 이름·작업 제목·지금 말하는 사람을 보여 준다.
   이 정보가 없으면 안드로이드 크롬은 「chrome-native://newtab」 같은 엉뚱한 제목을 띄운다. */
const APP_NAME = "Diarized Transcription";
const MS = "mediaSession" in navigator ? navigator.mediaSession : null;
let msTitle = "";
function mediaMeta(force = false) {
  if (!MS || typeof MediaMetadata === "undefined") return;
  const d = REVIEW.data, t = player.currentTime || 0, fi = TL.loaded >= 0 ? TL.loaded : TL.file;
  const it = (TL.items || []).find((x) => x.f === fi && !x.plaud && x.s <= t && t < x.e);
  const file = ((d && d.job.audioFiles) || [])[fi];
  const title = (it ? `${it.name} · ` : "") + (file ? file.name : "녹음") + ` · ${hms(t)}`;
  const key = (it ? it.name : "") + "|" + (file ? file.name : "") + "|" + (d ? d.job.title : "");
  if (force || key !== msTitle) {
    msTitle = key;
    const art = (n) => ({ src: new URL(`icons/icon-${n}.png`, location.href).href, sizes: `${n}x${n}`, type: "image/png" });
    try { MS.metadata = new MediaMetadata({ title, artist: d ? d.job.title || APP_NAME : APP_NAME, album: APP_NAME, artwork: [art(192), art(512)] }); } catch { /* 지원 안 함 */ }
  }
  try { if (player.duration && isFinite(player.duration)) MS.setPositionState({ duration: player.duration, playbackRate: player.playbackRate || 1, position: Math.min(t, player.duration) }); } catch { /* 지원 안 함 */ }
}
if (MS) {
  const on = (a, f) => { try { MS.setActionHandler(a, f); } catch { /* 지원 안 함 */ } };
  on("play", () => player.play());
  on("pause", () => player.pause());
  on("seekbackward", (e) => { player.currentTime = Math.max(0, player.currentTime - (e.seekOffset || 10)); mediaMeta(); });
  on("seekforward", (e) => { player.currentTime = Math.min(player.duration || 0, player.currentTime + (e.seekOffset || 10)); mediaMeta(); });
  on("seekto", (e) => { player.currentTime = e.seekTime; mediaMeta(); });
  player.addEventListener("play", () => { mediaMeta(true); MS.playbackState = "playing"; });
  player.addEventListener("pause", () => { MS.playbackState = "paused"; mediaMeta(); });
  player.addEventListener("timeupdate", () => mediaMeta());
}
const PAL = ["#2f6fa8", "#1b7f74", "#a2620a", "#6a43a8", "#b3261e", "#4a7a1e", "#8a5a44", "#3d5a80"];
const TL = { id: null, file: 0, loaded: -1, t: 0, env: {}, items: [], Z: 45, drag: null, cur: null, raf: 0 };
const PRE = 0.3; // ▶는 발언 시각 0.3초 앞부터(첫 소리가 잘리지 않을 만큼만 — 2초 앞부터 틀면 적힌 시각과 들리는 소리가 어긋나 보였음)
const fileDur = (fi) => ((REVIEW.data?.job.audioFiles || [])[fi] || {}).dur || 0;
const hashColor = (n) => { let h = 0; for (const c of String(n)) h = (h * 31 + c.charCodeAt(0)) >>> 0; return PAL[h % PAL.length]; };

/** 띠에 그릴 발언들 [{f,s,e,name,color,i,plaud}] */
function tlItems() {
  const d = REVIEW.data, out = [];
  if (!d) return out;
  const ed = { e: REVIEW.edits, names: REVIEW.names };
  if (d.result) {
    for (const g of d.result.segs) {
      const name = speakerOf(g, ed), parts = REVIEW.edits[g.i] && REVIEW.edits[g.i].parts;
      const color = g.cluster && !(REVIEW.edits[g.i] && REVIEW.edits[g.i].speaker) ? PAL[clusterIndex(g.cluster) % 8] : g.kind === "단일" || g.cluster ? hashColor(name) : "#9aa0a8";
      if (parts && parts.length) { // 나눈 발언은 조각마다 제 화자 색
        parts.forEach((p, k) => out.push({ f: g.file || 0, s: p.start, e: partEnd(g, parts, k), name: p.speaker || name, color: p.speaker ? hashColor(p.speaker) : color, i: g.i, k }));
        continue;
      }
      out.push({ f: g.file || 0, s: g.start, e: g.end, name, color, i: g.i });
    }
    if (d.job.mode === "gap" || d.job.mode === "range") {
      const smap = d.job.speakerMap || {};
      for (const p of d.plaud) out.push({ f: 0, s: p.start, e: p.end || p.start + 2, name: smap[p.speaker] || p.speaker, color: "#9aa0a8", plaud: true });
    }
  } else if (REVIEW.diar && REVIEW.diar.kind === "diar") {
    const cl = REVIEW.diar.clusters;
    for (const u of REVIEW.diar.units) out.push({ f: u.f, s: u.s, e: u.e, name: REVIEW.names[cl[u.c].id] || cl[u.c].label, color: PAL[u.c % 8] });
  }
  return out.sort((a, b) => a.f - b.f || a.s - b.s);
}

function tlOpen() {
  const d = REVIEW.data, files = d.job.audioFiles || [];
  const show = !d.job.audioDeleted && files.length > 0;
  $("#tl").classList.toggle("hidden", !show);
  if (TL.id !== REVIEW.id) { player.pause(); TL.id = REVIEW.id; TL.file = 0; TL.loaded = -1; TL.t = 0; TL.env = {}; }
  $("#tlFile").innerHTML = files.map((f, i) => `<option value="${i}">${i + 1}번 ${esc(f.name)}</option>`).join("");
  $("#tlFile").classList.toggle("hidden", files.length < 2);
  $("#tlFile").value = String(TL.file);
  TL.items = tlItems();
  applyFold();
}

async function tlLoad(fi) {
  if (TL.loaded === fi && player.src) return;
  const file = await S.audioFile(REVIEW.id, fi);
  if (player.src) URL.revokeObjectURL(player.src);
  player.src = URL.createObjectURL(new Blob([wavHeader(file.size / 2), file], { type: "audio/wav" }));
  TL.loaded = fi; TL.file = fi; $("#tlFile").value = String(fi);
  await new Promise((res) => { if (player.readyState >= 1) res(); else player.addEventListener("loadedmetadata", res, { once: true }); });
  tlEnvelope(fi);
}

/** 소리 크기 윤곽(0.25초마다 최댓값) — 1분씩 읽어 조금씩 채운다 */
async function tlEnvelope(fi) {
  const key = REVIEW.id + "/" + fi;
  if (TL.env[key]) return;
  const dur = fileDur(fi), step = 0.25, env = (TL.env[key] = new Float32Array(Math.ceil(dur / step) + 1));
  for (let t = 0; t < dur; t += 60) {
    if (TL.id !== REVIEW.id) return;
    const x = await S.readAudio(REVIEW.id, fi, t, Math.min(dur, t + 60));
    const n = Math.floor(step * 16000);
    for (let k = 0; k * n < x.length; k++) {
      let m = 0;
      for (let j = k * n; j < Math.min(x.length, (k + 1) * n); j += 4) { const v = Math.abs(x[j]); if (v > m) m = v; }
      env[Math.floor(t / step) + k] = m;
    }
    if (player.paused) tlDraw();
  }
}

async function seekPlay(fi, t, play = true) {
  if (REVIEW.data.job.audioDeleted) { toast("음원을 지운 작업입니다"); return; }
  try {
    await tlLoad(fi);
    player.currentTime = Math.max(0, Math.min(t, fileDur(fi) - 0.05));
    TL.t = player.currentTime;
    if (play) await player.play();
    tlDraw(true);
  } catch (err) { toast("재생 실패: " + err.message); }
}

function canvasCtx(c) {
  const dpr = window.devicePixelRatio || 1, w = c.clientWidth, h = c.clientHeight;
  if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) { c.width = Math.round(w * dpr); c.height = Math.round(h * dpr); }
  const g = c.getContext("2d");
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, w, h);
  return [g, w, h];
}

function tlDraw(scrollToCur = false) {
  if ($("#tl").classList.contains("hidden") || !REVIEW.data) return;
  const fi = TL.file, dur = fileDur(fi) || 1;
  const t = TL.loaded === fi ? player.currentTime : TL.t;
  TL.t = t;
  const items = TL.items.filter((x) => x.f === fi);
  const env = TL.env[REVIEW.id + "/" + fi];
  const css = getComputedStyle(document.body), ink = css.color, mute = css.getPropertyValue("--mute") || "#888";
  // 위 띠: t ± Z
  const [g, w, h] = canvasCtx($("#tlZoom"));
  const a = t - TL.Z, span = 2 * TL.Z, X = (sec) => ((sec - a) / span) * w;
  if (env) {
    g.fillStyle = "rgba(128,128,128,.35)";
    const k0 = Math.max(0, Math.floor(a / 0.25)), k1 = Math.min(env.length, Math.ceil((a + span) / 0.25));
    for (let k = k0; k < k1; k++) { const v = Math.min(1, env[k] * 2.2) * (h - 18); g.fillRect(X(k * 0.25), h - 4 - v, Math.max(1, w / (span / 0.25)), v); }
  }
  g.font = "11px system-ui, sans-serif"; g.textBaseline = "top";
  for (const x of items) {
    if (x.e < a || x.s > a + span) continue;
    const x0 = Math.max(0, X(x.s)), x1 = Math.min(w, X(x.e));
    g.globalAlpha = x.plaud ? 0.18 : 0.22; g.fillStyle = x.color; g.fillRect(x0, 14, x1 - x0, h - 18);
    g.globalAlpha = 1; g.fillRect(x0, 14, x1 - x0, x.plaud ? 2 : 4);
    if (x1 - x0 > 30) { g.fillStyle = x.plaud ? mute : x.color; g.fillText(x.name, x0 + 2, 1, x1 - x0 - 4); }
  }
  g.fillStyle = mute; g.globalAlpha = 0.8;
  for (let s = Math.ceil(a / 10) * 10; s < a + span; s += 10) { if (s < 0) continue; g.fillRect(X(s), h - 4, 1, 4); }
  g.globalAlpha = 1; g.fillStyle = "#d33"; g.fillRect(w / 2 - 1, 0, 2, h);
  // 아래 띠: 녹음 전체
  const [o, ow, oh] = canvasCtx($("#tlAll"));
  const OX = (sec) => (sec / dur) * ow;
  o.fillStyle = "rgba(128,128,128,.18)"; o.fillRect(0, 0, ow, oh);
  for (const x of items) { o.globalAlpha = x.plaud ? 0.35 : 0.9; o.fillStyle = x.color; o.fillRect(OX(x.s), x.plaud ? oh - 4 : 3, Math.max(1, OX(x.e) - OX(x.s)), x.plaud ? 4 : oh - 6); }
  o.globalAlpha = 1; o.strokeStyle = ink; o.lineWidth = 1; o.strokeRect(Math.max(0, OX(a)) + 0.5, 0.5, Math.max(2, OX(a + span) - Math.max(0, OX(a))), oh - 1);
  o.fillStyle = "#d33"; o.fillRect(OX(t) - 1, 0, 2, oh);
  // 지금 발언
  const cur = items.find((x) => !x.plaud && x.s <= t && t < x.e) || items.find((x) => x.s <= t && t < x.e);
  $("#tlTime").textContent = `${hms(t)} / ${hms(dur)}`;
  $("#tlNow").textContent = cur ? cur.name : "";
  $("#tlPlay").textContent = player.paused || TL.loaded !== fi ? "▶" : "❚❚";
  // 지금 발언(나눈 발언은 조각까지) — 「i」 또는 「i/조각」. 행을 다시 그리면 TL.cur를 비워 다시 찾는다
  const curI = cur && cur.i != null ? String(cur.i) + (cur.k != null ? "/" + cur.k : "") : null;
  if (curI !== TL.cur) {
    TL.cur = curI;
    $$("#rvBody .playing").forEach((r) => r.classList.remove("playing"));
    const row = cur && cur.i != null && $(`#rvBody tr[data-i="${cur.i}"]`);
    if (row) {
      row.classList.add("playing");
      const part = cur.k != null && $(`.part[data-k="${cur.k}"]`, row);
      if (part) part.classList.add("playing");
      const el = part || row, r = el.getBoundingClientRect(), bottom = window.innerHeight - $("#tl").offsetHeight;
      const topLim = $(".tabs").offsetHeight + $("#rvBar").offsetHeight;
      const editing = document.activeElement && row.contains(document.activeElement) && document.activeElement.matches("textarea, select");
      if (!editing && (scrollToCur || (!player.paused && $("#tlFollow").checked)) && (r.top < topLim || r.bottom > bottom)) el.scrollIntoView({ block: "center", behavior: REDUCE_MOTION ? "auto" : "smooth" });
    }
  }
}
const tlLoop = () => { tlDraw(); if (!player.paused) TL.raf = requestAnimationFrame(tlLoop); };
player.addEventListener("play", () => { cancelAnimationFrame(TL.raf); TL.raf = requestAnimationFrame(tlLoop); });
player.addEventListener("pause", () => tlDraw());
player.addEventListener("ended", () => tlDraw());
window.addEventListener("resize", () => tlDraw());

$("#tlPlay").addEventListener("click", () => (player.paused || TL.loaded !== TL.file ? seekPlay(TL.file, TL.t) : player.pause()));
$$("#tl [data-j]").forEach((b) => b.addEventListener("click", () => seekPlay(TL.file, TL.t + +b.dataset.j, !player.paused)));
$("#tlRate").addEventListener("change", (e) => { player.playbackRate = +e.target.value; });
$("#tlFile").addEventListener("change", (e) => seekPlay(+e.target.value, 0, false));
$("#tlTime").addEventListener("click", () => { TL.cur = null; tlDraw(true); });
// 아래 띠: 누르거나 끌면 그 자리로
const tlAll = $("#tlAll");
const allSeek = (ev) => { const r = tlAll.getBoundingClientRect(); TL.t = Math.max(0, Math.min(1, (ev.clientX - r.left) / r.width)) * fileDur(TL.file); if (TL.loaded === TL.file) player.currentTime = TL.t; tlDraw(true); };
tlAll.addEventListener("pointerdown", (ev) => { tlAll.setPointerCapture(ev.pointerId); TL.drag = "all"; tlLoad(TL.file).then(() => allSeek(ev)); });
tlAll.addEventListener("pointermove", (ev) => { if (TL.drag === "all") allSeek(ev); });
tlAll.addEventListener("pointerup", () => { TL.drag = null; });
// 위 띠: 끌면 앞뒤로 옮기기, 짧게 누르면 그 자리로
const tlZoom = $("#tlZoom");
tlZoom.addEventListener("pointerdown", (ev) => { tlZoom.setPointerCapture(ev.pointerId); TL.drag = { x: ev.clientX, t: TL.t, moved: false }; tlLoad(TL.file); });
tlZoom.addEventListener("pointermove", (ev) => {
  const d = TL.drag; if (!d || d === "all") return;
  const dx = ev.clientX - d.x; if (Math.abs(dx) > 4) d.moved = true;
  if (!d.moved) return;
  TL.t = Math.max(0, Math.min(fileDur(TL.file), d.t - (dx / tlZoom.clientWidth) * 2 * TL.Z));
  if (TL.loaded === TL.file) player.currentTime = TL.t;
  tlDraw();
});
tlZoom.addEventListener("pointerup", (ev) => {
  const d = TL.drag; TL.drag = null;
  if (!d || d === "all" || d.moved) return;
  const r = tlZoom.getBoundingClientRect();
  seekPlay(TL.file, TL.t - TL.Z + ((ev.clientX - r.left) / r.width) * 2 * TL.Z, !player.paused);
});

// 구간만 정확히 듣기: s에서 시작해 e에서 멈춘다. timeupdate(약 0.25초마다)로는 끝을 넘겨 듣게 되어 화면 갱신마다 확인한다
const STOP = { at: null, raf: 0 };
function stopWatch() {
  cancelAnimationFrame(STOP.raf);
  const tick = () => {
    if (STOP.at == null) return;
    if (player.paused) { STOP.at = null; return; }
    if (player.currentTime >= STOP.at) { player.pause(); STOP.at = null; return; }
    STOP.raf = requestAnimationFrame(tick);
  };
  STOP.raf = requestAnimationFrame(tick);
}
async function playRange(f, s, e) {
  STOP.at = e;
  await seekPlay(f, s);
  stopWatch();
}
// 발언 ▶ — 발언 시각부터 이어서 재생(같은 발언을 재생 중이면 멈춤)
function playFrom(f, s) {
  if (!player.paused && TL.loaded === f && TL.t >= s - PRE - 0.1 && TL.t < s + 0.5) { player.pause(); return; }
  seekPlay(f, Math.max(0, s - PRE));
}
$("#rvBody").addEventListener("click", (ev) => {
  const b = ev.target.closest("button.play");
  if (b) playFrom(+b.dataset.f, +b.dataset.s);
});
async function doExport(fmt) {
  if (!REVIEW.id) return;
  const data = await reviewData(REVIEW.id);
  const opts = { usePlaud: $("#exPlaud").checked, useGlossary: $("#exGl").checked };
  const name = safeName(data.job.title) + "_통합본." + fmt;
  if (fmt === "csv") download(name, new Blob([exportCsv(data, opts)], { type: "text/csv;charset=utf-8" }));
  else download(name, new Blob([exportTxt(data, opts)], { type: "text/plain;charset=utf-8" }));
}
$("#exTxt").addEventListener("click", () => doExport("txt"));
$("#exCsv").addEventListener("click", () => doExport("csv"));

/* ================================================================== 화자 패널(소니 녹음) */
// 묶음(Speaker N)마다 대표 구간을 들어 보고 이름을 붙이면 그 묶음 발언 전체에 적용된다. 같은 이름을 붙이면 합쳐진다.
// 이름이 정해지는 우선순위: 발언별 수정 > 묶음 이름 > 처리 결과(Speaker N). 원래 묶음은 지우지 않아 언제든 되돌릴 수 있다.
const clustersOf = () => (REVIEW.data && (REVIEW.data.result?.clusters || REVIEW.diar?.clusters)) || [];
const clusterIndex = (id) => Math.max(0, clustersOf().findIndex((c) => c.id === id));
const clusterLabel = (id) => (clustersOf().find((c) => c.id === id) || {}).label || id;
const nameOfCluster = (c) => REVIEW.names[c.id] || c.label;

function pushUndo(diar) { // diar: 묶음을 나누기 전 화자 나누기 결과(되돌릴 때 다시 저장)
  REVIEW.undo.push({ s: JSON.stringify({ e: REVIEW.edits, names: REVIEW.names }), diar });
  if (REVIEW.undo.length > 100) REVIEW.undo.shift();
  updUndo();
}
function updUndo() {
  const none = !(REVIEW.undo && REVIEW.undo.length);
  for (const q of ["#spUndo", "#rvUndo"]) if ($(q)) $(q).disabled = none;
}
function undo() {
  const last = REVIEW.undo.pop();
  if (!last) { toast("되돌릴 것이 없습니다"); return; }
  const v = JSON.parse(last.s);
  REVIEW.edits = v.e; REVIEW.names = v.names;
  if (last.diar) { REVIEW.diar = last.diar; S.put("chunks", REVIEW.id, last.diar).catch((e) => toast("되돌리기 저장 실패: " + e.message)); }
  REVIEW.split = null; updUndo();
  saveEdits(); renderReview(); toast("되돌렸습니다");
}
document.addEventListener("keydown", (ev) => {
  if (!(ev.ctrlKey || ev.metaKey) || ev.key.toLowerCase() !== "z" || ev.shiftKey) return;
  if (!$("#tab-review").classList.contains("on") || ev.target.closest("input, textarea, select")) return;
  ev.preventDefault(); undo();
});

function textNear(f, s) {
  const segs = REVIEW.data.result ? REVIEW.data.result.segs : [];
  const g = segs.find((x) => (x.file || 0) === f && x.start <= s + 0.5 && x.end > s);
  return g ? (REVIEW.edits[g.i] && REVIEW.edits[g.i].text) || gloss(g.text) : "";
}

function renderPanel() {
  const d = REVIEW.data, el = $("#spkPanel");
  if (!d || !isDiar(d.job.mode)) { el.classList.add("hidden"); $("#stNames").classList.add("hidden"); return; }
  el.classList.remove("hidden"); $("#stNames").classList.remove("hidden");
  const cl = clustersOf();
  const pending = !d.result;
  const skip = new Set(d.job.skip || []);
  const byName = {};
  cl.forEach((c) => { const n = REVIEW.names[c.id]; if (n) (byName[n] = byName[n] || []).push(c); });
  const segs = d.result ? d.result.segs : [];
  const vp = new Set(REVIEW.vpNames);
  const names = [...new Set([...REVIEW.vpNames, ...Object.values(REVIEW.names).filter(Boolean)])].sort((a, b) => a.localeCompare(b, "ko"));
  const strong = cl.filter((c) => c.suggest && c.suggest.strong && !REVIEW.names[c.id]);
  const cards = [...cl].sort((a, b) => b.dur - a.dur).map((c) => {
    const ci = clusterIndex(c.id), nm = REVIEW.names[c.id] || "";
    const same = nm && byName[nm].length > 1 ? byName[nm].filter((x) => x !== c).map((x) => x.label) : [];
    const page = REVIEW.page[c.id] || 0, per = 2;
    const smp = (c.samples || []).slice(page * per, page * per + per);
    const nseg = segs.filter((g) => g.cluster === c.id).length;
    const sug = c.suggest ? `<button type="button" class="sug${c.suggest.strong ? "" : " weak"}" data-a="sug" title="${c.suggest.strong ? "저장된 목소리 기준과 닮음" : "닮은 정도가 약합니다 — 들어 보고 정하세요"}">${c.suggest.strong ? "추천" : "닮음"}: ${esc(c.suggest.name)} ${Math.round(c.suggest.sim * 100)}%</button>` : vp.size ? '<span class="msg">저장된 기준과 닮은 사람 없음</span>' : "";
    return `<div class="cl${skip.has(c.id) ? " skipped" : ""}${REVIEW.only === c.id ? " focus" : ""}" data-c="${esc(c.id)}">
      <div class="hd"><span class="chip cc${ci % 8}">${esc(c.label)}</span>
        <span class="msg">${pending ? `발언 ${c.nunit}` : `발언 ${nseg}`} · ${hms(c.dur)}</span><span class="spacer"></span>
        <label class="chk" title="빼면 이 묶음의 발언은 전사하지 않습니다(잡음·음악 묶음 등)"><input type="checkbox" data-a="inc" ${skip.has(c.id) ? "" : "checked"}> 전사</label>
        ${pending ? ((c.nturn || 0) >= 4 ? '<button type="button" class="link" data-a="split2" title="두 사람이 쉼 없이 주고받아 한 사람으로 묶였을 때 — 목소리로 다시 둘로 나눕니다">둘로 나누기</button>' : "")
          : `<button type="button" class="link" data-a="only">${REVIEW.only === c.id ? "모두 보기" : "이 묶음만 보기"}</button>`}</div>
      <div class="nm"><input data-a="name" list="dlNames" value="${esc(nm)}" placeholder="이름(예: 김○○ 팀장)" aria-label="${esc(c.label)} 이름"> ${sug}
        ${same.length ? `<span class="merged">↳ ${esc(same.join(", "))}와 같은 사람(합쳐짐)</span>` : ""}</div>
      <div class="smp">${smp.map((x) => `<div><button type="button" class="play" data-a="play" data-f="${x.f}" data-s="${x.s}" data-e="${x.e}" title="듣기">▶</button>
        <span class="msg">${(d.job.audioFiles || []).length > 1 ? x.f + 1 + "번 " : ""}${fmt1(x.s)}~${fmt1(x.e)} (${(x.e - x.s).toFixed(1)}초)</span> <span class="tx">${esc(textNear(x.f, x.s).slice(0, 90))}</span>${pending && REVIEW.diar ? `<button type="button" class="act rgbtn" data-a="rg" data-f="${x.f}" data-s="${x.s}" data-e="${x.e}" title="이 구간에서 다른 사람 목소리를 발라내기">✂ 손보기</button>` : ""}</div>`).join("") || '<span class="msg">들어 볼 구간 없음</span>'}
        ${(c.samples || []).length > per ? `<button type="button" class="link" data-a="more">다른 구간 ▸ ${page + 1}/${Math.ceil(c.samples.length / per)}</button>` : ""}</div>
    </div>`;
  }).join("");
  // 섞였을 수 있는 곳(이름 대기 중): 한 묶음 안에서 목소리가 바뀌는 듯한 곳을 먼저 보여 준다
  const mix = pending && REVIEW.diar ? mixSuspects(REVIEW.diar) : [];
  const multiF = (d.job.audioFiles || []).length > 1;
  const mixHtml = mix.length ? `<div class="mixalert"><b>⚠ 다른 목소리가 섞였을 수 있는 곳 ${mix.length}곳</b>
      <div class="msg">한 묶음 안에서 목소리가 바뀌는 듯한 곳입니다. 들어 보고 손봐 주세요.</div>
      ${mix.map((r) => {
        const span = r.ctxE - r.ctxS || 1, l = ((r.s - r.ctxS) / span) * 100, w = ((r.e - r.s) / span) * 100;
        return `<div class="mixrow"><span class="chip cc${r.c % 8}">${esc(cl[r.c].label.replace("Speaker ", "S"))}</span>
          <span class="mixbar cc${r.c % 8}"><i data-left="${l.toFixed(1)}" data-w="${w.toFixed(1)}"></i></span>
          <button type="button" class="act" data-a="rg" data-f="${r.f}" data-s="${r.s}" data-e="${r.e}">✂ 손보기</button>
          <span class="t">${multiF ? r.f + 1 + "번 " : ""}${fmt1(r.s)}~${fmt1(r.e)} (${(r.e - r.s).toFixed(1)}초)${r.other >= 0 ? ` · ${esc(cl[r.other].label.replace("Speaker ", "S"))}와 닮음` : " · 다른 목소리"}</span></div>`;
      }).join("")}</div>` : "";
  el.innerHTML = `<div class="bar"><span class="msg">${pending ? "대표 구간을 들어 보고 이름을 붙이세요. 같은 이름을 붙이면 한 사람으로 합쳐집니다. 이름은 전사 뒤에도 바꿀 수 있습니다." : "이름을 바꾸면 그 묶음 발언 전체에 적용됩니다(발언별로 따로 지정한 것은 그대로)."}</span>
      <span class="spacer"></span>
      ${strong.length ? `<button type="button" data-a="sugall">추천 ${strong.length}건 모두 적용</button>` : ""}
      <button type="button" id="spUndo" data-a="undo" ${REVIEW.undo.length ? "" : "disabled"} title="Ctrl+Z / ⌘Z">되돌리기</button>
      ${pending ? `<button type="button" class="primary" data-a="go" ${d.job.status === "이름 대기" ? "" : "disabled"}>이 이름으로 전사 시작</button>`
        : `<button type="button" data-a="vp" title="이름 붙인 사람의 목소리를 다음 녹음에서 추천하도록 저장합니다(30초 이상 말한 사람만)">목소리 기준 저장</button>`}</div>
    ${mixHtml}
    <div class="clgrid">${cards}</div>
    <datalist id="dlNames">${names.map((n) => `<option value="${esc(n)}">`).join("")}</datalist>`;
  applyGeom(el);
}

$("#spkPanel").addEventListener("change", async (ev) => {
  const t = ev.target, card = t.closest(".cl");
  if (!card) return;
  const id = card.dataset.c;
  if (t.dataset.a === "name") {
    pushUndo();
    const v = t.value.trim();
    if (v) REVIEW.names[id] = v; else delete REVIEW.names[id];
    saveEdits(); renderReview();
  }
  if (t.dataset.a === "inc") {
    const job = await S.get("jobs", REVIEW.id);
    const skip = new Set(job.skip || []);
    if (t.checked) skip.delete(id); else skip.add(id);
    await S.saveJob(REVIEW.id, { skip: [...skip] });
    REVIEW.data.job.skip = [...skip];
    if (REVIEW.data.result && t.checked) toast("작업 목록에서 「이어서 처리」를 누르면 이 묶음 발언을 전사해 더합니다");
    if (REVIEW.data.result && !t.checked) toast("내보내기에서 빠지려면 「이어서 처리」로 결과를 다시 만드세요");
    if (REVIEW.data.result && job.status === "완료" && t.checked) await S.saveJob(REVIEW.id, { status: "중지", progress: { pct: 0, msg: "더할 발언이 있습니다 — 이어서 처리" } });
    if (REVIEW.data.result && job.status === "완료" && !t.checked) await S.saveJob(REVIEW.id, { status: "중지", progress: { pct: 0, msg: "뺀 묶음이 있습니다 — 이어서 처리" } });
    renderPanel();
  }
});
$("#spkPanel").addEventListener("click", async (ev) => {
  const b = ev.target.closest("button[data-a]");
  if (!b) return;
  const a = b.dataset.a, card = b.closest(".cl"), id = card && card.dataset.c;
  const c = id && clustersOf().find((x) => x.id === id);
  if (a === "play") return playRange(+b.dataset.f, +b.dataset.s, +b.dataset.e); // 대표 구간은 적힌 시각 그대로(앞 2초 없이)
  if (a === "rg") return openRange(+b.dataset.f, +b.dataset.s, +b.dataset.e);
  if (a === "more") { REVIEW.page[id] = ((REVIEW.page[id] || 0) + 1) % Math.ceil(c.samples.length / 2); renderPanel(); return; }
  if (a === "only") { REVIEW.only = REVIEW.only === id ? null : id; REVIEW.split = null; renderReview(); if (REVIEW.only) $("#rvMain").scrollIntoView({ block: "start" }); return; }
  if (a === "sug") { pushUndo(); REVIEW.names[id] = c.suggest.name; saveEdits(); renderReview(); return; }
  if (a === "sugall") { pushUndo(); clustersOf().forEach((x) => { if (x.suggest && x.suggest.strong && !REVIEW.names[x.id]) REVIEW.names[x.id] = x.suggest.name; }); saveEdits(); renderReview(); return; }
  if (a === "undo") return undo();
  if (a === "split2") { // 두 사람이 쉼 없이 주고받아 한 묶음이 된 경우 — 이름 대기 중에만
    const ci = clustersOf().indexOf(c);
    const vp = Object.fromEntries(await S.all("voiceprints"));
    const nd = splitCluster(REVIEW.diar, ci, knownPrints(vp, REVIEW.data.job.speakers));
    if (!nd) { toast("이 묶음은 더 나눌 수 없습니다(말한 구간이 너무 적음)"); return; }
    pushUndo(REVIEW.diar);
    REVIEW.diar = nd;
    await S.put("chunks", REVIEW.id, nd);
    const neu = nd.clusters[nd.clusters.length - 1];
    renderReview();
    toast(`${c.label}을 둘로 나눴습니다 — 새로 생긴 ${neu.label}의 대표 구간을 들어 보세요(되돌리기 가능)`);
    return;
  }
  if (a === "go") {
    const unnamed = clustersOf().filter((x) => !REVIEW.names[x.id] && !(REVIEW.data.job.skip || []).includes(x.id)).length;
    if (unnamed && !confirm(`이름 없는 묶음이 ${unnamed}개 있습니다. 그대로 전사할까요? (이름은 전사 뒤에도 붙일 수 있습니다)`)) return;
    clearTimeout(REVIEW.saveT);
    await S.put("edits", REVIEW.id, { e: REVIEW.edits, names: REVIEW.names, updatedAt: S.now() });
    await S.saveJob(REVIEW.id, { stage: "transcribe", status: "대기", progress: { pct: 0, msg: "전사 대기" } });
    kick(); toast("전사를 시작합니다 — 작업 탭에서 진행을 볼 수 있습니다"); showTab("jobs");
    return;
  }
  if (a === "vp") return saveSonyPrints();
});

async function saveSonyPrints() {
  const d = REVIEW.data;
  if (!REVIEW.diar || REVIEW.diar.kind !== "diar") { toast("이 작업은 목소리 특징이 남아 있지 않아(백업에서 되살림 등) 저장할 수 없습니다"); return; }
  const prints = printsFromReview(d.result.segs, REVIEW.diar.units, (g) => speakerOf(g, { e: REVIEW.edits, names: REVIEW.names }), isGeneric);
  const list = Object.entries(prints);
  if (!list.length) { toast("저장할 사람이 없습니다(이름을 붙이고 30초 이상 말한 사람만 저장)"); return; }
  if (!confirm(`다음 사람의 목소리 기준을 「${d.job.title}」 출처로 저장할까요? (같은 출처는 바꿔 넣습니다)\n\n` + list.map(([n, p]) => `${n} — ${hms(p.sec)}`).join("\n"))) return;
  for (const [name, p] of list) {
    await S.update("voiceprints", name, (ent) => {
      const e = ent || { name, items: {}, model: "campplus" };
      e.items = { ...e.items, [d.job.title || REVIEW.id]: { vec: p.vec, n: p.n, at: S.now() } };
      e.updatedAt = S.now();
      return e;
    });
  }
  REVIEW.vpNames = (await S.all("voiceprints")).map(([n]) => n);
  toast(`목소리 기준 ${list.length}명 저장`);
}

/* ---- 발언별 화자 창: 이 발언만 / 이 묶음 전체 / 이 묶음에서 이 발언 이후 */
const pop = $("#spkPop");
let popRow = null;
$("#rvBody").addEventListener("click", (ev) => {
  const b = ev.target.closest("button.spkbtn");
  if (!b) return;
  const tr = b.closest("tr"), g = REVIEW.data.result.segs.find((x) => String(x.i) === tr.dataset.i);
  popRow = g;
  const cur = speakerOf(g, { e: REVIEW.edits, names: REVIEW.names });
  const clusterNamed = REVIEW.names[g.cluster] && !isGeneric(REVIEW.names[g.cluster]);
  const chips = [...new Set([...Object.values(REVIEW.names), ...REVIEW.vpNames])].filter(Boolean).sort((a, c) => a.localeCompare(c, "ko"));
  pop.innerHTML = `<b>${hms(g.start)} 발언의 화자</b> <span class="msg">(${esc(clusterLabel(g.cluster))})</span>
    <input id="popName" list="dlNames" value="${esc(cur)}" aria-label="화자 이름">
    <div class="chips">${chips.map((n) => `<span class="chip" data-n="${esc(n)}">${esc(n)}</span>`).join("")}</div>
    <label class="opt"><input type="radio" name="popScope" value="one" ${clusterNamed ? "checked" : ""}> 이 발언만</label>
    <label class="opt"><input type="radio" name="popScope" value="all" ${clusterNamed ? "" : "checked"}> 이 묶음(${esc(clusterLabel(g.cluster))}) 전체</label>
    <label class="opt"><input type="radio" name="popScope" value="after"> 이 묶음에서 이 발언부터 끝까지</label>
    ${REVIEW.edits[g.i] && REVIEW.edits[g.i].speaker ? '<button type="button" class="link" data-a="reset">따로 지정 풀기(묶음 이름 따르기)</button>' : ""}
    <div class="row end"><button type="button" data-a="cancel">취소</button><button type="button" class="primary" data-a="save">저장</button></div>`;
  pop.classList.remove("hidden");
  const r = b.getBoundingClientRect();
  pop.style.top = Math.min(window.innerHeight - pop.offsetHeight - 8, r.bottom + 4) + "px";
  pop.style.left = Math.max(8, Math.min(window.innerWidth - pop.offsetWidth - 8, r.left)) + "px";
  $("#popName").select();
});
pop.addEventListener("click", (ev) => {
  const chip = ev.target.closest(".chip");
  if (chip) { $("#popName").value = chip.dataset.n; return; }
  const b = ev.target.closest("button[data-a]");
  if (!b) return;
  if (b.dataset.a === "cancel") { pop.classList.add("hidden"); return; }
  const g = popRow;
  pushUndo();
  if (b.dataset.a === "reset") { delete editOf(g.i).speaker; editOf(g.i).ok = true; }
  else {
    const v = $("#popName").value.trim();
    if (!v) { toast("이름을 넣어 주세요"); REVIEW.undo.pop(); return; }
    const scope = $('input[name="popScope"]:checked', pop).value;
    if (scope === "one") { editOf(g.i).speaker = v; editOf(g.i).ok = true; }
    if (scope === "all") { REVIEW.names[g.cluster] = v; if (REVIEW.edits[g.i]) delete REVIEW.edits[g.i].speaker; }
    if (scope === "after") {
      for (const x of REVIEW.data.result.segs) {
        if (x.cluster !== g.cluster || (x.file || 0) < (g.file || 0) || ((x.file || 0) === (g.file || 0) && x.start < g.start)) continue;
        if (REVIEW.edits[x.i] && REVIEW.edits[x.i].speaker && x !== g) continue; // 따로 지정한 발언은 그대로
        editOf(x.i).speaker = v;
      }
    }
  }
  pop.classList.add("hidden");
  saveEdits(); renderReview();
});
pop.addEventListener("keydown", (ev) => { if (ev.key === "Enter" && ev.target.id === "popName") { ev.preventDefault(); pop.querySelector('[data-a="save"]').click(); } if (ev.key === "Escape") pop.classList.add("hidden"); });
document.addEventListener("mousedown", (ev) => { if (!pop.classList.contains("hidden") && !ev.target.closest("#spkPop, button.spkbtn")) pop.classList.add("hidden"); });

/* ================================================================== 목소리 기준 */
async function loadVoices() {
  const vs = (await S.all("voiceprints")).sort((a, b) => a[0].localeCompare(b[0], "ko"));
  $("#vpBody").innerHTML = vs.length ? vs.map(([name, v]) => {
    const items = Object.entries(v.items || {});
    const n = items.reduce((m, [, it]) => m + it.n, 0);
    return `<tr data-n="${esc(name)}"><td><b>${esc(name)}</b></td><td>${n}</td>
      <td class="src">${items.map(([src, it]) => `<div><span>${esc(src)} (${it.n})</span><button type="button" data-src="${esc(src)}" title="이 출처만 빼기">빼기</button></div>`).join("")}</td>
      <td class="nowrap"><button type="button" data-a="ren">이름 바꾸기·합치기</button> <button type="button" data-a="del">지우기</button></td></tr>`;
  }).join("") : '<tr><td colspan="4" class="empty">저장된 목소리 기준이 없습니다. Plaud 녹음 작업을 처리하거나, 화자 나누기 검수에서 「목소리 기준 저장」을 누르면 쌓입니다.</td></tr>';
}
$("#vpBody").addEventListener("click", async (ev) => {
  const b = ev.target.closest("button");
  if (!b) return;
  const n = b.closest("tr").dataset.n;
  if (b.dataset.src) {
    if (!confirm(`${n}의 「${b.dataset.src}」 기준을 뺄까요?`)) return;
    const v = await S.get("voiceprints", n);
    delete v.items[b.dataset.src];
    if (Object.keys(v.items).length) await S.put("voiceprints", n, v); else await S.del("voiceprints", n);
  } else if (b.dataset.a === "del") {
    if (!confirm(`${n}의 목소리 기준을 모두 지울까요?`)) return;
    await S.del("voiceprints", n);
  } else if (b.dataset.a === "ren") {
    const to = (prompt("새 이름 (이미 있는 이름이면 합쳐집니다)", n) || "").trim();
    if (!to || to === n) return;
    const v = await S.get("voiceprints", n), w = await S.get("voiceprints", to);
    await S.put("voiceprints", to, w ? { ...w, items: { ...w.items, ...v.items }, updatedAt: S.now() } : { ...v, name: to, updatedAt: S.now() });
    await S.del("voiceprints", n);
  }
  loadVoices();
});

/* ================================================================== 사전 */
async function loadGlossary() {
  const g = (await S.get("kv", "glossary")) || { pairs: [] };
  $("#glBody").innerHTML = "";
  (g.pairs.length ? g.pairs : [{ from: "", to: "" }]).forEach(addGlRow);
}
function addGlRow(p = { from: "", to: "" }) {
  const tr = document.createElement("tr");
  tr.innerHTML = `<td><input class="f" value="${esc(p.from)}" aria-label="잘못 적힌 말"></td><td><input class="t" value="${esc(p.to)}" aria-label="바로잡을 말"></td><td><button type="button" title="줄 지우기">✕</button></td>`;
  tr.querySelector("button").addEventListener("click", () => tr.remove());
  $("#glBody").appendChild(tr);
}
$("#glAdd").addEventListener("click", () => addGlRow());
$("#glSave").addEventListener("click", async () => {
  const pairs = $$("#glBody tr").map((tr) => ({ from: $(".f", tr).value.trim(), to: $(".t", tr).value.trim() })).filter((p) => p.from);
  await S.put("kv", "glossary", { pairs, updatedAt: S.now() });
  REVIEW.gl = pairs;
  toast("사전을 저장했습니다");
});

/* ================================================================== 설정·백업 */
async function loadSettings() {
  const set = (await S.get("kv", "settings")) || {};
  $("#threads").value = set.threads || 0;
  const dev = await detectDevice();
  const auto = dev.level;
  $("#gpuLevel").innerHTML = `<option value="auto">자동(권장) → ${esc(levelLabel(auto))}</option>` + LEVELS.map((l) => `<option value="${l.v}">${esc(l.label)}</option>`).join("");
  $("#gpuLevel").value = typeof set.gpuLevel === "number" ? String(set.gpuLevel) : set.gpu === false ? "0" : "auto";
  // 한 줄로: 기기 · 그래픽 칩 → 자동 단계(근거는 말풍선으로)
  $("#devInfo").textContent = `이 기기: ${[dev.name || dev.model, dev.gpu].filter(Boolean).join(" · ") || "알 수 없음"} → 자동: ${levelLabel(auto)}`;
  $("#devInfo").title = `근거: ${dev.basis}`;
  renderLevelNow();
  showBenchPrev().catch(() => {});
  worker.postMessage({ type: "status" });
  try {
    const est = await navigator.storage.estimate();
    const persisted = navigator.storage.persisted ? await navigator.storage.persisted() : false;
    $("#storeState").innerHTML = `이 사이트가 쓰는 공간 ${(est.usage / 1073741824).toFixed(2)}GB / 쓸 수 있는 공간 ${(est.quota / 1073741824).toFixed(0)}GB · ${persisted ? "영구 보관 켜짐" : "영구 보관 꺼짐(공간이 부족하면 브라우저가 지울 수 있음)"}`;
  } catch { /* 없음 */ }
}
$("#btnModels").addEventListener("click", () => { worker.postMessage({ type: "download" }); toast("모델을 받기 시작했습니다"); });
$("#btnClearModels").addEventListener("click", async () => {
  if (!confirm("받아 둔 모델을 지울까요? 다음 처리 때 다시 받습니다.")) return;
  for (const k of await caches.keys()) if (k.startsWith("pb-models") || k.startsWith("pb-m-")) await caches.delete(k);
  worker.terminate(); startWorker(); toast("모델을 지웠습니다");
});
/* 기기 성능 시험: 그래픽 칩(WebGPU) 지원은 화면 쪽에서, 단계별 속도는 일꾼에서 잰다 */
async function gpuInfo() {
  try {
    if (!navigator.gpu) return { ok: false, why: "이 브라우저에 WebGPU 없음" };
    const ad = await navigator.gpu.requestAdapter();
    if (!ad) return { ok: false, why: "그래픽 칩을 쓸 수 없음" };
    const info = ad.info || {};
    return { ok: true, f16: ad.features.has("shader-f16"), name: [info.vendor, info.architecture, info.description].filter(Boolean).join(" ") || "알 수 없음" };
  } catch (e) { return { ok: false, why: String(e.message || e) }; }
}
const sec = (ms) => (ms >= 3600000 ? `${Math.floor(ms / 3600000)}시간 ${Math.round((ms % 3600000) / 60000)}분` : ms >= 60000 ? `${Math.floor(ms / 60000)}분 ${Math.round((ms % 60000) / 1000)}초` : `${(ms / 1000).toFixed(ms < 10000 ? 1 : 0)}초`);
let BENCH_GPU = null;
// 시험 기록의 가속 단계 — 설정 목록과 같은 이름(사용 - 빠름·보통·느림, 끔)
const levelText = (r) => {
  const n = r.device === "gpu" ? (r.gpuParts ?? r.nParts ?? 4) : 0;
  return LEVELS.some((l) => l.v === n) ? levelLabel(n) : `사용(${n}/${r.nParts || 4})`;
};
function renderBench(r, gpu) {
  const row = (k, v) => `<dt>${k}</dt><dd>${v}</dd>`;
  const enc = r.enc.map(sec).join(" → ");
  const d = r.at ? new Date(r.at) : new Date(), when = `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  $("#benchOut").innerHTML = [
    row("시험 시각", `${when}`),
    row("그래픽 칩", gpu ? (gpu.ok ? `WebGPU 사용 가능 · 16비트 연산 ${gpu.f16 ? "지원" : "없음"} · ${esc(gpu.name)}` : esc(gpu.why)) : "-"),
    row("처리 스레드", r.threads || "-"),
    row("기기", esc(r.dev ? devText(r.dev) : "-")),
    row("가속 단계", levelText(r)
      + (r.want != null && r.want !== (r.device === "gpu" ? r.gpuParts : 0)
        ? `<br><span class="err">설정은 「${esc(levelLabel(r.want))}」이었지만 적용되지 않음 — ${esc(r.why || "모델을 먼저 다른 단계로 올려 둠(새로 고침 필요)")}</span>` : "")),
    row("모델 올리기", r.load < 100 ? "이미 올라가 있음" : sec(r.load)),
    row("말소리 찾기", r.vadMin != null ? `음성 1분에 ${sec(r.vadMin)}` : "-"),
    row("목소리 특징", `3초 창 하나에 ${sec(r.emb)}`),
    row("전사 30초 창", `${enc}` + (r.decStep[0] ? ` · 글자 조각 하나 ${sec(r.decStep.reduce((a, b) => a + b, 0) / r.decStep.length)}` : "")),
    row("느려짐", r.slow > 1.3 ? `<span class="err">세 번째가 첫 번째보다 ${r.slow.toFixed(1)}배 느림 — 발열로 속도가 떨어지는 기기입니다</span>` : `없음(${r.slow.toFixed(2)}배)`),
    row("1시간 회의 어림", `화자 나누기 약 ${sec(r.estDiar)} · 전사 약 ${sec(r.estTr)}`),
  ].join("");
}
function onBench(m) {
  if (m.msg) { $("#benchMsg").textContent = m.msg + " …"; return; }
  keepAwake("bench", false);
  WSTATE.busy = false; worker.postMessage({ type: "status" }); // 시험 중에 받은 「처리 중」 상태가 남지 않게
  $("#btnBench").disabled = false;
  if (m.error) { $("#benchMsg").textContent = m.error; $("#benchMsg").classList.add("err"); return; }
  $("#benchMsg").textContent = "끝났습니다"; $("#benchMsg").classList.remove("err");
  const rec = { at: S.now(), gpu: BENCH_GPU, ...m.result, dev: DEV ? { name: DEV.name, model: DEV.model, soc: DEV.soc, gpu: DEV.gpu } : null };
  m.result.dev = rec.dev;
  renderBench(m.result, BENCH_GPU);
  S.update("kv", "bench", (h) => [rec, ...((h && Array.isArray(h) ? h : []))].slice(0, 10)).then(showBenchPrev).catch(() => {});
}
/** 시험 기록 목록(최근 10번): 시각 · 가속 단계 · 전사 30초 창(첫 번째) · 1시간 회의 전사 어림 · 느려짐 */
async function showBenchPrev() {
  const h = (await S.get("kv", "bench")) || [];
  const el = $("#benchHist");
  if (!Array.isArray(h) || !h.length) { el.innerHTML = ""; return; }
  const when = (at) => { const d = new Date(at); return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`; };
  el.innerHTML = `<h4>시험 기록</h4><table class="bh"><thead><tr><th>시각</th><th>가속 단계</th><th title="전사 30초 창 하나(첫 번째)">30초 창</th><th title="1시간 회의 전사 어림">1시간 전사</th><th title="세 번째 ÷ 첫 번째(1.3배 넘으면 발열)">느려짐</th></tr></thead><tbody>`
    + h.map((r) => `<tr><td>${when(r.at)}</td><td>${esc(levelText(r))}${r.want != null && r.want !== (r.device === "gpu" ? r.gpuParts : 0) ? ' <span class="err" title="설정한 단계가 적용되지 않음">*</span>' : ""}</td><td>${sec(r.enc[0])}</td><td>${sec(r.estTr)}</td><td>${r.slow > 1.3 ? `<span class="err">${r.slow.toFixed(2)}배</span>` : `${r.slow.toFixed(2)}배`}</td></tr>`).join("")
    + `</tbody></table>`;
}
$("#btnBench").addEventListener("click", async () => {
  if (WSTATE.busy) { $("#benchMsg").textContent = "작업을 처리하는 중에는 시험할 수 없습니다."; return; }
  $("#btnBench").disabled = true; $("#benchMsg").classList.remove("err");
  $("#benchMsg").textContent = "그래픽 칩 확인 …";
  keepAwake("bench", true);
  const want = effectiveLevel((await S.get("kv", "settings")) || {}, await detectDevice());
  if (WSTATE.engineLoaded && WSTATE.loadedLevel !== want) toast(`설정(${levelLabel(want)})은 새로 고친 뒤 적용됩니다 — 이번 시험은 「${levelLabel(WSTATE.loadedLevel ?? 0)}」으로 잽니다`);
  BENCH_GPU = await gpuInfo();
  worker.postMessage({ type: "bench" });
});
$("#gpuLevel").addEventListener("change", async () => {
  const v = $("#gpuLevel").value, set = (await S.get("kv", "settings")) || {};
  delete set.gpu; // 예전 켜고 끄기 설정은 단계로 바뀜
  if (v === "auto") delete set.gpuLevel; else set.gpuLevel = +v;
  await S.put("kv", "settings", set);
  if (!WSTATE.engineLoaded) { await sendLevel(); toast("다음 전사·성능 시험부터 적용됩니다"); }
  else toast("모델이 이미 올라가 있어 새로 고쳐야 적용됩니다");
  renderLevelNow();
});
$("#btnThreads").addEventListener("click", async () => {
  await S.put("kv", "settings", { ...((await S.get("kv", "settings")) || {}), threads: Math.max(0, Math.min(32, +$("#threads").value || 0)) });
  toast("페이지를 새로 고친 뒤부터 적용됩니다");
});
$("#btnBackup").addEventListener("click", async () => {
  const jobs = {};
  for (const [id, job] of await S.all("jobs")) {
    jobs[id] = { job, result: await S.get("results", id), edits: await S.get("edits", id), plaud: await S.get("plaud", id) };
  }
  const bk = { format: "plaud-booster-backup", version: 2, exportedAt: S.now(), voiceprints: Object.fromEntries(await S.all("voiceprints")),
    glossary: ((await S.get("kv", "glossary")) || {}).pairs || [], jobs };
  const d = new Date();
  download(`plaud-booster-백업_${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}.json`, new Blob([JSON.stringify(bk)], { type: "application/json" }));
});
$("#restoreFile").addEventListener("change", async (ev) => {
  const f = ev.target.files[0];
  if (!f) return;
  try {
    const bk = JSON.parse(await f.text());
    if (bk.format !== "plaud-booster-backup") throw new Error("작업대 백업 파일이 아닙니다");
    if (bk.version > 2) throw new Error("이 화면보다 새 판의 백업입니다. 페이지를 새로 고친 뒤 다시 올려 주세요");
    const cur = { voiceprints: Object.fromEntries(await S.all("voiceprints")), glossary: ((await S.get("kv", "glossary")) || {}).pairs || [], jobIds: new Set((await S.all("jobs")).map(([k]) => k)) };
    const m = mergeBackup(cur, bk);
    for (const [name, v] of Object.entries(m.voiceprints)) await S.put("voiceprints", name, v);
    await S.put("kv", "glossary", { pairs: m.glossary, updatedAt: S.now() });
    for (const [id, j] of Object.entries(m.jobs)) {
      await S.put("jobs", id, j.job);
      if (j.result) await S.put("results", id, j.result);
      if (j.edits) await S.put("edits", id, j.edits);
      if (j.plaud) await S.put("plaud", id, j.plaud);
    }
    $("#restoreMsg").textContent = `합쳐 넣음 — 목소리 기준 ${m.added.voiceprints}건, 사전 ${m.added.glossary}건, 작업 ${m.added.jobs}건`;
  } catch (e) { $("#restoreMsg").textContent = "실패: " + e.message; }
  ev.target.value = "";
});

/* ================================================================== 시작 */
(async () => {
  if (!(await ensureIsolation())) return;
  if (!window.OfflineAudioContext || !navigator.storage?.getDirectory) {
    $("#banner").textContent = "이 브라우저는 지원하지 않습니다. 최신 Chrome이나 Edge로 열어 주세요.";
    $("#banner").classList.remove("hidden");
    return;
  }
  try { if (navigator.storage.persist) await navigator.storage.persist(); } catch { /* 무시 */ }
  startWorker();
  const start = (location.hash || "#jobs").slice(1);
  showTab(["jobs", "review", "voices", "glossary", "settings"].includes(start) ? start : "jobs");
  setInterval(() => { if ($("#tab-jobs").classList.contains("on")) loadJobs(); }, 5000);
})();

/* ================================================================== 구간 손보기(이름 대기 중)
 * 1 구간 정하기(파형 끌기·손잡이·⏱ 지금·±0.2초) → 2 누구 말인지(기존 묶음·새 사람·빼기) → 3 비슷한 곳(들어 보고 고른 것만 옮김).
 * 규칙은 diar.js(relabelRange·similarRegions·mixSuspects). 되돌리기는 손보기 전 화자 나누기 결과를 다시 저장한다. */
const RG = { open: false };
const fmt1 = (t) => { const m = Math.floor(t / 60), s = t - m * 60; return `${m}:${s < 10 ? "0" : ""}${s.toFixed(1)}`; };
const rgNameOf = (i) => { const c = clustersOf()[i]; return c ? (REVIEW.names[c.id] ? `${REVIEW.names[c.id]}(${c.label.replace("Speaker ", "S")})` : c.label) : "빼기"; };
async function rgKnown() { const vp = Object.fromEntries(await S.all("voiceprints")); return knownPrints(vp, REVIEW.data.job.speakers); }
function rgMajority(f, s, e) {
  const had = {};
  for (const t of REVIEW.diar.turns) { if ((t.f || 0) !== f || t.e <= s || t.s >= e) continue; had[t.c] = (had[t.c] || 0) + Math.min(e, t.e) - Math.max(s, t.s); }
  const top = Object.entries(had).sort((a, b) => b[1] - a[1])[0];
  return top ? +top[0] : -1;
}
async function openRange(f, s, e) {
  if (!REVIEW.diar || REVIEW.data.result) return;
  const dur = fileDur(f) || e + 10;
  const pad = Math.max(4, Math.min(8, (e - s) * 0.4));
  let vs = Math.max(0, s - pad), ve = Math.min(dur, e + pad);
  if (ve - vs > 45) { const mid = (s + e) / 2; vs = Math.max(0, mid - 22.5); ve = Math.min(dur, vs + 45); }
  Object.assign(RG, { open: true, f, vs, ve, s, e, target: null, drag: null, peaks: null, from: rgMajority(f, s, e) });
  $("#rgEdit").classList.remove("hidden"); $("#rgSim").classList.add("hidden");
  $("#rgSheet").classList.remove("hidden");
  document.body.classList.add("rg-open");
  rgRender();
  try {
    const x = await S.readAudio(REVIEW.id, f, vs, ve);
    const n = 400, step = Math.max(1, Math.floor(x.length / n)), pk = new Float32Array(n);
    for (let k = 0; k < n; k++) { let m = 0; for (let j = k * step; j < Math.min(x.length, (k + 1) * step); j += 2) { const v = Math.abs(x[j]); if (v > m) m = v; } pk[k] = m; }
    const top = Math.max(1e-4, ...pk); for (let k = 0; k < n; k++) pk[k] /= top;
    if (RG.open && RG.f === f && RG.vs === vs) { RG.peaks = pk; rgDraw(); }
  } catch (err) { toast("파형을 읽지 못했습니다: " + err.message); }
}
function closeRange() {
  RG.open = false; STOP.at = null;
  $("#rgSheet").classList.add("hidden");
  document.body.classList.remove("rg-open");
}
function rgRender() {
  const cl = clustersOf();
  $("#rgFrom").textContent = `${(REVIEW.data.job.audioFiles || []).length > 1 ? RG.f + 1 + "번 " : ""}${fmt1(RG.vs)}~${fmt1(RG.ve)}`;
  $("#rgS").textContent = fmt1(RG.s); $("#rgE").textContent = fmt1(RG.e);
  $("#rgWhoQ").textContent = `이 구간(${(RG.e - RG.s).toFixed(1)}초)은 누구 말인가요?`;
  const chip = (v, html, cls) => `<button type="button" data-to="${v}" class="${cls}${String(RG.target) === String(v) ? " on" : ""}">${html}</button>`;
  $("#rgWho").innerHTML = cl.map((c, i) => chip(i, esc(rgNameOf(i)) + (i === RG.from ? " <small>(지금)</small>" : ""), `who cc${i % 8}`)).join("")
    + chip("new", "＋ 새 사람", "") + chip("drop", "🚫 빼기 <small>잡음·제3자</small>", "");
  $("#rgLegend").innerHTML = cl.map((c, i) => `<span><i class="cc${i % 8}"></i>${esc(c.label.replace("Speaker ", "S"))}</span>`).join("") + '<span><i class="sel"></i>고른 구간</span><span><i class="ph"></i>재생 위치</span>';
  const ticks = 5;
  $("#rgAxis").innerHTML = Array.from({ length: ticks }, (_, k) => `<span>${hms(RG.vs + ((RG.ve - RG.vs) * k) / (ticks - 1))}</span>`).join("");
  $("#rgSheet [data-rg='apply']").disabled = RG.target == null;
  $("#rgFindWrap").classList.toggle("hidden", RG.target === "drop");
  $$("#rgSheet .flow span").forEach((x) => x.classList.toggle("on", x.dataset.st === "1" || (x.dataset.st === "2" && RG.target != null)));
  rgDraw();
}
function rgDraw() {
  if (!RG.open) return;
  const [g, w, h] = canvasCtx($("#rgWave"));
  const X = (t) => ((t - RG.vs) / (RG.ve - RG.vs)) * w;
  const css = getComputedStyle(document.body);
  g.fillStyle = css.getPropertyValue("--bg") || "#f6f5f1"; g.fillRect(0, 0, w, h);
  // 위 띠: 지금 묶음(사람이 정한 곳은 진하게)
  for (const t of REVIEW.diar.turns) {
    if ((t.f || 0) !== RG.f || t.e <= RG.vs || t.s >= RG.ve) continue;
    g.globalAlpha = t.m ? 1 : 0.75; g.fillStyle = t.c >= 0 ? PAL[t.c % 8] : "#9aa0a8";
    g.fillRect(X(t.s), 0, Math.max(1, X(t.e) - X(t.s)), 9);
  }
  g.globalAlpha = 1;
  // 고른 구간
  g.fillStyle = "rgba(31,95,139,.16)"; g.fillRect(X(RG.s), 10, X(RG.e) - X(RG.s), h - 10);
  // 파형
  if (RG.peaks) {
    const n = RG.peaks.length, bw = w / n, mid = (h + 10) / 2, amp = (h - 30) / 2;
    g.fillStyle = css.getPropertyValue("--mute") || "#6b7078";
    for (let k = 0; k < n; k++) { const v = Math.max(0.5, RG.peaks[k] * amp); g.fillRect(k * bw, mid - v, Math.max(1, bw - 0.6), 2 * v); }
  } else { g.fillStyle = css.getPropertyValue("--mute"); g.font = "12px system-ui"; g.fillText("파형 읽는 중…", 8, h / 2); }
  // 손잡이
  g.fillStyle = "#1f5f8b";
  for (const t of [RG.s, RG.e]) { const x = X(t); g.fillRect(x - 1.5, 10, 3, h - 10); g.beginPath(); g.roundRect(x - 10, h - 24, 20, 24, 4); g.fill(); }
  g.strokeStyle = "#fff"; g.lineWidth = 1.6;
  for (const t of [RG.s, RG.e]) { const x = X(t); g.beginPath(); g.moveTo(x - 3, h - 17); g.lineTo(x - 3, h - 7); g.moveTo(x + 3, h - 17); g.lineTo(x + 3, h - 7); g.stroke(); }
  // 재생 위치
  if (TL.loaded === RG.f) { const p = player.currentTime; if (p >= RG.vs && p <= RG.ve) { g.fillStyle = "#d33"; g.fillRect(X(p) - 1, 0, 2, h); } }
}
// 파형 끌기: 손잡이 가까이면 그 끝을, 아니면 새로 고르기. 끌지 않고 누르면 그 자리로 재생 위치를 옮김
(() => {
  const c = $("#rgWave");
  const tOf = (ev) => { const r = c.getBoundingClientRect(); return RG.vs + Math.max(0, Math.min(1, (ev.clientX - r.left) / r.width)) * (RG.ve - RG.vs); };
  c.addEventListener("pointerdown", (ev) => {
    if (!RG.open) return;
    const r = c.getBoundingClientRect(), x = ev.clientX - r.left, X = (t) => ((t - RG.vs) / (RG.ve - RG.vs)) * r.width;
    const ds = Math.abs(x - X(RG.s)), de = Math.abs(x - X(RG.e));
    RG.drag = { kind: Math.min(ds, de) < 24 ? (ds <= de ? "s" : "e") : "new", t0: tOf(ev), x0: ev.clientX, moved: false };
    c.setPointerCapture(ev.pointerId);
  });
  c.addEventListener("pointermove", (ev) => {
    const d = RG.drag; if (!d) return;
    if (Math.abs(ev.clientX - d.x0) > 4) d.moved = true;
    if (!d.moved) return;
    const t = tOf(ev);
    if (d.kind === "s") RG.s = Math.min(t, RG.e - 0.2);
    else if (d.kind === "e") RG.e = Math.max(t, RG.s + 0.2);
    else { RG.s = Math.min(d.t0, t); RG.e = Math.max(d.t0, t); }
    RG.s = Math.round(RG.s * 10) / 10; RG.e = Math.round(RG.e * 10) / 10;
    rgRender();
  });
  c.addEventListener("pointerup", (ev) => {
    const d = RG.drag; RG.drag = null;
    if (!d) return;
    if (!d.moved) seekPlay(RG.f, tOf(ev), !player.paused);
    else if (RG.e - RG.s < 0.2) { RG.e = RG.s + 0.2; rgRender(); }
  });
})();
queueMicrotask(() => player.addEventListener("timeupdate", () => {
  if (!RG.open) return;
  rgDraw();
}));
document.addEventListener("keydown", (ev) => { if (ev.key === "Escape" && RG.open) closeRange(); });
$("#rgSheet").addEventListener("click", async (ev) => {
  if (ev.target === $("#rgSheet")) { closeRange(); return; } // 바깥(어두운 곳) 누르면 닫기
  const who = ev.target.closest("button[data-to]");
  if (who) { RG.target = who.dataset.to; rgRender(); return; }
  const pl = ev.target.closest("button[data-ps]");
  if (pl) { playRange(RG.f, +pl.dataset.ps, +pl.dataset.pe); return; }
  const b = ev.target.closest("button[data-rg]");
  if (!b) return;
  const a = b.dataset.rg, now = TL.loaded === RG.f ? player.currentTime : null, dur = fileDur(RG.f) || RG.ve;
  const set = (k, v) => { RG[k] = Math.round(Math.max(0, Math.min(dur, v)) * 10) / 10; if (RG.e - RG.s < 0.2) { if (k === "s") RG.s = RG.e - 0.2; else RG.e = RG.s + 0.2; } RG.vs = Math.min(RG.vs, RG.s); RG.ve = Math.max(RG.ve, RG.e); rgRender(); };
  if (a === "close") { closeRange(); return; }
  if (a === "s-") set("s", RG.s - 0.2); if (a === "s+") set("s", RG.s + 0.2);
  if (a === "e-") set("e", RG.e - 0.2); if (a === "e+") set("e", RG.e + 0.2);
  if (a === "snow" || a === "enow") { if (now == null) { toast("먼저 재생하다가 누르세요"); return; } set(a[0], now); }
  if (a === "play") playRange(RG.f, RG.s, RG.e);
  if (a === "playctx") playRange(RG.f, Math.max(0, RG.s - 2), RG.e + 2);
  if (a === "apply") {
    const known = await rgKnown();
    const res = relabelRange(REVIEW.diar, RG.f, RG.s, RG.e, RG.target, known);
    if (!res) { toast("이 구간에는 말소리 구간이 없습니다"); return; }
    pushUndo(REVIEW.diar);
    REVIEW.diar = res.diar;
    await S.put("chunks", REVIEW.id, res.diar);
    renderReview();
    const toName = res.to >= 0 ? rgNameOf(res.to) : "빼기";
    const sim = $("#rgFind").checked && res.to >= 0 && res.from >= 0 && res.from !== res.to ? similarRegions(res.diar, res.from, res.to) : [];
    if (!sim.length) { closeRange(); toast(`${fmt1(RG.s)}~${fmt1(RG.e)} → ${toName} (되돌리기 가능)${$("#rgFind").checked && res.to >= 0 ? " · 비슷한 곳은 없었습니다" : ""}`); return; }
    Object.assign(RG, { simTo: res.to, sim });
    $("#rgDone").textContent = `✓ ${fmt1(RG.s)}~${fmt1(RG.e)} → ${toName} (되돌리기 가능)`;
    $("#rgSimT").textContent = `${toName}와 닮은 곳 ${sim.length}곳 (${Math.round(sim.reduce((m, r) => m + r.e - r.s, 0))}초)`;
    $("#rgSimH").textContent = `${rgNameOf(res.from)}으로 묶였지만 방금 고른 목소리에 더 가까운 곳입니다. 들어 보고 맞는 것만 고르세요.`;
    $("#rgSimList").innerHTML = sim.map((r, k) => `<label class="sim"><input type="checkbox" data-k="${k}" ${r.sim >= 0.7 ? "checked" : ""}>
      <button type="button" class="play" data-ps="${r.s}" data-pe="${r.e}" title="듣기">▶</button>
      <span class="tt">${fmt1(r.s)}~${fmt1(r.e)} <small>(${(r.e - r.s).toFixed(1)}초)</small></span><span class="pc${r.sim < 0.7 ? " lo" : ""}">${Math.round(r.sim * 100)}%</span></label>`).join("");
    $("#rgEdit").classList.add("hidden"); $("#rgSim").classList.remove("hidden");
    $$("#rgSheet .flow span").forEach((x) => x.classList.toggle("on", x.dataset.st === "3"));
    rgSimCount();
    return;
  }
  if (a === "moveSim") {
    const pick = $$("#rgSimList input:checked").map((x) => RG.sim[+x.dataset.k]);
    if (!pick.length) { closeRange(); return; }
    const known = await rgKnown();
    pushUndo(REVIEW.diar);
    let d = REVIEW.diar;
    for (const r of pick) { const res = relabelRange(d, r.f, r.s, r.e, RG.simTo, known, { ref: false }); if (res) d = res.diar; }
    REVIEW.diar = d;
    await S.put("chunks", REVIEW.id, d);
    renderReview(); closeRange();
    toast(`${pick.length}곳을 ${rgNameOf(RG.simTo)}(으)로 옮겼습니다 (되돌리기 가능)`);
  }
});
function rgSimCount() { const n = $$("#rgSimList input:checked").length; const b = $("#rgSheet [data-rg='moveSim']"); b.textContent = n ? `고른 ${n}곳 옮기기` : "닫기"; }
$("#rgSimList").addEventListener("change", rgSimCount);
