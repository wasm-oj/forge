import { createHash, webcrypto } from "node:crypto";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerToolchainCache } from "./service-worker";

interface WorkerHarness {
  listeners: Map<string, (event: Record<string, unknown>) => void>;
  claim: ReturnType<typeof vi.fn>;
  cache: {
    match: ReturnType<typeof vi.fn>;
    put: ReturnType<typeof vi.fn>;
    keys: ReturnType<typeof vi.fn>;
    delete: ReturnType<typeof vi.fn>;
  };
  fetch: ReturnType<typeof vi.fn>;
  warnings: ReturnType<typeof vi.fn>;
}

async function serviceWorkerHarness(options: { chunkManifestPath?: string } = {}): Promise<WorkerHarness> {
  const listeners = new Map<string, (event: Record<string, unknown>) => void>();
  const claim = vi.fn(async () => undefined);
  const cache = {
    match: vi.fn(async () => undefined),
    put: vi.fn(async () => undefined),
    keys: vi.fn(async () => []),
    delete: vi.fn(async () => true),
  };
  const fetch = vi.fn(async () => new Response("network"));
  const warnings = vi.fn();
  const source = await readFile("public/toolchain-cache-sw.js", "utf8");
  runInNewContext(source, {
    URL,
    Request,
    Response,
    Headers,
    TextDecoder,
    Uint8Array,
    crypto: webcrypto,
    fetch,
    console: { warn: warnings },
    caches: {
      open: async () => cache,
    },
    self: {
      location: { origin: "https://forge.test" },
      clients: { claim },
      skipWaiting: async () => undefined,
      addEventListener(type: string, listener: (event: Record<string, unknown>) => void) {
        listeners.set(type, listener);
      },
    },
  });
  if (options.chunkManifestPath) {
    const accepted = vi.fn();
    listeners.get("message")?.({
      data: { type: "configure-toolchain-chunks", path: options.chunkManifestPath },
      ports: [{ postMessage: accepted }],
    });
    expect(accepted).toHaveBeenCalledWith({ ok: true });
  }
  return { listeners, claim, cache, fetch, warnings };
}

