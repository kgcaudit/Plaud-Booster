// 기기·그래픽 칩 알아보기와 그래픽 칩 가속 단계 정하기 — 순수 함수(화면·시험 공용).
//
// 브라우저가 알려 주는 것(허락 창 없음, 바깥으로 보내지 않음):
//   · WebGL 그래픽 칩 이름  예: "ANGLE (Qualcomm, Adreno (TM) 660, OpenGL ES 3.2)" → 정확한 칩 이름
//   · WebGPU 어댑터 정보    예: vendor "qualcomm", architecture "adreno-6xx" → 세대만
//   · 클라이언트 힌트 모델  예: "SM-F711N" → 기기 이름 표시용
// 삼성 국내판은 같은 S 시리즈라도 해마다 엑시노스·스냅드래곤이 섞이므로, 단계는 모델 번호가 아니라 그래픽 칩 이름으로 정한다.
//
// 점수: 휴대폰은 3DMark Wild Life Extreme Unlimited(score), PC는 3DMark Time Spy 그래픽(ts) — Notebookcheck 모음 기준(2026-10 조사).
//   est: true는 직접 수치가 없어 발표 비율 등으로 어림한 값.
export const GPU_TABLE = [
  { re: /adreno\D{0,8}840/i, name: "Adreno 840", soc: "Snapdragon 8 Elite Gen 5", score: 7500, est: true },
  { re: /adreno\D{0,8}830/i, name: "Adreno 830", soc: "Snapdragon 8 Elite", score: 6400 },
  { re: /adreno\D{0,8}750/i, name: "Adreno 750", soc: "Snapdragon 8 Gen 3", score: 4500, est: true },
  { re: /adreno\D{0,8}740/i, name: "Adreno 740", soc: "Snapdragon 8 Gen 2", score: 3650 },
  { re: /adreno\D{0,8}735/i, name: "Adreno 735", soc: "Snapdragon 8s Gen 3", score: 3300, est: true },
  { re: /adreno\D{0,8}732/i, name: "Adreno 732", soc: "Snapdragon 7+ Gen 3", score: 3000, est: true },
  { re: /adreno\D{0,8}730/i, name: "Adreno 730", soc: "Snapdragon 8 (+) Gen 1", score: 2550 },
  { re: /adreno\D{0,8}725/i, name: "Adreno 725", soc: "Snapdragon 7+ Gen 2", score: 2000, est: true },
  { re: /adreno\D{0,8}720/i, name: "Adreno 720", soc: "Snapdragon 7 Gen 3", score: 1480 },
  { re: /adreno\D{0,8}660/i, name: "Adreno 660", soc: "Snapdragon 888", score: 1450 },
  { re: /adreno\D{0,8}650/i, name: "Adreno 650", soc: "Snapdragon 865", score: 1100, est: true },
  { re: /xclipse\D{0,8}950/i, name: "Xclipse 950", soc: "Exynos 2500", score: 4500, est: true },
  { re: /xclipse\D{0,8}940/i, name: "Xclipse 940", soc: "Exynos 2400", score: 4190 },
  { re: /xclipse\D{0,8}930/i, name: "Xclipse 930", soc: "Exynos 2300", score: 2500, est: true },
  { re: /xclipse\D{0,8}920/i, name: "Xclipse 920", soc: "Exynos 2200", score: 1870 },
  { re: /mali-?g78/i, name: "Mali-G78", soc: "Exynos 2100 등", score: 1760 },
  // ───────── PC(Windows) — 휴대폰과 달리 3DMark Time Spy 그래픽 점수(ts)로 단계를 정한다(levelForTs) ─────────
  // 기준점(실측): GeForce MX570 A(ts 약 3,300) 전부 4/4 30초 창 2.7~3.3초 · CPU 12스레드 18초(약 5.6배), 꺼짐 없음.
  // 점수: Notebookcheck 평균(노트북)·ComputerBase(데스크톱), 2026-10-12 조사. est는 같은 칩 다른 값·형제 칩으로 어림.
  { re: /geforce\s*mx\s*570/i, name: "GeForce MX570", soc: "노트북 외장(NVIDIA)", level: 4, measured: "30초 창 2.7초(CPU만 18초)", ts: 3306 },
  // NVIDIA — 이름이 칩마다 달라 이름으로 가린다(노트북은 「Laptop GPU」, MX·2050은 붙지 않음)
  { re: /geforce\s*mx\s*550/i, name: "GeForce MX550", soc: "노트북 외장(NVIDIA)", ts: 2472 },
  { re: /geforce\s*mx\s*450/i, name: "GeForce MX450", soc: "노트북 외장(NVIDIA)", ts: 1796 },
  { re: /geforce\s*mx\s*[1-3]\d0/i, name: "GeForce MX100~300번대", soc: "노트북 외장(NVIDIA)", ts: 1322 },
  { re: /geforce\s*rtx\s*2050/i, name: "GeForce RTX 2050", soc: "노트북 외장(NVIDIA)", ts: 3155 },
  { re: /geforce\s*rtx\s*3050/i, name: "GeForce RTX 3050", soc: "NVIDIA", ts: 4448 },
  { re: /geforce\s*rtx\s*50[5-9]0/i, name: "GeForce RTX 50번대", soc: "NVIDIA", ts: 8958 },
  { re: /geforce\s*rtx\s*40[5-9]0/i, name: "GeForce RTX 40번대", soc: "NVIDIA", ts: 7679 },
  { re: /geforce\s*rtx\s*(?:20[6-9]0|30[6-9]0)/i, name: "GeForce RTX 20·30번대", soc: "NVIDIA", ts: 5000, est: true },
  { re: /rtx\s*(?:pro\s*)?\d{3,4}\s*(?:ada|blackwell)/i, name: "RTX Ada·Blackwell(업무용)", soc: "NVIDIA", ts: 5449 },
  { re: /rtx\s*a500\b/i, name: "RTX A500", soc: "노트북 외장(NVIDIA)", ts: 2995 },
  { re: /rtx\s*a\d{4}/i, name: "RTX A1000 이상(업무용)", soc: "NVIDIA", ts: 4256 },
  // Intel 이름이 분명한 것(Arc ○○○V·T·B, 외장 Arc)
  { re: /arc\S*\s*140v/i, name: "Arc 140V", soc: "Core Ultra 200V(Lunar Lake)", ts: 3883 },
  { re: /arc\S*\s*130v/i, name: "Arc 130V", soc: "Core Ultra 200V(Lunar Lake)", ts: 3381 },
  { re: /arc\S*\s*140t/i, name: "Arc 140T", soc: "Core Ultra 200H(Arrow Lake)", ts: 3719 },
  { re: /arc\S*\s*130t/i, name: "Arc 130T", soc: "Core Ultra 200H(Arrow Lake)", ts: 2378 },
  { re: /arc\S*\s*b3[79]0/i, name: "Arc B390·B370", soc: "Core Ultra 300(Panther Lake)", ts: 6050 },
  { re: /arc\S*\s*(?:pro\s*)?[ab]\d{3}m?\b/i, name: "Arc 외장(A·B 시리즈)", soc: "Intel 외장", ts: 3269 },
  // Intel 내장 — 「Intel(R) Graphics」처럼 이름이 여러 칩에 같아, 이름 뒤 장치 번호(0x0000○○○○)로 가린다
  { re: /\(0x0000(?:B080|B081|B082|B083|B084|B085|B086|B087)\)/i, name: "Arc B390·B370", soc: "Core Ultra 300(Panther Lake)", ts: 6050 },
  { re: /\(0x0000(?:7D55)\)/i, name: "Arc 내장(7~8 Xe)", soc: "Core Ultra 100H(Meteor Lake)", ts: 2881 },
  { re: /\(0x0000(?:7D51)\)/i, name: "Arc 140T·130T", soc: "Core Ultra 200H(Arrow Lake)", ts: 2378 },
  { re: /\(0x0000(?:64A0)\)/i, name: "Arc 140V·130V", soc: "Core Ultra 200V(Lunar Lake)", ts: 3381 },
  { re: /\(0x0000(?:6420|64B0)\)/i, name: "Intel Graphics(Lunar Lake)", soc: "Core Ultra 200V", ts: 2500, est: true },
  { re: /\(0x0000(?:B08F|B090|B0A0|B0B0)\)/i, name: "Intel Graphics(Xe3 4코어)", soc: "Core Ultra 300(Panther Lake)", ts: 2854 },
  { re: /\(0x0000(?:7DD5|7D45|7D40|7DD1|7D41|7D67)\)/i, name: "Intel Graphics(Xe-LPG 4코어)", soc: "Core Ultra 100·200(Meteor·Arrow Lake)", ts: 1855 },
  { re: /\(0x0000(?:9A49|9A40|46A6|46A8|46AA|A7A0|A7A1|A7AA|A7AB|A7AC)\)/i, name: "Iris Xe·Intel Graphics(Xe-LP)", soc: "11~13세대 Core·Core 100U", ts: 1175 },
  { re: /\(0x0000(?:9A78|9A60|9A68|9A70|46A3|46B3|46C3|4626|4628|462A|46D0|46D1|46D2|46D3|46D4|A7A8|A7A9|A721|A7AD)\)/i, name: "UHD Graphics(Xe-LP)", soc: "11~13세대 Core(i3 등)", ts: 1067 },
];

