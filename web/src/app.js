// 감사 녹취 작업대 — 화면 (빌드 없음). 처리는 worker.js, 저장은 store.js.
import * as S from "./store.js";
import { parse as parseTranscript } from "./plaud.js";
import { decodeFile, wavBlob, embeddedTime } from "./audio.js";
import { exportTxt, exportCsv, mergeBackup, speakerOf, hms as hmsLong, MODE_LABEL, SOURCE_LABEL, sourceOf, isDiar } from "./export.js";
import { orderFiles, printsFromReview, recordedAt } from "./diar.js";
import { isGeneric } from "./engine.js";

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const MULTI = (m) => m === "fragment" || isDiar(m);
const jobKind = (j) => `${SOURCE_LABEL[sourceOf(j)]} · ${MODE_LABEL[j.mode] || j.mode}`;
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
  worker.onmessage = (ev) => {
    const m = ev.data;
    if (m.type === "hello") { WSTATE.owner = m.owner; worker.postMessage({ type: "status" }); kick(); }
    if (m.type === "status") { Object.assign(WSTATE, m); renderSys(); }
    if (m.type === "models") {
      if (m.phase === "download") WSTATE.dl = m;
      if (m.phase === "load") WSTATE.dl = { ...(WSTATE.dl || {}), loading: true };
      if (m.phase === "ready") { WSTATE.dl = null; WSTATE.threads = m.threads; worker.postMessage({ type: "status" }); }
      renderSys();
    }
    if (m.type === "job") { wakeLock(true); if ($("#tab-jobs").classList.contains("on")) loadJobs(); if (m.done) toast("작업이 끝났습니다"); }
    if (m.type === "idle") { wakeLock(false); loadJobs(); }
    if (m.type === "error") toast(m.message);
  };
}
const kick = () => worker && worker.postMessage({ type: "kick" });
let lock = null;
async function wakeLock(on) {
  try {
    if (on && !lock && navigator.wakeLock) { lock = await navigator.wakeLock.request("screen"); lock.addEventListener("release", () => { lock = null; }); }
    if (!on && lock) { await lock.release(); lock = null; }
  } catch { /* 지원 안 함 */ }
}

function renderSys() {
  const m = WSTATE.models;
  let eng;
  if (WSTATE.fake) eng = '<span class="bad">시험용 가짜 엔진</span>';
  else if (!m) eng = "엔진 확인 중";
  else if (WSTATE.dl && !WSTATE.dl.loading) eng = `모델 받는 중 ${Math.round((WSTATE.dl.got / WSTATE.dl.total) * 100)}%`;
  else if (WSTATE.dl && WSTATE.dl.loading) eng = "모델 여는 중";
  else if (m.ready) eng = '<span class="ok">엔진 준비됨</span>';
  else eng = `<span class="bad">모델 없음</span> (받은 양 ${Math.round((m.cachedBytes / Math.max(1, m.totalBytes)) * 100)}%)`;
  const th = WSTATE.threads ? ` · 스레드 ${WSTATE.threads}` : "";
  $("#sysline").innerHTML = `${eng}${th}` + (WSTATE.coi ? "" : ' · <span class="bad">스레드 꺼짐(느림)</span>') + (WSTATE.owner ? "" : ' · <span class="bad">다른 탭에서 처리 중</span>');
  $("#engState").innerHTML = eng + (m && !m.ready && !WSTATE.fake ? "<br><small>모델을 받아 두면 대기 중인 작업이 바로 시작됩니다. 작업을 등록하면 자동으로 받습니다.</small>" : "");
  const pct = WSTATE.dl && WSTATE.dl.total ? (WSTATE.dl.got / WSTATE.dl.total) * 100 : m ? (m.cachedBytes / Math.max(1, m.totalBytes)) * 100 : 0;
  $("#dlBar").style.width = (WSTATE.fake ? 100 : pct) + "%";
  $("#btnModels").disabled = !!(m && m.ready) || !!WSTATE.dl || WSTATE.fake;
}

