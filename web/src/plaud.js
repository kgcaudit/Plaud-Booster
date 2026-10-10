// Plaud에서 내보낸 전사 파일(TXT·SRT·DOCX·JSON)을 [{start,end,speaker,text}](초)로 읽는다.
//
// Plaud 내보내기는 시간·화자 표시를 켜고 끌 수 있고 배치도 조금씩 달라서 흔한 형태를 모두 받는다.
//   00:01:05 김응옥            (시간 다음 화자, 다음 줄부터 발언)
//   김응옥 00:01:05            (화자 다음 시간)
//   [00:01:05] 김응옥: 발언     (한 줄)
//   김응옥 (01:05): 발언
//   00:01:05 - 00:01:12 김응옥 (구간)
//   SRT 블록 (본문이 「화자: 발언」이면 화자를 뗀다)
//   Plaud 커넥터 JSON (start_time/end_time 밀리초, speaker, content)
// 시간이 없으면 화자 기준을 만들 수 없으므로 오류 대신 경고를 돌려준다.
import { readZipEntry } from "./zip.js";

const TS = String.raw`(?:\d{1,2}:)?\d{1,2}:\d{2}(?:[.,]\d{1,3})?`;
const RE_SRT_TIME = new RegExp(String.raw`^\s*(${TS})\s*-->\s*(${TS})`);
const RE_SRT_TIME_ANY = new RegExp(String.raw`^\s*(${TS})\s*-->\s*(${TS})`, "m");
const RE_RANGE = new RegExp(String.raw`^\s*\[?(${TS})\]?\s*[-~–]\s*\[?(${TS})\]?\s*(.*)$`);
const RE_TS_FIRST = new RegExp(String.raw`^\s*[\[(]?(${TS})(?![0-9A-Za-z가-힣])[\])]?\s*[-|·]?\s*(.*)$`); // 「2:30에 다시…」 같은 본문은 시각 머리가 아님
const RE_TS_LAST = new RegExp(String.raw`^\s*(.+?)\s*[\[(]?(${TS})[\])]?\s*:?\s*$`);
const RE_SPK_TS_TEXT = new RegExp(String.raw`^\s*(.{1,40}?)\s*[\[(](${TS})[\])]\s*[:：]\s*(.+)$`);
const RE_SPK_TEXT = /^\s*([^:：\s][^:：]{0,30}?)\s*[:：]\s*(.+)$/;

export function ts(s) {
  return s.replace(",", ".").split(":").reduce((v, p) => v * 60 + parseFloat(p), 0);
}

function looksLikeSpeaker(s) {
  s = s.trim();
  return s.length > 0 && s.length <= 30 && !/[.?!。]$/.test(s) && s.split(/\s+/).length <= 4;
}

const round2 = (x) => Math.round(x * 100) / 100;

function finish(segs) {
  segs = segs.filter((g) => (g.text || "").trim());
  segs.sort((a, b) => a.start - b.start);
  segs.forEach((g, i) => {
    if (g.end == null || g.end <= g.start) {
      const nxt = i + 1 < segs.length ? segs[i + 1].start : null;
      if (nxt != null && nxt > g.start) g.end = Math.min(nxt, g.start + 60); // 다음 발언 시작까지(Plaud 발언은 대개 이어 붙어 있다)
      else g.end = g.start + Math.min(30, Math.max(2, g.text.length * 0.18));
    }
    g.text = g.text.replace(/\s+/g, " ").trim();
    // Plaud는 「김응옥 (법제팀장)」처럼 직함을 괄호로 붙인다 — 목소리 기준은 이름으로 모은다
    g.speaker = (g.speaker || "").trim().replace(/\s*[(（][^()（）]*[)）]\s*$/, "");
    g.start = round2(g.start);
    g.end = round2(g.end);
  });
  return segs;
}

export function parseSrt(text) {
  const segs = [];
  for (const block of text.trim().split(/\n\s*\n/)) {
    let lines = block.trim().split(/\r?\n/).filter((l) => l.trim());
    if (lines.length && /^\d+$/.test(lines[0].trim())) lines = lines.slice(1);
    if (!lines.length) continue;
    const m = lines[0].match(RE_SRT_TIME);
    if (!m) continue;
    let body = lines.slice(1).join(" ").trim();
    let spk = "";
    const mm = body.match(/^\[([^\]]{1,30})\]\s*[:：]?\s*(.+)$/) || body.match(/^([^:：]{1,30}?)\s*[:：]\s*(.+)$/);
    if (mm) { spk = mm[1]; body = mm[2]; }
    segs.push({ start: ts(m[1]), end: ts(m[2]), speaker: spk, text: body });
  }
  return finish(segs);
}

