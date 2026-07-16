const CACHE_NAME = "localwasi-toolchains-v1";
const TOOLCHAIN_HOSTS = new Set([
  "registry.wasmer.io",
  "cdn.wasmer.io",
  "registry-cdn.wapm.io",
]);

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("fetch", (event) => {
  const request = event.request;
  const url = new URL(request.url);
  const localToolchain = url.origin === self.location.origin && url.pathname.startsWith("/toolchains/");
  if (request.method !== "GET" || (!localToolchain && !TOOLCHAIN_HOSTS.has(url.hostname))) return;

  event.respondWith((async () => {
    const cache = await caches.open(CACHE_NAME);
    const cached = await cache.match(request);
    if (cached) return cached;
    const response = await fetch(request);
    if (response.ok) await cache.put(request, response.clone());
    return response;
  })());
});
