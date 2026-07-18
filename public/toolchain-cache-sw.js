const CACHE_NAME = "wasm-oj-forge-v1:toolchains";
const TRANSPORT_CONFIGURATION_CACHE_NAME = "wasm-oj-forge-v1:toolchain-transport";
const SHA256 = /^[a-f0-9]{64}$/;
const CHUNK_MANIFEST_SCHEMA = "wasm-oj-forge-v1/sites-toolchain-chunks";
const MAX_CHUNK_MANIFEST_BYTES = 1024 * 1024;
const MAX_CHUNKED_ASSET_BYTES = 512 * 1024 * 1024;
const MAX_CHUNKS_PER_ASSET = 64;
const MAX_CHUNK_BYTES = 25 * 1024 * 1024;
const CHUNK_MANIFEST_CACHE_KEY = "/__forge__/sites-toolchain-chunks";
let deploymentChunkManifest;

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("message", (event) => {
  if (!event.data || event.data.type !== "configure-toolchain-chunks"
    || (event.data.path !== null && event.data.path !== "/toolchains/forge-sites-chunks.json")) {
    event.ports[0]?.postMessage({ ok: false });
    return;
  }
  const operation = configureDeploymentChunkManifest(event.data.path)
    .then(
      () => event.ports[0]?.postMessage({ ok: true }),
      (error) => {
        console.warn("Forge toolchain chunk configuration failed.", error);
        event.ports[0]?.postMessage({ ok: false });
      },
    );
  event.waitUntil(operation);
});

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

  const network = await fetchDeploymentAsset(request, url, expectedSha256);
  const response = network.response;
  if (!response.ok) return { response, persistence: Promise.resolve() };
  if (network.chunked) {
    return { response, persistence: Promise.resolve() };
  }
  const { digest: actual, byteLength } = network.verification
    ?? await responseSha256(response.clone());
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

async function fetchDeploymentAsset(request, url, expectedSha256) {
  const manifest = await loadDeploymentChunkManifest();
  const asset = manifest?.get(url.pathname);
  if (!asset) return { response: await fetch(request) };
  if (asset.sha256 !== expectedSha256) {
    return {
      response: failureResponse(`Chunk manifest digest for '${url.pathname}' does not match the pinned request.`),
    };
  }
  let index = 0;
  const body = new ReadableStream({
    async pull(controller) {
      if (index >= asset.chunks.length) {
        controller.close();
        return;
      }
      try {
        controller.enqueue(await loadVerifiedChunk(asset.chunks[index]));
        index += 1;
      } catch (error) {
        controller.error(error);
      }
    },
  });
  return {
    response: new Response(body, {
      headers: {
        "Content-Length": String(asset.byteLength),
        "Content-Type": "application/octet-stream",
      },
    }),
    chunked: true,
  };
}

async function loadVerifiedChunk(chunk) {
  const chunkUrl = new URL(chunk.path, self.location.origin);
  chunkUrl.searchParams.set("sha256", chunk.sha256);
  const request = new Request(chunkUrl);
  let cache;
  let response;
  let cacheHit = false;
  try {
    cache = await caches.open(CACHE_NAME);
    response = await cache.match(request);
    cacheHit = response !== undefined;
  } catch (error) {
    console.warn(`Forge toolchain chunk cache read failed for '${chunk.path}'.`, error);
  }
  if (!response) {
    response = await fetch(request);
    if (!response.ok) {
      throw new Error(`Unable to load pinned toolchain chunk '${chunk.path}' (${response.status}).`);
    }
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  const actual = await bytesSha256(bytes);
  if (bytes.byteLength !== chunk.byteLength || actual !== chunk.sha256) {
    if (cache) await cache.delete(request);
    throw new Error(`Pinned toolchain chunk '${chunk.path}' failed integrity verification.`);
  }
  if (cache && !cacheHit) {
    try {
      await cache.put(request, withStorageMetadata(new Response(bytes), bytes.byteLength));
    } catch (error) {
      console.warn(`Forge toolchain chunk cache write failed for '${chunk.path}'.`, error);
    }
  }
  return bytes;
}

async function loadDeploymentChunkManifest() {
  deploymentChunkManifest ??= (async () => {
    const cache = await caches.open(TRANSPORT_CONFIGURATION_CACHE_NAME);
    const response = await cache.match(chunkManifestCacheRequest());
    if (!response) return undefined;
    return (await decodeDeploymentChunkManifest(response)).manifest;
  })();
  return deploymentChunkManifest;
}

async function configureDeploymentChunkManifest(path) {
  const cache = await caches.open(TRANSPORT_CONFIGURATION_CACHE_NAME);
  const cacheRequest = chunkManifestCacheRequest();
  deploymentChunkManifest = undefined;
  if (path === null) {
    await cache.delete(cacheRequest);
  } else {
    const response = await fetch(new URL(path, self.location.origin), { cache: "no-cache" });
    if (!response.ok) throw new Error(`Unable to load Forge deployment chunk manifest (${response.status}).`);
    const decoded = await decodeDeploymentChunkManifest(response);
    await deleteAssembledAssetCacheEntries(decoded.manifest);
    await cache.put(cacheRequest, new Response(decoded.bytes, {
      headers: { "Content-Type": "application/json; charset=utf-8" },
    }));
    deploymentChunkManifest = Promise.resolve(decoded.manifest);
  }
  await self.clients.claim();
}

async function deleteAssembledAssetCacheEntries(manifest) {
  const cache = await caches.open(CACHE_NAME);
  const keys = await cache.keys();
  await Promise.all(keys
    .filter((request) => manifest.has(new URL(request.url).pathname))
    .map((request) => cache.delete(request)));
}

async function decodeDeploymentChunkManifest(response) {
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_CHUNK_MANIFEST_BYTES) {
    throw new Error("Forge deployment chunk manifest exceeds its byte limit.");
  }
  let value;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch (error) {
    throw new Error("Forge deployment chunk manifest is not valid UTF-8 JSON.", { cause: error });
  }
  return { bytes, manifest: validateDeploymentChunkManifest(value) };
}