export function parseTxt(text) {
  const lines = text.replace(/\r\n/g, "\n").replace(/﻿/g, "").split("\n");
  const segs = [];
  let cur = null;
  const start = (t0, spk, body = "", t1 = null) => {
    cur = { start: t0, end: t1, speaker: spk || (cur ? cur.speaker : ""), text: body };
    segs.push(cur);
  };
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    let m = line.match(RE_SPK_TS_TEXT); // 김응옥 (01:05): 발언
    if (m && looksLikeSpeaker(m[1])) { start(ts(m[2]), m[1], m[3]); continue; }
    m = line.match(RE_RANGE); // 00:01:05 - 00:01:12 김응옥[: 발언]
    if (m) {
      const rest = m[3].trim();
      const mm = rest.match(RE_SPK_TEXT);
      if (mm) start(ts(m[1]), mm[1], mm[2], ts(m[2]));
      else if (looksLikeSpeaker(rest)) start(ts(m[1]), rest, "", ts(m[2]));
      else start(ts(m[1]), "", rest, ts(m[2]));
      continue;
    }
    // 머리(시각·화자)만 있고 아직 말이 없는 다음 줄, 또는 시각이 앞 머리보다 이르면 시각처럼 보여도 본문이다(「…회의는 3:00」)
    const bodyFirst = (t) => cur && (!cur.text || t < cur.start);
    m = line.match(RE_TS_FIRST); // [00:01:05] 김응옥: 발언 / 00:01:05 김응옥
    if (m && bodyFirst(ts(m[1]))) m = null;
    if (m) {
      const rest = m[2].trim();
      const mm = rest.match(RE_SPK_TEXT);
      if (mm && looksLikeSpeaker(mm[1])) start(ts(m[1]), mm[1], mm[2]);
      else if (!rest || looksLikeSpeaker(rest)) start(ts(m[1]), rest);
      else start(ts(m[1]), "", rest);
      continue;
    }
    m = line.match(RE_TS_LAST); // 김응옥 00:01:05
    if (m && looksLikeSpeaker(m[1]) && !bodyFirst(ts(m[2]))) { start(ts(m[2]), m[1]); continue; }
    if (cur) cur.text = (cur.text + " " + line).trim();
  }
  return finish(segs);
}

export function parseJson(data) {
  if (!Array.isArray(data)) data = data.segments || data.segs || data.data || [];
  const segs = data.map((g) => ("start_time" in g
    ? { start: g.start_time / 1000, end: (g.end_time || 0) / 1000, speaker: g.speaker || "", text: g.content || g.text || "" }
    : { start: +g.start, end: +(g.end || 0), speaker: g.speaker || "", text: g.text || "" }));
  // 커넥터 응답은 같은 구간이 겹쳐 나올 때가 있다
  const uniq = new Map();
  for (const g of segs) uniq.set(round2(g.start) + "|" + g.speaker, g);
  return finish([...uniq.values()]);
}

export function docxText(xml) {
  const ent = (t) => t.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");
  const out = [];
  for (const p of xml.match(/<w:p[ >][\s\S]*?<\/w:p>/g) || []) {
    const q = p.replace(/<w:tab\/>/g, "<w:t>\t</w:t>").replace(/<w:br\/>/g, "<w:t>\n</w:t>");
    out.push(ent([...q.matchAll(/<w:t(?: [^>]*)?>([\s\S]*?)<\/w:t>/g)].map((m) => m[1]).join("")));
  }
  return out.join("\n");
}

function decodeText(bytes) {
  for (const enc of ["utf-8", "euc-kr", "utf-16le"]) {
    try {
      let t = new TextDecoder(enc, { fatal: true }).decode(bytes);
      if (t.charCodeAt(0) === 0xfeff) t = t.slice(1);
      return t;
    } catch { /* 다음 인코딩 */ }
  }
  throw new Error("글자 인코딩을 알 수 없습니다.");
}

/** @param {string} filename @param {Uint8Array} bytes */
export async function parse(filename, bytes) {
  const name = filename.toLowerCase();
  let segs;
  if (name.endsWith(".docx")) {
    const xml = new TextDecoder().decode(await readZipEntry(bytes, "word/document.xml"));
    const text = docxText(xml);
    segs = RE_SRT_TIME_ANY.test(text) ? parseSrt(text) : parseTxt(text);
  } else if (name.endsWith(".json")) {
    segs = parseJson(JSON.parse(new TextDecoder().decode(bytes)));
  } else if (name.endsWith(".pdf")) {
    throw new Error("PDF는 읽지 않습니다. Plaud에서 TXT·SRT·DOCX로 내보내 주세요.");
  } else {
    const text = decodeText(bytes);
    segs = name.endsWith(".srt") || RE_SRT_TIME_ANY.test(text) ? parseSrt(text) : parseTxt(text);
  }
  const warnings = [];
  if (!segs.length) warnings.push("시간 표시를 찾지 못했습니다. Plaud에서 내보낼 때 「타임스탬프」와 「화자」를 켜 주세요.");
  else if (!segs.some((g) => g.speaker)) warnings.push("화자 표시가 없습니다. 이 전사로는 목소리 기준을 만들 수 없습니다.");
  const speakers = {};
  for (const g of segs) if (g.speaker) speakers[g.speaker] = (speakers[g.speaker] || 0) + 1;
  return { segs, warnings, speakers, endSec: segs.reduce((m, g) => Math.max(m, g.end), 0) };
}
