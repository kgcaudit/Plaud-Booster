import { test } from "node:test";
import assert from "node:assert/strict";
import { inScope, scopeCounts, isEdited, splitPart, mergeParts, partEnd } from "../../web/src/review.js";
import { mergedLines } from "../../web/src/export.js";
import { titleFromFiles } from "../../web/src/diar.js";

test("보기 범위: 전체 = 확인함 + 미검수, 미검수 = 확인 필요 + 판정 확실", () => {
  const segs = [1, 2, 3, 4, 5].map((i) => ({ i, need: i <= 2 }));
  const edits = { 1: { ok: true }, 3: { ok: true, text: "고침" }, 4: { speaker: "갑" } };
  const c = scopeCounts(segs, edits, (g) => g.need);
  assert.deepEqual(c, { all: 5, ok: 2, todo: 3, need: 1, sure: 2, edited: 2 });
  assert.equal(c.ok + c.todo, c.all);
  assert.equal(c.need + c.sure, c.todo);
  assert.equal(inScope("need", { ok: true }, true), false); // 확인하면 확인 필요에서 빠짐
  assert.equal(inScope("sure", undefined, false), true);
  assert.ok(isEdited({ parts: [{ text: "a" }, { text: "b" }] }));
  assert.ok(!isEdited({ ok: true }));
});

test("발언 나누기: 커서 위치에서 둘로, 시각은 글자 비율 또는 재생 위치", () => {
  const g = { i: 7, start: 10, end: 20 };
  const text = "네 그건 제가 볼게요 아니 그건 끝난 거예요";
  const pos = text.indexOf("아니");
  const p = splitPart(g, null, 0, text, pos);
  assert.equal(p.length, 2);
  assert.equal(p[0].text, "네 그건 제가 볼게요");
  assert.equal(p[1].text, "아니 그건 끝난 거예요");
  assert.equal(p[0].start, 10);
  assert.ok(p[1].start > 10 && p[1].start < 20);
  // 재생 위치로
  assert.equal(splitPart(g, null, 0, text, pos, 13.37)[1].start, 13.37);
  // 조각을 다시 나눔(세 사람) — 시각은 그 조각 안에서만
  p[1].speaker = "을";
  const q = splitPart(g, p, 1, p[1].text, 2);
  assert.equal(q.length, 3);
  assert.ok(q[2].start > q[1].start && q[2].start < 20);
  assert.equal(q[2].speaker, "을"); // 처음엔 나눈 조각의 화자를 따름
  assert.equal(partEnd(g, q, 2), 20);
  assert.equal(partEnd(g, q, 0), q[1].start);
  // 글 끝·처음에서는 나눌 수 없음
  assert.equal(splitPart(g, null, 0, text, 0), null);
  assert.equal(splitPart(g, null, 0, text, text.length), null);
});

test("합치기: 글은 이어 붙이고, 모든 조각이 같은 사람일 때만 화자 유지", () => {
  assert.deepEqual(mergeParts([{ text: "가", speaker: "갑" }, { text: "나", speaker: "갑" }]), { text: "가 나", speaker: "갑" });
  assert.deepEqual(mergeParts([{ text: "가", speaker: "갑" }, { text: "나" }]), { text: "가 나", speaker: "" });
});

test("통합본: 나눈 발언은 조각마다 한 줄, 조각 화자 > 묶음 이름", () => {
  const result = { stats: {}, segs: [{ i: 1, start: 5, end: 9, cluster: "S1", speaker: "Speaker 1", text: "원문" }, { i: 2, start: 10, end: 12, cluster: "S2", speaker: "Speaker 2", text: "다음" }] };
  const edits = { names: { S1: "갑", S2: "을" }, e: { 1: { parts: [{ start: 5, text: "앞 말" }, { start: 7, text: "뒤 말", speaker: "을" }] } } };
  const lines = mergedLines({ job: { mode: "diar" }, result, edits, plaud: [], glossary: [] });
  assert.deepEqual(lines.map((l) => [l.t, l.spk, l.text]), [[5, "갑", "앞 말"], [7, "을", "뒤 말"], [10, "을", "다음"]]);
});

