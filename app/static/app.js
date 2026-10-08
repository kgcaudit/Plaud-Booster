"use strict";
/* Plaud 보강 작업대 — 화면 스크립트 (빌드 없음) */

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const CHUNK = 8 * 1024 * 1024;
const MODE_LABEL = { gap: "누락 구간 보충", range: "지정 구간 재전사", fragment: "조각 음원 화자 매칭", enroll: "목소리 기준 등록" };

function hms(t) {
  t = Math.max(0, Math.round(t || 0));
  const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = t % 60;
  return (h ? h + ":" + String(m).padStart(2, "0") : String(m)) + ":" + String(s).padStart(2, "0");
}
function parseHms(s) {
  s = String(s || "").trim();
  if (!s) return NaN;
  return s.split(":").reduce((a, p) => a * 60 + Number(p), 0);
}
async function api(path, opt = {}) {
  const o = { ...opt, headers: { ...(opt.headers || {}) } };
  if (o.json !== undefined) { o.body = JSON.stringify(o.json); o.headers["Content-Type"] = "application/json"; delete o.json; }
  const r = await fetch(path, o);
  const ct = r.headers.get("content-type") || "";
  const data = ct.includes("json") ? await r.json() : await r.text();
  if (!r.ok) throw new Error((data && data.error) || data.detail || r.statusText);
  return data;
}
let toastT;
function toast(msg) {
  const t = $("#toast"); t.textContent = msg; t.classList.add("on");
  clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove("on"), 2600);
}

/* ---------------- tabs ---------------- */
$$(".tabs button").forEach((b) => b.addEventListener("click", () => showTab(b.dataset.tab)));
function showTab(name) {
  $$(".tabs button").forEach((x) => x.classList.toggle("on", x.dataset.tab === name));
  $$(".tab").forEach((x) => x.classList.toggle("on", x.id === "tab-" + name));
  location.hash = name;
  if (name === "review") loadReviewJobs();
  if (name === "voices") loadVoices();
  if (name === "glossary") loadGlossary();
  if (name === "settings") loadSystem();
}

/* ---------------- system line ---------------- */
let SYS = {};
async function loadSystem() {
  try { SYS = await api("/api/system"); } catch { $("#sysline").innerHTML = '<span class="bad">서버 연결 끊김</span>'; return; }
  const st = SYS.setup || {};
  let eng;
  if (SYS.fake) eng = '<span class="bad">시험용 가짜 엔진</span>';
  else if (SYS.modelsReady) eng = '<span class="ok">엔진 준비됨</span>';
  else if (st.running) eng = "모델 준비 중: " + esc(st.msg);
  else eng = '<span class="bad">모델 없음' + (st.error ? " — " + esc(st.error) : "") + "</span>";
  $("#sysline").innerHTML = `${eng} · CPU ${SYS.cpu}개 · 남은 디스크 ${SYS.diskFreeGB}GB`;
  $("#engState").innerHTML = eng + (SYS.modelsReady ? "" : "<br><small>모델이 준비되면 대기 중인 작업이 자동으로 시작됩니다.</small>");
  $("#btnSetup").disabled = SYS.modelsReady || st.running;
  if (document.activeElement !== $("#threads")) $("#threads").value = SYS.threads;
}
$("#btnSetup").addEventListener("click", async () => { await api("/api/system/setup", { method: "POST" }); toast("모델을 받기 시작했습니다"); loadSystem(); });
$("#btnThreads").addEventListener("click", async () => {
  await api("/api/settings", { method: "PUT", json: { threads: Number($("#threads").value) } });
  toast("다음 작업부터 적용됩니다"); loadSystem();
});

/* ---------------- uploads ---------------- */
async function uploadFile(file, onProg) {
  const { id } = await api("/api/uploads", { method: "POST", json: { name: file.name, size: file.size } });
  const n = Math.max(1, Math.ceil(file.size / CHUNK));
  for (let i = 0; i < n; i++) {
    const blob = file.slice(i * CHUNK, Math.min(file.size, (i + 1) * CHUNK));
    for (let tries = 0; ; tries++) {
      try { await api(`/api/uploads/${id}/${i}`, { method: "PUT", body: blob, headers: { "Content-Type": "application/octet-stream" } }); break; }
      catch (e) { if (tries >= 3) throw e; await new Promise((r) => setTimeout(r, 1500 * (tries + 1))); }
    }
    onProg((i + 1) / n);
  }
  return id;
}

