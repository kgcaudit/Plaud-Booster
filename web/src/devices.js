// 기기·그래픽 칩 알아보기와 그래픽 칩 가속 단계 정하기 — 순수 함수(화면·시험 공용).
//
// 브라우저가 알려 주는 것(허락 창 없음, 바깥으로 보내지 않음):
//   · WebGL 그래픽 칩 이름  예: "ANGLE (Qualcomm, Adreno (TM) 660, OpenGL ES 3.2)" → 정확한 칩 이름
//   · WebGPU 어댑터 정보    예: vendor "qualcomm", architecture "adreno-6xx" → 세대만
//   · 클라이언트 힌트 모델  예: "SM-F711N" → 기기 이름 표시용
// 삼성 국내판은 같은 S 시리즈라도 해마다 엑시노스·스냅드래곤이 섞이므로, 단계는 모델 번호가 아니라 그래픽 칩 이름으로 정한다.
//
// 점수: 3DMark Wild Life Extreme Unlimited(그래픽 칩 연산 성능), Notebookcheck 모음 기준(2026-10 조사).
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

/** WebGL 그래픽 칩 이름 → 표 항목(없으면 null) */
export function matchGpu(renderer) {
  const s = String(renderer || "");
  return GPU_TABLE.find((g) => g.re.test(s)) || null;
}

/** 이름을 모를 때 WebGPU 세대(architecture)로 어림: adreno-8xx 전부, 7xx 절반, 그 밖 끄기 */
export function levelForArch(arch) {
  const m = /adreno-(\d)xx/i.exec(String(arch || ""));
  if (!m) return 0;
  return +m[1] >= 8 ? 4 : +m[1] === 7 ? 2 : 0;
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
  else if (gpu) { level = levelForScore(gpu.score); basis = `${gpu.name} 성능 점수 ${gpu.est ? "약 " : ""}${gpu.score.toLocaleString("en-US")}${gpu.est ? "(어림)" : ""}`; }
  else { level = levelForArch(raw.arch); basis = raw.arch ? `칩 이름을 몰라 세대(${raw.arch})로 어림` : "칩을 알 수 없음"; }
  return {
    model: raw.model || "", name, gpu: gpu ? gpu.name : (raw.renderer || "").replace(/^ANGLE \(|\)$/g, "").slice(0, 80),
    soc: gpu ? gpu.soc : "", score: gpu ? gpu.score : null, est: gpu ? !!gpu.est : false, level, basis,
  };
}

/** 한 단계 낮추기(4 → 2 → 1 → 0) */
export function lowerLevel(v) {
  const order = [4, 2, 1, 0];
  const i = order.indexOf(v);
  return i < 0 ? 0 : order[Math.min(order.length - 1, i + 1)];
}
