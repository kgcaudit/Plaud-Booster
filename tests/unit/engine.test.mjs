import { test } from "node:test";
import assert from "node:assert/strict";
import { runJob, label, isHallu, isGeneric, centroid, pacer, cleanText, gpuCrashed } from "../../web/src/engine.js";
import { exportTxt, exportCsv, mergeBackup, mergedLines } from "../../web/src/export.js";

// 합성 음원: 6초 주기(4초 말 + 2초 쉼). 화자는 시간대로 정해지는 가짜 특징(앞 30초 A, 뒤 B)
const SR = 16000;
function audio(sec) {
  const x = new Float32Array(sec * SR);
  for (let s = 0; s < sec; s += 6) for (let i = s * SR; i < (s + 4) * SR && i < x.length; i++) x[i] = 0.3 * Math.sin(i / 5);
  return x;
}
function makeCtx(x, extra = {}) {
  const store = { enroll: null, chunks: null, partial: {} };
  const vec = (who) => Float32Array.from({ length: 8 }, (_, i) => (who === "A" ? (i === 0 ? 1 : 0) : i === 1 ? 1 : 0));
  return {
    store,
    readAudio: async (fi, s, e) => { const a = x.subarray(Math.floor(s * SR), Math.floor(e * SR)); a.t0 = s; return a; },
    transcribe: async (a) => (extra.hallu && a.t0 > 60 ? "다음 영상에서 만나요" : `말 ${a.t0.toFixed(1)}`),
    embed: async (a) => vec(a.t0 < 30 ? "A" : "B"),
    plaud: [{ start: 0, end: 4, speaker: "Speaker 1", text: "가" }, { start: 6, end: 10, speaker: "Speaker 1", text: "나" }, { start: 36, end: 40, speaker: "B씨", text: "다" }, { start: 42, end: 46, speaker: "B씨", text: "라" }],
    vpStore: extra.vpStore || {},
    loadEnroll: async () => store.enroll, saveEnroll: async (v) => { store.enroll = v; },
    loadChunks: async () => store.chunks, saveChunks: async (c) => { store.chunks = c; },
    loadPartial: async () => ({ ...store.partial }), savePartial: async (r) => { store.partial[r.k] = r; },
    progress: () => {}, shouldStop: extra.shouldStop || (() => false),
  };
}

test("구간 재전사: 대상 밖 Plaud 이름 구간으로 기준을 만들고 화자를 맞힌다", async () => {
  const x = audio(90);
  const job = { mode: "range", range: { from: 24, to: 60 }, speakerMap: { "Speaker 1": "A씨" }, useVoiceprints: true };
  const ctx = makeCtx(x);
  const { result, fresh } = await runJob(job, [{ name: "a.wav", dur: 90 }], ctx);
  assert.deepEqual(Object.keys(fresh).sort(), ["A씨"]); // B씨 발언(36~46초)은 대상 구간 안이라 기준에서 빠진다
  assert.ok(result.segs.length >= 3);
  assert.ok(result.segs.every((g) => g.start >= 24 && g.end <= 60.2));
  assert.ok(result.segs.every((g) => g.speaker === "A씨" && g.kind === "단일"));
});

test("중간에 멈추면 이어서 하고, 같은 구간을 다시 전사하지 않는다", async () => {
  const x = audio(120);
  let calls = 0, stopAt = 3;
  const ctx = makeCtx(x, { shouldStop: () => calls >= stopAt });
  const t = ctx.transcribe; ctx.transcribe = async (a) => { calls++; return t(a); };
  const job = { mode: "fragment" };
  const r1 = await runJob(job, [{ name: "a.wav", dur: 120 }], ctx);
  assert.equal(r1.result, null);
  stopAt = Infinity;
  const r2 = await runJob(job, [{ name: "a.wav", dur: 120 }], ctx);
  assert.equal(calls, ctx.store.chunks.length);
  assert.equal(r2.result.segs.length, ctx.store.chunks.length);
  assert.ok(r2.result.segs.every((g) => g.kind === "미상")); // 기준이 없으면 미상
});

test("누락 구간 보충: 전사 끝-15초부터, 환각은 걸러 세기만 한다", async () => {
  const x = audio(90);
  const job = { mode: "gap", transcriptEndSec: 46, useVoiceprints: true };
  const vpStore = { "A씨": { items: { 옛회의: { vec: [1, 0, 0, 0, 0, 0, 0, 0], n: 10 } } } };
  const { result } = await runJob(job, [{ name: "a.wav", dur: 90 }], makeCtx(x, { hallu: true, vpStore }));
  assert.ok(result.segs.every((g) => g.start >= 31));
  assert.ok(result.stats.droppedHallucination > 0);
  assert.deepEqual(result.stats.speakersUsed, ["A씨", "Speaker 1"]); // B씨 발언은 보충 대상 구간 안이라 기준에서 빠짐
});