/* ================================================================== 탭 */
$$(".tabs button").forEach((b) => b.addEventListener("click", () => showTab(b.dataset.tab)));
function showTab(name) {
  $$(".tabs button").forEach((x) => x.classList.toggle("on", x.dataset.tab === name));
  $$(".tab").forEach((x) => x.classList.toggle("on", x.id === "tab-" + name));
  history.replaceState(null, "", location.pathname + location.search + "#" + name);
  if (name === "jobs") loadJobs();
  if (name === "review") loadReviewJobs();
  if (name === "voices") loadVoices();
  if (name === "glossary") loadGlossary();
  if (name === "settings") loadSettings();
}

/* ================================================================== 새 작업 */
// 1. 녹음 출처(Plaud · 소니 녹음기 · 휴대폰·기타) → 2. 출처에 맞는 할 일 → 3. 파일 → 4. Plaud 전사(Plaud만) → 5. 참석자 → 6. 이름·고지
const F = { audio: [], tr: null, voices: [], picked: new Set() };
const source = () => ($('input[name="source"]:checked') || {}).value || "";
const mode = () => ($('input[name="mode"]:checked') || {}).value || "";
const DEFAULT_TASK = { plaud: "gap", sony: "diar", phone: "diar" };

$("#btnNew").addEventListener("click", async () => {
  resetForm();
  $("#newJob").classList.remove("hidden");
  $("#btnNew").classList.add("hidden");
  F.voices = (await S.all("voiceprints")).map(([name]) => name);
  renderChips();
});
$("#btnCancel").addEventListener("click", () => { $("#newJob").classList.add("hidden"); $("#btnNew").classList.remove("hidden"); });
function resetForm() {
  $("#newJob").reset();
  F.audio = []; F.tr = null; F.picked = new Set();
  $("#audioList").innerHTML = ""; $("#trInfo").innerHTML = ""; $("#spkMap").innerHTML = ""; $("#gapTape").classList.add("hidden");
  setMsg("");
  applyMode();
}
function setMsg(t, err = false) { $("#formMsg").textContent = t; $("#formMsg").classList.toggle("err", err); }
$$('input[name="source"]').forEach((r) => r.addEventListener("change", () => {
  const src = source(), cur = $('input[name="mode"]:checked');
  const ok = cur && cur.closest(".mode").dataset.src === (src === "plaud" ? "plaud" : "dev");
  if (!ok) $(`input[name="mode"][value="${DEFAULT_TASK[src]}"]`).checked = true;
  applyMode();
}));
$$('input[name="mode"]').forEach((r) => r.addEventListener("change", applyMode));
$("#isCall").addEventListener("change", () => { if ($("#isCall").checked) $("#attendees").value = 2; });
function applyMode() {
  const src = source(), m = mode(), dev = src && src !== "plaud";
  $("#fsTask").classList.toggle("hidden", !src);
  $$("#fsTask .mode").forEach((l) => l.classList.toggle("hidden", !src || l.dataset.src !== (dev ? "dev" : "plaud")));
  $$("#newJob .after-src").forEach((f) => f.classList.toggle("hidden", !src));
  $("#callWrap").classList.toggle("hidden", !(src === "phone" && isDiar(m)));
  if (!src) return;
  $("#audioFiles").multiple = MULTI(m);
  $("#audioHint").textContent = src === "sony" ? "MP3·WAV 여러 개 가능 — 파일 이름의 녹음 시각 순으로 자동 정렬"
    : src === "phone" ? "m4a·mp3·wav 등 여러 개 가능 — 녹음 시각(파일 이름 → 파일 정보 → 저장 시각) 순으로 자동 정렬"
      : "Plaud에서 내려받은 음원(MP3) 1개";
  $("#fsRange").classList.toggle("hidden", m !== "range");
  $("#fsSpeakers").classList.toggle("hidden", m === "enroll");
  $("#fsTranscript").classList.toggle("hidden", dev);
  $("#spkLegend").textContent = isDiar(m) ? "참석자(선택)" : "화자 후보";
  $("#spkHint").textContent = isDiar(m) ? "고르면 그 사람들의 목소리 기준으로만 이름을 추천합니다. 인원 수는 묶음이 지나치게 많아지지 않게 하는 데만 씁니다."
    : m === "fragment" ? "고르지 않으면 저장된 사람 전원 중에서 맞힙니다" : "고르지 않으면 저장된 사람 전원 + 이 회의 전사의 사람 중에서 맞힙니다";
  $("#attWrap").classList.toggle("hidden", !isDiar(m));
  $("#useVpWrap").classList.toggle("hidden", isDiar(m));
  // 단계 번호: Plaud는 4번이 전사 파일, 다른 출처는 전사 파일 단계가 없다
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
  for (const a of F.audio) { a.dur = await mediaDuration(a.file); renderAudioList(); }
  if (source() !== "plaud") { await stampTimes(); if (MULTI(mode())) F.audio = orderFiles(F.audio); renderAudioList(); }
  drawTape();
});
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
    transcript: tr ? { name: tr.name, count: tr.segs.length, endSec: tr.endSec } : null,
    transcriptEndSec: tr ? tr.endSec : 0, range, speakerMap: speakerMap(), speakers: [...F.picked],
    useVoiceprints: $("#useVp").checked, note: $("#jobNote").value.trim(), progress: { pct: 0, msg: "음원 준비 중" },
    ...(isDiar(m) ? { attendees: ($("#isCall").checked && src === "phone" ? 2 : att) || null, call: $("#isCall").checked && src === "phone", stage: "diar", skip: [] } : {}),
  };
  $("#btnSubmit").disabled = true;
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
  } finally { $("#btnSubmit").disabled = false; }
});

