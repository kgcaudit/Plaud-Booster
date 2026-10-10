import { test } from "node:test";
import assert from "node:assert/strict";
import { matchGpu, describeDevice, levelForScore, levelForArch, modelName, lowerLevel } from "../../web/src/devices.js";

test("그래픽 칩 이름 알아보기(WebGL 문자열 여러 꼴)", () => {
  assert.equal(matchGpu("ANGLE (Qualcomm, Adreno (TM) 660, OpenGL ES 3.2)").name, "Adreno 660");
  assert.equal(matchGpu("Adreno (TM) 840").name, "Adreno 840");
  assert.equal(matchGpu("ANGLE (Samsung Xclipse 940) on Vulkan 1.3.231").name, "Xclipse 940");
  assert.equal(matchGpu("Mali-G78 MP14").name, "Mali-G78");
  assert.equal(matchGpu("SwiftShader"), null);
});

test("기본 단계: 폴드8(840) 전부 · S23(740) 절반 · 플립3(660) 끄기 · 모르면 세대로", () => {
  assert.equal(describeDevice({ webgpu: true, renderer: "Adreno (TM) 840", model: "SM-F976N" }).level, 4);
  assert.equal(describeDevice({ webgpu: true, renderer: "Adreno (TM) 740", model: "SM-S911N" }).level, 2);
  const flip3 = describeDevice({ webgpu: true, renderer: "ANGLE (Qualcomm, Adreno (TM) 660, OpenGL ES 3.2)", model: "SM-F711N" });
  assert.equal(flip3.level, 0); assert.equal(flip3.name, "갤럭시 Z 플립3"); assert.equal(flip3.soc, "Snapdragon 888");
  assert.equal(describeDevice({ webgpu: true, renderer: "?", arch: "adreno-8xx" }).level, 4);
  assert.equal(describeDevice({ webgpu: true, renderer: "?", arch: "adreno-7xx" }).level, 2);
  assert.equal(describeDevice({ webgpu: false, renderer: "Adreno (TM) 840" }).level, 0); // WebGPU 없으면 끄기
  assert.equal(levelForScore(4190), 4); assert.equal(levelForScore(2550), 2); assert.equal(levelForScore(1870), 0);
  assert.equal(levelForArch("adreno-6xx"), 0);
  assert.equal(modelName("sm-s928n"), "갤럭시 S24 Ultra");
  assert.deepEqual([4, 2, 1, 0].map(lowerLevel), [2, 1, 0, 0]);
});
