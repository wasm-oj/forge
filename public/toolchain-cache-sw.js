const CACHE_NAME = "wasm-oj-forge-v1:toolchains";
const SHA256 = /^[a-f0-9]{64}$/;

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("fetch", (event) => {
  const request = event.request;
  const url = new URL(request.url);
  const digests = url.searchParams.getAll("sha256");
  const pinnedSameOriginAsset = url.origin === self.location.origin
    && digests.length === 1
    && SHA256.test(digests[0]);
  if (request.method !== "GET" || !pinnedSameOriginAsset) return;

  const operation = loadVerifiedToolchain(request, url, digests[0]);
  event.respondWith(operation.then(({ response }) => response));
  event.waitUntil(operation.then(({ persistence }) => persistence));
});

async function loadVerifiedToolchain(request, url, expectedSha256) {
  let cache;
  try {
    cache = await caches.open(CACHE_NAME);
    const cached = await cache.match(request);
    if (cached) {
      const { digest: actual } = await responseSha256(cached.clone());
      if (actual === expectedSha256) {
        return { response: cached, persistence: Promise.resolve() };
      }
      console.warn(`Discarding corrupt Forge toolchain cache entry '${url.pathname}': ${actual}.`);
      await cache.delete(request);
    }
  } catch (error) {
    console.warn("Forge toolchain cache read failed; using the verified network response.", error);
    cache = undefined;
  }

  const response = await fetch(request);
  if (!response.ok) return { response, persistence: Promise.resolve() };
  const { digest: actual, byteLength } = await responseSha256(response.clone());
  if (actual !== expectedSha256) {
    return {
      response: new Response(
        `Pinned toolchain digest mismatch for '${url.pathname}': expected ${expectedSha256}, received ${actual}.`,
        { status: 502, headers: { "Content-Type": "text/plain; charset=utf-8" } },
      ),
      persistence: Promise.resolve(),
    };
  }

  if (!cache) return { response, persistence: Promise.resolve() };
  const cacheable = withStorageMetadata(response.clone(), byteLength);
  const persistence = (async () => {
    await cache.put(request, cacheable);
    const keys = await cache.keys();
    await Promise.all(keys
      .filter((key) => {
        const cachedUrl = new URL(key.url);
        return cachedUrl.pathname === url.pathname && cachedUrl.href !== url.href;
      })
      .map((key) => cache.delete(key)));
  })().catch((error) => {
    console.warn("Forge toolchain cache write failed; the verified response remains usable.", error);
  });
  return { response, persistence };
}

async function responseSha256(response) {
  const bytes = await response.arrayBuffer();
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return {
    byteLength: bytes.byteLength,
    digest: Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join(""),
  };
}

function withStorageMetadata(response, byteLength) {
  const headers = new Headers(response.headers);
  headers.set("X-WASM-OJ-Forge-Byte-Length", String(byteLength));
  headers.set("X-WASM-OJ-Forge-Cached-At", String(Date.now()));
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