/* ---------------- new job form ---------------- */
const F = { audio: [], tr: null, voices: [], picked: new Set() };
function mode() { return $('input[name="mode"]:checked').value; }

$("#btnNew").addEventListener("click", async () => {
  resetForm();
  $("#newJob").classList.remove("hidden");
  $("#btnNew").classList.add("hidden");
  try { F.voices = await api("/api/voiceprints"); } catch { F.voices = []; }
  renderChips();
});
$("#btnCancel").addEventListener("click", () => { $("#newJob").classList.add("hidden"); $("#btnNew").classList.remove("hidden"); });
function resetForm() {
  $("#newJob").reset();
  F.audio = []; F.tr = null; F.picked = new Set();
  $("#audioList").innerHTML = ""; $("#trInfo").innerHTML = ""; $("#spkMap").innerHTML = ""; $("#gapTape").classList.add("hidden");
  $("#formMsg").textContent = ""; $("#formMsg").classList.remove("err");
  applyMode();
}
$$('input[name="mode"]').forEach((r) => r.addEventListener("change", applyMode));
function applyMode() {
  const m = mode();
  const multi = m === "fragment";
  $("#audioFiles").multiple = multi;
  $("#audioHint").textContent = multi ? "MP3·WAV·M4A 여러 개 가능 — 녹음 순서대로 고르세요" : "MP3·WAV·M4A 1개";
  $("#fsRange").classList.toggle("hidden", m !== "range");
  $("#fsSpeakers").classList.toggle("hidden", m === "enroll");
  $("#trHint").textContent = (m === "gap" || m === "enroll")
    ? "필수 — Plaud에서 TXT·SRT·DOCX로 내보낸 파일(타임스탬프·화자 켜기)"
    : (m === "range" ? "권장 — 같은 녹음의 전사가 있으면 그 사람들 목소리로 화자를 맞힙니다" : "선택 — 없으면 저장된 목소리 기준만으로 맞힙니다");
  $("#fsTranscript").classList.toggle("hidden", m === "fragment");
  drawTape();
}

$("#audioFiles").addEventListener("change", async (ev) => {
  const files = [...ev.target.files];
  if (!files.length) return;
  F.audio = files.map((f) => ({ file: f, id: null, dur: null, prog: 0, err: null }));
  renderAudioList();
  for (const a of F.audio) {
    try {
      a.id = await uploadFile(a.file, (p) => { a.prog = p; renderAudioList(); });
      const pr = await api(`/api/uploads/${a.id}/probe`, { method: "POST" });
      a.dur = pr.durationSec;
    } catch (e) { a.err = e.message; }
    renderAudioList(); drawTape();
  }
});
function renderAudioList() {
  $("#audioList").innerHTML = F.audio.map((a, i) => `<li><span>${i + 1}. ${esc(a.file.name)}</span>
    <span class="pbar"><i style="width:${Math.round(a.prog * 100)}%"></i></span>
    <span class="msg ${a.err ? "err" : ""}">${a.err ? esc(a.err) : a.dur ? "길이 " + hms(a.dur) : a.prog >= 1 ? "확인 중" : Math.round(a.prog * 100) + "%"}</span></li>`).join("");
}