test("작업 이름: 파일 이름 속 녹음 시각(시작~끝)·기기 종류를 우리말로", () => {
  process.env.TZ = "Asia/Seoul"; // 줌(세계 표준시) 변환 확인용
  const T = (n) => titleFromFiles([n]);
  assert.equal(T("260911_082625-084031_Audio.m4a"), "26년 9월 11일 오전 08시 26분 25초 ~ 오전 08시 40분 31초 · 음성");
  assert.equal(T("음성 261011_104940.m4a"), "26년 10월 11일 오전 10시 49분 40초 · 음성"); // 갤럭시 음성 녹음
  assert.equal(T("통화 녹음 홍길동_260914_075100.m4a"), "26년 9월 14일 오전 07시 51분 00초 · 통화 녹음 홍길동");
  assert.equal(T("통화 녹음 010-1234-5678_260914_075100.m4a"), "26년 9월 14일 오전 07시 51분 00초 · 통화 녹음 010-1234-5678");
  assert.equal(T("251009_1430.MP3"), "25년 10월 9일 오후 02시 30분"); // 소니(초 없음)
  assert.equal(T("251009_1430_01.MP3"), "25년 10월 9일 오후 02시 30분");
  assert.equal(T("2025-10-08 14-30-12 현장 면담.mp3"), "25년 10월 8일 오후 02시 30분 12초 · 현장 면담");
  assert.equal(T("Recording_20251008_120000.wav"), "25년 10월 8일 오후 12시 00분 00초 · 음성");
  assert.equal(T("GMT20251008-053012_Recording.m4a"), "25년 10월 8일 오후 02시 30분 12초 · 음성"); // 줌: 세계 표준시 → 한국 시각
  assert.equal(T("KakaoTalk_Audio_20251008_143012345.m4a"), "25년 10월 8일 오후 02시 30분 12초 · 카카오톡 음성");
  assert.equal(T("20261008.m4a"), "26년 10월 8일");
  assert.equal(T("2025.10.08 회의.mp3"), "25년 10월 8일 · 회의");
  assert.equal(T("10-09 현장_면담.m4a"), "10-09 현장 면담"); // 연도 없는 날짜는 그대로
  assert.equal(T("새로운 녹음 3.m4a"), "새로운 녹음 3"); // 시각이 없으면 이름 그대로
  assert.equal(titleFromFiles(["251009_1430.wav", "251009_1520.wav"]), "25년 10월 9일 오후 02시 30분 외 1개");
  assert.equal(titleFromFiles([]), "");
});

import { splitCluster } from "../../web/src/diar.js";
test("묶음 둘로 나누기: 한 묶음에 섞인 두 목소리를 가르고, 긴 쪽이 원래 번호를 잇는다", () => {
  const D = 8, vA = Array.from({ length: D }, (_, j) => (j === 0 ? 1 : 0)), vB = Array.from({ length: D }, (_, j) => (j === 1 ? 1 : 0));
  const jit = (v, k) => v.map((x, j) => x + (j === 2 + (k % 5) ? 0.05 : 0));
  // 0~30초: A·B가 1.5초씩 번갈아(A가 더 많이), 묶음 0 하나로 잡힘. 30초 뒤 묶음 1(C)
  const turns = [];
  for (let k = 0; k < 20; k++) turns.push({ f: 0, s: k * 1.5, e: k * 1.5 + 1.5, n: 1, c: 0, v: jit(k % 3 === 2 ? vB : vA, k) });
  const vC = Array.from({ length: D }, (_, j) => (j === 7 ? 1 : 0));
  for (let k = 0; k < 6; k++) turns.push({ f: 0, s: 31 + k * 1.5, e: 32.5 + k * 1.5, n: 1, c: 1, v: vC });
  const diar = { kind: "diar", narrow: false, turns, clusters: [{ id: "S1", label: "Speaker 1", vec: vA, dur: 30 }, { id: "S2", label: "Speaker 2", vec: vC, dur: 9 }], units: [] };
  const nd = splitCluster(diar, 0, { 갑: vB });
  assert.ok(nd);
  assert.equal(nd.clusters.length, 3);
  assert.equal(nd.clusters[2].id, "S3");
  const bTurns = turns.map((t, k) => k).filter((k) => k < 20 && k % 3 === 2);
  assert.ok(bTurns.every((k) => nd.turns[k].c === 2), "B 목소리가 새 묶음으로"); // 짧은 쪽(B)이 새 번호
  assert.ok(nd.turns.slice(0, 20).filter((t, k) => k % 3 !== 2).every((t) => t.c === 0));
  assert.ok(nd.turns.slice(20).every((t) => t.c === 1)); // 다른 묶음은 그대로
  assert.equal(nd.clusters[2].suggest.name, "갑"); // 이름 추천도 다시
  assert.ok(nd.units.some((u) => u.c === 2) && nd.clusters[2].samples.length > 0);
  assert.equal(diar.clusters.length, 2); // 입력은 그대로
  assert.equal(splitCluster(diar, 1, {}), null); // 한 목소리뿐이면 나누지 않음
  assert.equal(splitCluster({ ...diar, turns: turns.slice(0, 3) }, 0), null); // 너무 적으면 못 나눔
});

