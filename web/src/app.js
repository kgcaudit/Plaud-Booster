// Plaud 보강 작업대 — 화면 (빌드 없음). 처리는 worker.js, 저장은 store.js.
import * as S from "./store.js";
import { parse as parseTranscript } from "./plaud.js";
import { decodeFile, wavBlob } from "./audio.js";
import { exportTxt, exportCsv, mergeBackup, hms as hmsLong } from "./export.js";

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const MODE_LABEL = { gap: "누락 구간 보충", range: "지정 구간 재전사", fragment: "조각 음원 화자 매칭", enroll: "목소리 기준 등록" };
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
const F = { audio: [], tr: null, voices: [], picked: new Set() };
const mode = () => $('input[name="mode"]:checked').value;

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
$$('input[name="mode"]').forEach((r) => r.addEventListener("change", applyMode));
function applyMode() {
  const m = mode();
  $("#audioFiles").multiple = m === "fragment";
  $("#audioHint").textContent = m === "fragment" ? "MP3·WAV·M4A 여러 개 가능 — 녹음 순서대로 고르세요" : "MP3·WAV·M4A 1개";
  $("#fsRange").classList.toggle("hidden", m !== "range");
  $("#fsSpeakers").classList.toggle("hidden", m === "enroll");
  $("#fsTranscript").classList.toggle("hidden", m === "fragment");
  $("#trHint").textContent = m === "gap" || m === "enroll" ? "필수 — Plaud에서 TXT·SRT·DOCX로 내보낸 파일(타임스탬프·화자 켜기)"
    : "권장 — 같은 녹음의 전사가 있으면 그 사람들 목소리로 화자를 맞힙니다";
  drawTape();
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
  F.audio = [...ev.target.files].map((file) => ({ file, dur: null }));
  renderAudioList();
  for (const a of F.audio) { a.dur = await mediaDuration(a.file); renderAudioList(); }
  drawTape();
});
function renderAudioList() {
  $("#audioList").innerHTML = F.audio.map((a, i) => `<li><span>${i + 1}. ${esc(a.file.name)}</span>
    <span class="msg">${(a.file.size / 1048576).toFixed(1)}MB${a.dur ? " · 길이 " + hms(a.dur) : ""}</span>
    <span class="pbar"><i data-w="${Math.round((a.prog || 0) * 100)}"></i></span></li>`).join("");
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
  if (mode() === "fragment" || !a || !a.dur || !F.tr) { tape.classList.add("hidden"); return; }
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
  const m = mode();
  if (!F.audio.length) return setMsg("음원을 골라 주세요.", true);
  if (m !== "fragment" && F.audio.length !== 1) return setMsg("이 유형은 음원 1개만 받습니다.", true);
  if ((m === "gap" || m === "enroll") && !F.tr) return setMsg("Plaud 전사 파일이 필요합니다.", true);
  let range = null;
  if (m === "range") {
    const a = parseHms($("#rFrom").value), b = parseHms($("#rTo").value);
    if (!(b > a)) return setMsg("구간을 「1:04:00」처럼 넣어 주세요(끝이 시작보다 뒤).", true);
    range = { from: a, to: b };
  }
  const id = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14) + "-" + Math.random().toString(36).slice(2, 6);
  const tr = m !== "fragment" ? F.tr : null;
  const job = {
    title: $("#jobTitle").value.trim() || F.audio[0].file.name.replace(/\.[^.]+$/, ""),
    mode: m, status: "준비", createdAt: S.now(), audioFiles: [],
    transcript: tr ? { name: tr.name, count: tr.segs.length, endSec: tr.endSec } : null,
    transcriptEndSec: tr ? tr.endSec : 0, range, speakerMap: speakerMap(), speakers: [...F.picked],
    useVoiceprints: $("#useVp").checked, note: $("#jobNote").value.trim(), progress: { pct: 0, msg: "음원 준비 중" },
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
        job.audioFiles.push({ name: a.file.name, dur });
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
    const result = j.hasResult && j.mode !== "enroll" ? `발언 ${s.segments ?? "-"} · 혼재 ${s.mixed ?? 0} · 미상 ${s.unknown ?? 0} · 저신뢰 ${s.lowConf ?? 0} · 환각 제거 ${s.droppedHallucination ?? 0}` : "";
    const enrolled = s.enrolled && Object.keys(s.enrolled).length ? (result ? " · " : "") + "기준 등록 " + Object.keys(s.enrolled).join(", ") : "";
    const files = (j.audioFiles || []).map((f) => f.name + (f.dur ? ` (${hms(f.dur)})` : "")).join(", ");
    return `<div class="job" data-id="${esc(j.id)}">
      <div><span class="t">${esc(j.title)}</span><span class="badge st-${esc(j.status)}">${esc(j.status)}</span>
        <div class="meta">${MODE_LABEL[j.mode] || j.mode} · ${esc(files)}${j.range ? " · " + hms(j.range.from) + "~" + hms(j.range.to) : ""} · ${esc((j.createdAt || "").replace("T", " ").slice(0, 16))}${j.audioDeleted ? " · 음원 지움" : ""}</div>
        ${result || enrolled ? `<div class="meta">${result}${enrolled}</div>` : ""}
        ${j.error ? `<div class="meta err">${esc(j.error)}</div>` : ""}
      </div>
      <div class="acts">
        ${j.hasResult && j.mode !== "enroll" ? '<button type="button" data-a="review" class="primary">검수</button>' : ""}
        ${busy && j.status !== "준비" ? '<button type="button" data-a="stop">중지</button>' : ""}
        ${!busy && j.status !== "완료" && !j.audioDeleted ? '<button type="button" data-a="resume">이어서 처리</button>' : ""}
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
      if (!confirm("결과를 지우고 처음부터 다시 처리할까요? 검수 수정 내용은 남지만 발언 번호가 바뀔 수 있습니다.")) return;
      await S.resetJob(id); await S.saveJob(id, { status: "대기", error: null, stats: null, progress: { pct: 0, msg: "대기" } }); kick();
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
  const done = JOBS.filter((j) => j.hasResult && j.mode !== "enroll");
  const sel = $("#rvJob");
  sel.innerHTML = done.length ? done.map((j) => `<option value="${esc(j.id)}">${esc(j.title)} (${MODE_LABEL[j.mode]})</option>`).join("") : '<option value="">검수할 결과가 없습니다</option>';
  const id = REVIEW.want && done.some((j) => j.id === REVIEW.want) ? REVIEW.want : REVIEW.id && done.some((j) => j.id === REVIEW.id) ? REVIEW.id : done[0]?.id;
  REVIEW.want = null;
  if (id) { sel.value = id; await openReview(id); } else { $("#rvBody").innerHTML = ""; $("#rvStats").innerHTML = ""; }
}
$("#rvJob").addEventListener("change", (e) => openReview(e.target.value));
$$(".seg button").forEach((b) => b.addEventListener("click", () => { $$(".seg button").forEach((x) => x.classList.toggle("on", x === b)); REVIEW.filter = b.dataset.f; renderReview(); }));
$("#rvPlaud").addEventListener("change", renderReview);
async function reviewData(id) {
  const [job, result, edits, plaud, gl] = await Promise.all([S.get("jobs", id), S.get("results", id), S.get("edits", id), S.get("plaud", id), S.get("kv", "glossary")]);
  return { job: { ...job, id }, result, edits: edits || { e: {} }, plaud: plaud || [], glossary: (gl && gl.pairs) || [] };
}
async function openReview(id) {
  REVIEW.id = id;
  REVIEW.data = await reviewData(id);
  REVIEW.edits = REVIEW.data.edits.e || {};
  REVIEW.gl = REVIEW.data.glossary;
  $("#rvSave").textContent = "";
  renderReview();
}
const gloss = (t) => { for (const p of REVIEW.gl || []) if (p.from) t = t.split(p.from).join(p.to); return t; };
const isNeed = (g) => g.kind !== "단일" || g.conf < 0.6;
function renderReview() {
  const d = REVIEW.data;
  if (!d) return;
  const segs = d.result.segs, s = d.result.stats, job = d.job, smap = job.speakerMap || {};
  const names = new Set(s.speakersUsed || []);
  segs.forEach((g) => { if (g.kind === "단일") names.add(g.speaker); });
  Object.values(REVIEW.edits).forEach((e) => e.speaker && names.add(e.speaker));
  const nameList = [...names].sort((a, b) => a.localeCompare(b, "ko"));
  const checked = Object.values(REVIEW.edits).filter((e) => e.ok).length;
  const multi = (s.files || []).length > 1;
  $("#rvStats").innerHTML = [["발언", s.segments], ["확인 필요", segs.filter(isNeed).length], ["혼재", s.mixed], ["미상", s.unknown], ["저신뢰", s.lowConf], ["환각 제거", s.droppedHallucination], ["검수 완료", checked]]
    .map(([k, v]) => `<span class="stat"><b>${v ?? 0}</b>${k}</span>`).join("")
    + (s.targets ? `<span class="stat">대상 ${s.targets.map((t) => (multi ? t.file + 1 + "번 " : "") + hms(t.from) + "~" + hms(t.to)).join(", ")}</span>` : "");
  let rows = segs.map((g) => ({ g, e: REVIEW.edits[g.i] || {} }));
  const f = REVIEW.filter;
  if (f === "need") rows = rows.filter((r) => isNeed(r.g) && !r.e.ok);
  if (f === "edited") rows = rows.filter((r) => r.e.speaker || r.e.text);
  if (f === "todo") rows = rows.filter((r) => !r.e.ok);
  const items = rows.map((r) => ({ t: r.g.start, file: r.g.file || 0, r }));
  if ($("#rvPlaud").checked && job.mode !== "fragment") {
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
    const spk = e.speaker || g.speaker;
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
    let v = ev.target.value;
    if (v === "__new") { v = (prompt("화자 이름") || "").trim(); if (!v) { renderReview(); return; } }
    const e = editOf(i);
    if (v === g.speaker) delete e.speaker; else e.speaker = v;
    e.ok = true;
  } else if (ev.target.matches("textarea")) {
    const e = editOf(i), v = ev.target.value.trim();
    if (v === gloss(g.text).trim()) delete e.text; else e.text = v;
  } else if (ev.target.matches("input.ok")) editOf(i).ok = ev.target.checked;
  tr.classList.toggle("edited", !!(REVIEW.edits[i].speaker || REVIEW.edits[i].text));
  $("#rvSave").textContent = "저장 대기…";
  clearTimeout(REVIEW.saveT);
  REVIEW.saveT = setTimeout(async () => {
    try { await S.put("edits", REVIEW.id, { e: REVIEW.edits, updatedAt: S.now() }); $("#rvSave").textContent = "저장됨 " + new Date().toLocaleTimeString("ko-KR"); }
    catch (e) { $("#rvSave").textContent = "저장 실패: " + e.message; }
  }, 500);
});
const player = $("#player");
let playingRow = null;
$("#rvBody").addEventListener("click", async (ev) => {
  const b = ev.target.closest("button.play");
  if (!b) return;
  const row = b.closest("tr");
  if (playingRow === row && !player.paused) { player.pause(); return; }
  try {
    const pcm = await S.readAudio(REVIEW.id, +b.dataset.f, Math.max(0, +b.dataset.s - 0.3), +b.dataset.e + 0.3);
    if (player.src) URL.revokeObjectURL(player.src);
    player.src = URL.createObjectURL(wavBlob(pcm));
    await player.play();
    $$("#rvBody tr.playing").forEach((x) => x.classList.remove("playing"));
    playingRow = row; row.classList.add("playing");
  } catch (e) { toast("재생 실패: " + e.message); }
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

/* ================================================================== 목소리 기준 */
async function loadVoices() {
  const vs = (await S.all("voiceprints")).sort((a, b) => a[0].localeCompare(b[0], "ko"));
  $("#vpBody").innerHTML = vs.length ? vs.map(([name, v]) => {
    const items = Object.entries(v.items || {});
    const n = items.reduce((m, [, it]) => m + it.n, 0);
    return `<tr data-n="${esc(name)}"><td><b>${esc(name)}</b></td><td>${n}</td>
      <td class="src">${items.map(([src, it]) => `<div>${esc(src)} (${it.n})<button type="button" data-src="${esc(src)}" title="이 출처만 빼기">빼기</button></div>`).join("")}</td>
      <td class="nowrap"><button type="button" data-a="ren">이름 바꾸기·합치기</button> <button type="button" data-a="del">지우기</button></td></tr>`;
  }).join("") : '<tr><td colspan="4" class="empty">저장된 목소리 기준이 없습니다. Plaud 전사(화자 이름 포함)가 있는 작업을 처리하면 자동으로 쌓입니다.</td></tr>';
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
  for (const k of await caches.keys()) if (k.startsWith("pb-models")) await caches.delete(k);
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
  const bk = { format: "plaud-booster-backup", version: 1, exportedAt: S.now(), voiceprints: Object.fromEntries(await S.all("voiceprints")),
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
