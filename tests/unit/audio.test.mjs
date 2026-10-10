// 휴대폰 녹음(m4a·aac)을 ADTS 조각으로 바꾸는 부분 — ffmpeg로 만든 파일로 확인한다(ffmpeg가 없으면 건너뜀)
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { mp4Audio, adtsFrames, adtsChunk, parseAsc } from "../../web/src/audio.js";

const HAS = spawnSync("ffmpeg", ["-version"]).status === 0;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pb-aac-"));
after(() => fs.rmSync(tmp, { recursive: true, force: true })); // 시험 뒤 임시 폴더를 남기지 않음
const ff = (...a) => { const r = spawnSync("ffmpeg", ["-loglevel", "error", "-y", ...a]); assert.equal(r.status, 0, String(r.stderr)); };
function pcm(file, ch = 1) { // ffmpeg로 풀어 16비트 표본
  const out = path.join(tmp, "o.raw");
  ff("-i", file, "-f", "s16le", "-ac", String(ch), out);
  const b = fs.readFileSync(out);
  return new Int16Array(b.buffer, b.byteOffset, b.length / 2);
}

test("AudioSpecificConfig 읽기(LC·HE-AAC)", () => {
  assert.deepEqual(parseAsc(Uint8Array.of(0x12, 0x10)), { aot: 2, sfi: 4, sr: 44100, ch: 2 });
  assert.deepEqual(parseAsc(Uint8Array.of(0x2b, 0x92, 0x08, 0x00)), { aot: 2, sfi: 7, sr: 22050, ch: 2 }); // HE-AAC → 바탕 LC
});

test("m4a: 프레임을 ADTS로 이으면 원본과 같은 소리, 생성 시각도 읽는다", { skip: !HAS }, () => {
  const src = path.join(tmp, "a.m4a");
  ff("-f", "lavfi", "-i", "sine=frequency=330:duration=30", "-f", "lavfi", "-i", "sine=frequency=520:duration=30", "-filter_complex", "[0][1]amerge=inputs=2",
    "-ar", "48000", "-ac", "2", "-c:a", "aac", "-b:a", "96k", "-metadata", "creation_time=2025-10-09T05:30:00Z", src);
  const b = new Uint8Array(fs.readFileSync(src));
  const t = mp4Audio(b);
  assert.ok(t, "m4a 읽기");
  assert.equal(t.asc.sr, 48000); assert.equal(t.asc.ch, 2); assert.equal(t.asc.aot, 2);
  assert.equal(t.createdAt.toISOString(), "2025-10-09T05:30:00.000Z");
  assert.ok(Math.abs(t.off.length - (30 * 48000) / 1024) < 4, String(t.off.length));
  // 전부 이은 ADTS를 풀면 원본(m4a) 풀이와 앞쪽 지연만큼 어긋난 같은 소리
  const all = path.join(tmp, "all.aac");
  fs.writeFileSync(all, adtsChunk(b, t, 0, t.off.length));
  const x = pcm(src, 2), y = pcm(all, 2);
  let best = Infinity;
  for (const lag of [0, 1024, 2048, 2112]) {
    let d = 0;
    for (let i = 20000; i < 200000; i++) d = Math.max(d, Math.abs(x[i] - y[i + lag * 2]));
    best = Math.min(best, d);
  }
  assert.ok(best < 64, "최대 차이 " + best);
  // 중간 조각만 떼어도 풀리고 길이가 프레임 수와 맞는다
  const part = path.join(tmp, "part.aac");
  fs.writeFileSync(part, adtsChunk(b, t, 500, 800));
  const z = pcm(part, 2);
  assert.ok(Math.abs(z.length / 2 - 300 * 1024) <= 2048, String(z.length));
  assert.ok(z.slice(4096, 8192).some((v) => Math.abs(v) > 1000));
});

test("날 AAC(.aac ADTS) 프레임 목록", { skip: !HAS }, () => {
  const src = path.join(tmp, "b.aac");
  ff("-f", "lavfi", "-i", "sine=frequency=300:duration=10", "-ar", "44100", "-ac", "1", "-c:a", "aac", "-b:a", "64k", "-f", "adts", src);
  const b = new Uint8Array(fs.readFileSync(src));
  const t = adtsFrames(b);
  assert.ok(t && t.adts);
  assert.equal(t.asc.sr, 44100); assert.equal(t.asc.ch, 1);
  assert.ok(Math.abs(t.off.length - (10 * 44100) / 1024) < 4);
  assert.deepEqual(adtsChunk(b, t, 0, t.off.length), b.subarray(t.off[0], t.off[t.off.length - 1] + t.size[t.off.length - 1]));
});

test("m4a가 아닌 파일은 null", () => {
  assert.equal(mp4Audio(new Uint8Array(100)), null);
});