$("#trFile").addEventListener("change", async (ev) => {
  const f = ev.target.files[0];
  if (!f) return;
  $("#trInfo").textContent = "읽는 중…";
  try {
    const id = await uploadFile(f, () => {});
    const r = await api(`/api/uploads/${id}/transcript`, { method: "POST" });
    F.tr = { id, name: f.name, ...r };
    const sp = Object.entries(r.speakers);
    $("#trInfo").innerHTML = `<b>${r.count}개 발언</b> · 마지막 ${hms(r.endSec)} · 화자 ${sp.length}명`
      + r.warnings.map((w) => `<div class="warn">⚠ ${esc(w)}</div>`).join("")
      + (r.preview.length ? `<div class="msg">첫 발언: [${hms(r.preview[0].start)}] ${esc(r.preview[0].speaker)} — ${esc(r.preview[0].text.slice(0, 60))}</div>` : "");
    renderSpkMap(sp);
  } catch (e) { F.tr = null; $("#trInfo").innerHTML = `<span class="msg err">${esc(e.message)}</span>`; }
  drawTape(); renderChips();
});
function renderSpkMap(sp) {
  if (!sp.length) { $("#spkMap").innerHTML = ""; return; }
  const names = F.voices.map((v) => v.name);
  $("#spkMap").innerHTML = `<b>전사의 화자</b><b>실제 이름(바꿀 때만)</b><b>발언 수</b>` + sp.map(([s, n]) =>
    `<span>${esc(s)}</span><input data-from="${esc(s)}" list="vpNames" placeholder="${/^(speaker|화자)\s*\d+$/i.test(s) ? "이름을 넣으면 목소리 기준으로 저장" : "그대로"}"><span>${n}</span>`).join("")
    + `<datalist id="vpNames">${names.map((n) => `<option value="${esc(n)}">`).join("")}</datalist>`;
  $$("#spkMap input").forEach((i) => i.addEventListener("input", renderChips));
}
function speakerMap() {
  const m = {};
  $$("#spkMap input").forEach((i) => { if (i.value.trim()) m[i.dataset.from] = i.value.trim(); });
  return m;
}
function renderChips() {
  const set = new Set(F.voices.map((v) => v.name));
  if (F.tr) { const sm = speakerMap(); Object.keys(F.tr.speakers).forEach((s) => set.add(sm[s] || s)); }
  const all = [...set].sort((a, b) => a.localeCompare(b, "ko"));
  $("#spkChips").innerHTML = all.length ? all.map((n) => `<span class="chip ${F.picked.has(n) ? "on" : ""}" data-n="${esc(n)}">${esc(n)}</span>`).join("")
    : '<span class="msg">저장된 목소리 기준이 없습니다.</span>';
  $$("#spkChips .chip").forEach((c) => c.addEventListener("click", () => {
    const n = c.dataset.n; F.picked.has(n) ? F.picked.delete(n) : F.picked.add(n); c.classList.toggle("on");
  }));
}
function drawTape() {
  const tape = $("#gapTape");
  const a = F.audio[0];
  if (mode() === "fragment" || !a || !a.dur || !F.tr) { tape.classList.add("hidden"); return; }
  tape.classList.remove("hidden");
  if (F.tr.endSec > a.dur + 30) {
    tape.innerHTML = `<span style="left:0;color:var(--bad)">⚠ 전사(${hms(F.tr.endSec)})가 음원(${hms(a.dur)})보다 깁니다 — 같은 녹음인지 확인하세요</span>`;
    return;
  }
  const end = Math.min(F.tr.endSec, a.dur), pct = (end / a.dur) * 100;
  const gap = a.dur - end;
  tape.innerHTML = `<div class="cov" style="width:${pct}%"></div>`
    + (gap > 20 ? `<div class="gap" style="left:${pct}%;right:0"></div><span style="left:${Math.min(pct, 70)}%">전사 끝 ${hms(end)} → 녹음 끝 ${hms(a.dur)} (빠진 ${hms(gap)})</span>`
      : `<span style="left:0">전사가 녹음 끝(${hms(a.dur)})까지 있습니다</span>`);
}

$("#newJob").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const m = mode(), msg = $("#formMsg");
  msg.classList.add("err");
  if (!F.audio.length || F.audio.some((a) => !a.id)) { msg.textContent = "음원이 다 올라간 뒤 등록해 주세요."; return; }
  if ((m === "gap" || m === "enroll") && !F.tr) { msg.textContent = "Plaud 전사 파일이 필요합니다."; return; }
  const body = {
    mode: m, title: $("#jobTitle").value, note: $("#jobNote").value,
    audio: F.audio.map((a) => ({ id: a.id, name: a.file.name })),
    transcript: m !== "fragment" && F.tr ? { id: F.tr.id, name: F.tr.name } : null,
    speakerMap: speakerMap(), speakers: [...F.picked], useVoiceprints: $("#useVp").checked,
  };
  if (m === "range") {
    const a = parseHms($("#rFrom").value), b = parseHms($("#rTo").value);
    if (!(b > a)) { msg.textContent = "구간을 「1:04:00」처럼 넣어 주세요(끝이 시작보다 뒤)."; return; }
    body.range = { from: a, to: b };
  }
  $("#btnSubmit").disabled = true;
  try {
    await api("/api/jobs", { method: "POST", json: body });
    toast("작업을 등록했습니다");
    $("#newJob").classList.add("hidden"); $("#btnNew").classList.remove("hidden");
    loadJobs();
  } catch (e) { msg.textContent = e.message; }
  finally { $("#btnSubmit").disabled = false; }
});