import { relabelRange, similarRegions, mixSuspects } from "../../web/src/diar.js";
test("구간 손보기: 경계에서 잘라 옮기고, 비슷한 곳을 찾고, 섞인 곳을 알려 준다", () => {
  const D = 8, e0 = (j) => Array.from({ length: D }, (_, i) => (i === j ? 1 : 0));
  const vA = e0(0), vB = e0(1), vC = e0(7);
  const jit = (v, k) => v.map((x, j) => x + (j === 2 + (k % 5) ? 0.05 : 0));
  // 0~30초 묶음 0: A가 대부분, 9~12초·21~24초에 B. 31초 뒤 묶음 1(C)
  const turns = [];
  for (let k = 0; k < 20; k++) { const s = k * 1.5, b = (s >= 9 && s < 12) || (s >= 21 && s < 24); turns.push({ f: 0, s, e: s + 1.5, n: 1, c: 0, v: jit(b ? vB : vA, k) }); }
  for (let k = 0; k < 6; k++) turns.push({ f: 0, s: 31 + k * 1.5, e: 32.5 + k * 1.5, n: 1, c: 1, v: vC });
  const diar = { kind: "diar", turns, clusters: [{ id: "S1", label: "Speaker 1", vec: vA }, { id: "S2", label: "Speaker 2", vec: vC }], units: [] };
  // 섞였을 수 있는 곳: B 두 곳
  const mx = mixSuspects(diar, { minDur: 1 });
  assert.equal(mx.length, 2);
  assert.deepEqual(mx.map((r) => [r.s, r.e]), [[9, 12], [21, 24]]);
  // 9.4~11.8초를 새 사람으로 — 경계에서 잘림
  const r = relabelRange(diar, 0, 9.4, 11.8, "new", { 갑: vB });
  assert.equal(r.to, 2); assert.equal(r.from, 0);
  const moved = r.diar.turns.filter((t) => t.c === 2);
  assert.equal(Math.min(...moved.map((t) => t.s)), 9.4);
  assert.equal(Math.max(...moved.map((t) => t.e)), 11.8);
  assert.ok(moved.every((t) => t.m && t.ref));
  assert.ok(r.diar.turns.some((t) => t.c === 0 && t.s === 9 && t.e === 9.4)); // 앞 자투리는 원래 묶음
  assert.equal(r.diar.clusters[2].suggest.name, "갑");
  assert.equal(r.diar.manual.length, 1);
  // 비슷한 곳: 21~24초가 나와야
  const sim = similarRegions(r.diar, 0, 2);
  assert.equal(sim.length, 1);
  assert.deepEqual([sim[0].s, sim[0].e], [21, 24]);
  // 옮긴 뒤엔 섞인 곳 목록에서 빠짐(사람이 정한 차례 제외)
  const r2 = relabelRange(r.diar, 0, 21, 24, 2, {}, { ref: false });
  assert.equal(similarRegions(r2.diar, 0, 2).length, 0);
  // 빼기: 전사 발언 단위에서 빠짐
  const r3 = relabelRange(diar, 0, 31, 34, "drop");
  assert.ok(r3.diar.turns.filter((t) => t.s >= 31 && t.e <= 34).every((t) => t.c === -1));
  assert.ok(!r3.diar.units.some((u) => u.s < 34 && u.e > 31.1 && u.s >= 31));
  assert.equal(relabelRange(diar, 0, 50, 60, 0), null); // 말소리 없는 곳
});

import { hms as _hms } from "../../web/src/export.js";
test("시각 표시는 내림: 0:40.7은 0:40(반올림하면 실제 소리보다 늦게 적힘)", () => {
  assert.equal(_hms(40.7, false), "0:40");
  assert.equal(_hms(59.99, false), "0:59");
  assert.equal(_hms(3600.5), "01:00:00");
});