/** 가속 단계: 인코더 4조각 중 그래픽 칩에 올릴 조각 수 */
export const LEVELS = [
  { v: 4, label: "사용 - 빠름" },
  { v: 2, label: "사용 - 보통" },
  { v: 1, label: "사용 - 느림" },
  { v: 0, label: "끔" },
];
// 단계 이름은 모두 받침으로 끝나므로 뒤에 붙는 조사는 「으로」「이었지만」
export const levelLabel = (v) => (LEVELS.find((l) => l.v === v) || LEVELS[3]).label;

/**
 * 점수 → 기본 단계. 기준점(실측):
 *   Adreno 840(폴드8) 전부 4/4: 30초 창 4.7초, 꺼짐 없음
 *   Adreno 660(플립3) 전부 4/4: 성능 시험 중 크롬 꺼짐 → CPU
 * 4,000 이상 전부 · 2,500 이상 절반 · 그 밑은 끄기(사용자가 올려 볼 수 있음).
 */
export function levelForScore(score) {
  if (score >= 4000) return 4;
  if (score >= 2500) return 2;
  return 0;
}

/**
 * PC 점수(Time Spy 그래픽) → 기본 단계. 기준점: MX570 A(약 3,300)에서 전부 4/4가 CPU 12스레드보다 약 5.6배 빠름.
 * 3,000 이상 전부 · 1,500 이상 절반 · 그 밑(Iris Xe·UHD 등 Xe-LP 내장)은 실측 전까지 끄기.
 */
