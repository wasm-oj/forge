import { describe, expect, it, vi } from "vitest";
import type { BuildResult, Project, WorkerProgress } from "../core/types";
import type { ForgeCompiler } from "./compiler";
import { ForgeCompilerRegistry } from "./compiler-registry";

function compiler(result: BuildResult) {
  let progressListener: ((value: WorkerProgress) => void) | undefined;
  const removeProgressListener = vi.fn(() => {
    progressListener = undefined;
  });
  return {
    cacheIdentity: vi.fn(() => "forge-test-compiler-1"),
    ready: vi.fn(() => Promise.resolve()),
    build: vi.fn(async () => result),
    onProgress: vi.fn((listener: (value: WorkerProgress) => void) => {
      progressListener = listener;
      return removeProgressListener;
    }),
    clearToolchainCache: vi.fn(() => Promise.resolve()),
    cancel: vi.fn(),
    restart: vi.fn(),
    dispose: vi.fn(),
    emitProgress: (progress: WorkerProgress) => progressListener?.(progress),
    removeProgressListener,
  } satisfies ForgeCompiler & {
    emitProgress(progress: WorkerProgress): void;
    removeProgressListener: ReturnType<typeof vi.fn>;
  };
}

function project(language: string): Project {
  return {
    id: "custom",
    name: "custom",
    files: [{ path: "main.src", language, content: "" }],
    activeFile: "main.src",
    updatedAt: 0,
    config: {
      language,
      target: "wasip1",
      optimization: "release",
      entry: "main.src",
      args: [],
      stdin: "",
      env: {},
      determinism: { randomSeed: 0, realtimeEpochMs: 0, clockStepNs: 1 },
      resources: {
        instructionBudget: 1,
        logicalTimeLimitMs: 1,
        memoryLimitBytes: 65_536,
        outputLimitBytes: 1,
        filesystemWriteLimitBytes: 1,
        filesystemEntryLimit: 1,
        wallTimeLimitMs: 1,
      },
    },
  };
}