import { exportCsv, mergeBackup } from "../../web/src/export.js";
test("점검 보완: 짧은 조각 나누기·지운 글 빼기·CSV 수식 막기·이름 대기 백업은 중지", () => {
  const g = { i: 1, start: 10, end: 10.15 };
  const p = splitPart(g, null, 0, "네 네", 1);
  assert.ok(p[1].start > 10 && p[1].start < 10.15, "아주 짧은 발언도 조각 시각이 발언 안");
  const result = { stats: {}, segs: [{ i: 1, start: 1, end: 2, speaker: "갑", text: "헛말" }, { i: 2, start: 3, end: 4, speaker: "을", text: "-5억 원, \"확정\"" }] };
  const data = { job: { mode: "diar", audioFiles: [{ name: "a.wav" }] }, result, edits: { e: { 1: { text: "" } } }, plaud: [], glossary: [] };
  assert.equal(mergedLines(data).length, 1);
  const csv = exportCsv(data);
  assert.ok(csv.includes(`"'-5억 원, ""확정"""`));
  const r = mergeBackup({ voiceprints: {}, glossary: [], jobIds: new Set() }, { jobs: { x: { job: { status: "이름 대기" } } } });
  assert.equal(r.jobs.x.job.status, "중지");
});

test("묶음 번호는 다시 쓰지 않음·비슷한 곳 옮기기는 원래 묶음 차례만", () => {
  const e0 = (j) => Array.from({ length: 8 }, (_, i) => (i === j ? 1 : 0));
  const T = [];
  for (let k = 0; k < 6; k++) T.push({ f: 0, s: k * 3, e: k * 3 + 3, n: 1, c: 0, v: e0(0) });
  T.push({ f: 0, s: 9.2, e: 9.6, n: 1, c: 2, v: e0(2) }); // S3의 짧은 「네」가 S1 사이에
  T.push({ f: 0, s: 30, e: 33, n: 1, c: 1, v: e0(1) });
  const diar = { kind: "diar", turns: T, clusters: ["S1", "S2", "S3"].map((id, i) => ({ id, label: "Speaker " + (i + 1), vec: e0(i) })), units: [] };
  const a = relabelRange(diar, 0, 9.1, 9.7, 0, {}); // S3 전부 → S1, S3 지워짐
  assert.deepEqual(a.diar.clusters.map((c) => c.id), ["S1", "S2"]);
  const b = relabelRange(a.diar, 0, 0, 3, "new", {});
  assert.equal(b.diar.clusters[b.to].id, "S4"); // 지워진 S3를 다시 쓰지 않음(옛 이름·빼기가 붙지 않게)
  const c = relabelRange(diar, 0, 6, 12, 1, {}, { only: 0 });
  assert.ok(c.diar.turns.some((t) => t.s === 9.2 && c.diar.clusters[t.c].id === "S3")); // 사이에 낀 S3 차례는 그대로
});

import { jobFlow } from "../../web/src/review.js";
test("녹음 카드: 진행 단계와 지금 할 일", () => {
  const S = (f) => f.steps.map((s) => s.state[0]).join("");
  let f = jobFlow({ mode: "diar", status: "처리중", stage: "diar" });
  assert.equal(S(f), "dpttt" + "t"); assert.equal(f.badge, "화자 분리 중"); assert.equal(f.action, null); assert.ok(f.busy);
  assert.equal(f.group, "run"); assert.equal(f.stage, "diar");
  f = jobFlow({ mode: "diar", status: "이름 대기" });
  assert.equal(S(f), "ddcttt"); assert.equal(f.action.label, "화자 이름 지정 →");
  f = jobFlow({ mode: "diar", status: "중지", stage: "transcribe" });
  assert.equal(S(f), "dddstt"); assert.equal(f.action.a, "resume");
  f = jobFlow({ mode: "diar", status: "완료" }, { ok: 2, all: 10 });
  assert.equal(S(f), "ddddct"); assert.equal(f.action.label, "검수 이어하기 · 남음 8 →");
  f = jobFlow({ mode: "diar", status: "완료" }, { ok: 10, all: 10 });
  assert.equal(f.action.label, "내보내기 →"); assert.equal(f.badge, "내보내기"); assert.equal(f.group, "todo"); assert.equal(f.stage, "ex");
  f = jobFlow({ mode: "gap", status: "완료" }, { ok: 10, all: 10, exportedAt: "x" });
  assert.equal(S(f), "dddd"); assert.equal(f.badge, "완료"); assert.equal(f.group, "done");
  assert.equal(jobFlow({ mode: "gap", status: "완료" }).action.label, "검수하기 →");
  assert.equal(jobFlow({ mode: "enroll", status: "완료" }).action.a, "voices");
  assert.equal(jobFlow({ mode: "fragment", status: "준비" }).badge, "등록 중");
});
