// Diarized Transcription — 화면 (빌드 없음). 처리는 worker.js, 저장은 store.js.
import * as S from "./store.js";
import { parse as parseTranscript } from "./plaud.js";
import { decodeFile, wavHeader, embeddedTime } from "./audio.js";
import { encryptBackup, decryptBackup, isEncrypted, backupName, MIN_PW, PLAIN_FORMAT } from "./backup.js";
import { exportTxt, exportCsv, mergeBackup, mergedLines, speakerOf, hms as hmsLong, MODE_LABEL, SOURCE_LABEL, LANG_LABEL, sourceOf, isDiar } from "./export.js";
import { orderFiles, printsFromReview, recordedAt, titleFromFiles, splitCluster, relabelRange, similarRegions, mixSuspects } from "./diar.js";
import { isGeneric, knownPrints } from "./engine.js";
import { SCOPES, inScope, scopeCounts, isEdited, splitPart, mergeParts, partEnd, jobFlow, josa } from "./review.js";
import { describeDevice, LEVELS, levelLabel, lowerLevel } from "./devices.js";
import { applyLexicon, activeRules, diffPairs, harvest, dropJob, fromGlossary, toPairs, judge, conflicts, setVar, addManual, totals, whenOf, REC_MIN, PL_REC, mergeLex, stripJosa } from "./lexicon.js";
import { plaudAlign, plaudDiffers, plaudPairs, normText, PL_MIN } from "./compare.js";

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
const safeName = (s) => String(s || "녹음").replace(/[\\/:*?"<>|]+/g, "_").slice(0, 80);

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
      WSTATE.job = m.done || m.naming ? null : { id: m.id, pct: m.pct ?? (WSTATE.job ? WSTATE.job.pct : 0) }; renderSys();
      // 진행률만 바뀐 알림은 그 작업 카드의 진행 막대만 고친다(목록 전체를 다시 그리지 않음)
      const card = m.pct != null && !m.done && !m.naming ? document.querySelector(`.job[data-id="${CSS.escape(m.id)}"] .prog`) : null;
      if (card) { const i = card.querySelector(".pbar i"); if (i) { i.dataset.w = m.pct; applyGeom(card); } const t = card.querySelector("span:last-child"); if (t) t.textContent = `${m.pct}% · ${m.msg || ""}`; }
      else if ($("#tab-jobs").classList.contains("on")) loadJobs();
      if (m.done) toast("처리가 끝났습니다");
    }
    if (m.type === "idle") { WSTATE.busy = false; WSTATE.job = null; renderSys(); keepAwake("model", false); wakeLock(false); loadJobs(); } // 「처리 중」 상태는 일꾼이 쉬면 풀린다
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
    const ad = navigator.gpu && (await navigator.gpu.requestAdapter({ powerPreference: "high-performance" }));
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
/* 화면 꺼짐 방지: 이 페이지가 무언가 처리하는 동안(전사·화자 분리·모델 받기/열기·음원 준비·성능 시험) 화면을 켜 둔다.
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
  const th = (WSTATE.threads ? ` · 스레드 ${WSTATE.threads}` : "") + (WSTATE.device === "gpu" ? ` · 그래픽 칩 ${LEVELS.some((l) => l.v === WSTATE.gpuParts) ? levelLabel(WSTATE.gpuParts) : "사용"}` : "") + (lock ? ' · <span class="ok">화면 켜 둠</span>' : "");
  $("#sysline").innerHTML = `${eng}${th}` + (WSTATE.coi ? "" : ' · <span class="bad">스레드 꺼짐(느림)</span>') + (WSTATE.owner ? "" : ' · <span class="bad">다른 탭에서 처리 중</span>');
  // 위 바의 상태 칩: 할 말이 있을 때만 보인다(평소 준비됨이면 숨김). 누르면 그 일로 — 처리 중 → 그 녹음 카드, 모델 → 설정 엔진 칸, 경고 → 메뉴의 전체 상태
  let st = "ok", txt = "엔진 준비됨" + (WSTATE.device === "gpu" ? " · 그래픽 칩 " + (LEVELS.some((l) => l.v === WSTATE.gpuParts) ? levelLabel(WSTATE.gpuParts).replace("사용 - ", "") : "사용") : "");
  if (!WSTATE.owner) { st = "bad"; txt = "다른 탭"; }
  else if (WSTATE.fake) { st = "bad"; txt = "가짜 엔진"; }
  else if (WSTATE.dl && !WSTATE.dl.loading) { st = "busy"; txt = `${WSTATE.dl.net ? "⬇" : "↻"} ${Math.round((WSTATE.dl.got / Math.max(1, WSTATE.dl.total)) * 100)}%`; }
  else if (WSTATE.dl) { st = "busy"; txt = "모델 여는 중"; }
  else if (WSTATE.job) { st = "busy"; txt = `⏳ ${WSTATE.job.pct}%`; }
  else if (!m) { st = "busy"; txt = "확인 중"; }
  else if (!m.ready) { st = "warn"; txt = "모델 없음"; }
  else if (!WSTATE.coi) { st = "warn"; txt = "느림"; }
  const sb = $("#statBtn");
  sb.dataset.st = st; $("#statTxt").textContent = txt; sb.title = $("#sysline").textContent;
  sb.classList.toggle("hidden", st === "ok");
  sb.dataset.go = WSTATE.job && !WSTATE.dl && WSTATE.owner && !WSTATE.fake ? "job" : WSTATE.dl || (m && !m.ready && st === "warn") ? "settings" : WSTATE.job ? "job" : "menu";
  $("#engState").innerHTML = eng + (m && !m.ready && !WSTATE.fake ? "<br><small>모델을 미리 받아 두면 대기 중인 녹음을 바로 처리합니다. 녹음을 등록할 때도 자동으로 받습니다.</small>" : "");
  const pct = WSTATE.dl && WSTATE.dl.total ? (WSTATE.dl.got / WSTATE.dl.total) * 100 : m ? (m.cachedBytes / Math.max(1, m.totalBytes)) * 100 : 0;
  $("#dlBar").style.width = (WSTATE.fake ? 100 : pct) + "%";
  $("#btnModels").disabled = !!(m && m.ready) || !!WSTATE.dl || WSTATE.fake;
}

/* ================================================================== 탭 */
$$(".tabs button[data-tab]").forEach((b) => b.addEventListener("click", () => showTab(b.dataset.tab)));
// 로고 = 홈 단추: 누르는 순간 「HOME」으로 잠깐 바뀐다(누를 때 보이도록 pointerdown, 키보드는 click에서)
{
  const lg = $("#logoHome"); let lgT = 0;
  const flash = () => { lg.classList.add("home"); clearTimeout(lgT); lgT = setTimeout(() => lg.classList.remove("home"), 700); };
  lg.addEventListener("pointerdown", flash); lg.addEventListener("click", flash);
}
const SECONDARY = { new: "새 녹음", voices: "목소리 기준", glossary: "교정 사전", settings: "설정·백업" };
let TAB = "jobs";
/** 위 바의 지금 화면 이름(녹음 제목 | 새 녹음 | 메뉴 화면 이름). 홈(녹음 목록)에서는 비움 — 홈으로는 로고(#logoHome) */
function setCrumb() {
  const name = TAB === "review" ? (REVIEW.data && REVIEW.data.job.title) || "녹음" : SECONDARY[TAB] || "";
  $("#crumbName").classList.toggle("hidden", !name);
  $("#crumbName").textContent = name;
}
/* 휴대폰 「뒤로 가기」: 홈 밖 화면으로 갈 때 방문 기록을 한 칸 쌓아(홈 밖 화면끼리는 그 칸을 바꿔 씀) 뒤로 가기가
 * 사이트를 떠나지 않고 홈으로 오게 한다. 로고·단추로 홈에 올 때는 그 칸을 되돌려(history.back) 기록이 쌓이지 않게. */
const NAV = { skip: 0 };
const TABS = ["jobs", "new", "review", "voices", "glossary", "settings"];
function navRecord(name) {
  const url = location.pathname + location.search + "#" + name, st = history.state || {};
  if (name === "jobs") {
    if (st.sub) { NAV.skip++; history.back(); } // 쌓아 둔 칸을 걷어 낸다(그 popstate는 건너뜀)
    else history.replaceState({ home: 1 }, "", url);
  } else if (st.sub) history.replaceState({ sub: 1 }, "", url);
  else history.pushState({ sub: 1 }, "", url);
}
addEventListener("popstate", (e) => {
  if (NAV.skip) { NAV.skip--; return; }
  if (RG.open) closeRange(); // 구간 손보기 시트가 열려 있으면 닫고 화면을 옮긴다
  if (LX.open) closeLex();
  const st = e.state || {}, h = location.hash.slice(1);
  showTab(st.sub && TABS.includes(h) && h !== "jobs" ? h : "jobs", true);
});
function showTab(name, fromPop = false) {
  // 녹음 목록이 중심: 카드의 「지금 할 일」 → 작업 화면(review), 위 바 ＋ → 새 녹음(new), ☰ → 목소리·사전·설정
  closeMenu();
  const was = TAB; TAB = name;
  setCrumb();
  $("#btnNew").classList.toggle("hidden", name === "new");
  $$("#menuPanel button[data-tab]").forEach((x) => x.classList.toggle("on", x.dataset.tab === name));
  if (name === "new" && was !== "new") enterNew();
  // 검수를 떠나면 재생을 멈춘다(재생 막대는 검수 화면에만 있어 다른 화면에서는 멈출 방법이 없음)
  if (name !== "review" && !player.paused) player.pause();
  $$(".tab").forEach((x) => x.classList.toggle("on", x.id === "tab-" + name));
  if (!fromPop) navRecord(name);
  syncSticky();
  if (name === "jobs") return loadJobs();
  if (name === "review") loadReviewJobs();
  if (name === "voices") loadVoices();
  if (name === "glossary") loadGlossary();
  if (name === "settings") loadSettings();
}

/* ☰ 메뉴: 목소리 기준 · 교정 사전 · 설정·백업 + 엔진 상태 전체 */
const menuBtn = $("#menuBtn"), menuPanel = $("#menuPanel");
function openMenu() {
  menuPanel.classList.remove("hidden"); menuBtn.setAttribute("aria-expanded", "true"); menuBtn.textContent = "✕";
  menuCounts();
}
function closeMenu() {
  if (menuPanel.classList.contains("hidden")) return;
  menuPanel.classList.add("hidden"); menuBtn.setAttribute("aria-expanded", "false"); menuBtn.textContent = "☰";
}
async function menuCounts() {
  try {
    const vp = (await S.keys("voiceprints")).length, lex = await getLex(), conf = conflicts(lex);
    let on = 0, rec = 0;
    for (const t of lex.terms) for (const v of t.vars) { if (v.st === "on") on++; else if (judge(lex, t, v, conf).rec) rec++; }
    $("#mnVp").textContent = vp ? `저장 ${vp}명` : ""; $("#mnGl").textContent = [on ? `확정 ${on}` : "", rec ? `추천 ${rec}` : ""].filter(Boolean).join(" · ");
  } catch { /* 표시만 */ }
}
menuBtn.addEventListener("click", () => (menuPanel.classList.contains("hidden") ? openMenu() : closeMenu()));
$("#statBtn").addEventListener("click", () => {
  const go = $("#statBtn").dataset.go;
  if (go === "settings") { showTab("settings"); return; }
  if (go === "job" && WSTATE.job) { const id = WSTATE.job.id; showTab("jobs").then(() => flashJob(id)).catch(() => {}); return; }
  openMenu();
});
/** 녹음 목록에서 그 카드로 스크롤해 잠깐 강조 */
function flashJob(id) {
  setTimeout(() => {
    const c = id && document.querySelector(`.job[data-id="${CSS.escape(id)}"]`);
    if (!c) return;
    c.scrollIntoView({ block: "center", behavior: REDUCE_MOTION ? "auto" : "smooth" });
    c.classList.add("flash"); setTimeout(() => c.classList.remove("flash"), 1600);
  }, 120);
}
document.addEventListener("click", (ev) => { if (!ev.target.closest(".bar")) closeMenu(); });
document.addEventListener("keydown", (ev) => { if (ev.key === "Escape" && !menuPanel.classList.contains("hidden")) { closeMenu(); menuBtn.focus(); } });

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
let PREP = false; // 등록한 음원을 16kHz로 바꿔 저장하는 중 — 그동안 양식·파일 고르기·등록을 막는다
const source = () => ($('input[name="source"]:checked') || {}).value || "";
const mode = () => ($('input[name="mode"]:checked') || {}).value || "";
const DEFAULT_TASK = { plaud: "gap", sony: "diar", phone: "diar" };

// 새 녹음은 전용 화면(위 바 ＋). 들어올 때마다 양식을 비운다 — 파일부터 고르면 작업 이름·녹음 시각이 채워진다
async function enterNew() {
  if (PREP) { toast("음원을 준비하는 중입니다 — 끝나면 홈으로 넘어갑니다"); return; } // 준비 중인 양식을 비우지 않는다
  resetForm();
  window.scrollTo(0, 0);
  F.voices = (await S.all("voiceprints")).map(([name]) => name);
  renderChips();
}
$("#btnCancel").addEventListener("click", () => showTab("jobs"));
function resetForm() {
  if (PREP) return;
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
// Plaud 출처 화자 분리는 Plaud 전사를 붙일 수 있다(선택 — 검수에서 발언마다 Plaud 글과 견줌, 2026-10-12)
const TR_OPT = (src, m) => src === "plaud" && isDiar(m);
function applyMode() {
  const src = source(), m = mode(), dev = src && !NEEDS_TR(m) && !TR_OPT(src, m);
  $("#fsTask").classList.toggle("hidden", !src);
  $$("#fsTask .mode").forEach((l) => l.classList.toggle("hidden", !src || !srcOk(l, src)));
  $$("#newJob .after-src").forEach((f) => f.classList.toggle("hidden", !src));
  $("#audioFiles").multiple = !src || MULTI(m); // 출처를 고르기 전에는 여러 개 허용(파일부터 고를 수 있게)
  if (src && !MULTI(m) && F.audio.length > 1) setMsg("이 할 일은 음원 1개만 받습니다 — 파일을 다시 골라 주세요.", true);
  else if ($("#formMsg").classList.contains("err") && /음원 1개/.test($("#formMsg").textContent)) setMsg("");
  $("#callWrap").classList.toggle("hidden", !(src === "phone" && isDiar(m)));
  $("#srcTip").classList.toggle("hidden", !src);
  if (src) $("#srcTip").innerHTML = `<summary>녹음 요령 — ${SOURCE_LABEL[src]}(전사·화자 구분을 더 정확하게)</summary><ul class="tips">${SRC_TIPS[src].map((t) => `<li>${t}</li>`).join("")}</ul>`;
  if (!src) { $("#audioHint").textContent = "m4a·mp3·wav 등 — 여러 개면 녹음 시각 순으로 자동 정렬"; return; }
  $("#audioHint").textContent = src === "sony" ? "MP3·WAV 여러 개 가능 — 파일 이름의 녹음 시각 순으로 자동 정렬"
    : src === "phone" ? "m4a·mp3·wav 등 여러 개 가능 — 녹음 시각(파일 이름 → 파일 정보 → 저장 시각) 순으로 자동 정렬"
      : MULTI(m) ? "Plaud에서 내려받은 음원(MP3·WAV) — 여러 개 가능, 녹음 시각 순으로 자동 정렬" : "Plaud에서 내려받은 음원(MP3) 1개";
  $("#fsRange").classList.toggle("hidden", m !== "range");
  $("#fsSpeakers").classList.toggle("hidden", m === "enroll");
  $("#fsTranscript").classList.toggle("hidden", dev);
  $("#spkLegend").textContent = isDiar(m) ? "참석자(선택)" : "화자 후보";
  $("#spkHint").textContent = isDiar(m) ? "고르면 그 사람들의 목소리 기준으로만 이름을 추천합니다. 인원 수는 묶음이 지나치게 많아지지 않게 하는 데만 씁니다."
    : m === "fragment" ? "고르지 않으면 저장된 사람 전원 중에서 맞힙니다" : "고르지 않으면 저장된 사람 전원과 이 회의 전사에 나온 사람 중에서 맞힙니다";
  $("#attWrap").classList.toggle("hidden", !isDiar(m));
  $("#useVpWrap").classList.toggle("hidden", isDiar(m));
  // 단계 번호: Plaud 전사를 쓰는 할 일은 4번이 전사 파일, 그 밖에는 전사 파일 단계가 없다
  const nums = $$("#newJob legend .num");
  nums.forEach((n, i) => { n.textContent = (i < 3 ? i + 1 : dev && i >= 4 ? i : i + 1) + "."; });
  if (MULTI(m) && F.audio.length > 1) { F.audio = orderFiles(F.audio); renderAudioList(); }
  $("#trHint").textContent = m === "gap" || m === "enroll" ? "필수 — Plaud에서 TXT·SRT·DOCX로 내보낸 파일(시간·화자를 켜고 내보내기)"
    : TR_OPT(src, m) ? "선택 — 같은 녹음의 Plaud 전사가 있으면 검수에서 발언마다 Plaud 글을 함께 보고, 많이 다른 발언을 먼저 확인합니다(나중에 검수 화면에서 붙여도 됨)"
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
  if (PREP) { toast("음원을 준비하는 중에는 파일을 바꿀 수 없습니다"); return; }
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
  // 칩은 단추로(자판·화면 읽기 프로그램으로도 고르고 풀 수 있게)
  $("#spkChips").innerHTML = all.length ? all.map((n) => `<button type="button" class="chip ${F.picked.has(n) ? "on" : ""}" data-n="${esc(n)}" aria-pressed="${F.picked.has(n)}">${esc(n)}</button>`).join("")
    : '<span class="msg">저장된 목소리 기준이 없습니다.</span>';
  $$("#spkChips .chip").forEach((c) => c.addEventListener("click", () => {
    const n = c.dataset.n; F.picked.has(n) ? F.picked.delete(n) : F.picked.add(n);
    c.classList.toggle("on", F.picked.has(n)); c.setAttribute("aria-pressed", String(F.picked.has(n)));
  }));
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
  if (PREP) { toast("음원을 준비하는 중입니다"); return; }
  // 고른 파일·전사는 지금 것을 붙잡아 둔다(준비하는 동안 양식이 바뀌어도 이 등록에는 영향 없게)
  const m = mode(), src = source(), files = F.audio.slice(), trIn = F.tr;
  if (!src) return setMsg("녹음 출처를 골라 주세요.", true);
  if (!m) return setMsg("할 일을 골라 주세요.", true);
  if (!files.length) return setMsg("음원을 골라 주세요.", true);
  if (!MULTI(m) && files.length !== 1) return setMsg("이 할 일은 음원 1개만 받습니다.", true);
  if ((m === "gap" || m === "enroll") && !trIn) return setMsg("Plaud 전사 파일이 필요합니다.", true);
  let range = null;
  if (m === "range") {
    const a = parseHms($("#rFrom").value), b = parseHms($("#rTo").value);
    if (!(b > a)) return setMsg("구간을 「1:04:00」처럼 넣어 주세요(끝이 시작보다 뒤).", true);
    range = { from: a, to: b };
  }
  const id = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14) + "-" + Math.random().toString(36).slice(2, 6);
  // Plaud 전사는 음원 1개와 짝 — 화자 분리는 여러 파일을 받으므로 1개일 때만 붙인다
  if (trIn && TR_OPT(src, m) && files.length !== 1) return setMsg("Plaud 전사는 음원 1개일 때만 붙일 수 있습니다 — 전사 파일을 빼거나 음원을 1개만 고르세요.", true);
  const tr = !MULTI(m) || TR_OPT(src, m) ? trIn : null;
  const att = Math.max(0, Math.min(30, Math.round(+$("#attendees").value || 0)));
  const job = {
    title: $("#jobTitle").value.trim() || files[0].file.name.replace(/\.[^.]+$/, ""),
    source: src, mode: m, status: "준비", notice: $("#notice").checked, createdAt: S.now(), audioFiles: [],
    ...($("#jobLang").value !== "ko" ? { lang: $("#jobLang").value } : {}), // 말하는 언어(없으면 한국어)
    transcript: tr ? { name: tr.name, count: tr.segs.length, endSec: tr.endSec } : null,
    transcriptEndSec: tr ? tr.endSec : 0, range, speakerMap: speakerMap(), speakers: [...F.picked],
    useVoiceprints: $("#useVp").checked, note: $("#jobNote").value.trim(), progress: { pct: 0, msg: "음원 준비 중" },
    ...(isDiar(m) ? { attendees: ($("#isCall").checked && src === "phone" ? 2 : att) || null, call: $("#isCall").checked && src === "phone", stage: "diar", skip: [] } : {}),
  };
  PREP = true; $("#btnSubmit").disabled = true; $("#audioFiles").disabled = true;
  keepAwake("prep", true); // 긴 음원을 16kHz로 바꿔 저장하는 동안에도 화면을 켜 둔다
  try {
    await S.put("jobs", id, { ...job, updatedAt: S.now() });
    if (tr) await S.put("plaud", id, tr.segs);
    for (let i = 0; i < files.length; i++) {
      const a = files[i];
      setMsg(`음원 준비 중 ${i + 1}/${files.length}: ${a.file.name}`);
      const w = await S.audioWriter(id, i);
      try {
        const dur = await decodeFile(a.file, (pcm) => w.write(pcm), (p) => { a.prog = p; renderAudioList(); });
        await w.close();
        job.audioFiles.push({ name: a.file.name, dur, ...(a.recordedAt ? { recordedAt: a.recordedAt, timeSrc: a.timeSrc } : {}) });
      } catch (e) { await w.abort(); throw new Error(`${a.file.name}: 음원을 열지 못했습니다 (${e.message})`); }
    }
    if (!(await S.saveJob(id, { audioFiles: job.audioFiles, status: "대기", progress: { pct: 0, msg: "대기" } }))) throw new Error("음원을 준비하는 동안 녹음이 지워졌습니다");
    PREP = false;
    toast("녹음을 등록했습니다");
    kick(); await showTab("jobs"); flashJob(id);
  } catch (e) {
    setMsg(e.message, true);
    await S.deleteJob(id).catch(() => {});
  } finally { PREP = false; $("#btnSubmit").disabled = false; $("#audioFiles").disabled = false; keepAwake("prep", false); }
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
      BATT.warn = b.charging ? "" : `충전기가 연결되어 있지 않습니다(배터리 ${pct}%). 긴 녹음은 충전하면서 처리해야 느려지거나 멈추지 않습니다.`;
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
/** 진행 단계 표시(녹음 카드·작업 화면 머리 공용) — 끝난 단계 ✓, 지금 단계 강조, 앱이 하는 단계는 점선 */
function trackHtml(f) {
  const ico = (x) => (x.state === "done" ? "✓" : x.state === "proc" ? "⏳" : x.state === "stop" ? "!" : "");
  return `<ol class="trk" aria-label="진행 단계">${f.steps.map((x) => `<li class="${x.state}${x.auto ? " auto" : ""}"${x.state === "cur" || x.state === "proc" ? ' aria-current="step"' : ""}><i>${ico(x)}</i><span>${esc(x.label)}</span></li>`).join("")}</ol>`;
}
async function rvMap() { // 검수 진행(kv 「rv:작업id」) — 카드의 「남음 n」·내보내기 끝 표시용
  const m = {};
  try { for (const [k, v] of await S.all("kv")) if (String(k).startsWith("rv:")) m[k.slice(3)] = v; } catch { /* 없음 */ }
  return m;
}
// 목록 그리기는 늦게 시작한 것이 이긴다(먼저 부른 느린 읽기가 나중에 끝나 옛 목록을 덮지 않게).
// 부른 쪽이 기다리면 가장 나중 그리기까지 끝난 뒤에 풀린다(그 뒤 카드 강조 등).
let JOBS_GEN = 0, JOBS_P = null;
function loadJobs() {
  const gen = ++JOBS_GEN, p = renderJobs(gen);
  JOBS_P = p;
  return p.then(() => (gen === JOBS_GEN ? undefined : JOBS_P));
}
async function renderJobs(gen) {
  const list = await jobsList();
  if (gen !== JOBS_GEN) return;
  JOBS = list;
  const el = $("#jobList");
  if (!JOBS.length) {
    el.dataset.last = "";
    el.innerHTML = '<div class="empty"><p>아직 녹음이 없습니다.<br>오른쪽 위 「＋」를 눌러 새 녹음을 등록하세요.</p><button type="button" class="primary" data-a="new">＋ 새 녹음 등록</button></div>';
    return;
  }
  const RV = await rvMap();
  if (gen !== JOBS_GEN) return;
  const card = (j) => {
    const p = j.progress || {}, s = j.stats || {}, f = jobFlow(j, RV[j.id]);
    const dur = (j.audioFiles || []).reduce((m, x) => m + (x.dur || 0), 0);
    const result = isDiar(j.mode) ? (s.segments != null ? `발언 ${s.segments}` : s.clusters ? `화자 묶음 ${s.clusters}개` : "")
      : j.hasResult && j.mode !== "enroll" ? `발언 ${s.segments ?? "-"}` : "";
    const meta = [jobKind(j), dur ? hms(dur, false) : "", result, j.audioDeleted ? "음원 지움" : ""].filter(Boolean).join(" · ");
    const enrolled = !!(s.enrolled && Object.keys(s.enrolled).length);
    const files = (j.audioFiles || []).map((x) => x.name + (x.dur ? ` (${hms(x.dur)})` : "")).join(", ");
    const info = [
      ["음원", esc(files || "-") + (j.range ? ` · 구간 ${hms(j.range.from)}~${hms(j.range.to)}` : "")],
      ["등록", esc((j.createdAt || "").replace("T", " ").slice(0, 16))],
      ...(isDiar(j.mode) && s.clusters ? [["결과", `화자 묶음 ${s.clusters}개` + (s.segments != null ? ` · 발언 ${s.segments} · 불확실 ${s.lowConf ?? 0} · 환각 제거 ${s.droppedHallucination ?? 0}` : ` · 전사할 발언 ${s.units ?? "-"}`)]] : []),
      ...(!isDiar(j.mode) && j.hasResult && j.mode !== "enroll" ? [["결과", `발언 ${s.segments ?? "-"} · 혼재 ${s.mixed ?? 0} · 미상 ${s.unknown ?? 0} · 저신뢰 ${s.lowConf ?? 0} · 환각 제거 ${s.droppedHallucination ?? 0}`]] : []),
      ...(enrolled ? [["목소리 기준", esc(Object.keys(s.enrolled).join(", ")) + " 등록"]] : []),
    ];
    const prep = j.status === "준비";
    // 덜 쓰는 일은 ⋯ 안에: 녹음 정보 · 처음부터 다시 · 음원만 지우기 · 작업 삭제
    const more = `<details class="kebab"><summary aria-label="더 보기 — 녹음 정보·처음부터 다시·음원만 지우기·삭제">⋯</summary><div class="kmenu">
        <dl class="info">${info.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join("")}</dl>
        ${!f.busy && !j.audioDeleted ? '<button type="button" data-a="fresh">↺ 처음부터 다시</button>' : ""}
        ${!f.busy && !j.audioDeleted ? '<button type="button" data-a="delaudio">🗑 음원만 지우기</button>' : ""}
        ${!f.busy || prep ? '<button type="button" data-a="del" class="danger">✕ 녹음 삭제</button>' : ""}
      </div></details>`;
    const act = f.busy
      ? `<div class="prog"><span class="pbar"><i data-w="${p.pct || 0}"></i></span><span>${p.pct || 0}% · ${esc(p.msg || "")}</span></div>
         ${prep ? "" : '<div class="row end"><button type="button" data-a="stop">중지</button></div>'}`
      : f.action ? `<button type="button" class="go${f.action.primary ? " primary" : ""}" data-a="${f.action.a}">${esc(f.action.label)}</button>` : "";
    return `<div class="job" data-id="${esc(j.id)}" data-stage="${f.stage}">
      <div class="hd"><span class="t">${esc(j.title)}</span><span class="badge stg st-${esc(String(j.status).replace(/\s/g, ""))}">${esc(f.badge)}</span>${more}</div>
      <div class="meta">${esc(meta)}</div>
      ${trackHtml(f)}
      ${j.error ? `<p class="msg err">${esc(j.error)}</p>` : ""}
      ${f.busy && j.status === "처리중" && BATT.warn ? `<p class="note batt">${BATT.warn}</p>` : ""}
      ${act}
    </div>`;
  };
  // 묶음: 지금 할 일(사람 차례) → 처리 중(앱 차례) → 끝난 녹음 — 각 묶음 안은 최근 등록 순
  const groups = { todo: [], run: [], done: [] };
  for (const j of JOBS) groups[jobFlow(j, RV[j.id]).group].push(j);
  const GN = { todo: "지금 할 일", run: "처리 중", done: "끝난 녹음" };
  const html = Object.keys(GN).filter((g) => groups[g].length)
    .map((g) => `<section class="jgroup ${g}"><h3>${GN[g]} <b>${groups[g].length}</b></h3>${groups[g].map(card).join("")}</section>`).join("");
  if (html === el.dataset.last) return; // 바뀐 게 없으면 다시 그리지 않는다
  el.dataset.last = html.length > 200000 ? "" : html;
  // 열려 있던 ⋯는 다시 그린 뒤에도 열어 둔다
  const open = new Set($$("#jobList details.kebab[open]").map((d) => d.closest(".job").dataset.id));
  el.innerHTML = html;
  for (const id of open) { const d = el.querySelector(`.job[data-id="${CSS.escape(id)}"] details.kebab`); if (d) d.open = true; }
  applyGeom(el);
}
$("#jobList").addEventListener("click", async (ev) => {
  const b = ev.target.closest("button[data-a]");
  if (!b) return;
  if (b.dataset.a === "new") { showTab("new"); return; }
  const id = b.closest(".job").dataset.id, a = b.dataset.a;
  try {
    if (a === "review") { REVIEW.want = id; showTab("review"); return; }
    if (a === "voices") { showTab("voices"); return; }
    if (a === "stop") {
      const j = await S.get("jobs", id);
      if (j && j.status === "대기") await S.saveJob(id, { status: "중지" });
      worker && worker.postMessage({ type: "stop", id });
    }
    if (a === "resume") { await S.saveJob(id, { status: "대기", error: null }); await clearRv(id); kick(); }
    if (a === "fresh" || a === "del") { // 카드가 오래돼 지금 상태와 다를 수 있으니 다시 읽는다
      const j = await S.get("jobs", id);
      if (!j) { loadJobs(); return; }
      if (a === "fresh" && j.status === "처리중") { toast("처리 중입니다 — 먼저 「중지」한 뒤 다시 누르세요"); loadJobs(); return; }
    }
    if (a === "fresh") {
      const j = await S.get("jobs", id);
      if (isDiar(j.mode)) {
        if (!confirm("화자 분리부터 다시 할까요? 지정한 화자 이름과 검수 수정이 모두 지워집니다.")) return;
        await S.del("edits", id);
        lexUpdate((l) => dropJob(l, id)).catch(() => {});
      } else if (!confirm("결과를 지우고 처음부터 다시 처리할까요? 검수 수정 내용은 남지만 발언 번호가 바뀔 수 있습니다.")) return;
      await S.resetJob(id);
      await S.saveJob(id, { status: "대기", error: null, stats: null, progress: { pct: 0, msg: "대기" }, ...(isDiar(j.mode) ? { stage: "diar", skip: [] } : {}) });
      await clearRv(id); kick();
    }
    if (a === "delaudio") { if (!confirm("이 녹음의 음원만 지울까요? 결과는 남지만 검수 화면에서 더는 들을 수 없습니다.")) return; await S.deleteAudio(id); await S.saveJob(id, { audioDeleted: true }); }
    if (a === "del") { if (!confirm("이 녹음과 결과를 모두 지울까요? 목소리 기준은 남습니다.")) return; worker && worker.postMessage({ type: "stop", id }); await S.deleteJob(id); lexUpdate((l) => dropJob(l, id)).catch(() => {}); }
    loadJobs();
  } catch (e) { toast(e.message); }
});

/* ================================================================== 검수 */
// 할 일 순서대로 세 단계: ① 화자 이름 지정(화자 분리 작업만) → ② 발언 검수 → ③ 내보내기.
// 보기 범위는 포함 관계(전체 ⊃ 확인함·미검수, 미검수 ⊃ 확인 필요·판정 확실) — 규칙은 review.js.
const REVIEW = { id: null, want: null, data: null, edits: {}, names: {}, filter: "need", editedOnly: false, saveT: null, gl: [], split: null, visible: [], fold: {}, undo: [], only: null, tok: 0,
  lex: { terms: [] }, rules: [], hint: null, hintNo: new Set(), focusI: null, pl: new Map() };
/* ---- 교정 사전(배우는 사전, lexicon.js — 2026-10-12 사용자 승인으로 kv「lexicon」 추가)
 * 처음 열 때 예전 kv「glossary」 쌍 목록을 확정 항목으로 옮긴다. 예전 키에는 늘 확정 꼴을 펼친 목록을 같이 쓴다(예전 판·백업 호환).
 * 고치기는 LEXQ로 한 줄로 세워, 앞 쓰기가 끝난 뒤 다음이 읽는다(검수 근거 집계와 사전 화면 수정이 겹쳐도 한쪽이 사라지지 않게). */
let LEXQ = Promise.resolve();
async function getLex() {
  const l = await S.get("kv", "lexicon");
  if (l && l.terms) return l;
  const g = await S.get("kv", "glossary");
  const m = fromGlossary((g && g.pairs) || []);
  if (m.terms.length) await S.put("kv", "lexicon", { ...m, updatedAt: S.now() });
  return m;
}
function lexUpdate(fn) {
  const run = LEXQ.then(async () => {
    const l = await getLex();
    const r = fn(l) || l;
    r.updatedAt = S.now();
    await S.put("kv", "lexicon", r);
    await S.put("kv", "glossary", { pairs: toPairs(r), updatedAt: S.now() });
    return r;
  });
  LEXQ = run.catch(() => {});
  return run;
}
function setLex(l) { REVIEW.lex = l || { terms: [] }; REVIEW.rules = activeRules(REVIEW.lex); REVIEW.gl = toPairs(REVIEW.lex); }
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
  for (const q of ["#rvHead", "#stNames", "#rvMain", "#stExport"]) $(q).classList.toggle("hidden", none);
  if (id) { sel.value = id; await openReview(id); }
  else {
    REVIEW.id = null; REVIEW.data = null; setCrumb();
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
  const [job, result, edits, plaud, lex] = await Promise.all([S.get("jobs", id), S.get("results", id), S.get("edits", id), S.get("plaud", id), getLex()]);
  return { job: { ...job, id }, result, edits: { e: {}, ...(edits || {}) }, plaud: plaud || [], glossary: toPairs(lex), lexicon: lex };
}
/* ---- Plaud 대조(compare.js, 2026-10-12): Plaud 출처 화자 분리 녹음에 같은 녹음의 Plaud 전사가 있으면 발언마다 견준다.
 * 누락 보충·구간 다시 전사는 Plaud 글이 없는 곳을 전사한 것이라 견주지 않는다. Plaud 화자 이름은 등록 때 바꾼 이름(speakerMap)으로. */
const plaudCmp = (d) => !!(d && d.result && isDiar(d.job.mode) && d.plaud && d.plaud.length);
function plaudOf(d) {
  if (!plaudCmp(d)) return new Map();
  const smap = d.job.speakerMap || {};
  return plaudAlign(d.result.segs, d.plaud.map((p) => ({ ...p, speaker: smap[p.speaker] || p.speaker })));
}
async function openReview(id) {
  await flushEdits(); // 앞 작업에 쓰지 못한 수정부터
  const tok = (REVIEW.tok = (REVIEW.tok || 0) + 1); // 작업을 빨리 바꿔 늦게 끝난 앞 읽기가 뒤 작업을 덮지 않게
  const data = await reviewData(id);
  const diar = isDiar(data.job.mode) ? await S.get("chunks", id) : null;
  const vpNames = (await S.all("voiceprints")).map(([n]) => n);
  const rv = (await S.get("kv", "rv:" + id)) || null;
  if (tok !== REVIEW.tok) return;
  // 다 읽은 뒤 한꺼번에 바꾼다(사이에 기다림이 없어야 앞 작업 이름에 뒤 작업 내용이 섞이지 않음)
  REVIEW.id = id;
  REVIEW.data = data;
  REVIEW.only = null;
  REVIEW.rv = { id, v: rv };
  REVIEW.diar = diar;
  REVIEW.vpNames = vpNames;
  REVIEW.edits = REVIEW.data.edits.e || {};
  REVIEW.names = REVIEW.data.edits.names || {};
  setLex(REVIEW.data.lexicon);
  REVIEW.hint = null; REVIEW.hintNo = new Set();
  REVIEW.undo = [];
  REVIEW.split = null;
  REVIEW.pl = plaudOf(REVIEW.data);
  const plaudish = REVIEW.data.job.mode === "gap" || REVIEW.data.job.mode === "range";
  $("#rvPlaudWrap").classList.toggle("hidden", !plaudish);
  $("#exPlaudWrap").classList.toggle("hidden", !plaudish);
  REVIEW.page = {};
  $("#rvSave").textContent = "";
  // ① 이름을 다 붙였고 전사가 끝났으면 처음부터 접어 둔다(이름 대기 중이면 펼침)
  if (!REVIEW.fold[id]) REVIEW.fold[id] = { stNames: !!(REVIEW.data.result && namesDone().done) };
  applyStepFold();
  updUndo();
  renderReview();
  setCrumb();
  if (data.result) scheduleHarvest(id, REVIEW.edits, REVIEW.names, 300); // 예전 검수 수정도 사전 근거로(열 때 한 번 다시 셈)
}
/** 작업 화면 머리: 녹음 제목 · 정보 · 진행 단계(녹음 목록 카드와 같은 모양) */
function renderHead() {
  const d = REVIEW.data, el = $("#rvHead");
  if (!d) { el.innerHTML = ""; return; }
  const j = { ...d.job, id: REVIEW.id }, s = (d.result && d.result.stats) || j.stats || {};
  const dur = (j.audioFiles || []).reduce((m, x) => m + (x.dur || 0), 0);
  const meta = [jobKind(j), dur ? hms(dur) : "", d.result ? `발언 ${d.result.segs.length}` : s.clusters ? `화자 묶음 ${s.clusters}개` : ""].filter(Boolean).join(" · ");
  const f = jobFlow(j, REVIEW.rv && REVIEW.rv.v);
  el.dataset.stage = f.stage;
  el.innerHTML = `<div class="t">${esc(j.title)}</div><div class="meta">${esc(meta)}</div>${trackHtml(f)}`;
}
const gloss = (t) => applyLexicon(t, REVIEW.rules || []).text; // 교정 사전 확정 꼴(어절 경계 안에서만, 한 번에)
const isNeed = (g) => {
  if (g.cluster) { // 소니 녹음: 이름 없는 묶음 · 묶음과 덜 닮음 · 다른 묶음과 차이 작음 · 2초 미만
    const e = REVIEW.edits[g.i];
    const named = (e && (e.speaker || (e.parts && e.parts.every((p) => p.speaker)))) || (REVIEW.names[g.cluster] && !isGeneric(REVIEW.names[g.cluster]));
    return !named || g.conf < 0.5 || g.margin < 0.1 || g.end - g.start < 2 || plaudDiffers(REVIEW.pl.get(g.i));
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
  $("#stNamesProg").textContent = done ? `묶음 ${total}개 모두 이름 지정` : `묶음 ${total}개 중 ${named}개 이름 지정`;
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
  // 0건인 보기 칸은 누를 수 없고, 보고 있던 칸이 0건이 되면(남음을 다 확인 등) 「전체」로 넘어간다
  if (REVIEW.filter !== "all" && !c[REVIEW.filter] && c.all) { REVIEW.filter = "all"; REVIEW.split = null; renderReview(); return; }
  for (const f of SCOPES) $(`.scope b[data-n='${f}']`).textContent = c[f];
  $$(".scope button[data-f]").forEach((b) => { b.classList.toggle("on", !REVIEW.only && b.dataset.f === REVIEW.filter); b.disabled = !c[b.dataset.f]; });
  saveRv({ ok: c.ok, all: c.all });
  renderHead();
  $("#rvProg").textContent = `${c.ok} / ${c.all} 확인`;
  $("#rvPbar").dataset.w = c.all ? (100 * c.ok) / c.all : 0;
  $("#rvEditedN").textContent = `(${c.edited})`;
  const left = REVIEW.visible.filter((i) => !(REVIEW.edits[i] && REVIEW.edits[i].ok)).length;
  $("#rvAllOk").textContent = `✓ 모두 확인 ${left}`;
  $("#rvAllOk").disabled = !left;
  $("#exWarn").textContent = `아직 확인하지 않은 발언이 ${c.todo}개 있습니다. 그대로 내보내도 됩니다.`;
  $("#exWarn").classList.toggle("hidden", !c.todo);
  $("#exGlN").textContent = REVIEW.gl.length ? `(확정 ${REVIEW.gl.length}개)` : "";
  renderNamesStep();
  applyGeom($("#rvMain"));
}
/** 발언 아래 Plaud 줄: 같은 자리 Plaud 글(다를 때만)·「Plaud 글로」, Plaud에서 화자가 바뀌면 「✂ 여기서 나누기」 */
const knownName = (n) => Object.values(REVIEW.names).includes(n) || (REVIEW.vpNames || []).includes(n);
function plLine(g, shown) {
  const r = REVIEW.pl.get(g.i);
  if (!r || !$("#rvPlCmp").checked) return "";
  const out = [];
  const pt = r.text ? gloss(r.text) : ""; // Plaud 글에도 교정 사전 확정 꼴을 적용해 보인다(통합본과 같게)
  if (pt && normText(pt) !== normText(shown)) {
    out.push(`<div class="pltx"><span class="plb">Plaud</span><span class="grow">${esc(pt)}</span><button type="button" class="act" data-a="usePlaud" title="이 발언 글을 Plaud 글로 바꿉니다(↶로 되돌림)">Plaud 글로</button></div>`);
  } else if (!r.text && plaudDiffers(r)) out.push('<div class="pltx"><span class="plb">Plaud</span><span class="grow msg">이 자리에 Plaud 글이 없습니다 — 헛말인지 들어 보세요</span></div>');
  if (r.change) out.push(`<div class="pltx plchg"><span class="plb">Plaud</span><span class="grow">${hms(r.change.t)}부터 ${esc(r.change.to)}의 말로 적혀 있습니다</span><button type="button" class="act" data-a="plSplit" title="Plaud 화자가 바뀌는 자리를 나눌 곳으로 잡습니다">✂ 여기서 나누기</button></div>`);
  return out.join("");
}
/** 검수 위 Plaud 줄: 붙이기(없을 때) · 견준 결과(있을 때) */
function renderPlBar() {
  const d = REVIEW.data, bar = $("#rvPlBar");
  const can = d && d.result && isDiar(d.job.mode) && sourceOf(d.job) === "plaud";
  bar.classList.toggle("hidden", !can);
  $("#rvPlCmpWrap").classList.toggle("hidden", !plaudCmp(d));
  if (!can) { bar.innerHTML = ""; return; }
  if (!plaudCmp(d)) {
    bar.innerHTML = `<span class="grow">같은 녹음의 Plaud 전사(TXT·SRT·DOCX)를 붙이면 발언마다 Plaud 글과 견주고, 많이 다른 발언을 「불확실」에 넣습니다.</span>
      <label class="button">Plaud 전사 붙이기<input type="file" id="plFile" accept=".txt,.srt,.docx,.json" class="hidden"></label>`;
    return;
  }
  let diff = 0, chg = 0;
  for (const r of REVIEW.pl.values()) { if (plaudDiffers(r)) diff++; if (r.change) chg++; }
  bar.innerHTML = `<span class="grow"><b>Plaud 대조</b> · ${REVIEW.pl.size}개 발언 견줌 · 많이 다름(겹침 ${Math.round(PL_MIN * 100)}% 미만) ${diff}개 — 「불확실」에 넣음${chg ? ` · 화자 바뀜 ${chg}곳` : ""}</span>
    <button type="button" class="link" id="plDrop" title="붙인 Plaud 전사를 뗍니다(검수 수정은 그대로)">떼기</button>`;
}
$("#rvPlBar").addEventListener("change", async (ev) => {
  if (!ev.target.matches("#plFile")) return;
  const f = ev.target.files[0], id = REVIEW.id;
  if (!f || !id) return;
  try {
    const r = await parseTranscript(f.name, new Uint8Array(await f.arrayBuffer()));
    if (!r.segs.length) throw new Error("발언을 찾지 못했습니다");
    const dur = (REVIEW.data.job.audioFiles || []).reduce((m, x) => m + (x.dur || 0), 0);
    if (dur && r.endSec > dur + 60) throw new Error(`전사(${hms(r.endSec)})가 음원(${hms(dur)})보다 깁니다 — 같은 녹음인지 확인하세요`);
    await S.put("plaud", id, r.segs);
    await S.saveJob(id, { transcript: { name: f.name, count: r.segs.length, endSec: r.endSec } });
    if (REVIEW.id !== id) return;
    REVIEW.data.plaud = r.segs; REVIEW.data.job.transcript = { name: f.name, count: r.segs.length, endSec: r.endSec };
    REVIEW.pl = plaudOf(REVIEW.data);
    renderReview();
    scheduleHarvest(id, REVIEW.edits, REVIEW.names, 300);
    toast(`Plaud 전사 ${r.segs.length}개 발언을 붙였습니다` + (r.warnings.length ? ` — ${r.warnings[0]}` : ""));
  } catch (e) { toast("Plaud 전사를 읽지 못했습니다: " + e.message); }
});
$("#rvPlBar").addEventListener("click", async (ev) => {
  if (!ev.target.closest("#plDrop")) return;
  const id = REVIEW.id;
  if (!id || !confirm("붙인 Plaud 전사를 뗄까요? 검수 수정은 그대로 남습니다.")) return;
  await S.del("plaud", id);
  await S.saveJob(id, { transcript: null });
  if (REVIEW.id !== id) return;
  REVIEW.data.plaud = []; REVIEW.data.job.transcript = null; REVIEW.pl = new Map();
  renderReview(); scheduleHarvest(id, REVIEW.edits, REVIEW.names, 300);
});
$("#rvPlCmp").addEventListener("change", renderReview);
function renderReview() {
  const d = REVIEW.data;
  if (!d) return;
  renderHead();
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
    ...(job.hint && job.hint.length ? [`전사 힌트 ${job.hint.length}개(${job.hint.join(", ")})${job.hintDrops ? ` · 새어 나와 다시 푼 창 ${job.hintDrops}` : ""}`] : []),
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
  renderPlBar();
  const canPlay = !job.audioDeleted;
  const playBtn = (f, s0, e0) => (canPlay ? `<button type="button" class="play" title="듣기" data-s="${s0}" data-e="${e0}" data-f="${f}">▶</button>` : "");
  const optsFor = (cur) => (nameList.includes(cur) ? nameList : [cur, ...nameList]).map((n) => `<option ${n === cur ? "selected" : ""}>${esc(n)}</option>`).join("") + '<option value="__new">직접 입력…</option>';
  const sp = REVIEW.split;
  // 다시 그리기 전에 글 칸 포커스(발언 번호·조각 번호·커서)를 기억해 두었다가 돌려준다 — 휴대폰에서 키보드가 닫히지 않게
  const fa = document.activeElement, keep = !sp && fa && fa.matches && fa.matches("#rvBody textarea") ? {
    i: fa.closest("tr[data-i]")?.dataset.i, k: fa.closest(".part")?.dataset.k, a: fa.selectionStart, b: fa.selectionEnd } : null;
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
    } else {
      // 사람이 고치지 않은 발언: 사전이 바꾼 곳을 칩으로 보이고, 누르면 그 자리만 원래대로(되돌림은 사전 근거로 셈)
      const lx = e.text == null ? applyLexicon(g.text, REVIEW.rules) : { text: e.text, hits: [] };
      const chips = lx.hits.length && !splitting ? `<div class="lexhits"><span>사전</span>${lx.hits.map((h) => `<button type="button" class="lexchip" data-a="lexUndo" data-k="${h.k}" title="교정 사전이 바꾼 곳 — 누르면 여기만 원래 「${esc(h.from)}」로">${esc(h.from)} → ${esc(h.to)} ↺</button>`).join("")}</div>` : "";
      body = `<textarea rows="1" aria-label="발언"${splitting ? ' class="splitta"' : ""}>${esc(lx.text)}</textarea>${chips}${splitting ? splitBox() : plLine(g, lx.text)}`;
    }
    let spkCell, judge;
    if (parts) spkCell = `<span class="msg">${parts.length}조각으로 나눔</span>`;
    else if (sony) spkCell = `<button type="button" class="spkbtn cc${clusterIndex(g.cluster) % 8}${e.speaker ? " own" : ""}" title="${esc(clusterLabel(g.cluster))}${e.speaker ? " · 이 발언만 따로 지정" : ""}">${esc(spk)}</button>`;
    else spkCell = `<select class="spk" aria-label="화자">${optsFor(spk)}</select>`;
    if (sony) {
      const why = [];
      if (g.conf < 0.5) why.push("묶음과 덜 닮음");
      if (g.margin < 0.1) why.push("다른 묶음과 비슷");
      if (g.end - g.start < 2) why.push("짧음");
      const pr = REVIEW.pl.get(g.i);
      if (plaudDiffers(pr)) why.push(pr.text ? `Plaud와 많이 다름(겹침 ${Math.round(pr.sim * 100)}%)` : "Plaud에 없는 말");
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
      <td class="c-ok"><button type="button" class="okbtn${e.ok ? " done" : ""}" data-a="ok" aria-pressed="${!!e.ok}" title="확인하면 「남음」에서 빠집니다">${e.ok ? "✓ 확인함" : "✓ 확인"}</button></td></tr>`;
  }).join("");
  fitAll($$("#rvBody textarea"));
  renderScope();
  if (SEG.key) segUi(true); // 다시 그린 뒤에도 조작 줄을 재생 중인 발언에 붙임
  if (sp) { const ta = $(`#rvBody tr[data-i="${sp.i}"] textarea.splitta`); if (ta) { ta.focus(); if (sp.pos != null) { try { ta.setSelectionRange(sp.pos, sp.pos); } catch { /* 글이 바뀜 */ } } splitPreview(ta); } }
  else if (keep && keep.i != null) {
    const tr = $(`#rvBody tr[data-i="${CSS.escape(keep.i)}"]`);
    const ta = tr && (keep.k != null ? $(`.part[data-k="${CSS.escape(keep.k)}"] textarea`, tr) : $("td > textarea", tr));
    if (ta) { ta.focus({ preventScroll: true }); try { ta.setSelectionRange(keep.a, keep.b); } catch { /* 글이 바뀜 */ } }
  }
  TL.cur = null; tlDraw();
  drawHint();
  renderLexBox();
  renderExOpts();
  if (REVIEW.focusI != null) { // 사전 예문에서 들어옴: 그 발언으로
    const tr = $(`#rvBody tr[data-i="${CSS.escape(String(REVIEW.focusI))}"]`);
    REVIEW.focusI = null;
    if (tr) { tr.scrollIntoView({ block: "center" }); tr.classList.add("flash"); setTimeout(() => tr.classList.remove("flash"), 1600); }
  }
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
    if (v === "__new") { v = (prompt("화자 이름") || "").trim(); if (!v) { REVIEW.undo.pop(); updUndo(); renderReview(); return; } }
    const e = editOf(i);
    if (part) { // 나눈 조각의 화자
      const p = e.parts[+part.dataset.k], base = speakerOf(g, { e: { ...REVIEW.edits, [i]: { ...e, speaker: e.speaker } }, names: REVIEW.names });
      if (v === base) delete p.speaker; else p.speaker = v;
    } else if (v === g.speaker) delete e.speaker; else e.speaker = v;
    e.ok = true;
    saveEdits(); renderReview(); return;
  }
  if (ev.target.matches("textarea")) {
    if (ev.target.matches("textarea.splitta")) return; // 나누는 글 칸은 나눌 때 함께 반영(다른 발언 고치기는 그대로 저장)
    pushUndo();
    const e = editOf(i), v = ev.target.value.trim();
    const before = part ? e.parts[+part.dataset.k].text : e.text ?? gloss(g.text);
    if (part) e.parts[+part.dataset.k].text = v;
    else if (v === gloss(g.text).trim()) delete e.text; else e.text = v;
    lexHintFrom(i, before, v);
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
// 여럿은 한꺼번에: 모두 auto → 높이 모두 읽기 → 모두 쓰기(하나씩 하면 칸마다 배치를 다시 계산해 수백 발언에서 굼뜸)
function fitAll(list) { for (const t of list) t.style.height = "auto"; const h = list.map((t) => t.scrollHeight); list.forEach((t, k) => { t.style.height = h[k] + 2 + "px"; }); }
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
  if (a === "lexUndo") {
    pushUndo();
    editOf(i).text = applyLexicon(g.text, REVIEW.rules, { skip: new Set([+b.dataset.k]) }).text.trim();
    saveEdits(); renderReview(); toast("여기만 원래대로 두었습니다 — 사전에는 「되돌림」으로 셉니다");
    return;
  }
  if (a === "split") { REVIEW.split = { i: g.i, k: +b.dataset.k }; renderReview(); return; }
  if (a === "usePlaud") { // Plaud 글로 바꾸기 — 확인 표시는 붙이지 않음(글 고치기와 같음)
    const r = REVIEW.pl.get(g.i);
    if (!r || !r.text) return;
    pushUndo();
    const e = editOf(i), before = e.text ?? gloss(g.text), v = gloss(r.text).trim();
    if (v === gloss(g.text).trim()) delete e.text; else e.text = v;
    saveEdits(); renderReview(); lexHintFrom(i, before, v);
    toast("Plaud 글로 바꿨습니다 — ↶ 단추로 되돌릴 수 있습니다");
    return;
  }
  if (a === "plSplit") { // Plaud 화자 바뀜 자리를 나눌 곳으로 잡아 둔다(커서를 옮기면 그 자리에서)
    const r = REVIEW.pl.get(g.i), e = REVIEW.edits[g.i] || {};
    if (!r || !r.change) return;
    const shown = e.text ?? gloss(g.text), back = g.text.slice(r.change.pos).trim();
    let pos = back ? shown.indexOf(back.slice(0, Math.min(8, back.length))) : -1;
    if (pos <= 0) { pos = Math.round((r.change.pos / Math.max(1, g.text.length)) * shown.length); while (pos > 0 && !/\s/.test(shown[pos - 1])) pos--; }
    REVIEW.split = { i: g.i, k: 0, pos: pos > 0 ? pos : null, at: r.change.t, spk: r.change.to };
    renderReview(); return;
  }
  if (a === "splitCancel") { // 나누려다 그만둬도 글 칸에서 고친 것은 남긴다
    const ta = $("textarea.splitta", tr), e = editOf(i), k = REVIEW.split.k, v = ta ? ta.value.trim() : null;
    if (v != null) {
      const cur = e.parts && e.parts.length ? e.parts[k].text : e.text ?? gloss(g.text).trim();
      if (v !== (cur || "").trim()) {
        pushUndo();
        if (e.parts && e.parts.length) e.parts[k].text = v; else if (v === gloss(g.text).trim()) delete e.text; else e.text = v;
        saveEdits();
      }
    }
    REVIEW.split = null; renderReview(); return;
  }
  if (a === "doSplit" || a === "doSplitPlay") {
    const ta = $("textarea.splitta", tr), e = editOf(i), k = REVIEW.split.k;
    const sp0 = REVIEW.split, fromPl = sp0.at != null && ta.selectionStart === sp0.pos; // Plaud 제안 자리 그대로면 Plaud 시각·화자로
    const at = a === "doSplitPlay" ? playPosIn(g.file || 0, +b.dataset.s, +b.dataset.e) : fromPl ? sp0.at : undefined;
    const parts = splitPart(g, e.parts, k, ta.value, ta.selectionStart, at ?? undefined);
    if (!parts) { toast("커서를 글 중간에 두세요"); return; }
    pushUndo();
    if (fromPl && sp0.spk && parts[k + 1] && sp0.spk !== speakerOf(g, { e: REVIEW.edits, names: REVIEW.names }) && knownName(sp0.spk)) parts[k + 1].speaker = sp0.spk;
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
  saveEdits(); renderReview(); toast(`${todo.length}개를 확인했습니다 — ↶ 단추로 되돌릴 수 있습니다`);
});
$("#rvUndo").addEventListener("click", () => undo());
// 검수 수정 저장: 0.4초 모았다가 쓴다. 그 사이 작업을 바꾸거나 내보내면 flushEdits로 먼저 쓴다(예전엔 내보낸 파일에 마지막 수정이 빠지거나,
// 작업을 바꾼 직후 다른 작업의 수정이 앞 작업 이름으로 덮어써질 수 있었다). 쓸 내용은 부를 때의 것을 붙잡아 둔다.
REVIEW.pending = null;
function saveEdits() {
  $("#rvSave").textContent = "저장 대기…";
  clearTimeout(REVIEW.saveT);
  REVIEW.pending = { id: REVIEW.id, e: REVIEW.edits, names: REVIEW.names };
  REVIEW.saveT = setTimeout(() => flushEdits(), 400);
}
async function flushEdits() {
  clearTimeout(REVIEW.saveT);
  const p = REVIEW.pending; REVIEW.pending = null;
  if (!p || !p.id) return;
  try {
    await S.put("edits", p.id, { e: p.e, names: p.names, updatedAt: S.now() });
    if (REVIEW.id === p.id) $("#rvSave").textContent = "저장됨 " + new Date().toLocaleTimeString("ko-KR");
    scheduleHarvest(p.id, p.e, p.names);
  } catch (e) { $("#rvSave").textContent = "저장 실패: " + e.message; }
}
addEventListener("pagehide", () => { flushEdits(); });
/* ---- 교정 사전 배우기: 고친 글 ↔ 원래 전사 비교(근거 집계), 같은 녹음 나머지 바꾸기, 내보내기 앞 후보 상자 */
function scheduleHarvest(id, e, names, wait = 1500) {
  clearTimeout(REVIEW.hvT);
  REVIEW.hvT = setTimeout(() => runHarvest(id, e, names), wait);
}
async function runHarvest(id, e, names) {
  try {
    const d = REVIEW.data && REVIEW.id === id ? REVIEW.data : await reviewData(id);
    if (!d || !d.result) return;
    // 사람 이름(화자 이름·목소리 기준·Plaud 이름)으로 고친 것은 「이름」 — 자동 추천하지 않고 늘 사람이 확인
    const who = new Set([...(REVIEW.vpNames || []), ...Object.values(names || {}), ...Object.values(d.job.speakerMap || {})]);
    for (const x of Object.values(e || {})) { if (x.speaker) who.add(x.speaker); for (const q of x.parts || []) if (q.speaker) who.add(q.speaker); }
    for (const g of d.result.segs) if (g.speaker) who.add(g.speaker);
    for (const n of [...who]) if (!n || isGeneric(n)) who.delete(n);
    const segs = d.result.segs.map((g) => ({ i: g.i, text: g.text }));
    // Plaud 대조 쌍(발언마다 같은 쌍 한 번) — 같은 자리 Plaud 글과 소리가 닮게 다른 말
    const pl = REVIEW.id === id && REVIEW.data === d ? REVIEW.pl : plaudOf(d), plPairs = [];
    for (const g of d.result.segs) {
      const r = pl.get(g.i);
      if (!r || !r.text) continue;
      const seen = new Set();
      for (const p of plaudPairs(g.text, r.text, diffPairs, stripJosa)) { const k = p.from + "\u0000" + p.to; if (!seen.has(k)) { seen.add(k); plPairs.push({ i: g.i, ...p }); } }
    }
    const lex = await lexUpdate((l) => harvest(l, id, segs, e, who, plPairs));
    if (REVIEW.id === id) { setLex(lex); renderLexBox(); }
  } catch (err) { console.warn("교정 사전 근거 집계 실패", err); }
}
const ruleOf = (p) => [{ from: p.from, to: p.to, toks: p.from.split(/\s+/), when: null }];
/** 이 녹음에서 같은 꼴이 남은 곳 [{i, k}] (k: 나눈 조각 번호, 아니면 -1) */
function lexOccur(p, skipI) {
  const r = ruleOf(p), out = [];
  for (const g of REVIEW.data.result.segs) {
    if (String(g.i) === String(skipI)) continue;
    const e = REVIEW.edits[g.i] || {};
    if (e.parts && e.parts.length) e.parts.forEach((q, k) => { if (applyLexicon(q.text, r).hits.length) out.push({ i: g.i, k }); });
    else if (applyLexicon(e.text ?? gloss(g.text), r).hits.length) out.push({ i: g.i, k: -1 });
  }
  return out;
}
/** 발언 하나를 고친 직후: 인식 오류로 보이는 바꿈이 있고 같은 말이 이 녹음에 더 있으면 알림 */
function lexHintFrom(i, before, after) {
  if (!REVIEW.data || !REVIEW.data.result) return;
  const ps = diffPairs(before, after).filter((p) => !REVIEW.hintNo.has(p.from + "\u0000" + p.to));
  for (const p of ps) {
    const occ = lexOccur(p, i);
    if (occ.length) { REVIEW.hint = { i: String(i), from: p.from, to: p.to, occ }; drawHint(); return; }
  }
}
function drawHint() {
  $$("#rvBody .lexhint").forEach((x) => x.remove());
  const h = REVIEW.hint;
  if (!h) return;
  const td = $(`#rvBody tr[data-i="${CSS.escape(h.i)}"] > td:nth-child(4)`);
  if (!td) return;
  const d = document.createElement("div");
  d.className = "lexhint";
  d.innerHTML = `<span class="grow"><b>${esc(h.from)} → ${esc(h.to)}</b> · 이 녹음에 ${h.occ.length}곳 더 있습니다</span><button type="button" class="primary" data-lx="open">살펴보고 바꾸기</button><button type="button" data-lx="no">이번만</button>`;
  td.appendChild(d);
}
const LX = { open: false, h: null };
function curText(i, k) { const g = segOf(i), e = REVIEW.edits[g.i] || {}; return k >= 0 ? e.parts[k].text || "" : e.text ?? gloss(g.text); }
function openLex() {
  const h = REVIEW.hint;
  if (!h) return;
  h.occ = lexOccur(h, h.i); // 그사이 고쳤을 수 있음
  if (!h.occ.length) { REVIEW.hint = null; drawHint(); toast("더 바꿀 곳이 없습니다"); return; }
  LX.open = true; LX.h = h;
  $("#lexTitle").textContent = `「${h.from}」${josa(h.from, "을/를").slice(h.from.length)} 「${h.to}」${josa(h.to, "으로/로").slice(h.to.length)} — ${h.occ.length}곳`;
  const canPlay = !REVIEW.data.job.audioDeleted;
  $("#lexList").innerHTML = h.occ.map((o, n) => {
    const g = segOf(o.i), e = REVIEW.edits[g.i] || {}, t = curText(o.i, o.k);
    const at = t.indexOf(h.from), a = Math.max(0, at - 16), b = at + h.from.length;
    const st = o.k >= 0 ? e.parts[o.k].start : g.start, en = o.k >= 0 ? partEnd(g, e.parts, o.k) : g.end;
    const spk = o.k >= 0 ? e.parts[o.k].speaker || speakerOf(g, { e: REVIEW.edits, names: REVIEW.names }) : speakerOf(g, { e: REVIEW.edits, names: REVIEW.names });
    return `<div class="lxrow"><label><input type="checkbox" checked data-n="${n}"><span class="ctx"><small>${hms(st)} · ${esc(spk)}</small>${a ? "…" : ""}${esc(t.slice(a, at))}<mark>${esc(h.from)}</mark>${esc(t.slice(b, b + 16))}${b + 16 < t.length ? "…" : ""}</span></label>${canPlay ? `<button type="button" class="play" data-lx="play" data-f="${g.file || 0}" data-s="${st}" data-e="${en}" title="듣기">▶</button>` : ""}</div>`;
  }).join("");
  lexCount();
  $("#lexSheet").classList.remove("hidden");
  $("#lexSheet .rg-in").focus();
}
function lexCount() { const n = $$("#lexList input:checked").length; $("#lexApply").textContent = `고른 ${n}곳 바꾸기`; $("#lexApply").disabled = !n; }
function closeLex() { LX.open = false; $("#lexSheet").classList.add("hidden"); stopClear(); }
function applyLex() {
  const h = LX.h, r = ruleOf(h), pick = $$("#lexList input:checked").map((x) => h.occ[+x.dataset.n]);
  if (!pick.length) return;
  pushUndo();
  for (const o of pick) { // 바꾼 발언은 「확인」을 붙이지 않는다(사람이 들어 보지 않았으므로)
    const g = segOf(o.i), e = editOf(o.i), v = applyLexicon(curText(o.i, o.k), r).text.trim();
    if (o.k >= 0) e.parts[o.k].text = v; else if (v === gloss(g.text).trim()) delete e.text; else e.text = v;
  }
  REVIEW.hint = null; closeLex();
  saveEdits(); renderReview();
  toast(`${pick.length}곳을 바꿨습니다 — ↶ 단추로 되돌릴 수 있습니다`);
}
$("#rvBody").addEventListener("click", (ev) => {
  const b = ev.target.closest("button[data-lx]");
  if (!b) return;
  if (b.dataset.lx === "open") openLex();
  else if (b.dataset.lx === "no") { const h = REVIEW.hint; if (h) REVIEW.hintNo.add(h.from + "\u0000" + h.to); REVIEW.hint = null; drawHint(); }
});
$("#lexSheet").addEventListener("click", (ev) => {
  if (ev.target === $("#lexSheet")) { closeLex(); return; }
  const b = ev.target.closest("button[data-lx]");
  if (!b) return;
  if (b.dataset.lx === "close") closeLex();
  else if (b.dataset.lx === "apply") applyLex();
  else if (b.dataset.lx === "play") playRange(+b.dataset.f, +b.dataset.s, +b.dataset.e);
});
$("#lexList").addEventListener("change", lexCount);
/** ③ 내보내기 위: 이번 녹음에서 모은 후보 중 서로 다른 발언 REC_MIN곳 이상인 것 */
function renderLexBox() {
  const box = $("#lexBox"), id = REVIEW.id, lex = REVIEW.lex;
  if (!box || !lex) return;
  const conf = conflicts(lex), items = [];
  for (const t of lex.terms) for (const v of t.vars) {
    if (v.st !== "cand" || !v.by || !v.by[id]) continue;
    const j = judge(lex, t, v, conf);
    if ((j.s.n < REC_MIN && j.s.n + j.s.pl < PL_REC) || j.s.undo) continue;
    items.push({ t, v, j });
  }
  let plN = 0;
  for (const t of lex.terms) for (const v of t.vars) if (v.st === "cand" && v.by && v.by[id] && v.by[id].pl) plN++;
  const plNote = plN ? `<div class="lxh pln"><span class="grow">Plaud와 견줘 모은 후보 ${plN}개를 교정 사전 「후보」에 넣었습니다</span><button type="button" class="link" data-lc="glcand">보기</button></div>` : "";
  box.classList.toggle("hidden", !items.length && !plN);
  if (!items.length) { box.innerHTML = plNote; return; }
  items.sort((x, y) => y.j.s.n + y.j.s.pl - x.j.s.n - x.j.s.pl);
  box.innerHTML = `<div class="lxh"><b>이번 검수에서 찾은 교정 후보 ${items.length}개</b><span class="msg">사전에 넣으면 이 화면과 다음 녹음부터 바로 쓰입니다</span></div>` + plNote + items.map(({ t, v, j }) => {
    const here = v.by[id].n || 0, hpl = v.by[id].pl || 0, other = j.s.jobs - 1, when = j.common ? whenOf(v) : [];
    const badge = j.conflict ? '<span class="chip warn">고친 말이 둘 이상</span>' : j.name ? '<span class="chip">이름일 수 있음</span>' : j.common ? '<span class="chip">흔한 낱말</span>' : '<span class="chip acc">추천</span>';
    const ev = [here ? `이번 녹음 고침 ${here}곳` : "", hpl ? `Plaud 대조 ${hpl}곳` : "", other > 0 ? `다른 녹음 ${other}건` : "", j.common ? `고치지 않고 확인한 곳 ${j.s.neg}` : ""].filter(Boolean).join(" · ");
    const note = j.conflict ? "같은 말을 다른 말로도 고친 적이 있습니다 — 맞는 쪽만 넣으세요"
      : j.name ? "사람·업체 이름은 철자를 확인한 뒤 넣으세요"
      : j.common && when.length ? `「${esc(v.from)}」${josa(v.from, "은/는").slice(v.from.length)} 실제 낱말일 수 있어 뒤에 「${when.map(esc).join("·")}」${josa(when[when.length - 1], "이/가").slice(when[when.length - 1].length)} 올 때만 바꿉니다` : "";
    return `<div class="lxc" data-to="${esc(t.to)}" data-from="${esc(v.from)}"><div class="pair">${esc(v.from)} → ${esc(t.to)} ${badge}</div><div class="ev">${ev}</div>${note ? `<div class="ev">${note}</div>` : ""}
      <div class="acts"><button type="button" class="primary" data-lc="on">${when.length ? "조건 붙여 넣기" : "사전에 넣기"}</button><button type="button" data-lc="off">넣지 않기</button></div></div>`;
  }).join("");
}
$("#lexBox").addEventListener("click", async (ev) => {
  const b = ev.target.closest("button[data-lc]");
  if (!b) return;
  if (b.dataset.lc === "glcand") { GL.tab = "cand"; showTab("glossary"); return; }
  const c = b.closest(".lxc"), to = c.dataset.to, from = c.dataset.from, st = b.dataset.lc;
  b.disabled = true;
  try {
    const lex = await lexUpdate((l) => {
      const t = l.terms.find((x) => x.to === to), v = t && t.vars.find((x) => x.from === from);
      if (!v) return l;
      const j = judge(l, t, v);
      return setVar(l, to, from, st, st === "on" && j.common ? whenOf(v) : undefined);
    });
    setLex(lex); renderReview();
    toast(st === "on" ? `「${from} → ${to}」${josa(to, "을/를").slice(to.length)} 사전에 넣었습니다` : "넣지 않기로 했습니다 — 교정 사전 「꺼짐」에 남습니다");
  } catch (e) { toast("사전 저장 실패: " + e.message); b.disabled = false; }
});
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
// 화자 색 — OLO 타일 색조(style.css .cc0~7과 같은 순서)
const PAL = ["#B95B3B", "#3E7F80", "#6A5A9E", "#B04A6A", "#2E8B6B", "#8A6A3B", "#55606B", "#4C7A3E"];
const TL = { id: null, file: 0, loaded: -1, t: 0, env: {}, items: [], Z: 45, drag: null, cur: null, raf: 0 };
const PRE = 0.3; // ▶는 발언 시각 0.3초 앞부터(첫 소리가 잘리지 않을 만큼만 — 2초 앞부터 틀면 적힌 시각과 들리는 소리가 어긋나 보였음)
const fileDur = (fi) => ((REVIEW.data?.job.audioFiles || [])[fi] || {}).dur || 0;
const DARK = matchMedia("(prefers-color-scheme: dark)");
const cssBad = (css) => css.getPropertyValue("--bad").trim() || "#A50E2E"; // 재생 위치 선 — 어두운 화면에서는 밝은 빨강
/** #RRGGBB를 흰색 쪽으로 k(0~1)만큼 섞는다 */
const lighten = (hex, k) => { const n = parseInt(String(hex).slice(1), 16); if (!Number.isFinite(n)) return hex; const c = (v) => Math.round(v + (255 - v) * k); return `rgb(${c(n >> 16)}, ${c((n >> 8) & 255)}, ${c(n & 255)})`; };
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

/** 음원을 재생기에 건다. 기다리는 사이 다른 녹음으로 바뀌었으면 false(그 녹음의 재생기를 건드리지 않음) */
async function tlLoad(fi) {
  const id = REVIEW.id;
  if (TL.loaded === fi && player.src) return true;
  const file = await S.audioFile(id, fi);
  if (REVIEW.id !== id || TL.id !== id) return false;
  if (player.src) URL.revokeObjectURL(player.src);
  player.src = URL.createObjectURL(new Blob([wavHeader(file.size / 2), file], { type: "audio/wav" }));
  TL.loaded = fi; TL.file = fi; $("#tlFile").value = String(fi);
  await new Promise((res) => { if (player.readyState >= 1) res(); else player.addEventListener("loadedmetadata", res, { once: true }); });
  if (REVIEW.id !== id || TL.id !== id) return false;
  tlEnvelope(id, fi).catch(() => { delete TL.env[id + "/" + fi]; }); // 읽기 실패는 다음에 다시
  return true;
}

/** 소리 크기 윤곽(0.25초마다 최댓값) — 1분씩 읽어 조금씩 채운다 */
async function tlEnvelope(id, fi) {
  const key = id + "/" + fi;
  if (TL.env[key]) return;
  const dur = fileDur(fi), step = 0.25, env = (TL.env[key] = new Float32Array(Math.ceil(dur / step) + 1));
  for (let t = 0; t < dur; t += 60) {
    if (TL.id !== id || REVIEW.id !== id) return;
    const x = await S.readAudio(id, fi, t, Math.min(dur, t + 60));
    if (TL.id !== id || REVIEW.id !== id) return;
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
  if (REVIEW.data.job.audioDeleted) { toast("음원을 지운 녹음이라 들을 수 없습니다"); return; }
  try {
    if (!(await tlLoad(fi))) return;
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
  const css = getComputedStyle(document.body), ink = css.color, mute = css.getPropertyValue("--mute") || "#888", bad = cssBad(css);
  const dark = DARK.matches; // 어두운 화면에서는 화자 이름 글씨를 밝게(진한 화자 색 그대로는 바탕에 묻힘)
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
    if (x1 - x0 > 30) { g.fillStyle = x.plaud ? mute : dark ? lighten(x.color, 0.55) : x.color; g.fillText(x.name, x0 + 2, 1, x1 - x0 - 4); }
  }
  g.fillStyle = mute; g.globalAlpha = 0.8;
  for (let s = Math.ceil(a / 10) * 10; s < a + span; s += 10) { if (s < 0) continue; g.fillRect(X(s), h - 4, 1, 4); }
  g.globalAlpha = 1; g.fillStyle = bad; g.fillRect(w / 2 - 1, 0, 2, h);
  // 아래 띠: 녹음 전체
  const [o, ow, oh] = canvasCtx($("#tlAll"));
  const OX = (sec) => (sec / dur) * ow;
  o.fillStyle = "rgba(128,128,128,.18)"; o.fillRect(0, 0, ow, oh);
  for (const x of items) { o.globalAlpha = x.plaud ? 0.35 : 0.9; o.fillStyle = x.color; o.fillRect(OX(x.s), x.plaud ? oh - 4 : 3, Math.max(1, OX(x.e) - OX(x.s)), x.plaud ? 4 : oh - 6); }
  o.globalAlpha = 1; o.strokeStyle = ink; o.lineWidth = 1; o.strokeRect(Math.max(0, OX(a)) + 0.5, 0.5, Math.max(2, OX(a + span) - Math.max(0, OX(a))), oh - 1);
  o.fillStyle = bad; o.fillRect(OX(t) - 1, 0, 2, oh);
  // 지금 발언
  const cur = items.find((x) => !x.plaud && x.s <= t && t < x.e) || items.find((x) => x.s <= t && t < x.e);
  $("#tlTime").textContent = `${hms(t)} / ${hms(dur)}`;
  $("#tlNow").textContent = cur ? cur.name : "";
  $("#tlPlay").textContent = player.paused || TL.loaded !== fi ? "▶" : "❚❚";
  if (SEG.key) segUi();
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

// 아래 재생 막대를 쓰면 발언 듣기(끝에서 멈춤)는 풀고 녹음 전체를 이어 듣는다
const tlTake = () => { stopClear(); if (SEG.key) { SEG.key = null; segUi(true); } };
$("#tlPlay").addEventListener("click", () => { tlTake(); return player.paused || TL.loaded !== TL.file ? seekPlay(TL.file, TL.t) : player.pause(); });
$$("#tl [data-j]").forEach((b) => b.addEventListener("click", () => { tlTake(); seekPlay(TL.file, TL.t + +b.dataset.j, !player.paused); }));
$("#tlRate").addEventListener("change", (e) => { player.playbackRate = +e.target.value; });
$("#tlFile").addEventListener("change", (e) => seekPlay(+e.target.value, 0, false));
$("#tlTime").addEventListener("click", () => { TL.cur = null; tlDraw(true); });
// 아래 띠: 누르거나 끌면 그 자리로
const tlAll = $("#tlAll");
const allSeek = (ev) => { tlTake(); const r = tlAll.getBoundingClientRect(); TL.t = Math.max(0, Math.min(1, (ev.clientX - r.left) / r.width)) * fileDur(TL.file); if (TL.loaded === TL.file) player.currentTime = TL.t; tlDraw(true); };
tlAll.addEventListener("pointerdown", (ev) => { tlAll.setPointerCapture(ev.pointerId); TL.drag = "all"; tlLoad(TL.file).then((ok) => ok && allSeek(ev)).catch(() => {}); });
tlAll.addEventListener("pointermove", (ev) => { if (TL.drag === "all") allSeek(ev); });
tlAll.addEventListener("pointerup", () => { TL.drag = null; });
// 위 띠: 끌면 앞뒤로 옮기기, 짧게 누르면 그 자리로
const tlZoom = $("#tlZoom");
tlZoom.addEventListener("pointerdown", (ev) => { tlZoom.setPointerCapture(ev.pointerId); TL.drag = { x: ev.clientX, t: TL.t, moved: false }; tlLoad(TL.file).catch(() => {}); });
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
  tlTake();
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
// 화면이 꺼지거나 다른 앱으로 가면 화면 갱신(requestAnimationFrame)이 멈추므로 끝을 넘겨 계속 재생되던 것 — timeupdate로도 확인
queueMicrotask(() => player.addEventListener("timeupdate", () => { if (STOP.at != null && player.currentTime >= STOP.at) { player.pause(); STOP.at = null; } }));
async function playRange(f, s, e) {
  stopClear(); // 앞 구간의 멈춤 감시가 새 재생을 잘못 멈추지 않게(다른 파일로 옮길 때 특히)
  await seekPlay(f, s);
  STOP.at = e;
  stopWatch();
}
function stopClear() { cancelAnimationFrame(STOP.raf); STOP.at = null; }
/* ---- 발언 듣기: ▶는 재생·일시정지 겸용, 재생 중인 발언(조각) 아래에만 조작 줄(처음 · −n초 · ❚❚ · +n초 · 다음, n = segStep)
 * 전사 편집기들의 일반 방식(한 단추로 재생/멈춤, 5초 되감기, 지금 위치 표시)을 휴대폰 크기에 맞춤. 발언 끝에서 멈추고,
 * 멈춘 뒤 다시 누르면 1초 앞부터 이어 듣는다. 녹음 전체를 이어 듣기는 아래 재생 막대. */
const SEG = { f: 0, s: 0, e: 0, key: null };
const segKey = (b) => `${b.dataset.f}|${b.dataset.s}|${b.dataset.e}`;
async function segPlay(f, s, e, key, from) {
  Object.assign(SEG, { f, s, e, key });
  stopClear();
  await seekPlay(f, from ?? Math.max(0, s - PRE));
  STOP.at = e;
  stopWatch();
  segUi(true);
}
function segToggle(b) {
  const f = +b.dataset.f, s = +b.dataset.s, e = +b.dataset.e, key = segKey(b);
  if (SEG.key === key && TL.loaded === f) {
    if (!player.paused) { player.pause(); return; }
    const t = player.currentTime;
    const from = t >= e - 0.1 || t < s - 1 ? Math.max(0, s - PRE) : Math.max(s - PRE, t - 1); // 멈춘 곳 1초 앞부터(끝까지 들었으면 처음부터)
    segPlay(f, s, e, key, from); return;
  }
  segPlay(f, s, e, key);
}
// 발언 안에서 앞뒤로 옮기는 폭: 발언 길이에 맞춤(짧은 발언에서 5초는 처음·끝으로 튀어 나눌 곳을 찾기 어려움 — 2026-10-12 사용자)
//   10초 이하 1초 · 30초 이하 2초 · 그보다 길면 5초
const segStep = () => { const d = SEG.e - SEG.s; return d <= 10 ? 1 : d <= 30 ? 2 : 5; };
function segSeek(d) {
  if (!SEG.key || TL.loaded !== SEG.f) return;
  const t = Math.max(SEG.s - PRE, Math.min(SEG.e - 0.05, player.currentTime + d));
  player.currentTime = t; TL.t = t;
  if (!player.paused) { STOP.at = SEG.e; stopWatch(); }
  segUi(); tlDraw();
}
function segNext() {
  const all = $$("#rvBody button.play");
  const i = all.findIndex((b) => segKey(b) === SEG.key);
  const after = (b) => +b.dataset.f > SEG.f || (+b.dataset.f === SEG.f && +b.dataset.s >= SEG.e - 0.05); // 다음 파일은 시각과 상관없이 뒤
  const nx = all.slice(i + 1).find(after) || all[i + 1];
  if (nx) { segToggle(nx); nx.scrollIntoView({ block: "center", behavior: REDUCE_MOTION ? "auto" : "smooth" }); }
}
// 단추 모양·조작 줄 자리·진행 막대를 지금 상태에 맞춤(재생 막대 그리기와 함께 불림)
// force: 행을 다시 그렸을 때. 재생 중 화면 갱신마다 불리므로, 상태(어느 발언·재생 여부)가 바뀔 때만 단추들을 고친다(예전엔 매 화면 모든 ▶를 고쳐 긴 녹음에서 버벅임)
function segUi(force = false) {
  const playing = !player.paused;
  // 아래 재생 막대로 다른 곳을 듣기 시작하면 발언 조작 줄은 걷고, 그 발언의 끝 멈춤도 푼다
  if (SEG.key && playing && TL.loaded === SEG.f && (player.currentTime < SEG.s - PRE - 0.6 || player.currentTime > SEG.e + 0.6)) { SEG.key = null; stopClear(); }
  const sig = `${SEG.key}|${playing}`;
  if (force || sig !== SEG.sig || (SEG.host && !SEG.host.isConnected)) {
    SEG.sig = sig; SEG.host = null;
    for (const b of $$("#rvBody button.play")) {
      const on = SEG.key && segKey(b) === SEG.key;
      if (!on && !b.classList.contains("on") && b.textContent === "▶") continue;
      b.textContent = on && playing ? "❚❚" : "▶";
      b.classList.toggle("on", !!on);
      b.title = on && playing ? "멈춤" : "듣기";
      if (on) SEG.host = b.closest(".part") || b.closest("tr")?.querySelector("td:nth-child(4)");
    }
  }
  const host = SEG.key ? SEG.host : null;
  let bar = $("#segCtl");
  if (!host) { if (bar) bar.remove(); return; }
  if (!bar) {
    bar = document.createElement("div"); bar.id = "segCtl"; bar.className = "segctl";
    bar.innerHTML = `<div class="segtt"><span data-x="now"></span><span data-x="span"></span></div>
      <div class="segbar" data-x="bar"><i data-x="fill"></i><b data-x="knob"></b></div>
      <div class="segbtns"><button type="button" data-x="head">↺ 처음</button><button type="button" data-x="b5">−1초</button>
      <button type="button" class="primary" data-x="pp">▶</button><button type="button" data-x="f5">+1초</button><button type="button" data-x="next">다음 ▸</button></div>`;
  }
  if (bar.parentElement !== host) host.appendChild(bar);
  const t = TL.loaded === SEG.f ? player.currentTime : SEG.s;
  const pct = Math.max(0, Math.min(100, ((t - SEG.s) / Math.max(0.1, SEG.e - SEG.s)) * 100));
  $("[data-x='now']", bar).textContent = fmt1(Math.max(SEG.s, t));
  $("[data-x='span']", bar).textContent = `${fmt1(SEG.s)} ~ ${fmt1(SEG.e)}`;
  $("[data-x='fill']", bar).dataset.w = pct.toFixed(1); $("[data-x='knob']", bar).dataset.left = pct.toFixed(1);
  $("[data-x='pp']", bar).textContent = playing ? "❚❚" : "▶";
  const st = segStep();
  if ($("[data-x='f5']", bar).dataset.st !== String(st)) {
    $("[data-x='b5']", bar).textContent = `−${st}초`; $("[data-x='f5']", bar).textContent = `+${st}초`; $("[data-x='f5']", bar).dataset.st = String(st);
  }
  applyGeom(bar);
}
$("#rvBody").addEventListener("click", (ev) => {
  const x = ev.target.closest("#segCtl [data-x]");
  if (x) {
    const k = x.dataset.x;
    if (k === "pp") { const b = $$("#rvBody button.play").find((y) => segKey(y) === SEG.key); if (b) segToggle(b); }
    if (k === "b5") segSeek(-segStep()); if (k === "f5") segSeek(segStep());
    if (k === "head") segPlay(SEG.f, SEG.s, SEG.e, SEG.key, SEG.s);
    if (k === "next") segNext();
    return;
  }
  const b = ev.target.closest("button.play");
  if (b) segToggle(b);
});
// 발언 안 위치 막대: 누르거나 끌어서 옮기기
$("#rvBody").addEventListener("pointerdown", (ev) => {
  const bar = ev.target.closest("#segCtl .segbar");
  if (!bar || TL.loaded !== SEG.f) return;
  const move = (e2) => { const r = bar.getBoundingClientRect(); const t = SEG.s + Math.max(0, Math.min(1, (e2.clientX - r.left) / r.width)) * (SEG.e - SEG.s); player.currentTime = Math.min(SEG.e - 0.05, t); TL.t = player.currentTime; segUi(); };
  move(ev); bar.setPointerCapture(ev.pointerId);
  const up = () => { bar.removeEventListener("pointermove", move); if (!player.paused) { STOP.at = SEG.e; stopWatch(); } };
  bar.addEventListener("pointermove", move); bar.addEventListener("pointerup", up, { once: true });
});
// 자판(폴드 펼침·PC): Ctrl+Space 재생/멈춤, Ctrl+←/→ 발언 안에서는 발언 길이에 맞춘 폭(segStep), 그 밖은 5초
document.addEventListener("keydown", (ev) => {
  if (!$("#tab-review").classList.contains("on") || !(ev.ctrlKey || ev.metaKey)) return;
  if (!REVIEW.data) return;
  if (ev.code === "Space") { ev.preventDefault(); const b = SEG.key && $$("#rvBody button.play").find((y) => segKey(y) === SEG.key); if (b) segToggle(b); else $("#tlPlay").click(); }
  else if ((ev.key === "ArrowLeft" || ev.key === "ArrowRight") && !ev.target.closest("input, textarea")) { ev.preventDefault(); const d = ev.key === "ArrowLeft" ? -5 : 5; if (SEG.key) segSeek(Math.sign(d) * segStep()); else $(`#tl button[data-j='${d}']`).click(); }
});
/** 검수 진행을 kv 「rv:작업id」에 적어 둔다 — 녹음 목록 카드의 「남음 n」·내보내기 끝 표시용(바뀔 때만 씀) */
function saveRv(patch) {
  const id = REVIEW.id;
  if (!id) return;
  const cur = REVIEW.rv && REVIEW.rv.id === id ? REVIEW.rv.v : null;
  const v = { ...(cur || {}), ...patch };
  if (cur && JSON.stringify(cur) === JSON.stringify(v)) return;
  REVIEW.rv = { id, v };
  S.update("kv", "rv:" + id, (o) => ({ ...(o || {}), ...patch })).catch(() => {});
}
/** 검수 진행 기록을 지운다 — 발언이 더해지거나 빠지는 다시 처리 뒤에는 옛 「완료·내보내기」 표시가 맞지 않음 */
async function clearRv(id) {
  if (REVIEW.rv && REVIEW.rv.id === id) REVIEW.rv = { id, v: null };
  await S.del("kv", "rv:" + id).catch(() => {});
}
async function doExport(fmt) {
  const id = REVIEW.id;
  if (!id) return;
  try {
    await flushEdits(); // 방금 고친 글이 빠지지 않게
    const data = await reviewData(id);
    const opts = { usePlaud: $("#exPlaud").checked, useGlossary: $("#exGl").checked, ...exOpts() };
    const name = safeName(data.job.title) + "_통합본." + fmt;
    // 앞에 UTF-8 표시(BOM)를 붙인다: 없으면 휴대폰 크롬의 글 보기·윈도 메모장·엑셀이 한글을 EUC-KR로 짐작해 깨져 보임
    const BOM = "\uFEFF";
    if (fmt === "csv") download(name, new Blob([exportCsv(data, opts)], { type: "text/csv;charset=utf-8" })); // CSV는 exportCsv가 이미 BOM을 붙임
    else download(name, new Blob([BOM + exportTxt(data, opts)], { type: "text/plain;charset=utf-8" }));
    // 내려받기를 마친 뒤에만 「내보냄」으로 적는다(실패했는데 카드가 완료로 바뀌지 않게)
    if (REVIEW.id === id) { saveRv({ exportedAt: S.now() }); renderHead(); }
    else await S.update("kv", "rv:" + id, (o) => ({ ...(o || {}), exportedAt: S.now() })).catch(() => {});
  } catch (e) { toast("내보내지 못했습니다: " + e.message); }
}
/* 통합본 정리(이어 붙이기·맞장구 빼기·금액 쉼표 — export.js tidyLines). 고른 값은 설정(settings.export)에 남긴다. 처음엔 이어 붙이기·쉼표만 켬 */
const EX_DEF = { join: true, dropShort: false, comma: true };
const exOpts = () => Object.fromEntries($$(".exopts input[data-xo]").map((x) => [x.dataset.xo, x.checked]));
async function loadExOpts() {
  const o = { ...EX_DEF, ...(((await S.get("kv", "settings")) || {}).export || {}) };
  $$(".exopts input[data-xo]").forEach((x) => { x.checked = !!o[x.dataset.xo]; });
}
$$(".exopts input[data-xo]").forEach((x) => x.addEventListener("change", () => {
  const o = exOpts();
  S.update("kv", "settings", (st) => ({ ...(st || {}), export: o })).catch(() => {});
}));
/** 정리하면 몇 줄이 되는지(이어 붙이기·맞장구 줄) */
function renderExOpts() {
  const d = REVIEW.data;
  if (!d || !d.result) return;
  try {
    const data = { ...d, edits: { ...d.edits, e: REVIEW.edits, names: REVIEW.names }, lexicon: REVIEW.lex, glossary: REVIEW.gl };
    const base = { usePlaud: $("#exPlaud").checked, useGlossary: false };
    const all = mergedLines(data, base).length, joined = mergedLines(data, { ...base, join: true }).length, kept = mergedLines(data, { ...base, dropShort: true }).length;
    $("#exJoinN").textContent = all > joined ? `(${all} → ${joined}줄)` : "";
    $("#exShortN").textContent = all > kept ? `(${all - kept}줄)` : "";
  } catch (e) { console.warn(e); }
}
$("#exTxt").addEventListener("click", () => doExport("txt"));
$("#exCsv").addEventListener("click", () => doExport("csv"));

/* ================================================================== 화자 패널(소니 녹음) */
// 묶음(Speaker N)마다 대표 구간을 들어 보고 이름을 붙이면 그 묶음 발언 전체에 적용된다. 같은 이름을 붙이면 합쳐진다.
// 이름이 정해지는 우선순위: 발언별 수정 > 묶음 이름 > 처리 결과(Speaker N). 원래 묶음은 지우지 않아 언제든 되돌릴 수 있다.
const clustersOf = () => (REVIEW.data && (REVIEW.data.result?.clusters || REVIEW.diar?.clusters)) || [];
const clusterIndex = (id) => Math.max(0, clustersOf().findIndex((c) => c.id === id));
const clusterLabel = (id) => (clustersOf().find((c) => c.id === id) || {}).label || id;

function pushUndo(diar) { // diar: 묶음을 나누기 전 화자 분리 결과(되돌릴 때 다시 저장)
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

// 둘로 나누기에 쓸 수 있는 차례 수(사람이 정한 차례는 다시 나누지 않음 — splitCluster와 같은 기준)
const nFree = (ci) => (REVIEW.diar ? REVIEW.diar.turns.filter((t) => t.c === ci && !t.m).length : 0);
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
        <label class="chk" title="체크를 끄면 이 묶음은 전사하지 않습니다(차 소리·바람·음악 같은 잡음 묶음 등)"><input type="checkbox" data-a="inc" ${skip.has(c.id) ? "" : "checked"}> 전사 대상</label>
        ${pending ? (nFree(ci) >= 4 ? '<button type="button" class="link" data-a="split2" title="두 사람이 쉼 없이 주고받아 한 사람으로 묶였을 때 — 목소리로 다시 둘로 나눕니다">둘로 나누기</button>' : "")
          : `<button type="button" class="link" data-a="only">${REVIEW.only === c.id ? "모두 보기" : "이 묶음만 보기"}</button>`}</div>
      <div class="nm"><input data-a="name" list="dlNames" value="${esc(nm)}" placeholder="이름(예: 김○○ 팀장)" aria-label="${esc(c.label)} 이름"> ${sug}
        ${same.length ? `<span class="merged">↳ ${esc(josa(same.join(", "), "와/과"))} 같은 사람(합쳐짐)</span>` : ""}</div>
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
          <span class="t">${multiF ? r.f + 1 + "번 " : ""}${fmt1(r.s)}~${fmt1(r.e)} (${(r.e - r.s).toFixed(1)}초)${r.other >= 0 ? ` · ${esc(josa(cl[r.other].label.replace("Speaker ", "S"), "와/과"))} 닮음` : " · 다른 목소리"}</span></div>`;
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
    saveEdits();
    // 다음 이름 칸을 누르는 사이에 이 change가 와서 화면을 다시 그리면 새로 누른 칸이 사라져 키보드가 닫혔다 —
    // 포커스가 옮겨 간 뒤 다시 그리고, 같은 칸에 포커스를 돌려준다
    setTimeout(() => {
      const f = document.activeElement, fc = f && f.closest && f.closest("#spkPanel .cl");
      const sel = fc && f.dataset.a ? `#spkPanel .cl[data-c="${CSS.escape(fc.dataset.c)}"] [data-a="${f.dataset.a}"]` : null;
      renderReview();
      const g = sel && $(sel);
      if (g) g.focus({ preventScroll: true });
    }, 0);
  }
  if (t.dataset.a === "inc") {
    // 읽고 고치고 쓰기를 한 번에(일꾼이 같은 작업을 고치는 사이에 끼어도 서로 덮지 않게). 지워진 작업은 되살리지 않는다
    const jid = REVIEW.id, on = t.checked, had = !!REVIEW.data.result;
    const j = await S.update("jobs", jid, (job) => {
      if (!job) return undefined;
      const skip = new Set(job.skip || []);
      if (on) skip.delete(id); else skip.add(id);
      const halt = had && job.status === "완료"
        ? { status: "중지", progress: { pct: 0, msg: on ? "더할 발언이 있습니다 — 이어서 처리" : "뺀 묶음이 있습니다 — 이어서 처리" } } : {};
      return { ...job, skip: [...skip], ...halt, updatedAt: S.now() };
    });
    if (!j) { toast("이 녹음은 지워졌습니다"); showTab("jobs"); return; }
    if (had) await clearRv(jid); // 발언이 더해지거나 빠지므로 옛 검수·내보내기 표시는 맞지 않음
    if (REVIEW.id !== jid) return;
    REVIEW.data.job.skip = j.skip; REVIEW.data.job.status = j.status;
    if (had && on) toast("홈의 녹음 카드에서 「이어서 처리」를 누르면 이 묶음의 발언을 전사해 더합니다");
    if (had && !on) toast("이 묶음을 내보내기에서 빼려면 홈의 녹음 카드에서 「이어서 처리」를 눌러 결과를 다시 만드세요");
    renderPanel(); renderNamesStep();
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
  if (a === "split2" || a === "go") { // 두 번 눌러 두 번 나누거나 전사를 두 번 걸지 않게
    if (PANEL_BUSY) return;
    PANEL_BUSY = true;
    try { await (a === "split2" ? splitTwo(c) : startTranscribe()); } catch (e) { toast(e.message); } finally { PANEL_BUSY = false; }
    return;
  }
  if (a === "vp") return saveSonyPrints();
});

let PANEL_BUSY = false;
// 두 사람이 쉼 없이 주고받아 한 묶음이 된 경우 — 이름 대기 중에만
async function splitTwo(c) {
  const jid = REVIEW.id, ci = clustersOf().indexOf(c);
  const vp = Object.fromEntries(await S.all("voiceprints"));
  if (REVIEW.id !== jid) return;
  const nd = splitCluster(REVIEW.diar, ci, knownPrints(vp, REVIEW.data.job.speakers));
  if (!nd) { toast("이 묶음은 더 나눌 수 없습니다(말한 구간이 너무 적음)"); return; }
  pushUndo(REVIEW.diar);
  REVIEW.diar = nd;
  await S.put("chunks", jid, nd);
  const neu = nd.clusters[nd.clusters.length - 1];
  renderReview();
  toast(`${c.label} 묶음을 둘로 나눴습니다 — 새로 생긴 ${neu.label}의 대표 구간을 들어 보세요(되돌리기 가능)`);
}
async function startTranscribe() {
  const gid = REVIEW.id;
  const unnamed = clustersOf().filter((x) => !REVIEW.names[x.id] && !(REVIEW.data.job.skip || []).includes(x.id)).length;
  if (unnamed && !confirm(`이름 없는 묶음이 ${unnamed}개 있습니다. 그대로 전사할까요? (이름은 전사 뒤에도 지정할 수 있습니다)`)) return;
  saveEdits(); await flushEdits();
  if (!(await S.saveJob(gid, { stage: "transcribe", status: "대기", progress: { pct: 0, msg: "전사 대기" } }))) { toast("이 녹음은 지워졌습니다"); showTab("jobs"); return; }
  kick(); toast("전사를 시작합니다 — 홈에서 진행 상황을 볼 수 있습니다");
  await showTab("jobs"); flashJob(gid);
}
async function saveSonyPrints() {
  const d = REVIEW.data;
  if (!REVIEW.diar || REVIEW.diar.kind !== "diar") { toast("이 녹음은 목소리 특징이 남아 있지 않아(백업에서 되살린 경우 등) 저장할 수 없습니다"); return; }
  // 나눈 발언은 조각 화자가 둘 이상이면 목소리 기준에서 뺀다(섞인 목소리로 기준이 흐려지지 않게), 모두 같으면 그 사람
  const nameOf = (g) => {
    const base = speakerOf(g, { e: REVIEW.edits, names: REVIEW.names }), parts = REVIEW.edits[g.i] && REVIEW.edits[g.i].parts;
    if (!parts || !parts.length) return base;
    const who = new Set(parts.map((p) => p.speaker || base));
    return who.size === 1 ? [...who][0] : "";
  };
  const prints = printsFromReview(d.result.segs, REVIEW.diar.units, nameOf, isGeneric);
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
  toast(`목소리 기준을 ${list.length}명 저장했습니다`);
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
    <div class="chips">${chips.map((n) => `<button type="button" class="chip" data-n="${esc(n)}">${esc(n)}</button>`).join("")}</div>
    <label class="opt"><input type="radio" name="popScope" value="one" ${clusterNamed ? "checked" : ""}> 이 발언만</label>
    <label class="opt"><input type="radio" name="popScope" value="all" ${clusterNamed ? "" : "checked"}> 이 묶음(${esc(clusterLabel(g.cluster))}) 전체</label>
    <label class="opt"><input type="radio" name="popScope" value="after"> 이 묶음에서 이 발언부터 끝까지</label>
    ${REVIEW.edits[g.i] && REVIEW.edits[g.i].speaker ? '<button type="button" class="link" data-a="reset">따로 지정 풀기(묶음 이름으로)</button>' : ""}
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
    if (!v) { toast("이름을 넣어 주세요"); REVIEW.undo.pop(); updUndo(); return; }
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
  }).join("") : '<tr><td colspan="4" class="empty">저장된 목소리 기준이 없습니다. Plaud 녹음을 처리하거나, 검수 화면의 「화자 이름 지정」에서 「목소리 기준 저장」을 누르면 쌓입니다.</td></tr>';
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
    const to = (prompt("새 이름(이미 있는 이름이면 그 사람과 합쳐집니다)", n) || "").trim();
    if (!to || to === n) return;
    const v = await S.get("voiceprints", n), w = await S.get("voiceprints", to);
    await S.put("voiceprints", to, w ? { ...w, items: { ...w.items, ...v.items }, updatedAt: S.now() } : { ...v, name: to, updatedAt: S.now() });
    await S.del("voiceprints", n);
  }
  loadVoices();
});