const failure: BuildResult = {
  success: false,
  diagnostics: [],
  stdout: "",
  stderr: "",
  cacheHit: false,
};

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe("ForgeCompilerRegistry", () => {
  it("routes a seventh language's cache identity and build to its registered compiler", async () => {
    const builtin = compiler(failure);
    const custom = compiler(failure);
    const registry = new ForgeCompilerRegistry([
      { languages: ["c"], compiler: builtin },
      { languages: ["zig"], compiler: custom },
    ]);
    const zigProject = project("zig");

    expect(registry.languages()).toEqual(["c", "zig"]);
    expect(registry.cacheIdentity(zigProject)).toBe("forge-test-compiler-1");
    expect(custom.cacheIdentity).toHaveBeenCalledWith(zigProject);
    expect(builtin.cacheIdentity).not.toHaveBeenCalled();
    await expect(registry.build(zigProject, "key")).resolves.toBe(failure);
    expect(custom.build).toHaveBeenCalledWith(expect.objectContaining({ config: expect.objectContaining({ language: "zig" }) }), "key");
    expect(builtin.build).not.toHaveBeenCalled();
    registry.dispose();
  });

  it("owns shared compiler lifecycle exactly once and forwards progress until disposal", async () => {
    const shared = compiler(failure);
    const registry = new ForgeCompilerRegistry([
      { languages: ["c"], compiler: shared },
      { languages: ["cpp"], compiler: shared },
    ]);
    const progressListener = vi.fn();
    const removeRegistryListener = registry.onProgress(progressListener);
    const progress = { phase: "compiling", label: "main.c", progress: 0.5 } as const;

    shared.emitProgress(progress);
    expect(progressListener).toHaveBeenCalledWith(progress);
    await Promise.all([registry.ready(), registry.ready()]);
    expect(shared.ready).toHaveBeenCalledTimes(1);

    await registry.clearToolchainCache();
    expect(shared.ready).toHaveBeenCalledTimes(1);
    expect(shared.clearToolchainCache).toHaveBeenCalledTimes(1);
    registry.cancel();
    expect(shared.cancel).toHaveBeenCalledTimes(1);

    registry.restart();
    await registry.ready();
    expect(shared.restart).toHaveBeenCalledTimes(1);
    expect(shared.ready).toHaveBeenCalledTimes(2);

    removeRegistryListener();
    progressListener.mockClear();
    shared.emitProgress(progress);
    expect(progressListener).not.toHaveBeenCalled();

    registry.dispose();
    registry.dispose();
    expect(shared.removeProgressListener).toHaveBeenCalledTimes(1);
    expect(shared.dispose).toHaveBeenCalledTimes(1);
    expect(() => registry.ready()).toThrow("disposed");
  });

  it("rejects ambiguous registration and freezes routing after identity selection", () => {
    const registry = new ForgeCompilerRegistry();
    registry.register(["c"], compiler(failure));
    expect(() => registry.register(["c"], compiler(failure))).toThrow("already has");
    registry.cacheIdentity(project("c"));
    expect(() => registry.register(["zig"], compiler(failure))).toThrow("sealed");
    registry.dispose();
  });

  it("does not commit a route when compiler progress subscription fails", () => {
    const registry = new ForgeCompilerRegistry();
    const broken = compiler(failure);
    broken.onProgress.mockImplementationOnce(() => {
      throw new Error("subscription failed");
    });

    expect(() => registry.register(["zig"], broken)).toThrow("subscription failed");
    expect(registry.languages()).toEqual([]);
    expect(() => registry.cacheIdentity(project("zig"))).toThrow("No ForgeCompiler");
    registry.dispose();
    expect(broken.dispose).not.toHaveBeenCalled();
  });

  it("releases already-owned compilers when constructor registration fails", () => {
    const first = compiler(failure);
    const second = compiler(failure);

    expect(() => new ForgeCompilerRegistry([
      { languages: ["c"], compiler: first },
      { languages: ["c"], compiler: second },
    ])).toThrow("already has");
    expect(first.removeProgressListener).toHaveBeenCalledTimes(1);
    expect(first.dispose).toHaveBeenCalledTimes(1);
    expect(second.dispose).not.toHaveBeenCalled();
  });

  it("rejects malformed compiler contracts before taking ownership", () => {
    const registry = new ForgeCompilerRegistry();
    expect(() => registry.register(["zig"], { onProgress: vi.fn() } as never))
      .toThrow("cacheIdentity");
    expect(registry.languages()).toEqual([]);
    registry.dispose();
  });

  it("fails explicitly when no compiler owns a language", async () => {
    const registry = new ForgeCompilerRegistry();
    expect(() => registry.cacheIdentity(project("zig"))).toThrow("No ForgeCompiler");
    await expect(registry.build(project("zig"), "key")).rejects.toThrow("No ForgeCompiler");
    registry.dispose();
  });

  it("invalidates readiness and prevents a stale build after restart", async () => {
    const firstReady = deferred<void>();
    const implementation = compiler(failure);
    implementation.ready
      .mockImplementationOnce(() => firstReady.promise)
      .mockResolvedValue(undefined);
    const registry = new ForgeCompilerRegistry([{ languages: ["c"], compiler: implementation }]);

    const build = registry.build(project("c"), "key");
    registry.restart();
    firstReady.resolve();

    await expect(build).rejects.toThrow("superseded");
    expect(implementation.build).not.toHaveBeenCalled();
    await expect(registry.ready()).resolves.toBeUndefined();
    expect(implementation.ready).toHaveBeenCalledTimes(2);
    registry.dispose();
  });

  it("retries a failed compiler initialization", async () => {
    const implementation = compiler(failure);
    implementation.ready
      .mockRejectedValueOnce(new Error("initialization failed"))
      .mockResolvedValue(undefined);
    const registry = new ForgeCompilerRegistry([{ languages: ["c"], compiler: implementation }]);

    await expect(registry.ready()).rejects.toThrow("initialization failed");
    await expect(registry.ready()).resolves.toBeUndefined();
    expect(implementation.ready).toHaveBeenCalledTimes(2);
    registry.dispose();
  });

  it("settles every lifecycle participant before reporting failures", () => {
    const first = compiler(failure);
    const second = compiler(failure);
    first.restart.mockImplementation(() => {
      throw new Error("first restart failed");
    });
    first.dispose.mockImplementation(() => {
      throw new Error("first disposal failed");
    });
    const registry = new ForgeCompilerRegistry([
      { languages: ["c"], compiler: first },
      { languages: ["cpp"], compiler: second },
    ]);

    expect(() => registry.restart()).toThrow(AggregateError);
    expect(second.restart).toHaveBeenCalledTimes(1);
    expect(() => registry.dispose()).toThrow(AggregateError);
    expect(second.dispose).toHaveBeenCalledTimes(1);
  });
});
