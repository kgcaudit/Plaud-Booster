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

test("작업 이름: 파일 이름을 다듬어 날짜·시각을 우리말로", () => {
  assert.equal(titleFromFiles(["통화 녹음 홍길동_260914_075100.m4a"]), "26년 9월 14일 오전 7시 51분 · 통화 녹음 홍길동");
  assert.equal(titleFromFiles(["251009_1430.MP3"]), "25년 10월 9일 오후 2시 30분");
  assert.equal(titleFromFiles(["음성 260914_075100.m4a"]), "26년 9월 14일 오전 7시 51분"); // 기기가 붙인 말은 뺌
  assert.equal(titleFromFiles(["2025-10-08 14-30-12 현장 면담.mp3"]), "25년 10월 8일 오후 2시 30분 · 현장 면담");
  assert.equal(titleFromFiles(["Recording_20251008_120000.wav"]), "25년 10월 8일 오후 12시");
  assert.equal(titleFromFiles(["10-09 현장_면담.m4a"]), "10-09 현장 면담");
  assert.equal(titleFromFiles(["251009_1430.wav", "251009_1520.wav"]), "25년 10월 9일 오후 2시 30분 외 1개");
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