/* ================================================================== 교정 사전 */
// 바른 표기별 카드. 꼴마다 상태(확정·추천·후보·꺼짐)와 근거(고친 발언 수·녹음 수·적용·되돌림·고치지 않고 확인)를 보인다.
const GL = { tab: "on" };
const GL_TABS = [["on", "확정"], ["rec", "추천"], ["cand", "후보"], ["off", "꺼짐"]];
async function loadGlossary() {
  const lex = await getLex(), conf = conflicts(lex);
  const groupOf = (t, v) => (v.st === "on" ? "on" : v.st === "off" ? "off" : judge(lex, t, v, conf).rec ? "rec" : "cand");
  const cnt = { on: 0, rec: 0, cand: 0, off: 0 };
  for (const t of lex.terms) for (const v of t.vars) cnt[groupOf(t, v)]++;
  if (!cnt[GL.tab]) GL.tab = cnt.rec ? "rec" : cnt.on ? "on" : cnt.cand ? "cand" : cnt.off ? "off" : "on";
  $("#glTabs").innerHTML = GL_TABS.map(([k, n]) => `<button type="button" role="tab" data-gt="${k}" aria-selected="${GL.tab === k}" class="${GL.tab === k ? "on" : ""}"${cnt[k] ? "" : " disabled"}>${n} <b>${cnt[k]}</b></button>`).join("");
  const why = { on: "검수 화면 표시와 내보내기에 적용됩니다.", rec: "서로 다른 발언 2곳 이상에서 같게 고친 말(Plaud 대조까지 더하면 3곳 이상)입니다. 확정하면 바로 적용됩니다.",
    cand: "한 번 고쳤거나 확인이 필요한 말입니다(이름·흔한 낱말·충돌). 자동으로 바꾸지 않습니다.", off: "적용하지 않는 말입니다. 근거는 남아 있어 다시 켤 수 있습니다." }[GL.tab];
  const cards = [];
  for (const t of [...lex.terms].sort((a, b) => a.to.localeCompare(b.to, "ko"))) {
    const vs = t.vars.filter((v) => groupOf(t, v) === GL.tab);
    if (!vs.length) continue;
    const rows = vs.map((v) => {
      const j = judge(lex, t, v, conf), s = j.s;
      const ev = [s.jobs ? `녹음 ${s.jobs}건` : "", s.n ? `고침 ${s.n}` : "", s.app ? `적용 ${s.app}` : "", s.undo ? `되돌림 ${s.undo}` : "", s.neg ? `고치지 않고 확인 ${s.neg}` : "", s.pl ? `Plaud 대조 ${s.pl}` : "", v.manual ? (v.src ? `기본 사전(${v.src})` : "직접 넣음") : ""].filter(Boolean).join(" · ");
      const tags = [j.conflict ? '<span class="chip warn">충돌</span>' : "", j.common && v.st !== "on" ? '<span class="chip">흔한 낱말</span>' : "", v.when ? `<span class="chip">조건: 뒤에 ${v.when.map(esc).join("·")}</span>` : "", v.why ? `<span class="chip bad">${esc(v.why)}</span>` : ""].join("");
      const acts = v.st === "on" ? '<button type="button" data-g="when">조건</button><button type="button" data-g="off">끄기</button>'
        : v.st === "off" ? `<button type="button" data-g="on">다시 켜기</button>${s.n || s.app || s.undo || s.neg ? "" : '<button type="button" data-g="del">지우기</button>'}`
        : `<button type="button" class="primary" data-g="on">${j.common && whenOf(v).length ? "조건 붙여 확정" : "확정"}</button><button type="button" data-g="off">넣지 않기</button>`;
      const ex = Object.values(v.by || {}).some((b) => b.ex && b.ex.length) ? '<button type="button" data-g="ex">예문</button>' : "";
      return `<div class="vrow" data-from="${esc(v.from)}"><div class="vf"><span class="from">${esc(v.from)}</span><span class="to">→ ${esc(t.to)}</span>${tags}</div><div class="vn">${ev || "근거 없음"}</div><div class="vb">${ex}${acts}</div><div class="vex hidden"></div></div>`;
    }).join("");
    const hint = GL.tab === "on" ? `<label class="chk ghint" title="설정에서 「전사 힌트」를 켜면 다음 녹음 전사에 이 말을 미리 알려 줍니다"><input type="checkbox" data-g="hint"${t.hint === false ? "" : " checked"}> 전사 힌트</label>` : "";
    cards.push(`<div class="term" data-to="${esc(t.to)}"><div class="hd"><b>${esc(t.to)}</b>${t.kind === "name" ? '<span class="chip">이름</span>' : ""}<span class="spacer"></span>${hint}</div>${rows}</div>`);
  }
  $("#glWhy").textContent = why;
  $("#glList").innerHTML = cards.length ? cards.join("") : '<p class="empty">아직 없습니다. 발언 검수에서 잘못 들린 말을 고치면 여기에 후보가 모입니다. 「＋ 직접 넣기」로 바로 넣을 수도 있습니다.</p>';
}
$("#glTabs").addEventListener("click", (ev) => { const b = ev.target.closest("button[data-gt]"); if (!b) return; GL.tab = b.dataset.gt; loadGlossary(); });
// 기본 사전(web/lexicon-seed.json — tools/lexicon_seed.mjs): 실제 녹취에서 확인된 오인식. 실제 낱말인 꼴은 「후보」로 들어가 사람이 확정
$("#glSeed").addEventListener("click", async () => {
  try {
    const r = await fetch("lexicon-seed.json", { cache: "no-cache" });
    if (!r.ok) throw new Error("기본 사전 파일을 읽지 못했습니다");
    const seed = await r.json();
    let added = 0;
    setLex(await lexUpdate((l) => { const m = mergeLex(l, seed); added = m.added; return m.lex; }));
    GL.tab = "on"; loadGlossary(); menuCounts();
    toast(added ? `기본 사전 ${added}개를 넣었습니다 — 실제 낱말인 말은 「후보」에서 확정하세요` : "기본 사전은 이미 모두 들어 있습니다");
  } catch (e) { toast(e.message); }
});
$("#glAdd").addEventListener("click", () => { $("#glNew").classList.toggle("hidden"); if (!$("#glNew").classList.contains("hidden")) $("#glFrom").focus(); });
$("#glAddGo").addEventListener("click", async () => {
  const from = $("#glFrom").value.trim(), to = $("#glTo").value.trim();
  if (!from || !to) { toast("잘못 적힌 말과 바로잡을 말을 모두 넣어 주세요"); return; }
  if (from === to) { toast("두 말이 같습니다"); return; }
  const lex = await lexUpdate((l) => addManual(l, from, to));
  setLex(lex);
  $("#glFrom").value = ""; $("#glTo").value = ""; $("#glNew").classList.add("hidden");
  GL.tab = "on"; loadGlossary(); menuCounts();
  toast(`「${from} → ${to}」${josa(to, "을/를").slice(to.length)} 넣었습니다`);
});
$("#glList").addEventListener("change", async (ev) => {
  if (!ev.target.matches("input[data-g='hint']")) return;
  const to = ev.target.closest(".term").dataset.to, on = ev.target.checked;
  await lexUpdate((l) => { const t = l.terms.find((x) => x.to === to); if (t) t.hint = on; return l; });
});
$("#glList").addEventListener("click", async (ev) => {
  const b = ev.target.closest("button[data-g]");
  if (!b) return;
  const row = b.closest(".vrow"), to = b.closest(".term").dataset.to, from = row.dataset.from, g = b.dataset.g;
  if (g === "ex") { await showExamples(row, to, from); return; }
  if (g === "when") {
    const cur = await getLex(), v = cur.terms.find((x) => x.to === to)?.vars.find((x) => x.from === from);
    const ans = prompt(`「${from}」 바로 뒤에 이 말이 올 때만 바꿉니다(쉼표로 여럿, 비우면 늘 바꿈)`, ((v && v.when) || whenOf(v || {})).join(", "));
    if (ans == null) return;
    const when = ans.split(/[,，·\s]+/).map((x) => x.trim()).filter(Boolean);
    setLex(await lexUpdate((l) => setVar(l, to, from, "on", when)));
    loadGlossary(); return;
  }
  const lex = await lexUpdate((l) => {
    if (g === "del") { const t = l.terms.find((x) => x.to === to); if (t) t.vars = t.vars.filter((x) => x.from !== from); l.terms = l.terms.filter((x) => x.vars.length); return l; }
    const t = l.terms.find((x) => x.to === to), v = t && t.vars.find((x) => x.from === from);
    if (!v) return l;
    return setVar(l, to, from, g, g === "on" && v.st !== "off" && judge(l, t, v).common ? whenOf(v) : undefined);
  });
  setLex(lex); loadGlossary(); menuCounts();
  toast(g === "on" ? "확정했습니다 — 검수 화면과 내보내기에 바로 쓰입니다" : g === "off" ? "껐습니다" : "지웠습니다");
});
/** 예문: 고친 발언(녹음별 5곳까지) — 누르면 그 녹음의 그 발언으로 */
async function showExamples(row, to, from) {
  const box = $(".vex", row);
  if (!box.classList.contains("hidden")) { box.classList.add("hidden"); return; }
  const lex = await getLex(), v = lex.terms.find((x) => x.to === to)?.vars.find((x) => x.from === from);
  const out = [];
  for (const [jid, b] of Object.entries((v && v.by) || {})) {
    if (!b.ex || !b.ex.length) continue;
    const [job, res] = await Promise.all([S.get("jobs", jid), S.get("results", jid)]);
    if (!job || !res) continue;
    for (const i of b.ex) {
      const g = res.segs.find((x) => String(x.i) === String(i));
      if (!g) continue;
      const k = g.text.indexOf(from), a = Math.max(0, k - 20), t = k < 0 ? esc(g.text.slice(0, 60)) : `${a ? "…" : ""}${esc(g.text.slice(a, k))}<mark>${esc(from)}</mark>${esc(g.text.slice(k + from.length, k + from.length + 24))}`;
      out.push(`<button type="button" class="link exl" data-job="${esc(jid)}" data-i="${esc(i)}"><small>${esc(job.title)} · ${hms(g.start)}</small> ${t}</button>`);
    }
  }
  box.innerHTML = out.length ? out.join("") : '<span class="msg">예문을 찾지 못했습니다(녹음이 지워졌을 수 있음)</span>';
  box.classList.remove("hidden");
}
$("#glList").addEventListener("click", (ev) => {
  const b = ev.target.closest("button.exl");
  if (!b) return;
  REVIEW.want = b.dataset.job; REVIEW.focusI = b.dataset.i; REVIEW.filter = "all"; REVIEW.only = null; REVIEW.editedOnly = false;
  showTab("review");
});

