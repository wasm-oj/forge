import { afterEach, describe, expect, it, vi } from "vitest";
import { sha256Hex } from "../core/hash";
import {
  loadBrowserRuntimeDriverPlugins,
  validateBrowserRuntimeDriverPlugins,
} from "./browser-runtime-plugin";

const baseUrl = "https://judge.example/app/index.html";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("browser runtime-driver plug-ins", () => {
  it("canonicalizes same-origin descriptors and rejects trust-boundary violations", () => {
    expect(validateBrowserRuntimeDriverPlugins([{
      id: "ruby",
      moduleUrl: "./drivers/ruby.mjs?revision=1",
      sha256: "a".repeat(64),
    }], baseUrl)).toEqual([{
      id: "ruby",
      moduleUrl: "https://judge.example/app/drivers/ruby.mjs?revision=1",
      sha256: "a".repeat(64),
    }]);

    expect(() => validateBrowserRuntimeDriverPlugins([{
      id: "ruby",
      moduleUrl: "https://cdn.example/ruby.mjs",
      sha256: "a".repeat(64),
    }], baseUrl)).toThrow("must be loaded from https://judge.example");
    expect(() => validateBrowserRuntimeDriverPlugins([{
      id: "ruby",
      moduleUrl: "/ruby.mjs",
      sha256: "A".repeat(64),
    }], baseUrl)).toThrow("lowercase hexadecimal");
  });

  it("verifies, imports, and validates one self-contained driver", async () => {
    const source = `export function createRuntimeDriver() {
      return { id: "ruby", supports() { return false; }, async prepare() { throw new Error("unused"); } };
    }`;
    const sourceBytes = new TextEncoder().encode(source);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(sourceBytes, {
      status: 200,
      headers: { "content-length": String(sourceBytes.byteLength) },
    })));
    vi.spyOn(URL, "createObjectURL").mockReturnValue(`data:text/javascript,${encodeURIComponent(source)}`);
    const revoke = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);

    const drivers = await loadBrowserRuntimeDriverPlugins([{
      id: "ruby",
      moduleUrl: "/ruby.mjs",
      sha256: await sha256Hex(sourceBytes),
    }], baseUrl);

    expect(drivers).toHaveLength(1);
    expect(drivers[0]?.id).toBe("ruby");
    expect(revoke).toHaveBeenCalledOnce();
  });

  it("rejects unpinned transitive modules before evaluating source", async () => {
    const source = `import "./side-effect.mjs"; export function createRuntimeDriver() { return {}; }`;
    const sourceBytes = new TextEncoder().encode(source);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(sourceBytes, { status: 200 })));
    const createObjectUrl = vi.spyOn(URL, "createObjectURL");

    await expect(loadBrowserRuntimeDriverPlugins([{
      id: "unsafe",
      moduleUrl: "/unsafe.mjs",
      sha256: await sha256Hex(sourceBytes),
    }], baseUrl)).rejects.toThrow("must be self-contained");
    expect(createObjectUrl).not.toHaveBeenCalled();
  });
});