/* ---------------- job list ---------------- */
let JOBS = [];
async function loadJobs() {
  try { JOBS = await api("/api/jobs"); } catch { return; }
  const el = $("#jobList");
  if (!JOBS.length) { el.innerHTML = '<p class="empty">아직 작업이 없습니다. 「새 작업」으로 시작하세요.</p>'; return; }
  el.innerHTML = JOBS.map((j) => {
    const p = j.progress || {}, s = j.stats || {};
    const busy = j.status === "처리중" || j.status === "대기";
    const result = j.hasResult ? `발언 ${s.segments ?? "-"} · 혼재 ${s.mixed ?? 0} · 미상 ${s.unknown ?? 0} · 저신뢰 ${s.lowConf ?? 0} · 환각 제거 ${s.droppedHallucination ?? 0}` : "";
    const enrolled = s.enrolled && Object.keys(s.enrolled).length ? " · 기준 등록 " + Object.keys(s.enrolled).join(", ") : "";
    return `<div class="job" data-id="${esc(j.id)}">
      <div><span class="t">${esc(j.title)}</span><span class="badge st-${esc(j.status)}">${esc(j.status)}</span>
        <div class="meta">${MODE_LABEL[j.mode] || j.mode} · ${esc((j.audioFiles || []).map((n) => n.slice(2)).join(", "))}
          ${j.range ? " · " + hms(j.range.from) + "~" + hms(j.range.to) : ""} · ${esc((j.createdAt || "").replace("T", " ").slice(0, 16))}
          ${j.audioDeleted ? " · 음원 지움" : ""}</div>
        ${result || enrolled ? `<div class="meta">${result}${enrolled}</div>` : ""}
        ${j.error ? `<div class="meta" style="color:var(--bad)">${esc(j.error)}</div>` : ""}
      </div>
      <div class="acts">
        ${j.hasResult ? '<button data-a="review" class="primary">검수</button>' : ""}
        ${busy ? '<button data-a="stop">중지</button>' : ""}
        ${!busy && j.status !== "완료" && !j.audioDeleted ? '<button data-a="resume">이어서 처리</button>' : ""}
        ${!busy && !j.audioDeleted ? '<button data-a="fresh">처음부터 다시</button>' : ""}
        ${!busy && !j.audioDeleted ? '<button data-a="delaudio">음원 지우기</button>' : ""}
        ${!busy ? '<button data-a="del">삭제</button>' : ""}
      </div>
      ${busy ? `<div class="prog"><span class="pbar"><i style="width:${p.pct || 0}%"></i></span><span>${p.pct || 0}% · ${esc(p.msg || "")}</span></div>` : ""}
    </div>`;
  }).join("");
}
$("#jobList").addEventListener("click", async (ev) => {
  const b = ev.target.closest("button[data-a]"); if (!b) return;
  const id = b.closest(".job").dataset.id, a = b.dataset.a;
  try {
    if (a === "review") { REVIEW.want = id; showTab("review"); return; }
    if (a === "stop") await api(`/api/jobs/${id}/stop`, { method: "POST" });
    if (a === "resume") await api(`/api/jobs/${id}/start`, { method: "POST", json: {} });
    if (a === "fresh") { if (!confirm("결과를 지우고 처음부터 다시 처리할까요? 검수 수정 내용은 남지만 발언 번호가 바뀔 수 있습니다.")) return; await api(`/api/jobs/${id}/start`, { method: "POST", json: { fresh: true } }); }
    if (a === "delaudio") { if (!confirm("이 작업의 음원을 지울까요? 결과는 남고, 검수 화면의 재생은 안 됩니다.")) return; await api(`/api/jobs/${id}/audio`, { method: "DELETE" }); }
    if (a === "del") { if (!confirm("작업과 결과를 모두 지울까요? (목소리 기준은 남습니다)")) return; await api(`/api/jobs/${id}`, { method: "DELETE" }); }
    loadJobs();
  } catch (e) { toast(e.message); }
});