/* ================================================================== 설정·백업 */
async function loadSettings() {
  const set = (await S.get("kv", "settings")) || {};
  $("#threads").value = set.threads || 0;
  $("#hintOn").checked = !!set.hint;
  const dev = await detectDevice();
  const auto = dev.level;
  $("#gpuLevel").innerHTML = `<option value="auto">자동(권장) → ${esc(levelLabel(auto))}</option>` + LEVELS.map((l) => `<option value="${l.v}">${esc(l.label)}</option>`).join("");
  $("#gpuLevel").value = typeof set.gpuLevel === "number" ? String(set.gpuLevel) : set.gpu === false ? "0" : "auto";
  // 한 줄로: 기기 · 그래픽 칩 → 자동 단계(근거는 말풍선으로)
  $("#devInfo").textContent = `이 기기: ${[dev.name || dev.model, dev.gpu].filter(Boolean).join(" · ") || "알 수 없음"} → 자동: ${levelLabel(auto)}`;
  $("#devInfo").title = `근거: ${dev.basis}`;
  renderLevelNow();
  showBenchPrev().catch(() => {});
  worker && worker.postMessage({ type: "status" });
  try {
    const est = await navigator.storage.estimate();
    const persisted = navigator.storage.persisted ? await navigator.storage.persisted() : false;
    $("#storeState").innerHTML = `이 사이트가 쓰는 공간 ${(est.usage / 1073741824).toFixed(2)}GB / 쓸 수 있는 공간 ${(est.quota / 1073741824).toFixed(0)}GB · ${persisted ? "영구 보관 켜짐" : "영구 보관 꺼짐(공간이 부족하면 브라우저가 지울 수 있음)"}`;
  } catch { /* 없음 */ }
}
$("#btnModels").addEventListener("click", () => { if (!worker) return; worker.postMessage({ type: "download" }); toast("모델을 받기 시작했습니다"); });
$("#btnClearModels").addEventListener("click", async () => {
  if (!confirm("받아 둔 모델을 지울까요? 다음 처리 때 다시 받습니다.")) return;
  for (const k of await caches.keys()) if (k.startsWith("pb-models") || k.startsWith("pb-m-")) await caches.delete(k);
  if (worker) worker.terminate(); WSTATE.models = null; WSTATE.busy = false; startWorker(); toast("모델을 지웠습니다");
});
/* 기기 성능 시험: 그래픽 칩(WebGPU) 지원은 화면 쪽에서, 단계별 속도는 일꾼에서 잰다 */
async function gpuInfo() {
  try {
    if (!navigator.gpu) return { ok: false, why: "이 브라우저에 WebGPU 없음" };
    const ad = await navigator.gpu.requestAdapter({ powerPreference: "high-performance" });
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
    row("1시간 회의 어림", `화자 분리 약 ${sec(r.estDiar)} · 전사 약 ${sec(r.estTr)}`),
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
  if (WSTATE.busy) { $("#benchMsg").textContent = "녹음을 처리하는 동안에는 시험할 수 없습니다."; return; }
  $("#btnBench").disabled = true; $("#benchMsg").classList.remove("err");
  $("#benchMsg").textContent = "그래픽 칩 확인 중…";
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
$("#hintOn").addEventListener("change", async () => {
  const on = $("#hintOn").checked;
  await S.put("kv", "settings", { ...((await S.get("kv", "settings")) || {}), hint: on });
  toast(on ? "다음 전사부터 교정 사전의 확정 말을 힌트로 넣습니다" : "전사 힌트를 껐습니다");
});
$("#btnThreads").addEventListener("click", async () => {
  await S.put("kv", "settings", { ...((await S.get("kv", "settings")) || {}), threads: Math.max(0, Math.min(32, +$("#threads").value || 0)) });
  toast("페이지를 새로 고친 뒤부터 적용됩니다");
});
// 백업: 기본은 암호를 걸어(backup.js — AES-256-GCM·PBKDF2) 내려받는다. 속 내용 형식(plaud-booster-backup v2)은 그대로
async function backupObject() {
  const jobs = {};
  for (const [id, job] of await S.all("jobs")) {
    jobs[id] = { job, result: await S.get("results", id), edits: await S.get("edits", id), plaud: await S.get("plaud", id) };
  }
  const lexicon = await getLex();
  // glossary(확정 꼴을 펼친 쌍 목록)는 예전 판이 읽도록 계속 넣고, 교정 사전 전체(근거 포함)는 lexicon에(2026-10-12~)
  return { format: PLAIN_FORMAT, version: 2, exportedAt: S.now(), voiceprints: Object.fromEntries(await S.all("voiceprints")),
    glossary: toPairs(lexicon), lexicon, jobs };
}
let BK_BUSY = false;
$("#btnBackup").addEventListener("click", async () => {
  const pw = $("#bkPw").value, pw2 = $("#bkPw2").value;
  if (pw.length < MIN_PW) { toast(`암호를 ${MIN_PW}자 이상 넣어 주세요`); $("#bkPw").focus(); return; }
  if (pw !== pw2) { toast("두 칸의 암호가 다릅니다"); $("#bkPw2").focus(); return; }
  if (BK_BUSY) return;
  BK_BUSY = true; $("#btnBackup").disabled = true;
  try {
    const enc = await encryptBackup(await backupObject(), pw);
    download(backupName(), new Blob([JSON.stringify(enc)], { type: "application/json" }));
    $("#bkPw").value = ""; $("#bkPw2").value = "";
    toast("암호를 걸어 내려받았습니다 — 암호를 잊으면 되살릴 수 없습니다");
  } catch (e) { toast("백업 실패: " + e.message); }
  finally { BK_BUSY = false; $("#btnBackup").disabled = false; }
});
$("#btnBackupPlain").addEventListener("click", async () => {
  if (!confirm("암호 없이 내려받으면 파일을 연 사람 누구나 전사 글과 이름을 읽을 수 있습니다. 그래도 내려받을까요?")) return;
  download(backupName(new Date(), true), new Blob([JSON.stringify(await backupObject())], { type: "application/json" }));
});
let RS_PENDING = null; // 암호를 기다리는 올린 백업
async function restoreBackup(bk) {
  if (bk.format !== PLAIN_FORMAT) throw new Error("이 앱의 백업 파일이 아닙니다");
  if (bk.version > 2) throw new Error("이 화면보다 새 판에서 만든 백업입니다. 페이지를 새로 고친 뒤 다시 올려 주세요.");
  const lex = await getLex();
  const cur = { voiceprints: Object.fromEntries(await S.all("voiceprints")), glossary: toPairs(lex), lexicon: lex, jobIds: new Set((await S.all("jobs")).map(([k]) => k)) };
  const m = mergeBackup(cur, bk);
  for (const [name, v] of Object.entries(m.voiceprints)) await S.put("voiceprints", name, v);
  await lexUpdate(() => m.lexicon);
  for (const [id, j] of Object.entries(m.jobs)) {
    await S.put("jobs", id, j.job);
    if (j.result) await S.put("results", id, j.result);
    if (j.edits) await S.put("edits", id, j.edits);
    if (j.plaud) await S.put("plaud", id, j.plaud);
  }
  $("#restoreMsg").textContent = `합쳐 넣음 — 목소리 기준 ${m.added.voiceprints}건, 교정 사전 ${m.added.glossary}건, 녹음 ${m.added.jobs}건`;
}
$("#restoreFile").addEventListener("change", async (ev) => {
  const f = ev.target.files[0];
  ev.target.value = "";
  if (!f) return;
  RS_PENDING = null; $("#rsPwRow").classList.add("hidden");
  try {
    let bk;
    try { bk = JSON.parse(await f.text()); } catch { throw new Error("이 앱의 백업 파일이 아닙니다"); }
    if (isEncrypted(bk)) {
      RS_PENDING = bk;
      $("#rsPwRow").classList.remove("hidden"); $("#rsPw").value = ""; $("#rsPw").focus();
      $("#restoreMsg").textContent = `🔒 암호 걸린 백업입니다(${f.name}) — 암호를 넣고 「풀어서 합치기」를 누르세요`;
      return;
    }
    await restoreBackup(bk);
  } catch (e) { $("#restoreMsg").textContent = "실패: " + e.message; }
});
async function restoreEncrypted() {
  if (!RS_PENDING || BK_BUSY) return;
  BK_BUSY = true; $("#rsGo").disabled = true;
  $("#restoreMsg").textContent = "푸는 중…";
  try {
    const bk = await decryptBackup(RS_PENDING, $("#rsPw").value);
    await restoreBackup(bk);
    RS_PENDING = null; $("#rsPw").value = ""; $("#rsPwRow").classList.add("hidden");
  } catch (e) { $("#restoreMsg").textContent = "실패: " + e.message; $("#rsPw").select(); }
  finally { BK_BUSY = false; $("#rsGo").disabled = false; }
}
$("#rsGo").addEventListener("click", restoreEncrypted);
$("#rsPw").addEventListener("keydown", (e) => { if (e.key === "Enter") restoreEncrypted(); });

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
  loadExOpts().catch(() => {});
  const start = (location.hash || "#jobs").slice(1);
  // 홈 밖 화면 주소로 바로 열어도 그 아래에 홈 칸을 깔아 둔다(뒤로 가기 → 홈)
  history.replaceState({ home: 1 }, "", location.pathname + location.search + "#jobs");
  showTab(["jobs", "review", "voices", "glossary", "settings"].includes(start) ? start : "jobs");
  setInterval(() => { if ($("#tab-jobs").classList.contains("on")) loadJobs(); }, 5000);
})();

