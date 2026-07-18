import { afterEach, describe, expect, it, vi } from "vitest";
import { FORGE_CONTRACT_VERSION } from "../core/contract";
import { costProfileId } from "../core/cost-profile";
import { toolchainPackageIdentities } from "../core/toolchains";
import type { BuildArtifact, BuildResult, Project, WorkerProgress } from "../core/types";
import type { ForgeCompiler } from "./compiler";
import { CompileCoordinator, type ForgeArtifactStore } from "./coordinator";

function project(content: string): Project {
  return {
    id: "project",
    name: "project",
    files: [{ path: "src/main.c", language: "c", content }],
    activeFile: "src/main.c",
    updatedAt: 0,
    config: {
      language: "c",
      target: "wasip1",
      optimization: "release",
      entry: "src/main.c",
      args: [],
      stdin: "",
      env: {},
      determinism: { randomSeed: 1, realtimeEpochMs: 1, clockStepNs: 1 },
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

function artifact(projectValue: Project, cacheKey: string): BuildArtifact {
  return {
    kind: "wasm",
    forgeContract: FORGE_CONTRACT_VERSION,
    id: crypto.randomUUID(),
    projectId: projectValue.id,
    cacheKey,
    name: "project.wasm",
    language: "c",
    target: "wasip1",
    optimization: "release",
    createdAt: 0,
    durationMs: 1,
    size: 1,
    toolchains: toolchainPackageIdentities("c"),
    costProfile: costProfileId("c", "wasip1", "release"),
    bytes: new Uint8Array([0]),
  };
}

class MemoryStore implements ForgeArtifactStore {
  readonly values = new Map<string, BuildArtifact>();
  readonly saves: BuildArtifact[] = [];
  readonly deletes: string[] = [];
  async load(cacheKey: string) { return this.values.get(cacheKey); }
  async save(value: BuildArtifact) {
    this.saves.push(value);
    this.values.set(value.cacheKey, value);
  }
  async delete(cacheKey: string) {
    this.deletes.push(cacheKey);
    this.values.delete(cacheKey);
  }
  async clear() { this.values.clear(); }
}

class DeferredCompiler implements ForgeCompiler {
  builds: Array<{
    project: Project;
    cacheKey: string;
    resolve(result: BuildResult): void;
    reject(error: Error): void;
  }> = [];

  cacheIdentity() { return "forge-test-deferred-compiler-1"; }
  ready() { return Promise.resolve(); }
  onProgress(listener: (progress: WorkerProgress) => void) {
    void listener;
    return () => undefined;
  }
  clearToolchainCache() { return Promise.resolve(); }
  restart() { this.cancel(); }
  dispose() { this.cancel(); }

  build(projectValue: Project, cacheKey: string): Promise<BuildResult> {
    return new Promise((resolve, reject) => {
      this.builds.push({ project: projectValue, cacheKey, resolve, reject });
    });
  }

  cancel(): void {
    this.builds.at(-1)?.reject(new Error("Compilation cancelled."));
  }
}

class NonCooperativeCompiler extends DeferredCompiler {
  override cancel(): void {}
  override restart(): void {}
}

describe("CompileCoordinator", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("rejects malformed projects before compiler identity, cache, or build work", async () => {
    const compiler = new DeferredCompiler();
    const store = new MemoryStore();
    const cacheIdentity = vi.spyOn(compiler, "cacheIdentity");
    const load = vi.spyOn(store, "load");
    const save = vi.spyOn(store, "save");
    const coordinator = new CompileCoordinator(compiler, store);
    const source = project("int main(void){return 0;}");
    const malformed: Project = {
      ...source,
      config: { ...source.config, args: [1] as unknown as string[] },
    };

    await expect(coordinator.compile(malformed)).rejects.toThrow("arguments must contain only strings");
    await expect(coordinator.precompile(malformed)).rejects.toThrow("arguments must contain only strings");
    expect(cacheIdentity).not.toHaveBeenCalled();
    expect(load).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
    expect(compiler.builds).toHaveLength(0);
  });

  it("joins a matching compile-ahead request from a foreground build", async () => {
    const compiler = new DeferredCompiler();
    const store = new MemoryStore();
    const coordinator = new CompileCoordinator(compiler, store);
    const source = project("int main(void){return 0;}");
    const background = coordinator.precompile(source);
    await until(() => compiler.builds.length === 1);
    const foreground = coordinator.compile(source);
    await Promise.resolve();
    expect(compiler.builds).toHaveLength(1);
    const pending = compiler.builds[0]!;
    const result: BuildResult = {
      success: true,
      diagnostics: [],
      artifact: artifact(source, pending.cacheKey),
      stdout: "",
      stderr: "",
      cacheHit: false,
    };
    pending.resolve(result);
    await expect(foreground).resolves.toMatchObject({
      success: true,
      artifact: result.artifact,
    });
    expect(["ready", "superseded"]).toContain((await background).status);
    expect(store.values.get(pending.cacheKey)).toBe(result.artifact);
  });

  it("cancels a stale background build before compiling changed source", async () => {
    const compiler = new DeferredCompiler();
    const coordinator = new CompileCoordinator(compiler, new MemoryStore());
    const oldBuild = coordinator.precompile(project("int value=1;"));
    await until(() => compiler.builds.length === 1);
    coordinator.supersedeBackground();
    await expect(oldBuild).resolves.toMatchObject({ status: "superseded" });
    const currentProject = project("int value=2;");
    const current = coordinator.compile(currentProject);
    await until(() => compiler.builds.length === 2);
    const pending = compiler.builds[1]!;
    const result: BuildResult = {
      success: true,
      diagnostics: [],
      artifact: artifact(currentProject, pending.cacheKey),
      stdout: "",
      stderr: "",
      cacheHit: false,
    };
    pending.resolve(result);
    await expect(current).resolves.toBe(result);
  });

  it.each(["cancel", "restart"] as const)(
    "releases a foreground build synchronously on %s so an exact retry cannot join it",
    async (action) => {
      const compiler = new DeferredCompiler();
      const coordinator = new CompileCoordinator(compiler);
      const source = project("int main(void){return 0;}");
      const stale = coordinator.compile(source, { cache: false });
      await until(() => compiler.builds.length === 1);
      const staleAssertion = expect(stale).rejects.toThrow("cancelled");

      coordinator[action]();
      const retry = coordinator.compile(source, { cache: false });
      await until(() => compiler.builds.length === 2);
      await staleAssertion;

      const pending = compiler.builds[1]!;
      const result: BuildResult = {
        success: true,
        diagnostics: [],
        artifact: artifact(source, pending.cacheKey),
        stdout: "",
        stderr: "",
        cacheHit: false,
      };
      pending.resolve(result);
      await expect(retry).resolves.toBe(result);
    },
  );

  it.each(["cancel", "restart"] as const)(
    "supersedes a hashing compile on %s before it can reach the compiler",
    async (action) => {
      const compiler = new DeferredCompiler();
      const coordinator = new CompileCoordinator(compiler);
      const pending = coordinator.compile(project("int main(void){return 0;}"), { cache: false });
      const pendingAssertion = expect(pending).rejects.toThrow("superseded");

      coordinator[action]();

      await pendingAssertion;
      expect(compiler.builds).toHaveLength(0);
    },
  );

  it("rejects and never persists a superseded result from a non-cooperative compiler", async () => {
    const compiler = new NonCooperativeCompiler();
    const store = new MemoryStore();
    const coordinator = new CompileCoordinator(compiler, store);
    const source = project("int main(void){return 0;}");
    const stale = coordinator.compile(source);
    await until(() => compiler.builds.length === 1);
    const staleAssertion = expect(stale).rejects.toThrow("superseded");

    coordinator.cancel();
    const retry = coordinator.compile(source);
    await until(() => compiler.builds.length === 2);

    const staleBuild = compiler.builds[0]!;
    staleBuild.resolve({
      success: true,
      diagnostics: [],
      artifact: artifact(source, staleBuild.cacheKey),
      stdout: "",
      stderr: "",
      cacheHit: false,
    });
    await staleAssertion;
    expect(store.saves).toHaveLength(0);

    const currentBuild = compiler.builds[1]!;
    const current: BuildResult = {
      success: true,
      diagnostics: [],
      artifact: artifact(source, currentBuild.cacheKey),
      stdout: "",
      stderr: "",
      cacheHit: false,
    };
    currentBuild.resolve(current);
    await expect(retry).resolves.toBe(current);
    expect(store.saves).toEqual([current.artifact]);
  });

  it("loads an exact artifact without invoking the compiler", async () => {
    const compiler = new DeferredCompiler();
    const store = new MemoryStore();
    const coordinator = new CompileCoordinator(compiler, store);
    const source = project("int main(void){return 0;}");
    const first = coordinator.compile(source);
    await until(() => compiler.builds.length === 1);
    const pending = compiler.builds[0]!;
    pending.resolve({
      success: true,
      diagnostics: [],
      artifact: artifact(source, pending.cacheKey),
      stdout: "",
      stderr: "",
      cacheHit: false,
    });
    await first;
    const second = await coordinator.compile(source);
    expect(second.cacheHit).toBe(true);
    expect(compiler.builds).toHaveLength(1);
  });

  it("evicts an identity-invalid cached artifact and rebuilds the same request", async () => {
    const compiler = new DeferredCompiler();
    const store = new MemoryStore();
    const coordinator = new CompileCoordinator(compiler, store);
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const source = project("int main(void){return 0;}");
    const first = coordinator.compile(source);
    await until(() => compiler.builds.length === 1);
    const pending = compiler.builds[0]!;
    const cached = artifact(source, pending.cacheKey);
    pending.resolve({
      success: true,
      diagnostics: [],
      artifact: cached,
      stdout: "",
      stderr: "",
      cacheHit: false,
    });
    await first;
    cached.target = "wasix";
    const rebuilt = coordinator.compile(source);
    await until(() => compiler.builds.length === 2);
    expect(store.deletes).toEqual([pending.cacheKey]);
    expect(store.values.has(pending.cacheKey)).toBe(false);

    const replacement = compiler.builds[1]!;
    const result: BuildResult = {
      success: true,
      diagnostics: [],
      artifact: artifact(source, replacement.cacheKey),
      stdout: "",
      stderr: "",
      cacheHit: false,
    };
    replacement.resolve(result);
    await expect(rebuilt).resolves.toBe(result);
    expect(store.values.get(replacement.cacheKey)).toBe(result.artifact);
    expect(warning).toHaveBeenCalledWith(
      expect.stringContaining("build identity is invalid"),
      expect.any(Error),
    );
  });

  it("surfaces artifact-store read failures without compiling or evicting", async () => {
    const compiler = new DeferredCompiler();
    const store = new MemoryStore();
    const failure = new Error("IndexedDB read failed");
    vi.spyOn(store, "load").mockRejectedValue(failure);
    const coordinator = new CompileCoordinator(compiler, store);

    await expect(coordinator.compile(project("int main(void){return 0;}"))).rejects.toBe(failure);
    expect(compiler.builds).toHaveLength(0);
    expect(store.deletes).toHaveLength(0);
  });

  it("returns a successful build when artifact persistence exceeds its quota", async () => {
    const compiler = new DeferredCompiler();
    const store = new MemoryStore();
    vi.spyOn(store, "save").mockRejectedValue(new DOMException("Storage quota exceeded", "QuotaExceededError"));
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const coordinator = new CompileCoordinator(compiler, store);
    const source = project("int main(void){return 0;}");
    const compiled = coordinator.compile(source);
    await until(() => compiler.builds.length === 1);
    const pending = compiler.builds[0]!;
    const result: BuildResult = {
      success: true,
      diagnostics: [],
      artifact: artifact(source, pending.cacheKey),
      stdout: "",
      stderr: "",
      cacheHit: false,
    };
    pending.resolve(result);

    await expect(compiled).resolves.toBe(result);
    expect(warning).toHaveBeenCalledWith(
      expect.stringContaining("Unable to persist compiled artifact"),
      expect.objectContaining({ name: "QuotaExceededError" }),
    );
  });

  it("waits for an accepted save and removes it when cache clearing supersedes the build", async () => {
    const compiler = new NonCooperativeCompiler();
    const store = new MemoryStore();
    let releaseSave!: () => void;
    const saveGate = new Promise<void>((resolve) => { releaseSave = resolve; });
    vi.spyOn(store, "save").mockImplementation(async (value) => {
      await saveGate;
      store.values.set(value.cacheKey, value);
    });
    const coordinator = new CompileCoordinator(compiler, store);
    const source = project("int main(void){return 0;}");
    const compiled = coordinator.compile(source);
    await until(() => compiler.builds.length === 1);
    const pending = compiler.builds[0]!;
    pending.resolve({
      success: true,
      diagnostics: [],
      artifact: artifact(source, pending.cacheKey),
      stdout: "",
      stderr: "",
      cacheHit: false,
    });
    await until(() => vi.mocked(store.save).mock.calls.length === 1);
    const compiledAssertion = expect(compiled).rejects.toThrow("superseded");

    let quiescent = false;
    const cancellation = coordinator.cancelAndWait().then(() => { quiescent = true; });
    await Promise.resolve();
    expect(quiescent).toBe(false);
    releaseSave();

    await compiledAssertion;
    await cancellation;
    expect(store.values.size).toBe(0);
    expect(store.deletes).toEqual([pending.cacheKey]);
  });

  it("does not leave a late artifact behind after disposal during persistence", async () => {
    const compiler = new NonCooperativeCompiler();
    const store = new MemoryStore();
    let releaseSave!: () => void;
    const saveGate = new Promise<void>((resolve) => { releaseSave = resolve; });
    vi.spyOn(store, "save").mockImplementation(async (value) => {
      await saveGate;
      store.values.set(value.cacheKey, value);
    });
    const coordinator = new CompileCoordinator(compiler, store);
    const source = project("int main(void){return 0;}");
    const compiled = coordinator.compile(source);
    await until(() => compiler.builds.length === 1);
    const pending = compiler.builds[0]!;
    pending.resolve({
      success: true,
      diagnostics: [],
      artifact: artifact(source, pending.cacheKey),
      stdout: "",
      stderr: "",
      cacheHit: false,
    });
    await until(() => vi.mocked(store.save).mock.calls.length === 1);
    const compiledAssertion = expect(compiled).rejects.toThrow("superseded");

    coordinator.dispose();
    releaseSave();

    await compiledAssertion;
    expect(store.values.size).toBe(0);
    expect(store.deletes).toEqual([pending.cacheKey]);
  });

  it("serializes an exact retry behind superseded persistence cleanup", async () => {
    const compiler = new NonCooperativeCompiler();
    const store = new MemoryStore();
    let releaseFirstSave!: () => void;
    const firstSaveGate = new Promise<void>((resolve) => { releaseFirstSave = resolve; });
    let saveCount = 0;
    vi.spyOn(store, "save").mockImplementation(async (value) => {
      saveCount += 1;
      if (saveCount === 1) await firstSaveGate;
      store.values.set(value.cacheKey, value);
    });
    const coordinator = new CompileCoordinator(compiler, store);
    const source = project("int main(void){return 0;}");
    const stale = coordinator.compile(source);
    await until(() => compiler.builds.length === 1);
    const staleBuild = compiler.builds[0]!;
    staleBuild.resolve({
      success: true,
      diagnostics: [],
      artifact: artifact(source, staleBuild.cacheKey),
      stdout: "",
      stderr: "",
      cacheHit: false,
    });
    await until(() => saveCount === 1);
    const staleAssertion = expect(stale).rejects.toThrow("superseded");

    coordinator.cancel();
    const retry = coordinator.compile(source);
    await Promise.resolve();
    expect(compiler.builds).toHaveLength(1);
    releaseFirstSave();
    await staleAssertion;
    await until(() => compiler.builds.length === 2);

    const retryBuild = compiler.builds[1]!;
    const current: BuildResult = {
      success: true,
      diagnostics: [],
      artifact: artifact(source, retryBuild.cacheKey),
      stdout: "",
      stderr: "",
      cacheHit: false,
    };
    retryBuild.resolve(current);
    await expect(retry).resolves.toBe(current);
    expect(saveCount).toBe(2);
    expect(store.values.get(retryBuild.cacheKey)).toBe(current.artifact);
    expect(store.deletes).toEqual([staleBuild.cacheKey]);
  });
});

async function until(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error("Condition was not reached.");
}