/* ---------------- review ---------------- */
const REVIEW = { id: null, want: null, data: null, edits: {}, filter: "need", saveT: null };
async function loadReviewJobs() {
  try { JOBS = await api("/api/jobs"); } catch { return; }
  const done = JOBS.filter((j) => j.hasResult && j.mode !== "enroll");
  const sel = $("#rvJob");
  sel.innerHTML = done.length ? done.map((j) => `<option value="${esc(j.id)}">${esc(j.title)} (${MODE_LABEL[j.mode]})</option>`).join("") : '<option value="">검수할 결과가 없습니다</option>';
  const id = REVIEW.want && done.some((j) => j.id === REVIEW.want) ? REVIEW.want : REVIEW.id && done.some((j) => j.id === REVIEW.id) ? REVIEW.id : done[0]?.id;
  REVIEW.want = null;
  if (id) { sel.value = id; if (id !== REVIEW.id || !REVIEW.data) await openReview(id); else renderReview(); }
  else { $("#rvBody").innerHTML = ""; $("#rvStats").innerHTML = ""; }
}
$("#rvJob").addEventListener("change", (e) => openReview(e.target.value));
$$(".seg button").forEach((b) => b.addEventListener("click", () => {
  $$(".seg button").forEach((x) => x.classList.toggle("on", x === b)); REVIEW.filter = b.dataset.f; renderReview();
}));
$("#rvPlaud").addEventListener("change", renderReview);
async function openReview(id) {
  REVIEW.id = id;
  const [d, gl] = await Promise.all([api(`/api/jobs/${id}/result`), api("/api/glossary")]);
  REVIEW.data = d; REVIEW.edits = (d.edits && d.edits.e) || {}; REVIEW.gl = gl.pairs || [];
  $("#rvSave").textContent = "";
  renderReview();
}
function gloss(t) { for (const p of REVIEW.gl || []) if (p.from) t = t.split(p.from).join(p.to); return t; }
function isNeed(g) { return g.kind !== "단일" || g.conf < 0.6; }
function renderReview() {
  const d = REVIEW.data; if (!d) return;
  const segs = d.result.segs, s = d.result.stats, job = d.job;
  const smap = job.speakerMap || {};
  const names = new Set([...(s.speakersUsed || [])]);
  segs.forEach((g) => { if (g.kind === "단일") names.add(g.speaker); });
  Object.values(REVIEW.edits).forEach((e) => e.speaker && names.add(e.speaker));
  const nameList = [...names].sort((a, b) => a.localeCompare(b, "ko"));
  const checked = Object.values(REVIEW.edits).filter((e) => e.ok).length;
  $("#rvStats").innerHTML = [
    ["발언", s.segments], ["확인 필요", segs.filter(isNeed).length], ["혼재", s.mixed], ["미상", s.unknown],
    ["저신뢰", s.lowConf], ["환각 제거", s.droppedHallucination], ["검수 완료", checked],
  ].map(([k, v]) => `<span class="stat"><b>${v ?? 0}</b>${k}</span>`).join("")
    + (s.targets ? `<span class="stat">대상 ${s.targets.map((t) => (s.files && s.files.length > 1 ? (t.file + 1) + "번 " : "") + hms(t.from) + "~" + hms(t.to)).join(", ")}</span>` : "");

  let rows = segs.map((g) => ({ g, e: REVIEW.edits[g.i] || {} }));
  const f = REVIEW.filter;
  if (f === "need") rows = rows.filter((r) => isNeed(r.g) && !r.e.ok);
  if (f === "edited") rows = rows.filter((r) => r.e.speaker || r.e.text);
  if (f === "todo") rows = rows.filter((r) => !r.e.ok);
  let items = rows.map((r) => ({ t: r.g.start, file: r.g.file || 0, r }));
  if ($("#rvPlaud").checked && job.mode !== "fragment") {
    const tg = s.targets || [];
    (d.plaud || []).forEach((p) => {
      // 대상 구간 앞뒤 3분의 Plaud 발언만 맥락으로 보여준다
      const near = tg.some((t) => p.start >= t.from - 180 && p.start < t.to + 180);
      if (near && !tg.some((t) => t.from <= p.start && p.start < t.to)) items.push({ t: p.start, file: 0, p });
    });
  }
  items.sort((a, b) => a.file - b.file || a.t - b.t);
  if ($("#rvPlaud").checked && items.length > 1500) items = items.slice(0, 1500);
  $("#rvEmpty").classList.toggle("hidden", items.length > 0);
  const canPlay = !job.audioDeleted;
  $("#rvBody").innerHTML = items.map((it) => {
    if (it.p) {
      return `<tr class="plaud"><td class="c-t">${hms(it.p.start)}</td><td></td><td>${esc(smap[it.p.speaker] || it.p.speaker)}</td><td>${esc(gloss(it.p.text))}</td><td><span class="msg">Plaud</span></td><td></td></tr>`;
    }
    const { g, e } = it.r;
    const spk = e.speaker || g.speaker;
    const kindLabel = g.kind === "단일" && g.conf < 0.6 ? "저신뢰" : g.kind;
    const votes = Object.entries(g.votes || {}).slice(0, 3).map(([k, v]) => `${k} ${Math.round(v * 100)}%`).join(" · ");
    const opts = (nameList.includes(spk) ? nameList : [spk, ...nameList]).map((n) => `<option ${n === spk ? "selected" : ""}>${esc(n)}</option>`).join("")
      + '<option value="__new">직접 입력…</option>';
    return `<tr data-i="${g.i}" class="${e.speaker || e.text ? "edited" : ""}">
      <td class="c-t">${(s.files && s.files.length > 1 ? `<small>${(g.file || 0) + 1}번</small> ` : "") + hms(g.start)}</td>
      <td>${canPlay ? `<button class="play" title="듣기" data-s="${g.start}" data-e="${g.end}" data-f="${g.file || 0}">▶</button>` : ""}</td>
      <td><select class="spk">${opts}</select></td>
      <td><textarea rows="2">${esc(e.text ?? gloss(g.text))}</textarea></td>
      <td><span class="kind k-${kindLabel}">${kindLabel} ${Math.round(g.conf * 100)}%</span><span class="votes">${esc(votes)}</span></td>
      <td class="c-ok"><input type="checkbox" class="ok" ${e.ok ? "checked" : ""} title="검수 완료"></td></tr>`;
  }).join("");
  $$("#rvBody textarea").forEach((t) => { t.style.height = "auto"; t.style.height = t.scrollHeight + 2 + "px"; });
}
function editOf(i) { return (REVIEW.edits[i] = REVIEW.edits[i] || {}); }
$("#rvBody").addEventListener("change", (ev) => {
  const tr = ev.target.closest("tr[data-i]"); if (!tr) return;
  const i = tr.dataset.i, g = REVIEW.data.result.segs.find((x) => String(x.i) === i);
  if (ev.target.matches("select.spk")) {
    let v = ev.target.value;
    if (v === "__new") { v = (prompt("화자 이름") || "").trim(); if (!v) { renderReview(); return; } }
    const e = editOf(i);
    if (v === g.speaker) delete e.speaker; else e.speaker = v;
    if (!e.ok) e.ok = true;
  } else if (ev.target.matches("textarea")) {
    const e = editOf(i), v = ev.target.value.trim();
    if (v === gloss(g.text).trim()) delete e.text; else e.text = v;
  } else if (ev.target.matches("input.ok")) {
    editOf(i).ok = ev.target.checked;
  }
  tr.classList.toggle("edited", !!(REVIEW.edits[i].speaker || REVIEW.edits[i].text));
  scheduleSave();
});
function scheduleSave() {
  $("#rvSave").textContent = "저장 대기…";
  clearTimeout(REVIEW.saveT);
  REVIEW.saveT = setTimeout(async () => {
    try { await api(`/api/jobs/${REVIEW.id}/edits`, { method: "PUT", json: { e: REVIEW.edits } }); $("#rvSave").textContent = "저장됨 " + new Date().toLocaleTimeString("ko-KR"); }
    catch (e) { $("#rvSave").textContent = "저장 실패: " + e.message; }
  }, 600);
}
const player = $("#player");
let stopAt = null, playingRow = null;
$("#rvBody").addEventListener("click", (ev) => {
  const b = ev.target.closest("button.play"); if (!b) return;
  if (playingRow === b.closest("tr") && !player.paused) { player.pause(); return; }
  const s = Number(b.dataset.s), e = Number(b.dataset.e);
  player.src = `/api/jobs/${REVIEW.id}/clip?file=${b.dataset.f}&start=${Math.max(0, s - 0.3)}&end=${e + 0.3}`;
  player.play().catch((err) => toast("재생 실패: " + err.message));
  $$("#rvBody tr.playing").forEach((x) => x.classList.remove("playing"));
  playingRow = b.closest("tr"); playingRow.classList.add("playing");
});
player.addEventListener("ended", () => playingRow && playingRow.classList.remove("playing"));
player.addEventListener("pause", () => playingRow && playingRow.classList.remove("playing"));
function exportUrl(fmt) { return `/api/jobs/${REVIEW.id}/export?fmt=${fmt}&plaud=${$("#exPlaud").checked ? 1 : 0}&glossary=${$("#exGl").checked ? 1 : 0}`; }
$("#exTxt").addEventListener("click", () => { if (REVIEW.id) location.href = exportUrl("txt"); });
$("#exCsv").addEventListener("click", () => { if (REVIEW.id) location.href = exportUrl("csv"); });

