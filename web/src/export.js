// 통합본 만들기(Plaud 전사 + 보충 결과 + 검수 수정 + 사전)와 백업 합치기 — 순수 함수(시험 가능)

export function hms(t, long = true) {
  t = Math.max(0, Math.round(t || 0));
  const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = t % 60;
  const p = (x) => String(x).padStart(2, "0");
  return long ? `${p(h)}:${p(m)}:${p(s)}` : (h ? h + ":" + p(m) : String(m)) + ":" + p(s);
}

export function applyGlossary(text, pairs) {
  for (const p of pairs || []) if (p.from) text = text.split(p.from).join(p.to || "");
  return text;
}

/** 발언의 최종 화자: 발언별 수정 > 묶음 이름(소니 녹음) > 처리 결과 */
export function speakerOf(g, edits) {
  const e = (edits && edits.e) || {}, names = (edits && edits.names) || {};
  return (e[g.i] && e[g.i].speaker) || (g.cluster && names[g.cluster]) || g.speaker;
}

/** 통합본 줄 목록 [{t,file,spk,text,src}] */
export function mergedLines({ job, result, edits, plaud, glossary }, { usePlaud = true, useGlossary = true } = {}) {
  const e = (edits && edits.e) || {};
  const pairs = useGlossary ? glossary || [] : [];
  const smap = job.speakerMap || {};
  const targets = result.stats.targets || [];
  const lines = [];
  if (usePlaud && (job.mode === "gap" || job.mode === "range")) {
    const inside = (g) => targets.some((t) => t.file === 0 && t.from <= g.start && g.start < t.to);
    for (const g of plaud || []) if (!inside(g)) lines.push({ t: g.start, file: 0, spk: smap[g.speaker] || g.speaker || "화자 미상", text: g.text, src: "Plaud" });
  }
  for (const g of result.segs) {
    const ed = e[g.i] || {};
    let tag = job.mode === "gap" || job.mode === "range" ? "보충" : "";
    if (!ed.speaker && g.kind === "혼재") tag = [tag, "화자 혼재"].filter(Boolean).join("·");
    lines.push({ t: g.start, file: g.file || 0, spk: speakerOf(g, edits), text: ed.text || g.text, src: tag });
  }
  lines.sort((a, b) => a.file - b.file || a.t - b.t);
  for (const x of lines) { x.text = applyGlossary(x.text, pairs); x.spk = applyGlossary(x.spk, pairs); }
  return lines;
}

export function exportTxt(data, opts) {
  const { job } = data;
  const files = (job.audioFiles || []).map((f) => f.name + (f.recordedAt ? ` (${f.recordedAt.replace("T", " ").slice(0, 16)} 녹음)` : ""));
  const multi = files.length > 1;
  const d = new Date();
  const out = [job.title, `내보낸 시각: ${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`, ""];
  let cur = null;
  for (const x of mergedLines(data, opts)) {
    if (multi && x.file !== cur) { cur = x.file; out.push("", `■ ${files[cur] ?? cur}`, ""); }
    const tag = x.src && x.src !== "Plaud" ? ` (${x.src})` : "";
    out.push(`[${hms(x.t)}] ${x.spk}${tag}: ${x.text}`);
  }
  return out.join("\n") + "\n";
}

export function exportCsv(data, opts) {
  const files = (data.job.audioFiles || []).map((f) => f.name);
  const q = (s) => (/[",\n]/.test(s) ? `"${String(s).replace(/"/g, '""')}"` : String(s));
  const rows = [["파일", "시각", "화자", "발언", "출처"]];
  for (const x of mergedLines(data, opts)) rows.push([files[x.file] ?? x.file, hms(x.t), x.spk, x.text, x.src]);
  return "﻿" + rows.map((r) => r.map(q).join(",")).join("\r\n") + "\r\n";
}

/** 백업 합치기: 목소리 기준은 이름·출처별로 더하고, 사전은 없는 쌍만, 작업은 없는 것만 */
export function mergeBackup(cur, bk) {
  const added = { voiceprints: 0, glossary: 0, jobs: 0 };
  const vps = { ...cur.voiceprints };
  for (const [name, ent] of Object.entries(bk.voiceprints || {})) {
    const c = vps[name] ? { ...vps[name], items: { ...vps[name].items } } : { name, items: {}, model: "campplus" };
    for (const [s, it] of Object.entries(ent.items || {})) if (!c.items[s]) { c.items[s] = it; added.voiceprints++; }
    vps[name] = c;
  }
  const have = new Set((cur.glossary || []).map((p) => p.from + "\u0000" + p.to));
  const glossary = [...(cur.glossary || [])];
  for (const p of bk.glossary || []) if (!have.has(p.from + "\u0000" + p.to)) { glossary.push(p); added.glossary++; }
  const jobs = {};
  for (const [id, j] of Object.entries(bk.jobs || {})) {
    if (cur.jobIds.has(id)) continue; // 백업 형식 1·2 모두 같은 자리(2는 edits에 묶음 이름 names가 더 있음)
    const job = { ...j.job, audioDeleted: true };
    if (job.status === "대기" || job.status === "처리중") job.status = "중지";
    jobs[id] = { ...j, job };
    added.jobs++;
  }
  return { voiceprints: vps, glossary, jobs, added };
}