test("판정 규칙", () => {
  assert.deepEqual(label({ 갑: 0.8, 을: 0.2 }, { 갑: 0.7, 을: 0.3 }), ["갑", "단일", 0.8]);
  assert.deepEqual(label({ 갑: 0.8, 을: 0.2 }, { 갑: 0.5, 을: 0.45 }), ["갑", "단일", 0.55]);
  assert.deepEqual(label({ 갑: 0.6, 을: 0.4 }, {}), ["갑·을", "혼재", 0.6]);
  assert.deepEqual(label({}, {}), ["미상", "미상", 0]);
  assert.ok(isHallu("다음 영상에서 만나요") && isHallu("네네네네네네네네네네네네네네네네") && !isHallu("네 알겠습니다"));
  assert.ok(isGeneric("Speaker 2") && isGeneric("화자 3") && !isGeneric("김응옥"));
  const c = centroid({ items: { a: { vec: [1, 0], n: 3 }, b: { vec: [0, 1], n: 1 } } });
  assert.ok(c.vec[0] > c.vec[1] && c.n === 4);
});

test("통합본: Plaud 전사(대상 밖) + 보충 결과 + 검수 + 사전", () => {
  const data = {
    job: { title: "회의", mode: "gap", audioFiles: [{ name: "a.mp3" }], speakerMap: { "Speaker 1": "김씨" } },
    result: { segs: [{ i: 1, file: 0, start: 100, end: 105, text: "윤택 팀장님", speaker: "박씨", kind: "단일", conf: 0.9 }, { i: 2, file: 0, start: 110, end: 115, text: "둘", speaker: "박씨·김씨", kind: "혼재", conf: 0.5 }], stats: { targets: [{ file: 0, from: 95, to: 200 }] } },
    edits: { e: { 2: { speaker: "김씨" } } },
    plaud: [{ start: 10, end: 20, speaker: "Speaker 1", text: "앞" }, { start: 96, end: 99, speaker: "Speaker 1", text: "겹침" }],
    glossary: [{ from: "윤택", to: "윤태길" }],
  };
  const lines = mergedLines(data);
  assert.deepEqual(lines.map((l) => [l.spk, l.text, l.src]), [["김씨", "앞", "Plaud"], ["박씨", "윤태길 팀장님", "보충"], ["김씨", "둘", "보충"]]);
  const txt = exportTxt(data);
  assert.match(txt, /\[00:01:40\] 박씨 \(보충\): 윤태길 팀장님/);
  assert.match(exportCsv(data), /^﻿파일,시각,화자,발언,출처\r\n/);
});

test("백업 합치기: 목소리 기준은 출처별로 더하고 같은 작업은 건너뛴다", () => {
  const cur = { voiceprints: { 갑: { items: { r1: { vec: [1], n: 1 } } } }, glossary: [{ from: "a", to: "b" }], jobIds: new Set(["j1"]) };
  const bk = { voiceprints: { 갑: { items: { r1: { vec: [9], n: 9 }, r2: { vec: [1], n: 2 } } }, 을: { items: { r1: { vec: [1], n: 1 } } } },
    glossary: [{ from: "a", to: "b" }, { from: "c", to: "d" }], jobs: { j1: { job: {} }, j2: { job: { status: "처리중" } } } };
  const m = mergeBackup(cur, bk);
  assert.deepEqual(m.added, { voiceprints: 2, glossary: 1, jobs: 1 });
  assert.equal(m.voiceprints.갑.items.r1.n, 1);
  assert.equal(m.jobs.j2.job.status, "중지");
  assert.equal(m.jobs.j2.job.audioDeleted, true);
});

test("기준 만들기: 한 사람당 창 수를 제한하되 회의 전체에서 고르게 고른다", async () => {
  const { enroll } = await import("../../web/src/engine.js");
  const segs = Array.from({ length: 50 }, (_, k) => ({ start: k * 20, end: k * 20 + 13, speaker: "갑" })); // 발언당 창 2개 → 100개
  const seen = [];
  const out = await enroll(async (a) => { seen.push(a); return Float32Array.of(1, 0); }, segs, () => true, () => {}, 30);
  assert.equal(seen.length, 30);
  assert.equal(out.갑.n, 30);
  assert.ok(Math.min(...seen) < 20 && Math.max(...seen) > 900);
});

test("느려짐 알림: 최근 구간이 처음보다 1.8배 넘게 느려야만 알린다", () => {
  let t = 0; const step = (d) => { t += d; };
  const p = pacer(() => t);
  let msg = "";
  for (let k = 0; k < 16; k++) { step(1000); msg = p(); }
  assert.equal(msg, "");
  for (let k = 0; k < 8; k++) { step(2500); msg = p(); }
  assert.match(msg, /느려졌습니다/);
  const q = pacer(() => t);
  for (let k = 0; k < 24; k++) { step(1200 + (k % 3) * 100); msg = q(); }
  assert.equal(msg, "");
});