export function levelForTs(ts) {
  if (ts >= 3000) return 4;
  if (ts >= 1500) return 2;
  return 0;
}

/** WebGL 그래픽 칩 이름 → 표 항목(없으면 null) */
export function matchGpu(renderer) {
  const s = String(renderer || "");
  return GPU_TABLE.find((g) => g.re.test(s)) || null;
}

/**
 * 이름을 모를 때 WebGPU 세대(architecture, Dawn gpu_info.json 이름)로 어림:
 * adreno-8xx 전부·7xx 절반 · NVIDIA ampere·lovelace·blackwell 전부·turing 절반 ·
 * Intel 외장(gen-12hp·xe-2hpg) 전부, 내장 xe-lpg·xe-2lpg·xe-3lpg 절반 · 그 밖(gen-12lp 등) 끄기
 */
export function levelForArch(arch) {
  const a = String(arch || "").toLowerCase();
  const m = /adreno-(\d)xx/.exec(a);
  if (m) return +m[1] >= 8 ? 4 : +m[1] === 7 ? 2 : 0;
  if (/^(ampere|lovelace|blackwell|gen-12hp|xe-2hpg)$/.test(a)) return 4;
  if (/^(turing|xe-lpg|xe-2lpg|xe-3lpg)$/.test(a)) return 2;
  return 0;
}

