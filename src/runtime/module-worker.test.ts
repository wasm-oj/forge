import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createModuleWorker,
  createModuleWorkerBootstrap,
  moduleWorkerBaseUrl,
} from "./module-worker";

interface WorkerConstruction {
  url: string | URL;
  options?: WorkerOptions;
}

const constructions: WorkerConstruction[] = [];

class FakeWorker {
  constructor(url: string | URL, options?: WorkerOptions) {
    constructions.push({ url, options });
  }
}

beforeEach(() => {
  constructions.length = 0;
  vi.stubGlobal("location", {
    href: "https://forge.example/judge",
    origin: "https://forge.example",
  });
  vi.stubGlobal("Worker", FakeWorker);
  vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:https://forge.example/bootstrap");
  vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("module Worker bootstrap", () => {
  it("loads a relative emitted module through an absolute static import", async () => {
    const worker = createModuleWorker("/assets/compiler.worker.js", { name: "forge-compiler" });

    expect(worker).toBeInstanceOf(FakeWorker);
    expect(constructions).toEqual([{
      url: "blob:https://forge.example/bootstrap",
      options: { name: "forge-compiler", type: "module" },
    }]);
    const bootstrap = vi.mocked(URL.createObjectURL).mock.calls[0]?.[0];
    expect(bootstrap).toBeInstanceOf(Blob);
    expect(await (bootstrap as Blob).text()).toBe([
      "const pendingMessages = [];",
      "const queueMessage = (event) => { event.stopImmediatePropagation(); pendingMessages.push(event.data); };",
      'globalThis.addEventListener("message", queueMessage);',
      'Object.defineProperty(globalThis, "__wasmOjForgeModuleWorkerBaseUrl", { value: "https://forge.example/judge" });',
      'try { await import("https://forge.example/assets/compiler.worker.js"); } finally { globalThis.removeEventListener("message", queueMessage); }',
      'for (const data of pendingMessages) globalThis.dispatchEvent(new MessageEvent("message", { data }));',
      "",
    ].join("\n"));
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:https://forge.example/bootstrap");
  });

  it("revokes the bootstrap URL when Worker construction throws", () => {
    vi.stubGlobal("Worker", class {
      constructor() {
        throw new Error("constructor failed");
      }
    });

    expect(() => createModuleWorker("https://cdn.example/runner.worker.js"))
      .toThrow("constructor failed");
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:https://forge.example/bootstrap");
  });

  it("keeps a reusable bootstrap alive until its owner explicitly revokes it", async () => {
    const bootstrap = createModuleWorkerBootstrap("/assets/wasmer-thread.worker.js");

    expect(bootstrap.url).toBe("blob:https://forge.example/bootstrap");
    expect(URL.revokeObjectURL).not.toHaveBeenCalled();
    const source = vi.mocked(URL.createObjectURL).mock.calls[0]?.[0];
    expect(await (source as Blob).text()).toContain(
      'await import("https://forge.example/assets/wasmer-thread.worker.js")',
    );

    bootstrap.revoke();
    bootstrap.revoke();
    expect(URL.revokeObjectURL).toHaveBeenCalledTimes(1);
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:https://forge.example/bootstrap");
  });

  it("uses the injected browser base inside a blob Worker", () => {
    vi.stubGlobal("location", {
      href: "blob:https://forge.example/bootstrap",
      origin: "null",
    });
    vi.stubGlobal("__wasmOjForgeModuleWorkerBaseUrl", "https://forge.example/judge");

    expect(moduleWorkerBaseUrl().href).toBe("https://forge.example/judge");
  });

  it("rejects a relative module URL when no trustworthy base exists", () => {
    vi.stubGlobal("location", {
      href: "blob:https://forge.example/bootstrap",
      origin: "null",
    });

    expect(() => createModuleWorker("runner.worker.js"))
      .toThrow("requires a browser base URL");
    expect(URL.createObjectURL).not.toHaveBeenCalled();
  });
});