/* ---------------- voices ---------------- */
async function loadVoices() {
  const vs = await api("/api/voiceprints");
  $("#vpBody").innerHTML = vs.length ? vs.map((v) => `<tr data-n="${esc(v.name)}"><td><b>${esc(v.name)}</b></td><td>${v.n}</td>
    <td class="src">${v.sources.map((s) => `<div>${esc(s.source)} (${s.n})<button data-src="${esc(s.source)}" title="이 출처만 빼기">빼기</button></div>`).join("")}</td>
    <td style="white-space:nowrap"><button data-a="ren">이름 바꾸기·합치기</button> <button data-a="del">지우기</button></td></tr>`).join("")
    : '<tr><td colspan="4" class="empty">저장된 목소리 기준이 없습니다. Plaud 전사(화자 이름 포함)가 있는 작업을 처리하면 자동으로 쌓입니다.</td></tr>';
}
$("#vpBody").addEventListener("click", async (ev) => {
  const b = ev.target.closest("button"); if (!b) return;
  const n = b.closest("tr").dataset.n;
  try {
    if (b.dataset.src) { if (!confirm(`${n}의 「${b.dataset.src}」 기준을 뺄까요?`)) return; await api(`/api/voiceprints/${encodeURIComponent(n)}?source=${encodeURIComponent(b.dataset.src)}`, { method: "DELETE" }); }
    else if (b.dataset.a === "del") { if (!confirm(`${n}의 목소리 기준을 모두 지울까요?`)) return; await api(`/api/voiceprints/${encodeURIComponent(n)}`, { method: "DELETE" }); }
    else if (b.dataset.a === "ren") { const to = (prompt("새 이름 (이미 있는 이름이면 합쳐집니다)", n) || "").trim(); if (!to || to === n) return; await api("/api/voiceprints/rename", { method: "POST", json: { from: n, to } }); }
    loadVoices();
  } catch (e) { toast(e.message); }
});

