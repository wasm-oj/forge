import { describe, expect, it, vi } from "vitest";
import { FORGE_CONTRACT_VERSION } from "../core/contract";
import type { ForgeCompiler } from "../compiler/compiler";
import type { BuildResult, WasmArtifact } from "../core/types";
import { WEIGHTED_METER_MODEL } from "../core/resources";
import { costProfileId } from "../core/cost-profile";
import { toolchainPackageIdentities } from "../core/toolchains";
import type { ForgeRunner } from "../runner/runner";
import { ForgeEngine, type ForgeArtifactStore } from "./engine";
import type { ForgeOperationEvent } from "../operations/operation";

const artifact: WasmArtifact = {
  kind: "wasm",
  forgeContract: FORGE_CONTRACT_VERSION,
  id: "artifact",
  projectId: "project",
  cacheKey: "unused-outside-compile",
  name: "app.wasm",
  language: "c",
  target: "wasip1",
  optimization: "release",
  createdAt: 0,
  durationMs: 0,
  size: 8,
  toolchains: toolchainPackageIdentities("c"),
  costProfile: costProfileId("c", "wasip1", "release"),
  bytes: new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]),
};

describe("ForgeEngine", () => {
  it("composes environment-neutral compiler, runner, and artifact-store contracts", async () => {
    const compiler = {
      cacheIdentity: vi.fn(() => "forge-test-c-compiler-1"),
      ready: vi.fn(async () => undefined),
      build: vi.fn(async (project, cacheKey) => ({
        success: true,
        diagnostics: [],
        artifact: {
          ...artifact,
          projectId: project.id,
          name: `${project.name}.wasm`,
          cacheKey,
        },
        stdout: "",
        stderr: "",
        cacheHit: false,
      })),
      onProgress: vi.fn(() => () => undefined),
      clearToolchainCache: vi.fn(async () => undefined),
      cancel: vi.fn(),
      restart: vi.fn(),
      dispose: vi.fn(),
    } satisfies ForgeCompiler;
    const runner = {
      ready: vi.fn(async () => undefined),
      run: vi.fn(async (_artifact, config) => ({
        code: 0,
        stdout: "ok\n",
        stderr: "",
        files: {},
        durationMs: 1,
        determinism: config.determinism,
        resources: config.resources,
        termination: "exited" as const,
        metrics: {
          cost: 1,
          rawCost: 4,
          baselineCost: 3,
          costProfile: artifact.costProfile,
          costModel: WEIGHTED_METER_MODEL,
          operations: { I32Const: 1 },
          memoryBytes: 65_536,
          logicalTimeNs: 0,
          filesystemBytes: 0,
          filesystemEntries: 0,
          stdoutBytes: 3,
          stderrBytes: 0,
        },
      })),
      interact: vi.fn(),
      onProgress: vi.fn(() => () => undefined),
      onStream: vi.fn(() => () => undefined),
      clearRuntimeCache: vi.fn(async () => undefined),
      cancel: vi.fn(),
      cancelAndWait: vi.fn(async () => undefined),
      restart: vi.fn(),
      dispose: vi.fn(),
    } satisfies ForgeRunner;
    let cached: WasmArtifact | undefined;
    const store = {
      load: vi.fn(async () => cached),
      save: vi.fn(async (value) => {
        cached = value as WasmArtifact;
      }),
      delete: vi.fn(async () => {
        cached = undefined;
      }),
      clear: vi.fn(async () => {
        cached = undefined;
      }),
    } satisfies ForgeArtifactStore;
    const engine = new ForgeEngine({ compiler, runner, artifactStore: store });
    const input = { language: "c" as const, entry: "main.c", files: { "main.c": "int main(){}" } };

    await engine.ready();
    expect((await engine.compile(input)).cacheHit).toBe(false);
    expect((await engine.compile(input)).cacheHit).toBe(true);
    expect(compiler.build).toHaveBeenCalledTimes(1);
    expect((await engine.run(artifact)).stdout).toBe("ok\n");
    await expect(engine.compile({ language: "c", entry: "main.c", files: {} })).rejects.toMatchObject({
      code: "invalid-input",
      stage: "compile",
      retryable: false,
    });
    runner.run.mockRejectedValueOnce(new Error("runtime transport failed"));
    await expect(engine.run(artifact)).rejects.toMatchObject({
      code: "runner-failure",
      stage: "run",
      retryable: true,
    });
    await expect(engine.run(artifact, { args: "abc" as unknown as string[] })).rejects.toMatchObject({
      code: "invalid-input",
      stage: "run",
      retryable: false,
    });

    await engine.clearCache();
    expect(compiler.clearToolchainCache).toHaveBeenCalledOnce();
    expect(runner.cancelAndWait).toHaveBeenCalledOnce();
    expect(runner.clearRuntimeCache).toHaveBeenCalledOnce();
    expect(store.clear).toHaveBeenCalledOnce();

    engine.dispose();
    engine.dispose();
    expect(compiler.dispose).toHaveBeenCalledOnce();
    expect(runner.dispose).toHaveBeenCalledOnce();
    expect(() => engine.restart()).toThrow("ForgeEngine is disposed");
    await expect(engine.compile(input)).rejects.toThrow("ForgeEngine is disposed");
  });

  it("executes one observable submission and protects its operation boundary", async () => {
    const compiler = {
      cacheIdentity: vi.fn(() => "forge-test-c-compiler-1"),
      ready: vi.fn(async () => undefined),
      build: vi.fn(async (project, cacheKey) => ({
        success: true,
        diagnostics: [],
        artifact: { ...artifact, projectId: project.id, cacheKey, name: `${project.name}.wasm` },
        stdout: "",
        stderr: "",
        cacheHit: false,
      })),
      onProgress: vi.fn(() => () => undefined),
      clearToolchainCache: vi.fn(async () => undefined),
      cancel: vi.fn(),
      restart: vi.fn(),
      dispose: vi.fn(),
    } satisfies ForgeCompiler;
    const runner = {
      ready: vi.fn(async () => undefined),
      run: vi.fn(async (_artifact, config) => ({
        code: 0,
        stdout: "ok\n",
        stderr: "",
        files: {},
        durationMs: 1,
        determinism: config.determinism,
        resources: config.resources,
        termination: "exited" as const,
        metrics: {
          cost: 1,
          rawCost: 4,
          baselineCost: 3,
          costProfile: artifact.costProfile,
          costModel: WEIGHTED_METER_MODEL,
          operations: { I32Const: 1 },
          memoryBytes: 65_536,
          logicalTimeNs: 0,
          filesystemBytes: 0,
          filesystemEntries: 0,
          stdoutBytes: 3,
          stderrBytes: 0,
        },
      })),
      interact: vi.fn(),
      onProgress: vi.fn(() => () => undefined),
      onStream: vi.fn(() => () => undefined),
      clearRuntimeCache: vi.fn(async () => undefined),
      cancel: vi.fn(),
      cancelAndWait: vi.fn(async () => undefined),
      restart: vi.fn(),
      dispose: vi.fn(),
    } satisfies ForgeRunner;
    const engine = new ForgeEngine({ compiler, runner });
    const input = { language: "c" as const, entry: "main.c", files: { "main.c": "int main(){}" } };
    const events: ForgeOperationEvent[] = [];
    engine.onObservation((event) => events.push(event));

    const operation = engine.submit({
      id: "submission-1",
      input,
      spec: {
        version: FORGE_CONTRACT_VERSION,
        cases: [{
          id: "sample",
          kind: "batch",
          input: { kind: "inline", value: "" },
          matcher: { id: "text", config: { expected: "ok\n", normalization: "lines" } },
        }],
      },
    });
    await expect(engine.compile(input)).rejects.toMatchObject({ code: "operation-conflict" });
    expect(() => engine.clearCache()).toThrow(expect.objectContaining({ code: "operation-conflict" }));

    await expect(operation.result).resolves.toMatchObject({
      build: { success: true },
      judge: { verdict: "accepted" },
    });
    expect(events.every((event) => event.operationId === operation.id)).toBe(true);
    expect(events.map((event) => event.sequence)).toEqual(events.map((_, index) => index));
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "build", success: true }),
      expect.objectContaining({ type: "case", caseId: "sample", verdict: "accepted" }),
      expect.objectContaining({ type: "state", state: "succeeded" }),
    ]));
    engine.dispose();
  });

  it.each(["cancel", "restart"] as const)(
    "allows an immediate exact compile retry after %s",
    async (action) => {
      const builds: Array<{
        cacheKey: string;
        resolve(value: Awaited<ReturnType<ForgeCompiler["build"]>>): void;
        reject(error: Error): void;
      }> = [];
      const rejectCurrent = (message: string) => builds.at(-1)?.reject(new Error(message));
      const compiler = {
        cacheIdentity: vi.fn(() => "forge-test-c-compiler-1"),
        ready: vi.fn(async () => undefined),
        build: vi.fn((_project, cacheKey) => new Promise<BuildResult>((resolve, reject) => {
          builds.push({ cacheKey, resolve, reject });
        })),
        onProgress: vi.fn(() => () => undefined),
        clearToolchainCache: vi.fn(async () => undefined),
        cancel: vi.fn(() => rejectCurrent("Compilation cancelled.")),
        restart: vi.fn(() => rejectCurrent("Compiler restarted.")),
        dispose: vi.fn(() => rejectCurrent("Compiler disposed.")),
      } satisfies ForgeCompiler;
      const runner = {
        ready: vi.fn(async () => undefined),
        run: vi.fn(),
        interact: vi.fn(),
        onProgress: vi.fn(() => () => undefined),
        onStream: vi.fn(() => () => undefined),
        clearRuntimeCache: vi.fn(async () => undefined),
        cancel: vi.fn(),
        cancelAndWait: vi.fn(async () => undefined),
        restart: vi.fn(),
        dispose: vi.fn(),
      } satisfies ForgeRunner;
      const engine = new ForgeEngine({ compiler, runner });
      const input = { language: "c" as const, entry: "main.c", files: { "main.c": "int main(){}" } };
      const stale = engine.compile(input);
      await until(() => builds.length === 1);
      const staleAssertion = expect(stale).rejects.toThrow(action === "cancel" ? "cancelled" : "restarted");

      engine[action]();
      const retry = engine.compile(input);
      await until(() => builds.length === 2);
      await staleAssertion;

      const current = builds[1]!;
      current.resolve({
        success: true,
        diagnostics: [],
        artifact: { ...artifact, cacheKey: current.cacheKey, projectId: "sdk:main", name: "main.wasm" },
        stdout: "",
        stderr: "",
        cacheHit: false,
      });
      await expect(retry).resolves.toMatchObject({ success: true });
      engine.dispose();
    },
  );

  it("quiesces late artifact persistence before clearing every cache", async () => {
    let releaseSave!: () => void;
    const saveGate = new Promise<void>((resolve) => { releaseSave = resolve; });
    const compiler = {
      cacheIdentity: vi.fn(() => "forge-test-c-compiler-1"),
      ready: vi.fn(async () => undefined),
      build: vi.fn(async (project, cacheKey) => ({
        success: true,
        diagnostics: [],
        artifact: { ...artifact, projectId: project.id, cacheKey, name: `${project.name}.wasm` },
        stdout: "",
        stderr: "",
        cacheHit: false,
      })),
      onProgress: vi.fn(() => () => undefined),
      clearToolchainCache: vi.fn(async () => undefined),
      cancel: vi.fn(),
      restart: vi.fn(),
      dispose: vi.fn(),
    } satisfies ForgeCompiler;
    const runner = {
      ready: vi.fn(async () => undefined),
      run: vi.fn(),
      interact: vi.fn(),
      onProgress: vi.fn(() => () => undefined),
      onStream: vi.fn(() => () => undefined),
      clearRuntimeCache: vi.fn(async () => undefined),
      cancel: vi.fn(),
      cancelAndWait: vi.fn(async () => undefined),
      restart: vi.fn(),
      dispose: vi.fn(),
    } satisfies ForgeRunner;
    const values = new Map<string, WasmArtifact>();
    const store = {
      load: vi.fn(async (cacheKey: string) => values.get(cacheKey)),
      save: vi.fn(async (value: WasmArtifact) => {
        await saveGate;
        values.set(value.cacheKey, value);
      }),
      delete: vi.fn(async (cacheKey: string) => { values.delete(cacheKey); }),
      clear: vi.fn(async () => { values.clear(); }),
    } satisfies ForgeArtifactStore;
    const engine = new ForgeEngine({ compiler, runner, artifactStore: store });
    const input = { language: "c" as const, entry: "main.c", files: { "main.c": "int main(){}" } };
    const compile = engine.compile(input);
    await until(() => store.save.mock.calls.length === 1);
    const compileAssertion = expect(compile).rejects.toThrow("superseded");

    const clearing = engine.clearCache();
    await expect(engine.compile(input)).rejects.toThrow("clearing its caches");
    expect(compiler.clearToolchainCache).not.toHaveBeenCalled();
    releaseSave();

    await compileAssertion;
    await clearing;
    expect(values.size).toBe(0);
    expect(store.delete).toHaveBeenCalledOnce();
    expect(store.clear).toHaveBeenCalledOnce();
    expect(compiler.clearToolchainCache).toHaveBeenCalledOnce();
    engine.dispose();
  });

  it("cancels and awaits an active run before clearing runtime state", async () => {
    let rejectRun!: (error: Error) => void;
    let activeRun: Promise<never> | undefined;
    const compiler = {
      cacheIdentity: vi.fn(() => "forge-test-c-compiler-1"),
      ready: vi.fn(async () => undefined),
      build: vi.fn(),
      onProgress: vi.fn(() => () => undefined),
      clearToolchainCache: vi.fn(async () => undefined),
      cancel: vi.fn(),
      restart: vi.fn(),
      dispose: vi.fn(),
    } satisfies ForgeCompiler;
    const runner = {
      ready: vi.fn(async () => undefined),
      run: vi.fn(() => {
        activeRun = new Promise<never>((_resolve, reject) => { rejectRun = reject; });
        return activeRun;
      }),
      interact: vi.fn(),
      onProgress: vi.fn(() => () => undefined),
      onStream: vi.fn(() => () => undefined),
      clearRuntimeCache: vi.fn(async () => undefined),
      cancel: vi.fn(() => rejectRun(new Error("Execution cancelled."))),
      cancelAndWait: vi.fn(async () => {
        runner.cancel();
        if (activeRun) await Promise.allSettled([activeRun]);
      }),
      restart: vi.fn(),
      dispose: vi.fn(),
    } satisfies ForgeRunner;
    const engine = new ForgeEngine({ compiler, runner });
    const run = engine.run(artifact);
    const runAssertion = expect(run).rejects.toThrow("cancelled");

    await expect(engine.clearCache()).resolves.toBeUndefined();
    await runAssertion;
    expect(runner.cancelAndWait).toHaveBeenCalledOnce();
    expect(runner.clearRuntimeCache).toHaveBeenCalledOnce();
    engine.dispose();
  });
});

async function until(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error("Condition was not reached.");
}
