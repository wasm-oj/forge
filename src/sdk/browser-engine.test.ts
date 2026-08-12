import { beforeEach, describe, expect, it, vi } from "vitest";
import { WASM_OJ_CONTRACT_VERSION, WASM_OJ_SCHEMAS } from "../core/contract";
import type { BrowserToolchainSource } from "../core/types";

const state = vi.hoisted(() => ({
  compilerOptions: [] as unknown[],
  runnerOptions: [] as unknown[],
  compilerDisposals: 0,
  runnerDisposals: 0,
  cacheCloses: 0,
  runnerThrows: false,
}));

vi.mock("../runtime/compiler-client", () => ({
  BrowserCompiler: class {
    constructor(options: unknown) {
      state.compilerOptions.push(options);
    }
    ready = async (): Promise<void> => undefined;
    onProgress = (): (() => void) => () => undefined;
    onTrace = (): (() => void) => () => undefined;
    cacheIdentity = (): string => "compiler";
    build = async (): Promise<never> => { throw new Error("unused"); };
    clearToolchainCache = async (): Promise<void> => undefined;
    cancel = (): void => undefined;
    restart = (): void => undefined;
    dispose = (): void => { state.compilerDisposals += 1; };
  },
}));

vi.mock("../runtime/runner-client", () => ({
  BrowserRunner: class {
    constructor(options: unknown) {
      if (state.runnerThrows) throw new Error("runner construction failed");
      state.runnerOptions.push(options);
    }
    ready = async (): Promise<void> => undefined;
    onProgress = (): (() => void) => () => undefined;
    onStream = (): (() => void) => () => undefined;
    run = async (): Promise<never> => { throw new Error("unused"); };
    interact = async (): Promise<never> => { throw new Error("unused"); };
    clearRuntimeCache = async (): Promise<void> => undefined;
    cancel = (): void => undefined;
    restart = (): void => undefined;
    dispose = (): void => { state.runnerDisposals += 1; };
  },
}));

vi.mock("../dependencies/indexeddb-cache", () => ({
  IndexedDbDependencyCache: class {
    close(): void {
      state.cacheCloses += 1;
    }
  },
}));

vi.mock("../dependencies/manager", () => ({
  createDefaultDependencyManager: () => undefined,
}));

import { createBrowserEngine } from "./browser-engine";

describe("createBrowserEngine", () => {
  beforeEach(() => {
    state.compilerOptions.length = 0;
    state.runnerOptions.length = 0;
    state.compilerDisposals = 0;
    state.runnerDisposals = 0;
    state.cacheCloses = 0;
    state.runnerThrows = false;
  });

  it("passes an immutable explicit source snapshot to both browser hosts", async () => {
    const source = browserSource();
    const input = [source];
    const engine = await createBrowserEngine({ toolchains: input });

    expect(state.compilerOptions).toHaveLength(1);
    expect(state.runnerOptions).toHaveLength(1);
    const compilerSources = (state.compilerOptions[0] as { toolchains: readonly BrowserToolchainSource[] }).toolchains;
    const runnerSources = (state.runnerOptions[0] as { toolchains: readonly BrowserToolchainSource[] }).toolchains;
    expect(compilerSources).toEqual([source]);
    expect(runnerSources).toEqual([source]);
    expect(Object.isFrozen(compilerSources)).toBe(true);
    expect(compilerSources).not.toBe(input);

    engine.dispose();
    expect(state.compilerDisposals).toBe(1);
    expect(state.runnerDisposals).toBe(1);
    expect(state.cacheCloses).toBe(1);
  });

  it("rejects missing sources before allocating browser resources", async () => {
    await expect(createBrowserEngine(undefined as never)).rejects.toThrow("requires explicit toolchain options");
    await expect(createBrowserEngine({ toolchains: [] })).rejects.toThrow("At least one explicit");
    expect(state.compilerOptions).toHaveLength(0);
    expect(state.runnerOptions).toHaveLength(0);
    expect(state.cacheCloses).toBe(0);
  });

  it("disposes partial resources when host construction fails", async () => {
    state.runnerThrows = true;
    await expect(createBrowserEngine({ toolchains: [browserSource()] })).rejects.toThrow(
      "runner construction failed",
    );
    expect(state.compilerDisposals).toBe(1);
    expect(state.cacheCloses).toBe(1);
  });
});

function browserSource(): BrowserToolchainSource {
  return {
    kind: "browser",
    baseUrl: "/toolchains/",
    descriptor: {
      schema: WASM_OJ_SCHEMAS.toolchainPackage,
      id: "test",
      version: "1.0.0",
      wasmOjContract: WASM_OJ_CONTRACT_VERSION,
      languages: ["javascript"],
      profiles: [{ language: "javascript", target: "wasip1", optimization: "release" }],
      assets: [{
        path: "/toolchains/test.bin",
        bytes: 1,
        sha256: "0".repeat(64),
        exportPath: "./assets/test.bin",
      }],
    },
  };
}