/* ================================================================== 구간 손보기(이름 대기 중)
 * 1 구간 정하기(파형 끌기·손잡이·⏱ 지금·±0.2초) → 2 누구 말인지(기존 묶음·새 사람·빼기) → 3 비슷한 곳(들어 보고 고른 것만 옮김).
 * 규칙은 diar.js(relabelRange·similarRegions·mixSuspects). 되돌리기는 손보기 전 화자 분리 결과를 다시 저장한다. */
const RG = { open: false };
const fmt1 = (t) => { const d = Math.max(0, Math.floor((t || 0) * 10 + 1e-6)) / 10, h = Math.floor(d / 3600), m = Math.floor((d % 3600) / 60), s = d - h * 3600 - m * 60; return `${h ? h + ":" + String(m).padStart(2, "0") : m}:${s < 10 ? "0" : ""}${s.toFixed(1)}`; }; // 0.1초 내림
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
  RG.ret = document.activeElement; // 닫을 때 포커스를 돌려줄 곳(누른 「✂ 손보기」)
  $("#rgSheet").classList.remove("hidden");
  document.body.classList.add("rg-open");
  rgRender();
  $("#rgSheet .rg-in").focus({ preventScroll: true });
  await rgPeaks();
}
// 보이는 범위(vs~ve)의 파형 — 범위가 넓어지면 다시 읽는다(옛 파형을 늘려 그리면 시각이 어긋남)
async function rgPeaks() {
  const { f, vs, ve } = RG;
  RG.peaks = null;
  try {
    const x = await S.readAudio(REVIEW.id, f, vs, ve);
    const n = 400, step = Math.max(1, Math.floor(x.length / n)), pk = new Float32Array(n);
    for (let k = 0; k < n; k++) { let m = 0; for (let j = k * step; j < Math.min(x.length, (k + 1) * step); j += 2) { const v = Math.abs(x[j]); if (v > m) m = v; } pk[k] = m; }
    const top = Math.max(1e-4, ...pk); for (let k = 0; k < n; k++) pk[k] /= top;
    if (RG.open && RG.f === f && RG.vs === vs && RG.ve === ve) { RG.peaks = pk; rgDraw(); }
  } catch (err) { toast("파형을 읽지 못했습니다: " + err.message); }
}
function closeRange() {
  RG.open = false;
  if (STOP.at != null && !player.paused) player.pause(); // 구간 듣기 중에 닫으면 멈춤(안 그러면 끝없이 이어 재생)
  stopClear();
  $("#rgSheet").classList.add("hidden");
  document.body.classList.remove("rg-open");
  // 누른 단추로 포커스를 돌려준다. 화면을 다시 그려 그 단추가 없어졌으면 같은 구간의 단추로
  const r = RG.ret; RG.ret = null;
  const back = r && r.isConnected ? r : r && r.dataset && r.dataset.s ? $(`#spkPanel button[data-a="rg"][data-s="${CSS.escape(r.dataset.s)}"]`) : null;
  if (back) back.focus({ preventScroll: true });
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
  g.fillStyle = css.getPropertyValue("--bg") || "#F7F4EF"; g.fillRect(0, 0, w, h);
  // 위 띠: 지금 묶음(사람이 정한 곳은 진하게)
  for (const t of REVIEW.diar.turns) {
    if ((t.f || 0) !== RG.f || t.e <= RG.vs || t.s >= RG.ve) continue;
    g.globalAlpha = t.m ? 1 : 0.75; g.fillStyle = t.c >= 0 ? PAL[t.c % 8] : "#9aa0a8";
    g.fillRect(X(t.s), 0, Math.max(1, X(t.e) - X(t.s)), 9);
  }
  g.globalAlpha = 1;
  // 고른 구간
  g.fillStyle = "rgba(185,91,59,.16)"; g.fillRect(X(RG.s), 10, X(RG.e) - X(RG.s), h - 10);
  // 파형
  if (RG.peaks) {
    const n = RG.peaks.length, bw = w / n, mid = (h + 10) / 2, amp = (h - 30) / 2;
    g.fillStyle = css.getPropertyValue("--mute") || "#6F6358";
    for (let k = 0; k < n; k++) { const v = Math.max(0.5, RG.peaks[k] * amp); g.fillRect(k * bw, mid - v, Math.max(1, bw - 0.6), 2 * v); }
  } else { g.fillStyle = css.getPropertyValue("--mute"); g.font = "12px system-ui"; g.fillText("파형 읽는 중…", 8, h / 2); }
  // 손잡이
  g.fillStyle = "#B95B3B";
  for (const t of [RG.s, RG.e]) { const x = X(t); g.fillRect(x - 1.5, 10, 3, h - 10); g.beginPath(); g.roundRect(x - 10, h - 24, 20, 24, 4); g.fill(); }
  g.strokeStyle = "#fff"; g.lineWidth = 1.6;
  for (const t of [RG.s, RG.e]) { const x = X(t); g.beginPath(); g.moveTo(x - 3, h - 17); g.lineTo(x - 3, h - 7); g.moveTo(x + 3, h - 17); g.lineTo(x + 3, h - 7); g.stroke(); }
  // 재생 위치
  if (TL.loaded === RG.f) { const p = player.currentTime; if (p >= RG.vs && p <= RG.ve) { g.fillStyle = cssBad(css); g.fillRect(X(p) - 1, 0, 2, h); } }
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
    if (!d.moved) { const go = !player.paused; tlTake(); seekPlay(RG.f, tOf(ev), go); } // 앞 구간 끝 멈춤을 지우고 옮김
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
  const set = (k, v) => { RG[k] = Math.round(Math.max(0, Math.min(dur, v)) * 10) / 10; if (RG.e - RG.s < 0.2) { if (k === "s") RG.s = RG.e - 0.2; else RG.e = RG.s + 0.2; } const vs = Math.min(RG.vs, RG.s), ve = Math.max(RG.ve, RG.e), wide = vs !== RG.vs || ve !== RG.ve; RG.vs = vs; RG.ve = ve; rgRender(); if (wide) rgPeaks(); };
  if (a === "close") { closeRange(); return; }
  if (a === "s-") set("s", RG.s - 0.2); if (a === "s+") set("s", RG.s + 0.2);
  if (a === "e-") set("e", RG.e - 0.2); if (a === "e+") set("e", RG.e + 0.2);
  if (a === "snow" || a === "enow") { if (now == null) { toast("재생하는 중에 누르세요"); return; } set(a[0], now); }
  if (a === "play") playRange(RG.f, RG.s, RG.e);
  if (a === "playctx") playRange(RG.f, Math.max(0, RG.s - 2), RG.e + 2);
  if (RG.busy) return; // 두 번 눌러 두 번 옮기지 않게
  if (a === "apply") {
    RG.busy = true;
    try { await rgApply(); } finally { RG.busy = false; }
    return;
  }
  if (a === "moveSim") {
    RG.busy = true;
    try { await rgMoveSim(); } finally { RG.busy = false; }
  }
});
async function rgApply() {
  {
    const known = await rgKnown();
    const res = relabelRange(REVIEW.diar, RG.f, RG.s, RG.e, RG.target, known);
    if (!res) { toast("이 구간에서는 말소리를 찾지 못했습니다"); return; }
    pushUndo(REVIEW.diar);
    REVIEW.diar = res.diar;
    await S.put("chunks", REVIEW.id, res.diar);
    renderReview();
    const toName = res.to >= 0 ? rgNameOf(res.to) : "빼기";
    const sim = $("#rgFind").checked && res.to >= 0 && res.from >= 0 && res.from !== res.to ? similarRegions(res.diar, res.from, res.to) : [];
    if (!sim.length) { closeRange(); toast(`${fmt1(RG.s)}~${fmt1(RG.e)} → ${toName} (되돌리기 가능)${$("#rgFind").checked && res.to >= 0 ? " · 비슷한 곳은 없었습니다" : ""}`); return; }
    Object.assign(RG, { simToId: res.diar.clusters[res.to].id, simFromId: res.diar.clusters[res.from].id, sim });
    $("#rgDone").textContent = `✓ ${fmt1(RG.s)}~${fmt1(RG.e)} → ${toName} (되돌리기 가능)`;
    $("#rgSimT").textContent = `${toName} 목소리와 닮은 곳 ${sim.length}곳 (${Math.round(sim.reduce((m, r) => m + r.e - r.s, 0))}초)`;
    $("#rgSimH").textContent = `${rgNameOf(res.from)} 묶음에 들어 있지만 방금 고른 목소리에 더 가까운 곳입니다. 들어 보고 맞는 곳만 고르세요.`;
    $("#rgSimList").innerHTML = sim.map((r, k) => `<label class="sim"><input type="checkbox" data-k="${k}" ${r.sim >= 0.7 ? "checked" : ""}>
      <button type="button" class="play" data-ps="${r.s}" data-pe="${r.e}" title="듣기">▶</button>
      <span class="tt">${fmt1(r.s)}~${fmt1(r.e)} <small>(${(r.e - r.s).toFixed(1)}초)</small></span><span class="pc${r.sim < 0.7 ? " lo" : ""}">${Math.round(r.sim * 100)}%</span></label>`).join("");
    $("#rgEdit").classList.add("hidden"); $("#rgSim").classList.remove("hidden");
    $$("#rgSheet .flow span").forEach((x) => x.classList.toggle("on", x.dataset.st === "3"));
    rgSimCount();
  }
}
// 비슷한 곳 옮기기: 옮길 때마다 빈 묶음이 지워져 번호가 당겨질 수 있으므로 묶음은 id로 찾는다.
// 원래 묶음(from)의 차례만 옮긴다 — 곳 사이에 낀 다른 사람의 짧은 말은 건드리지 않음
async function rgMoveSim() {
  const pick = $$("#rgSimList input:checked").map((x) => RG.sim[+x.dataset.k]);
  if (!pick.length) { closeRange(); return; }
  const known = await rgKnown();
  const ix = (d, id) => d.clusters.findIndex((c) => c.id === id);
  let d = REVIEW.diar, n = 0;
  for (const r of pick) {
    const to = ix(d, RG.simToId), from = ix(d, RG.simFromId);
    if (to < 0 || from < 0) break;
    const res = relabelRange(d, r.f, r.s, r.e, to, known, { ref: false, only: from });
    if (res) { d = res.diar; n++; }
  }
  if (!n) { closeRange(); return; }
  pushUndo(REVIEW.diar); // 다 끝낸 뒤에 되돌리기 자리를 만든다(중간에 실패해도 반쯤 바뀐 상태가 남지 않게)
  REVIEW.diar = d;
  await S.put("chunks", REVIEW.id, d);
  renderReview(); closeRange();
  const to = ix(d, RG.simToId);
  toast(`${n}곳을 ${to >= 0 ? josa(rgNameOf(to), "으로/로") + " " : ""}옮겼습니다(되돌리기 가능)`);
}
function rgSimCount() { const n = $$("#rgSimList input:checked").length; const b = $("#rgSheet [data-rg='moveSim']"); b.textContent = n ? `고른 ${n}곳 옮기기` : "닫기"; }
$("#rgSimList").addEventListener("change", rgSimCount);