describe("toolchain cache service worker", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("registers the exported worker at a consumer-configured URL and scope", async () => {
    const registration = {
      active: { state: "activated" },
      installing: null,
      waiting: null,
    } as unknown as ServiceWorkerRegistration;
    const register = vi.fn(async () => registration);
    vi.stubGlobal("navigator", { serviceWorker: { register } });

    await expect(registerToolchainCache({
      scriptUrl: "/assets/forge-toolchains.js",
      scope: "/judge/",
    })).resolves.toBe(registration);
    expect(register).toHaveBeenCalledWith(
      "/assets/forge-toolchains.js",
      { scope: "/judge/" },
    );
  });

  it("waits for its own registration instead of an unrelated ready scope", async () => {
    let state: ServiceWorkerState = "installing";
    let stateChange: (() => void) | undefined;
    const worker = {
      get state() { return state; },
      addEventListener(type: string, listener: () => void) {
        if (type === "statechange") stateChange = listener;
      },
      removeEventListener: vi.fn(),
    } as unknown as ServiceWorker;
    const registration = {
      active: null,
      installing: worker,
      waiting: null,
    } as unknown as ServiceWorkerRegistration;
    const register = vi.fn(async () => registration);
    vi.stubGlobal("navigator", {
      serviceWorker: {
        register,
        get ready() { throw new Error("global ready must not be read"); },
      },
    });

    const pending = registerToolchainCache();
    await Promise.resolve();
    state = "activated";
    stateChange?.();
    await expect(pending).resolves.toBe(registration);
  });

  it("claims clients without carrying an old-contract cache migration path", async () => {
    const harness = await serviceWorkerHarness();
    let lifetime: Promise<unknown> | undefined;
    harness.listeners.get("activate")?.({
      waitUntil(promise: Promise<unknown>) { lifetime = promise; },
    });
    await lifetime;

    expect(harness.claim).toHaveBeenCalledOnce();
  });

  it("returns verified network bytes even when optional cache persistence fails", async () => {
    const harness = await serviceWorkerHarness();
    const body = "verified toolchain";
    const sha256 = createHash("sha256").update(body).digest("hex");
    harness.fetch.mockResolvedValue(new Response(body));
    harness.cache.put.mockRejectedValue(new DOMException("quota", "QuotaExceededError"));
    let response: Promise<Response> | undefined;
    let lifetime: Promise<unknown> | undefined;

    harness.listeners.get("fetch")?.({
      request: new Request(`https://forge.test/toolchains/compiler.bin?sha256=${sha256}`),
      respondWith(promise: Promise<Response>) { response = promise; },
      waitUntil(promise: Promise<unknown>) { lifetime = promise; },
    });

    expect(response).toBeDefined();
    expect(await (await response!).text()).toBe(body);
    await lifetime;
    expect(harness.cache.put).toHaveBeenCalledOnce();
    expect(harness.warnings).toHaveBeenCalledOnce();
  });

  it("does not cache or return a network response with the wrong digest", async () => {
    const harness = await serviceWorkerHarness();
    harness.fetch.mockResolvedValue(new Response("tampered"));
    let response: Promise<Response> | undefined;
    const expected = "0".repeat(64);

    harness.listeners.get("fetch")?.({
      request: new Request(`https://forge.test/toolchains/compiler.bin?sha256=${expected}`),
      respondWith(promise: Promise<Response>) { response = promise; },
      waitUntil() {},
    });

    expect(response).toBeDefined();
    const rejected = await response!;
    expect(rejected.status).toBe(502);
    expect(await rejected.text()).toContain("digest mismatch");
    expect(harness.cache.put).not.toHaveBeenCalled();
  });

  it("assembles a build-configured chunk transport and verifies every part", async () => {
    const manifestPath = "/toolchains/forge-sites-chunks.json";
    const harness = await serviceWorkerHarness({ chunkManifestPath: manifestPath });
    const parts = [new TextEncoder().encode("verified "), new TextEncoder().encode("toolchain")];
    const body = Buffer.concat(parts);
    const sha256 = createHash("sha256").update(body).digest("hex");
    const chunks = parts.map((part, index) => ({
      path: `/toolchains/compiler.bin.forge-chunk-${String(index).padStart(3, "0")}`,
      byteLength: part.byteLength,
      sha256: createHash("sha256").update(part).digest("hex"),
    }));
    harness.fetch.mockImplementation(async (input: RequestInfo | URL) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      if (url.pathname === manifestPath) {
        return new Response(JSON.stringify({
          schema: "wasm-oj-forge-v1/sites-toolchain-chunks",
          assets: [{ path: "/toolchains/compiler.bin", byteLength: body.byteLength, sha256, chunks }],
        }));
      }
      const index = chunks.findIndex((chunk) => chunk.path === url.pathname);
      if (index >= 0) return new Response(parts[index]);
      throw new Error(`Unexpected network request '${url.pathname}'.`);
    });
    let response: Promise<Response> | undefined;
    harness.listeners.get("fetch")?.({
      request: new Request(`https://forge.test/toolchains/compiler.bin?sha256=${sha256}`),
      respondWith(promise: Promise<Response>) { response = promise; },
      waitUntil() {},
    });

    expect(await (await response!).text()).toBe("verified toolchain");
    expect(harness.cache.put).toHaveBeenCalledOnce();
  });

  it("fails closed when a deployment chunk does not match its manifest", async () => {
    const manifestPath = "/toolchains/forge-sites-chunks.json";
    const harness = await serviceWorkerHarness({ chunkManifestPath: manifestPath });
    const expected = createHash("sha256").update("expected").digest("hex");
    const chunkSha256 = createHash("sha256").update("expected").digest("hex");
    harness.fetch.mockImplementation(async (input: RequestInfo | URL) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      if (url.pathname === manifestPath) {
        return new Response(JSON.stringify({
          schema: "wasm-oj-forge-v1/sites-toolchain-chunks",
          assets: [{
            path: "/toolchains/compiler.bin",
            byteLength: 8,
            sha256: expected,
            chunks: [{
              path: "/toolchains/compiler.bin.forge-chunk-000",
              byteLength: 8,
              sha256: chunkSha256,
            }],
          }],
        }));
      }
      return new Response("tampered");
    });
    let response: Promise<Response> | undefined;
    harness.listeners.get("fetch")?.({
      request: new Request(`https://forge.test/toolchains/compiler.bin?sha256=${expected}`),
      respondWith(promise: Promise<Response>) { response = promise; },
      waitUntil() {},
    });

    expect((await response!).status).toBe(502);
    expect(harness.cache.put).not.toHaveBeenCalled();
  });
});