/* ================================================================== 작업 목록 */
let JOBS = [];
async function jobsList() {
  const rows = await S.all("jobs");
  const res = new Set((await S.all("results")).map(([k]) => k));
  return rows.map(([id, j]) => ({ ...j, id, hasResult: res.has(id) })).sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}
async function loadJobs() {
  JOBS = await jobsList();
  const el = $("#jobList");
  if (!JOBS.length) { el.innerHTML = '<p class="empty">아직 작업이 없습니다. 「새 작업」으로 시작하세요.</p>'; return; }
  el.innerHTML = JOBS.map((j) => {
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
      ${busy ? `<div class="prog"><span class="pbar"><i data-w="${p.pct || 0}"></i></span><span>${p.pct || 0}% · ${esc(p.msg || "")}</span></div>` : ""}
    </div>`;
  }).join("");
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
const REVIEW = { id: null, want: null, data: null, edits: {}, filter: "need", saveT: null, gl: [] };
async function loadReviewJobs() {
  JOBS = await jobsList();
  const done = JOBS.filter((j) => (j.hasResult && j.mode !== "enroll") || j.status === "이름 대기");
  const sel = $("#rvJob");
  sel.innerHTML = done.length ? done.map((j) => `<option value="${esc(j.id)}">${esc(j.title)} (${esc(jobKind(j))}${j.status === "이름 대기" ? " · 이름 대기" : ""})</option>`).join("") : '<option value="">검수할 결과가 없습니다</option>';
  const id = REVIEW.want && done.some((j) => j.id === REVIEW.want) ? REVIEW.want : REVIEW.id && done.some((j) => j.id === REVIEW.id) ? REVIEW.id : done[0]?.id;
  REVIEW.want = null;
  if (id) { sel.value = id; await openReview(id); } else { $("#rvBody").innerHTML = ""; $("#rvStats").innerHTML = ""; $("#spkPanel").classList.add("hidden"); }
}
$("#rvJob").addEventListener("change", (e) => openReview(e.target.value));
$$(".seg button").forEach((b) => b.addEventListener("click", () => { $$(".seg button").forEach((x) => x.classList.toggle("on", x === b)); REVIEW.filter = b.dataset.f; renderReview(); }));
$("#rvPlaud").addEventListener("change", renderReview);
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
  REVIEW.diar = isDiar(REVIEW.data.job.mode) ? await S.get("chunks", id) : null;
  const plaudish = REVIEW.data.job.mode === "gap" || REVIEW.data.job.mode === "range";
  $("#rvPlaudWrap").classList.toggle("hidden", !plaudish);
  $("#exPlaudWrap").classList.toggle("hidden", !plaudish);
  REVIEW.vpNames = (await S.all("voiceprints")).map(([n]) => n);
  REVIEW.page = {};
  $("#rvSave").textContent = "";
  renderReview();
}
const gloss = (t) => { for (const p of REVIEW.gl || []) if (p.from) t = t.split(p.from).join(p.to); return t; };
const isNeed = (g) => {
  if (g.cluster) { // 소니 녹음: 이름 없는 묶음 · 묶음과 덜 닮음 · 다른 묶음과 차이 작음 · 2초 미만
    const named = (REVIEW.edits[g.i] && REVIEW.edits[g.i].speaker) || (REVIEW.names[g.cluster] && !isGeneric(REVIEW.names[g.cluster]));
    return !named || g.conf < 0.5 || g.margin < 0.1 || g.end - g.start < 2;
  }
  return g.kind !== "단일" || g.conf < 0.6;
};
function renderReview() {
  const d = REVIEW.data;
  if (!d) return;
  renderPanel();
  const sony = isDiar(d.job.mode);
  $("#rvMain").classList.toggle("hidden", !d.result);
  if (!d.result) { $("#rvStats").innerHTML = ""; $("#rvBody").innerHTML = ""; return; }
  const segs = d.result.segs, s = d.result.stats, job = d.job, smap = job.speakerMap || {};
  const names = new Set(s.speakersUsed || []);
  segs.forEach((g) => { if (g.kind === "단일") names.add(g.speaker); });
  Object.values(REVIEW.edits).forEach((e) => e.speaker && names.add(e.speaker));
  Object.values(REVIEW.names).forEach((n) => n && names.add(n));
  const nameList = [...names].sort((a, b) => a.localeCompare(b, "ko"));
  const checked = Object.values(REVIEW.edits).filter((e) => e.ok).length;
  const multi = (s.files || []).length > 1;
  $("#rvStats").innerHTML = (sony ? [["발언", s.segments], ["확인 필요", segs.filter(isNeed).length], ["화자 묶음", s.clusters], ["전사 제외", s.skipped], ["환각 제거", s.droppedHallucination], ["검수 완료", checked]]
    : [["발언", s.segments], ["확인 필요", segs.filter(isNeed).length], ["혼재", s.mixed], ["미상", s.unknown], ["저신뢰", s.lowConf], ["환각 제거", s.droppedHallucination], ["검수 완료", checked]])
    .map(([k, v]) => `<span class="stat"><b>${v ?? 0}</b>${k}</span>`).join("")
    + (s.targets ? `<span class="stat">대상 ${s.targets.map((t) => (multi ? t.file + 1 + "번 " : "") + hms(t.from) + "~" + hms(t.to)).join(", ")}</span>` : "");
  let rows = segs.map((g) => ({ g, e: REVIEW.edits[g.i] || {} }));
  const f = REVIEW.filter;
  if (f === "need") rows = rows.filter((r) => isNeed(r.g) && !r.e.ok);
  if (f === "edited") rows = rows.filter((r) => r.e.speaker || r.e.text);
  if (REVIEW.only) rows = rows.filter((r) => r.g.cluster === REVIEW.only);
  if (f === "todo") rows = rows.filter((r) => !r.e.ok);
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
  $("#rvBody").innerHTML = items.map((it) => {
    if (it.p) return `<tr class="plaud"><td class="c-t">${hms(it.p.start)}</td><td></td><td>${esc(smap[it.p.speaker] || it.p.speaker)}</td><td>${esc(gloss(it.p.text))}</td><td><span class="msg">Plaud</span></td><td></td></tr>`;
    const { g, e } = it.r;
    const spk = speakerOf(g, { e: REVIEW.edits, names: REVIEW.names });
    if (sony) {
      const ci = clusterIndex(g.cluster), why = [];
      if (g.conf < 0.5) why.push("묶음과 덜 닮음");
      if (g.margin < 0.1) why.push("다른 묶음과 비슷");
      if (g.end - g.start < 2) why.push("짧음");
      return `<tr data-i="${g.i}" class="${e.speaker || e.text ? "edited" : ""}">
      <td class="c-t">${(multi ? `<small>${(g.file || 0) + 1}번</small> ` : "") + hms(g.start)}</td>
      <td>${canPlay ? `<button type="button" class="play" title="듣기" data-s="${g.start}" data-e="${g.end}" data-f="${g.file || 0}">▶</button>` : ""}</td>
      <td><button type="button" class="spkbtn cc${ci % 8}${e.speaker ? " own" : ""}" title="${esc(clusterLabel(g.cluster))}${e.speaker ? " · 이 발언만 따로 지정" : ""}">${esc(spk)}</button></td>
      <td><textarea rows="2" aria-label="발언">${esc(e.text ?? gloss(g.text))}</textarea></td>
      <td><span class="kind ${why.length ? "k-저신뢰" : "k-단일"}">${esc(clusterLabel(g.cluster).replace("Speaker ", "S"))} ${Math.round(g.conf * 100)}%</span><span class="votes">${esc(why.join(" · "))}</span></td>
      <td class="c-ok"><input type="checkbox" class="ok" ${e.ok ? "checked" : ""} title="검수 완료" aria-label="검수 완료"></td></tr>`;
    }
    const kl = g.kind === "단일" && g.conf < 0.6 ? "저신뢰" : g.kind;
    const votes = Object.entries(g.votes || {}).slice(0, 3).map(([k, v]) => `${k} ${Math.round(v * 100)}%`).join(" · ");
    const opts = (nameList.includes(spk) ? nameList : [spk, ...nameList]).map((n) => `<option ${n === spk ? "selected" : ""}>${esc(n)}</option>`).join("") + '<option value="__new">직접 입력…</option>';
    return `<tr data-i="${g.i}" class="${e.speaker || e.text ? "edited" : ""}">
      <td class="c-t">${(multi ? `<small>${(g.file || 0) + 1}번</small> ` : "") + hms(g.start)}</td>
      <td>${canPlay ? `<button type="button" class="play" title="듣기" data-s="${g.start}" data-e="${g.end}" data-f="${g.file || 0}">▶</button>` : ""}</td>
      <td><select class="spk" aria-label="화자">${opts}</select></td>
      <td><textarea rows="2" aria-label="발언">${esc(e.text ?? gloss(g.text))}</textarea></td>
      <td><span class="kind k-${kl}">${kl} ${Math.round(g.conf * 100)}%</span><span class="votes">${esc(votes)}</span></td>
      <td class="c-ok"><input type="checkbox" class="ok" ${e.ok ? "checked" : ""} title="검수 완료" aria-label="검수 완료"></td></tr>`;
  }).join("");
  $$("#rvBody textarea").forEach((t) => { t.style.height = "auto"; t.style.height = t.scrollHeight + 2 + "px"; });
}
const editOf = (i) => (REVIEW.edits[i] = REVIEW.edits[i] || {});
$("#rvBody").addEventListener("change", (ev) => {
  const tr = ev.target.closest("tr[data-i]");
  if (!tr) return;
  const i = tr.dataset.i, g = REVIEW.data.result.segs.find((x) => String(x.i) === i);
  if (ev.target.matches("select.spk")) {
    pushUndo();
    let v = ev.target.value;
    if (v === "__new") { v = (prompt("화자 이름") || "").trim(); if (!v) { renderReview(); return; } }
    const e = editOf(i);
    if (v === g.speaker) delete e.speaker; else e.speaker = v;
    e.ok = true;
  } else if (ev.target.matches("textarea")) {
    pushUndo();
    const e = editOf(i), v = ev.target.value.trim();
    if (v === gloss(g.text).trim()) delete e.text; else e.text = v;
  } else if (ev.target.matches("input.ok")) editOf(i).ok = ev.target.checked;
  tr.classList.toggle("edited", !!(REVIEW.edits[i].speaker || REVIEW.edits[i].text));
  saveEdits();
});
function saveEdits() {
  $("#rvSave").textContent = "저장 대기…";
  clearTimeout(REVIEW.saveT);
  const id = REVIEW.id;
  REVIEW.saveT = setTimeout(async () => {
    try { await S.put("edits", id, { e: REVIEW.edits, names: REVIEW.names, updatedAt: S.now() }); $("#rvSave").textContent = "저장됨 " + new Date().toLocaleTimeString("ko-KR"); }
    catch (e) { $("#rvSave").textContent = "저장 실패: " + e.message; }
  }, 400);
}
const player = $("#player");
let playingRow = null;
async function playClip(b, f, s, e) {
  const row = b.closest("tr, .smp > div");
  if (playingRow === row && !player.paused) { player.pause(); return; }
  if (REVIEW.data.job.audioDeleted) { toast("음원을 지운 작업입니다"); return; }
  try {
    const pcm = await S.readAudio(REVIEW.id, f, Math.max(0, s - 0.3), e + 0.3);
    if (player.src) URL.revokeObjectURL(player.src);
    player.src = URL.createObjectURL(wavBlob(pcm));
    await player.play();
    $$(".playing").forEach((x) => x.classList.remove("playing"));
    playingRow = row; row.classList.add("playing");
  } catch (err) { toast("재생 실패: " + err.message); }
}
$("#rvBody").addEventListener("click", (ev) => {
  const b = ev.target.closest("button.play");
  if (b) playClip(b, +b.dataset.f, +b.dataset.s, +b.dataset.e);
});
player.addEventListener("ended", () => playingRow && playingRow.classList.remove("playing"));
player.addEventListener("pause", () => playingRow && playingRow.classList.remove("playing"));
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

function pushUndo() {
  REVIEW.undo.push(JSON.stringify({ e: REVIEW.edits, names: REVIEW.names }));
  if (REVIEW.undo.length > 100) REVIEW.undo.shift();
  $("#spUndo") && ($("#spUndo").disabled = false);
}
function undo() {
  const last = REVIEW.undo.pop();
  if (!last) { toast("되돌릴 것이 없습니다"); return; }
  const v = JSON.parse(last);
  REVIEW.edits = v.e; REVIEW.names = v.names;
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
  if (!d || !isDiar(d.job.mode)) { el.classList.add("hidden"); return; }
  el.classList.remove("hidden");
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
        ${pending ? "" : `<button type="button" class="link" data-a="only">${REVIEW.only === c.id ? "모두 보기" : "이 묶음만 보기"}</button>`}</div>
      <div class="nm"><input data-a="name" list="dlNames" value="${esc(nm)}" placeholder="이름(예: 김○○ 팀장)" aria-label="${esc(c.label)} 이름"> ${sug}
        ${same.length ? `<span class="merged">↳ ${esc(same.join(", "))}와 같은 사람(합쳐짐)</span>` : ""}</div>
      <div class="smp">${smp.map((x) => `<div><button type="button" class="play" data-a="play" data-f="${x.f}" data-s="${x.s}" data-e="${x.e}" title="듣기">▶</button>
        <span class="msg">${(d.job.audioFiles || []).length > 1 ? x.f + 1 + "번 " : ""}${hms(x.s)}~${hms(x.e)} (${Math.round(x.e - x.s)}초)</span> <span class="tx">${esc(textNear(x.f, x.s).slice(0, 90))}</span></div>`).join("") || '<span class="msg">들어 볼 구간 없음</span>'}
        ${(c.samples || []).length > per ? `<button type="button" class="link" data-a="more">다른 구간 ▸ ${page + 1}/${Math.ceil(c.samples.length / per)}</button>` : ""}</div>
    </div>`;
  }).join("");
  const info = REVIEW.diar && REVIEW.diar.kind === "diar" ? REVIEW.diar : (d.result && d.result.stats) || {};
  const notes = [];
  if (info.narrow) notes.push(`전화 음질(4kHz 위가 비어 있음, 대역 비 ${info.band}dB)로 판단해 목소리 묶기 기준을 높였습니다. 같은 사람이 여러 묶음으로 나뉠 수 있으니 같은 이름을 붙여 합치세요.`);
  if (info.vadFallback) notes.push("이 녹음은 말소리 모델이 말소리를 거의 찾지 못해 음량 기준으로 말소리를 찾았습니다(잡음이 크거나 전화 음질인 녹음).");
  el.innerHTML = `${notes.map((n) => `<p class="banner info">${esc(n)}</p>`).join("")}<div class="bar"><h3>화자 묶음 ${cl.length}개</h3><span class="msg">${pending ? "대표 구간을 들어 보고 이름을 붙이세요. 같은 이름을 붙이면 한 사람으로 합쳐집니다. 이름은 전사 뒤에도 바꿀 수 있습니다." : "이름을 바꾸면 그 묶음 발언 전체에 적용됩니다(발언별로 따로 지정한 것은 그대로)."}</span>
      <span class="spacer"></span>
      ${strong.length ? `<button type="button" data-a="sugall">추천 ${strong.length}건 모두 적용</button>` : ""}
      <button type="button" id="spUndo" data-a="undo" ${REVIEW.undo.length ? "" : "disabled"} title="Ctrl+Z / ⌘Z">되돌리기</button>
      ${pending ? `<button type="button" class="primary" data-a="go" ${d.job.status === "이름 대기" ? "" : "disabled"}>이 이름으로 전사 시작</button>`
        : `<button type="button" data-a="vp" title="이름 붙인 사람의 목소리를 다음 녹음에서 추천하도록 저장합니다(30초 이상 말한 사람만)">목소리 기준 저장</button>`}</div>
    <div class="clgrid">${cards}</div>
    <datalist id="dlNames">${names.map((n) => `<option value="${esc(n)}">`).join("")}</datalist>`;
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
  if (a === "play") return playClip(b, +b.dataset.f, +b.dataset.s, +b.dataset.e);
  if (a === "more") { REVIEW.page[id] = ((REVIEW.page[id] || 0) + 1) % Math.ceil(c.samples.length / 2); renderPanel(); return; }
  if (a === "only") { REVIEW.only = REVIEW.only === id ? null : id; if (REVIEW.only) { $$(".seg button").forEach((x) => x.classList.toggle("on", x.dataset.f === "all")); REVIEW.filter = "all"; } renderReview(); return; }
  if (a === "sug") { pushUndo(); REVIEW.names[id] = c.suggest.name; saveEdits(); renderReview(); return; }
  if (a === "sugall") { pushUndo(); clustersOf().forEach((x) => { if (x.suggest && x.suggest.strong && !REVIEW.names[x.id]) REVIEW.names[x.id] = x.suggest.name; }); saveEdits(); renderReview(); return; }
  if (a === "undo") return undo();
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
      <td class="src">${items.map(([src, it]) => `<div>${esc(src)} (${it.n})<button type="button" data-src="${esc(src)}" title="이 출처만 빼기">빼기</button></div>`).join("")}</td>
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
