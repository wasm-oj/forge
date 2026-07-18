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
  configure(path: string | null): Promise<unknown>;
}

const persistedManifestUrl = "https://forge.test/__forge__/sites-toolchain-chunks";

async function serviceWorkerHarness(options: { persistedManifest?: string } = {}): Promise<WorkerHarness> {
  const listeners = new Map<string, (event: Record<string, unknown>) => void>();
  const claim = vi.fn(async () => undefined);
  const cache = {
    match: vi.fn(async (input: RequestInfo | URL) => {
      const url = input instanceof Request ? input.url : new URL(input.toString(), "https://forge.test").href;
      return url === persistedManifestUrl && options.persistedManifest !== undefined
        ? new Response(options.persistedManifest)
        : undefined;
    }),
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
    ReadableStream,
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
  const configure = async (path: string | null): Promise<unknown> => {
    let answer: unknown;
    let lifetime: Promise<unknown> | undefined;
    listeners.get("message")?.({
      data: { type: "configure-toolchain-chunks", path },
      ports: [{ postMessage(value: unknown) { answer = value; } }],
      waitUntil(promise: Promise<unknown>) { lifetime = promise; },
    });
    await lifetime;
    return answer;
  };
  return { listeners, claim, cache, fetch, warnings, configure };
}

function acceptingWorker(state: ServiceWorkerState = "activated") {
  const postMessage = vi.fn((_message: unknown, transfer: Transferable[]) => {
    (transfer[0] as MessagePort).postMessage({ ok: true });
  });
  return { state, postMessage };
}

describe("toolchain cache service worker", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("registers the exported worker at a consumer-configured URL and scope", async () => {
    const worker = acceptingWorker();
    const registration = {
      active: worker,
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
      { scope: "/judge/", updateViaCache: "none" },
    );
    expect(worker.postMessage).toHaveBeenCalledWith(
      { type: "configure-toolchain-chunks", path: null },
      [expect.any(MessagePort)],
    );
  });

  it("waits for its own registration instead of an unrelated ready scope", async () => {
    let state: ServiceWorkerState = "installing";
    let stateChange: (() => void) | undefined;
    const postMessage = vi.fn((_message: unknown, transfer: Transferable[]) => {
      (transfer[0] as MessagePort).postMessage({ ok: true });
    });
    const worker = {
      get state() { return state; },
      addEventListener(type: string, listener: () => void) {
        if (type === "statechange") stateChange = listener;
      },
      removeEventListener: vi.fn(),
      postMessage,
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

  it("configures an updating worker instead of the stale active worker", async () => {
    let state: ServiceWorkerState = "installing";
    let stateChange: (() => void) | undefined;
    const oldWorker = acceptingWorker();
    const postMessage = vi.fn((_message: unknown, transfer: Transferable[]) => {
      (transfer[0] as MessagePort).postMessage({ ok: true });
    });
    const installingWorker = {
      get state() { return state; },
      addEventListener(type: string, listener: () => void) {
        if (type === "statechange") stateChange = listener;
      },
      removeEventListener: vi.fn(),
      postMessage,
    } as unknown as ServiceWorker;
    const registration = {
      active: oldWorker,
      installing: installingWorker,
      waiting: null,
    } as unknown as ServiceWorkerRegistration;
    vi.stubGlobal("navigator", {
      serviceWorker: { register: vi.fn(async () => registration) },
    });

    const pending = registerToolchainCache();
    await Promise.resolve();
    expect(oldWorker.postMessage).not.toHaveBeenCalled();
    state = "activated";
    stateChange?.();
    await pending;

    expect(postMessage).toHaveBeenCalledOnce();
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
    const harness = await serviceWorkerHarness();
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
    await expect(harness.configure(manifestPath)).resolves.toEqual({ ok: true });
    expect(harness.claim).toHaveBeenCalledOnce();
    harness.cache.put.mockClear();
    let response: Promise<Response> | undefined;
    harness.listeners.get("fetch")?.({
      request: new Request(`https://forge.test/toolchains/compiler.bin?sha256=${sha256}`),
      respondWith(promise: Promise<Response>) { response = promise; },
      waitUntil() {},
    });

    expect(await (await response!).text()).toBe("verified toolchain");
    expect(harness.cache.put).toHaveBeenCalledTimes(parts.length);
  });

  it("fails closed when a deployment chunk does not match its manifest", async () => {
    const manifestPath = "/toolchains/forge-sites-chunks.json";
    const harness = await serviceWorkerHarness();
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
    await expect(harness.configure(manifestPath)).resolves.toEqual({ ok: true });
    harness.cache.put.mockClear();
    let response: Promise<Response> | undefined;
    harness.listeners.get("fetch")?.({
      request: new Request(`https://forge.test/toolchains/compiler.bin?sha256=${expected}`),
      respondWith(promise: Promise<Response>) { response = promise; },
      waitUntil() {},
    });

    await expect((await response!).text()).rejects.toThrow("failed integrity verification");
    expect(harness.cache.put).not.toHaveBeenCalled();
  });

  it("restores the verified chunk manifest after the worker process restarts", async () => {
    const body = "persistent transport";
    const sha256 = createHash("sha256").update(body).digest("hex");
    const chunkSha256 = createHash("sha256").update(body).digest("hex");
    const manifest = JSON.stringify({
      schema: "wasm-oj-forge-v1/sites-toolchain-chunks",
      assets: [{
        path: "/toolchains/compiler.bin",
        byteLength: body.length,
        sha256,
        chunks: [{
          path: "/toolchains/compiler.bin.forge-chunk-000",
          byteLength: body.length,
          sha256: chunkSha256,
        }],
      }],
    });
    const harness = await serviceWorkerHarness({ persistedManifest: manifest });
    harness.fetch.mockResolvedValue(new Response(body));
    let response: Promise<Response> | undefined;

    harness.listeners.get("fetch")?.({
      request: new Request(`https://forge.test/toolchains/compiler.bin?sha256=${sha256}`),
      respondWith(promise: Promise<Response>) { response = promise; },
      waitUntil() {},
    });

    expect(await (await response!).text()).toBe(body);
    expect(harness.cache.match).toHaveBeenCalledWith(expect.objectContaining({ url: persistedManifestUrl }));
  });
});