/* ---------------- glossary ---------------- */
async function loadGlossary() {
  const g = await api("/api/glossary");
  $("#glBody").innerHTML = "";
  (g.pairs.length ? g.pairs : [{ from: "", to: "" }]).forEach(addGlRow);
}
function addGlRow(p = { from: "", to: "" }) {
  const tr = document.createElement("tr");
  tr.innerHTML = `<td><input class="f" value="${esc(p.from)}"></td><td><input class="t" value="${esc(p.to)}"></td><td><button title="줄 지우기">✕</button></td>`;
  tr.querySelector("button").addEventListener("click", () => tr.remove());
  $("#glBody").appendChild(tr);
}
$("#glAdd").addEventListener("click", () => addGlRow());
$("#glSave").addEventListener("click", async () => {
  const pairs = $$("#glBody tr").map((tr) => ({ from: $(".f", tr).value, to: $(".t", tr).value })).filter((p) => p.from.trim());
  await api("/api/glossary", { method: "PUT", json: { pairs } });
  toast("사전을 저장했습니다");
  if (REVIEW.data) REVIEW.gl = pairs;
});

/* ---------------- restore ---------------- */
$("#restoreFile").addEventListener("change", async (ev) => {
  const f = ev.target.files[0]; if (!f) return;
  $("#restoreMsg").textContent = "올리는 중…";
  try {
    const r = await api("/api/restore", { method: "POST", body: f, headers: { "Content-Type": "application/zip" } });
    $("#restoreMsg").textContent = `합쳐 넣음 — 목소리 기준 ${r.voiceprints}건, 사전 ${r.glossary}건, 작업 ${r.jobs}건`;
  } catch (e) { $("#restoreMsg").textContent = "실패: " + e.message; }
  ev.target.value = "";
});

/* ---------------- polling ---------------- */
async function tick() {
  await loadSystem();
  if ($("#tab-jobs").classList.contains("on")) await loadJobs();
}
const start = (location.hash || "#jobs").slice(1);
showTab(["jobs", "review", "voices", "glossary", "settings"].includes(start) ? start : "jobs");
loadJobs();
tick();
setInterval(tick, 4000);
