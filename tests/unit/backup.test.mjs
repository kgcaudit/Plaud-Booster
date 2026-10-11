import { test } from "node:test";
import assert from "node:assert/strict";
import { encryptBackup, decryptBackup, isEncrypted, backupName, ENC_FORMAT } from "../../web/src/backup.js";

const bk = { format: "plaud-booster-backup", version: 2, exportedAt: "2026-10-11T08:19:22Z", voiceprints: { 하상수: { items: { a: { vec: [0.1, -0.2], n: 3 } } } },
  glossary: [["덩규", "동규"]], jobs: { j1: { job: { title: "통화" }, result: { segs: [{ i: 1, text: "삼진일렉스랑 진행 경과는" }] } } } };

test("암호 걸린 백업: 겉에서는 글·이름이 보이지 않고, 같은 암호로만 그대로 풀린다", async () => {
  const enc = await encryptBackup(bk, "비밀번호1234", { iter: 2000 });
  const raw = JSON.stringify(enc);
  assert.equal(enc.format, ENC_FORMAT); assert.ok(isEncrypted(enc) && !isEncrypted(bk));
  for (const w of ["삼진", "하상수", "덩규", "통화", "plaud-booster-backup"]) assert.ok(!raw.includes(w), w + "가 보임");
  assert.deepEqual(await decryptBackup(enc, "비밀번호1234"), bk);
  await assert.rejects(decryptBackup(enc, "비밀번호1235"), /암호가 맞지 않거나/);
  const bad = { ...enc, data: enc.data.slice(0, -8) + "AAAAAAA=" }; // 한 군데라도 바뀌면 풀리지 않음
  await assert.rejects(decryptBackup(bad, "비밀번호1234"), /암호가 맞지 않거나/);
  await assert.rejects(encryptBackup(bk, "짧음"), /8자 이상/);
  // 같은 내용·같은 암호라도 매번 다른 파일(소금·초기값이 매번 새로)
  const enc2 = await encryptBackup(bk, "비밀번호1234", { iter: 2000 });
  assert.notEqual(enc2.data, enc.data);
});

test("백업 파일 이름은 영문만(한글이 깨지지 않게)", () => {
  const d = new Date(2026, 9, 11);
  assert.equal(backupName(d), "HAUD-AI-backup_20261011.json");
  assert.equal(backupName(d, true), "HAUD-AI-backup_20261011_plain.json");
});