/** 삼성 모델 번호 앞부분 → 기기 이름(표시용). 국내판 N·해외판 B/U 등 끝자리는 무시 */
const MODELS = [
  ["SM-G991", "갤럭시 S21"], ["SM-G996", "갤럭시 S21+"], ["SM-G998", "갤럭시 S21 Ultra"],
  ["SM-S901", "갤럭시 S22"], ["SM-S906", "갤럭시 S22+"], ["SM-S908", "갤럭시 S22 Ultra"],
  ["SM-S911", "갤럭시 S23"], ["SM-S916", "갤럭시 S23+"], ["SM-S918", "갤럭시 S23 Ultra"],
  ["SM-S921", "갤럭시 S24"], ["SM-S926", "갤럭시 S24+"], ["SM-S928", "갤럭시 S24 Ultra"],
  ["SM-S931", "갤럭시 S25"], ["SM-S936", "갤럭시 S25+"], ["SM-S938", "갤럭시 S25 Ultra"],
  ["SM-F711", "갤럭시 Z 플립3"], ["SM-F926", "갤럭시 Z 폴드3"], ["SM-F721", "갤럭시 Z 플립4"], ["SM-F936", "갤럭시 Z 폴드4"],
  ["SM-F731", "갤럭시 Z 플립5"], ["SM-F946", "갤럭시 Z 폴드5"], ["SM-F741", "갤럭시 Z 플립6"], ["SM-F956", "갤럭시 Z 폴드6"],
  ["SM-F766", "갤럭시 Z 플립7"], ["SM-F966", "갤럭시 Z 폴드7"], ["SM-F971", "갤럭시 Z 폴드8"],
];
export function modelName(model) {
  const m = String(model || "").toUpperCase();
  const hit = MODELS.find(([p]) => m.startsWith(p));
  return hit ? hit[1] : "";
}

/**
 * 알아낸 값들 → 기기 설명과 권장 단계.
 * @param {{model?:string, renderer?:string, arch?:string, vendor?:string, webgpu?:boolean}} raw
 */
export function describeDevice(raw = {}) {
  const gpu = matchGpu(raw.renderer);
  const name = modelName(raw.model);
  let level, basis;
  if (!raw.webgpu) { level = 0; basis = "이 브라우저는 그래픽 칩 계산(WebGPU)을 지원하지 않음"; }
  else if (gpu && gpu.level != null) { level = gpu.level; basis = `${gpu.name} 이 앱 성능 시험 실측 — ${gpu.measured}`; }
  else if (gpu && gpu.ts != null) { level = levelForTs(gpu.ts); basis = `${gpu.name} 3DMark Time Spy 그래픽 ${gpu.est ? "약 " : ""}${gpu.ts.toLocaleString("en-US")}${gpu.est ? "(어림)" : ""}`; }
  else if (gpu) { level = levelForScore(gpu.score); basis = `${gpu.name} 성능 점수 ${gpu.est ? "약 " : ""}${gpu.score.toLocaleString("en-US")}${gpu.est ? "(어림)" : ""}`; }
  else { level = levelForArch(raw.arch); basis = raw.arch ? `칩 이름을 몰라 세대(${raw.arch})로 어림` : "칩을 알 수 없음"; }
  return {
    model: raw.model || "", name, gpu: gpu ? gpu.name : (raw.renderer || "").replace(/^ANGLE \(|\)$/g, "").slice(0, 80),
    soc: gpu ? gpu.soc : "", score: gpu && gpu.score != null ? gpu.score : null, est: gpu ? !!gpu.est : false, level, basis,
  };
}

/** 한 단계 낮추기(4 → 2 → 1 → 0) */
export function lowerLevel(v) {
  const order = [4, 2, 1, 0];
  const i = order.indexOf(v);
  return i < 0 ? 0 : order[Math.min(order.length - 1, i + 1)];
}
