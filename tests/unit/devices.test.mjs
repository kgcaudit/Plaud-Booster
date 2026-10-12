import { test } from "node:test";
import assert from "node:assert/strict";
import { matchGpu, describeDevice, levelForScore, levelForArch, levelForTs, modelName, lowerLevel } from "../../web/src/devices.js";

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
  // 노트북 외장 칩(실측으로 단계): MX570 A는 전부, 내장 Intel은 모르는 칩이라 끔
  const mx = describeDevice({ webgpu: true, renderer: "ANGLE (NVIDIA, NVIDIA GeForce MX570 A (0x000025AA) Direct3D11 vs_5_0 ps_5_0, D3D11)", arch: "ampere" });
  assert.equal(mx.level, 4); assert.equal(mx.gpu, "GeForce MX570"); assert.match(mx.basis, /실측/);
  assert.equal(describeDevice({ webgpu: true, renderer: "ANGLE (Intel, Intel(R) Graphics (0x0000A7AC) Direct3D11 vs_5_0 ps_5_0, D3D11)", arch: "gen-12lp" }).level, 0);
  assert.equal(describeDevice({ webgpu: true, renderer: "?", arch: "adreno-7xx" }).level, 2);
  assert.equal(describeDevice({ webgpu: false, renderer: "Adreno (TM) 840" }).level, 0); // WebGPU 없으면 끄기
  assert.equal(levelForScore(4190), 4); assert.equal(levelForScore(2550), 2); assert.equal(levelForScore(1870), 0);
  assert.equal(levelForArch("adreno-6xx"), 0);
  assert.equal(modelName("sm-s928n"), "갤럭시 S24 Ultra");
  assert.equal(modelName("SM-F971N"), "갤럭시 Z 폴드8");
  assert.deepEqual([4, 2, 1, 0].map(lowerLevel), [2, 1, 0, 0]);
});

test("PC 그래픽 칩: Time Spy 그래픽 점수로 단계(3,000 이상 전부·1,500 이상 절반), Intel 내장은 장치 번호로 가림", () => {
  const lv = (r) => describeDevice({ webgpu: true, renderer: r }).level;
  const A = (s) => `ANGLE (NVIDIA, NVIDIA ${s} Direct3D11 vs_5_0 ps_5_0, D3D11)`, I = (s) => `ANGLE (Intel, Intel(R) ${s} Direct3D11 vs_5_0 ps_5_0, D3D11)`;
  assert.equal(levelForTs(3306), 4); assert.equal(levelForTs(2472), 2); assert.equal(levelForTs(1175), 0);
  // NVIDIA
  assert.equal(lv(A("GeForce RTX 4060 Laptop GPU (0x000028E0)")), 4);
  assert.equal(lv(A("GeForce RTX 5070 Ti (0x00002C05)")), 4);
  assert.equal(lv(A("GeForce RTX 3050 6GB Laptop GPU (0x000025EC)")), 4);
  assert.equal(lv(A("GeForce RTX 2050 (0x000025AD)")), 4);
  assert.equal(lv(A("RTX 500 Ada Generation Laptop GPU (0x000028BB)")), 4);
  assert.equal(lv(A("GeForce MX550 (0x00001F9F)")), 2);
  assert.equal(lv(A("RTX A500 Laptop GPU (0x000025BB)")), 2);
  assert.equal(lv(A("GeForce MX350 (0x00001C94)")), 0);
  // Intel — 이름이 같아도 장치 번호로
  assert.equal(lv(I("Graphics (0x0000A7AC)")), 0); // Raptor Lake-U Xe-LP(사용자 노트북 내장)
  assert.equal(lv(I("Iris(R) Xe Graphics (0x0000A7A1)")), 0);
  assert.equal(lv(I("Graphics (0x00007DD1)")), 2); // Arrow Lake 4코어
  assert.equal(lv(I("Arc(TM) Graphics (0x00007D55)")), 2); // Meteor Lake Arc 7~8코어
  assert.equal(lv(I("Arc(TM) 140V GPU (16GB) (0x000064A0)")), 4);
  assert.equal(lv(I("Arc(TM) 130T GPU (0x00007D51)")), 2);
  assert.equal(lv(I("Arc(TM) B390 GPU (0x0000B080)")), 4);
  assert.equal(lv(I("Arc(TM) B580 Graphics (0x0000E20B)")), 4);
  // 이름을 모를 때 세대로
  assert.equal(levelForArch("lovelace"), 4); assert.equal(levelForArch("turing"), 2); assert.equal(levelForArch("xe-2hpg"), 4);
  assert.equal(levelForArch("xe-lpg"), 2); assert.equal(levelForArch("gen-12lp"), 0);
});