test("대화체 줄표 걷어 내기", () => {
  assert.equal(cleanText("- 아, 됐어. - 응. - 그거"), "아, 됐어. 응. 그거");
  assert.equal(cleanText("-사무소 전화번호 잡고 있었어. - -"), "사무소 전화번호 잡고 있었어.");
  assert.equal(cleanText("- -"), "");
  assert.equal(cleanText("A-15 번하고 3-4번"), "A-15 번하고 3-4번");
});

test("그래픽 칩 시험 구간 중 꺼짐 판정: 정상 종료 뒤면 꺼진 것이 아님", () => {
  const at = "2026-10-10T00:00:10Z", t = Date.parse(at);
  assert.equal(gpuCrashed(null, 0), false);           // 시험 표시 없음
  assert.equal(gpuCrashed({ at }, 0), true);          // 표시가 남았고 정상 종료 기록 없음 → 꺼짐
  assert.equal(gpuCrashed({ at }, t - 5000), true);   // 정상 종료가 시험 시작보다 앞 → 그 뒤에 꺼짐
  assert.equal(gpuCrashed({ at }, t + 3000), false);  // 시험 중 새로 고침·탭 닫기
});

import { isHallu as _isHallu } from "../../web/src/engine.js";
test("영어 녹음의 영상 자막 말투는 환각으로 거르고, 「Thank you.」 한마디는 둔다", () => {
  assert.ok(_isHallu("Thank you for watching!"));
  assert.ok(_isHallu("Thanks for watching."));
  assert.ok(_isHallu("Please subscribe to my channel"));
  assert.ok(_isHallu("Subtitles by the Amara.org community"));
  assert.ok(!_isHallu("Thank you."));
  assert.ok(!_isHallu("We reviewed the progress billing for March."));
});

import { leadPad } from "../../web/src/engine.js";
test("전사 앞 여유: 조용한 뒤엔 0.5초까지, 앞 발언에 붙어 있으면 0.15초", () => {
  assert.equal(leadPad(3), 0.5);
  assert.equal(leadPad(0.3), 0.25);
  assert.equal(leadPad(0.05), 0.15);
  assert.equal(leadPad(undefined), 0.5); // 첫 발언
});

import { packGroups as _pg } from "../../web/src/engine.js";
test("묶은 창은 실제로 읽는 길이(앞뒤 여유 포함)로 24초를 넘지 않는다", () => {
  const U = Array.from({ length: 20 }, (_, k) => ({ f: 0, c: 0, s: k * 10, e: k * 10 + 1 }));
  const extra = () => 0.65;
  for (const g of _pg(U, U.map((_, k) => k), { extra })) {
    const real = g.reduce((m, k) => m + (U[k].e - U[k].s) + 0.65, 0) + 0.6 * (g.length - 1);
    assert.ok(real <= 24.0001, `창 ${real}초`);
  }
});

import { winSig, planTargets, regionsOf } from "../../web/src/engine.js";
import { activeEnd } from "../../web/src/dsp.js";
test("안정화: 특징 묶음 서명·누락 구간 끝 찾기는 10분씩 읽어도 같음·중지 확인", async () => {
  const w = [{ f: 0, s: 1, e: 4 }, { f: 0, s: 2.5, e: 5.5 }];
  assert.equal(winSig(w, 0, 2), winSig(w.map((x) => ({ ...x })), 0, 2));
  assert.notEqual(winSig(w, 0, 2), winSig([w[0], { f: 0, s: 2.6, e: 5.5 }], 0, 2)); // 창이 달라지면 서명도 다름
  // 누락 구간 끝: 통째로 읽은 것과 10분씩 읽은 것이 같다
  const x = audio(1500); x.fill(0, 900 * SR);
  const reads = [];
  const ra = async (fi, s, e) => { reads.push(e - s); return x.subarray(Math.floor(s * SR), Math.floor(e * SR)); };
  const [[, t0, end]] = await planTargets({ mode: "gap", transcriptEndSec: 115 }, [{ dur: 1500 }], 0, ra);
  assert.equal(end, activeEnd(x.subarray(100 * SR), 100, 1500));
  assert.ok(t0 === 100 && Math.max(...reads) <= 600);
  // 중지하면 말소리 찾기를 멈춘다
  const r = await regionsOf({ readAudio: ra, shouldStop: () => true }, 0, 0, 1500);
  assert.ok(r.stopped && r.length === 0);
  // 목소리 기준 만들기 중지 → 결과 없음(저장 안 함)
  const ctx = makeCtx(audio(90), { shouldStop: () => true });
  const res = await runJob({ mode: "range", range: { from: 24, to: 60 } }, [{ name: "a.wav", dur: 90 }], ctx);
  assert.equal(res.result, null); assert.equal(ctx.store.enroll, null);
});