function chunkManifestCacheRequest() {
  return new Request(new URL(CHUNK_MANIFEST_CACHE_KEY, self.location.origin));
}

function validateDeploymentChunkManifest(value) {
  if (!isRecord(value) || value.schema !== CHUNK_MANIFEST_SCHEMA || !Array.isArray(value.assets)
    || !hasExactKeys(value, ["assets", "schema"])) {
    throw new Error("Forge deployment chunk manifest has an invalid root contract.");
  }
  const assets = new Map();
  let previousAssetPath = "";
  for (const asset of value.assets) {
    if (!isRecord(asset) || !hasExactKeys(asset, ["byteLength", "chunks", "path", "sha256"])
      || !isToolchainPath(asset.path) || asset.path <= previousAssetPath || !isSha256(asset.sha256)
      || !isPositiveBytes(asset.byteLength, MAX_CHUNKED_ASSET_BYTES) || !Array.isArray(asset.chunks)
      || asset.chunks.length === 0 || asset.chunks.length > MAX_CHUNKS_PER_ASSET) {
      throw new Error("Forge deployment chunk manifest contains a malformed or unsorted asset.");
    }
    let total = 0;
    let previousChunkPath = "";
    for (const chunk of asset.chunks) {
      if (!isRecord(chunk) || !hasExactKeys(chunk, ["byteLength", "path", "sha256"])
        || !isToolchainPath(chunk.path) || !chunk.path.startsWith(`${asset.path}.forge-chunk-`)
        || chunk.path <= previousChunkPath || !isSha256(chunk.sha256)
        || !isPositiveBytes(chunk.byteLength, MAX_CHUNK_BYTES)) {
        throw new Error(`Forge deployment chunk manifest contains a malformed chunk for '${asset.path}'.`);
      }
      total += chunk.byteLength;
      if (!Number.isSafeInteger(total)) throw new Error("Forge deployment chunk sizes exceed the safe integer range.");
      previousChunkPath = chunk.path;
    }
    if (total !== asset.byteLength) throw new Error(`Forge deployment chunks do not cover '${asset.path}'.`);
    assets.set(asset.path, asset);
    previousAssetPath = asset.path;
  }
  return assets;
}

async function responseSha256(response) {
  const bytes = await response.arrayBuffer();
  return {
    byteLength: bytes.byteLength,
    digest: await bytesSha256(new Uint8Array(bytes)),
  };
}

async function bytesSha256(bytes) {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function failureResponse(message) {
  return new Response(message, { status: 502, headers: { "Content-Type": "text/plain; charset=utf-8" } });
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value, expected) {
  return JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...expected].sort());
}

function isToolchainPath(value) {
  return typeof value === "string" && /^\/toolchains\/[A-Za-z0-9._-]+$/.test(value);
}

function isSha256(value) {
  return typeof value === "string" && SHA256.test(value);
}

function isPositiveBytes(value, maximum) {
  return Number.isSafeInteger(value) && value > 0 && value <= maximum;
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
