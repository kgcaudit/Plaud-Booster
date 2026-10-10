// GitHub Pages는 응답 머리를 바꿀 수 없어서, 여러 스레드 처리(SharedArrayBuffer)에 필요한
// 교차 출처 격리 머리(COOP/COEP)를 이 서비스 워커가 붙인다. 같은 출처 요청만 다룬다.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));
self.addEventListener("fetch", (e) => {
  const r = e.request;
  if (new URL(r.url).origin !== self.location.origin) return;
  if (r.cache === "only-if-cached" && r.mode !== "same-origin") return;
  // 화면 파일(html·js·css)은 매번 서버와 대조해(바뀌었으면 새로) 받는다 — 고친 화면이 휴대폰 캐시 때문에 늦게 반영되지 않게.
  // 모델 조각은 일꾼이 Cache Storage에서 따로 관리하므로 그대로 둔다.
  const path = new URL(r.url).pathname;
  const fresh = r.mode === "navigate" || /\.(?:html|js|mjs|css|wasm)$/.test(path);
  e.respondWith(
    fetch(fresh ? new Request(r, { cache: "no-cache" }) : r).then((res) => {
      if (res.status === 0) return res;
      const h = new Headers(res.headers);
      h.set("Cross-Origin-Embedder-Policy", "require-corp");
      h.set("Cross-Origin-Opener-Policy", "same-origin");
      h.set("Cross-Origin-Resource-Policy", "same-origin");
      return new Response(res.body, { status: res.status, statusText: res.statusText, headers: h });
    }),
  );
});
