import type { ForgeCompiler } from "../compiler/compiler";
import {
  CompileCoordinator,
  type ForgeArtifactStore,
  type PrecompileOutcome,
} from "../compiler/coordinator";
import { resolveDeterminism } from "../core/determinism";
import { resolveResourcePolicy } from "../core/resources";
import type {
  BuildArtifact,
  BuildResult,
  InteractiveProgramConfig,
  InteractiveRunResult,
  RunResult,
  WorkerProgress,
} from "../core/types";
import type { ForgeRunner } from "../runner/runner";
import { createJudgeExecutor, JudgeEngine, type JudgeEngineOptions, type JudgeResult, type JudgeRunOptions } from "../judge/engine";
import { validateJudgeSpec, type JudgeSpec } from "../judge/spec";
import { createSdkProject, type CompileInput } from "./project";
import type { CompileOptions, ExecuteResult, InteractiveOptions, RunOptions } from "./types";
import {
  assertValidForgeReplayBundle,
  replayForgeBundle,
  type ForgeReplayBundle,
  type ForgeReplayOptions,
  type ForgeReplayResult,
} from "../replay/bundle";
import { assertValidProject } from "../core/project-validation";
import { assertValidBuildArtifact } from "../core/artifact-validation";
import type { Project } from "../core/types";
import {
  ForgeError,
  asForgeError,
  type ForgeErrorOptions,
  type ForgeErrorStage,
} from "../core/errors";
import {
  ForgeOperationScheduler,
  type ForgeOperationEvent,
  type ForgeOperationEventPayload,
  type ForgeSubmissionOperation,
  type ForgeSubmissionRequest,
} from "../operations/operation";
import type { DependencyBuildAdapter, DependencyBuildBundle } from "../dependencies/build";
import type {
  DependencyLock,
  DependencyManifest,
  ResolveDependencyOptions,
} from "../dependencies/types";
import type { ForgeDependencyManager } from "../dependencies/manager";

export type { ForgeArtifactStore } from "../compiler/coordinator";

export interface ForgeEngineOptions {
  compiler: ForgeCompiler;
  runner: ForgeRunner;
  artifactStore?: ForgeArtifactStore;
  judge?: JudgeEngineOptions;
  dependencyManager?: ForgeDependencyManager;
}

export interface JudgeProjectResult {
  build: BuildResult;
  judge?: JudgeResult;
}

/** High-level compile/run API shared by browser and server hosts. */
export class ForgeEngine {
  protected readonly compiler: ForgeCompiler;
  protected readonly runner: ForgeRunner;
  private readonly artifactStore?: ForgeArtifactStore;
  private readonly dependencyManager?: ForgeDependencyManager;
  private readonly compilation: CompileCoordinator;
  private readonly operationScheduler: ForgeOperationScheduler;
  private readonly observationListeners = new Set<(event: ForgeOperationEvent) => void>();
  private disposed = false;
  private cacheClearActive = false;
  private cacheClearOperation?: Promise<void>;
  /** Extensible judge registry for custom input providers and output matchers. */
  readonly judging: JudgeEngine;

  constructor(options: ForgeEngineOptions) {
    this.compiler = options.compiler;
    this.runner = options.runner;
    this.artifactStore = options.artifactStore;
    this.dependencyManager = options.dependencyManager;
    this.compilation = new CompileCoordinator(options.compiler, options.artifactStore);
    this.judging = new JudgeEngine(
      createJudgeExecutor({
        run: (artifact, run) => this.runner.run(artifact, {
          ...run,
          args: [...run.args],
          env: { ...run.env },
          files: Object.fromEntries(Object.entries(run.files).map(([path, contents]) => [path, contents.slice()])),
          outputPaths: [...run.outputPaths],
        }),
        interact: (contestant, interactor, interaction) => this.runner.interact(
          contestant,
          interactor,
          interaction,
        ),
      }),
      options.judge,
    );
    this.operationScheduler = new ForgeOperationScheduler({
      executeSubmission: (request, observe) => this.executeSubmission(request, observe),
      cancelActiveSubmission: () => this.cancelExecution(),
    }, (event) => this.notifyObservation(event));
  }

  async ready(): Promise<void> {
    this.assertAvailable();
    await stableBoundary(
      () => Promise.all([this.compiler.ready(), this.runner.ready()]).then(() => undefined),
      { code: "initialization-failure", stage: "initialize", retryable: false },
    );
  }

  onProgress(listener: (progress: WorkerProgress) => void): () => void {
    this.assertActive();
    const removeCompilerListener = this.compiler.onProgress(listener);
    let removeRunnerListener: () => void;
    try {
      removeRunnerListener = this.runner.onProgress(listener);
    } catch (error) {
      removeCompilerListener();
      throw error;
    }
    return () => {
      removeCompilerListener();
      removeRunnerListener();
    };
  }

  onStream(listener: (stream: "stdout" | "stderr", chunk: string) => void): () => void {
    this.assertActive();
    return this.runner.onStream(listener);
  }

  /** Subscribe to operation-scoped, structured host observations. */
  onObservation(listener: (event: ForgeOperationEvent) => void): () => void {
    this.assertActive();
    if (typeof listener !== "function") throw new TypeError("Forge observation listener must be a function.");
    this.observationListeners.add(listener);
    return () => this.observationListeners.delete(listener);
  }

  /** Enqueue one independently observable and cancellable compile-and-judge submission. */
  submit(request: ForgeSubmissionRequest): ForgeSubmissionOperation {
    this.assertActive();
    if (this.cacheClearActive) throw new ForgeError("ForgeEngine is clearing its caches.", {
      code: "operation-conflict",
      stage: "operation",
      retryable: true,
    });
    stableInput(() => {
      createSdkProject(request?.input);
      validateJudgeSpec(request?.spec);
      compileCacheRequested(request?.compile ?? {});
    }, "operation");
    return this.operationScheduler.submit(request);
  }

  /** Resolve and cache one canonical dependency graph using this host's adapters. */
  async resolveDependencies(
    manifest: DependencyManifest,
    options?: ResolveDependencyOptions,
  ): Promise<DependencyLock> {
    this.assertActive();
    const dependencyManager = this.dependencyManager;
    if (!dependencyManager) throw new ForgeError("ForgeEngine has no dependency manager.", {
      code: "unsupported",
      stage: "dependency",
    });
    return stableBoundary(
      () => dependencyManager.resolve(manifest, options),
      { code: "dependency-failure", stage: "dependency", retryable: true },
    );
  }

  /** Materialize a lock into the archive-independent compiler input contract. */
  async prepareDependencies(
    lock: DependencyLock,
    adapters?: readonly DependencyBuildAdapter[],
  ): Promise<DependencyBuildBundle> {
    this.assertActive();
    const dependencyManager = this.dependencyManager;
    if (!dependencyManager) throw new ForgeError("ForgeEngine has no dependency manager.", {
      code: "unsupported",
      stage: "dependency",
    });
    return stableBoundary(
      () => dependencyManager.prepareBuild(lock, adapters),
      { code: "dependency-failure", stage: "dependency", retryable: false },
    );
  }

  async compile(input: CompileInput, options: CompileOptions = {}): Promise<BuildResult> {
    this.assertAvailable();
    const { project, cache } = stableInput(() => ({
      project: createSdkProject(input),
      cache: compileCacheRequested(options),
    }), "compile");
    return stableBoundary(
      () => this.compilation.compile(project, {
        cache: this.artifactStore !== undefined && cache,
      }),
      { code: "compiler-failure", stage: "compile", retryable: true },
    );
  }

  /** Compile an already-normalized Project without reconstructing its library identity. */
  async compileProject(project: Project, options: CompileOptions = {}): Promise<BuildResult> {
    this.assertAvailable();
    const { normalized, cache } = stableInput(() => {
      assertValidProject(project);
      return {
        normalized: structuredClone(project),
        cache: compileCacheRequested(options),
      };
    }, "compile");
    return stableBoundary(
      () => this.compilation.compile(normalized, {
        cache: this.artifactStore !== undefined && cache,
      }),
      { code: "compiler-failure", stage: "compile", retryable: true },
    );
  }

  async replay(bundle: ForgeReplayBundle, options?: ForgeReplayOptions): Promise<ForgeReplayResult> {
    this.assertAvailable();
    stableInput(() => assertValidForgeReplayBundle(bundle), "replay");
    return stableBoundary(
      () => replayForgeBundle(this, bundle, options),
      { code: "replay-failure", stage: "replay", retryable: false },
    );
  }

  /** Compile during idle time; a matching foreground compile joins this exact request. */
  async precompile(input: CompileInput): Promise<PrecompileOutcome> {
    this.assertAvailable();
    const project = stableInput(() => createSdkProject(input), "compile");
    return stableBoundary(
      () => this.compilation.precompile(project),
      { code: "compiler-failure", stage: "compile", retryable: true },
    );
  }

  /** Supersede only speculative work; a foreground build is never cancelled here. */
  supersedePrecompile(): void {
    if (this.disposed || this.cacheClearActive) return;
    this.compilation.supersedeBackground();
  }

  async run(artifact: BuildArtifact, options: RunOptions = {}): Promise<RunResult> {
    this.assertAvailable();
    const request = stableInput(() => {
      assertValidBuildArtifact(artifact);
      return {
        args: runStringArray(options.args, "Run arguments"),
        stdin: optionalString(options.stdin, "Run stdin") ?? "",
        env: runEnvironment(options.env),
        files: Object.fromEntries(runFileEntries(options.files).map(([path, contents]) => [
          path,
          typeof contents === "string" ? new TextEncoder().encode(contents) : contents.slice(),
        ])),
        outputPaths: runStringArray(options.outputPaths, "Run output paths"),
        ...(options.cwd === undefined ? {} : { cwd: optionalString(options.cwd, "Run cwd")! }),
        determinism: resolveDeterminism(options.determinism),
        resources: resolveResourcePolicy(options.resources),
      };
    }, "run");
    return stableBoundary(
      () => this.runner.run(artifact, request),
      { code: "runner-failure", stage: "run", retryable: true },
    );
  }

  async interact(
    contestant: BuildArtifact,
    interactor: BuildArtifact,
    options: InteractiveOptions = {},
  ): Promise<InteractiveRunResult> {
    this.assertAvailable();
    const request = stableInput(() => {
      assertValidBuildArtifact(contestant);
      assertValidBuildArtifact(interactor);
      return {
        contestant: interactiveProgramConfig(options.contestant),
        interactor: interactiveProgramConfig(options.interactor),
        determinism: resolveDeterminism(options.determinism),
      };
    }, "run");
    return stableBoundary(
      () => this.runner.interact(contestant, interactor, request),
      { code: "runner-failure", stage: "run", retryable: true },
    );
  }

  async judge(artifact: BuildArtifact, spec: JudgeSpec, options?: JudgeRunOptions): Promise<JudgeResult> {
    this.assertAvailable();
    stableInput(() => {
      assertValidBuildArtifact(artifact);
      validateJudgeSpec(spec);
    }, "judge");
    return stableBoundary(
      () => this.judging.judge(artifact, spec, options),
      { code: "judge-failure", stage: "judge", retryable: false },
    );
  }

  async judgeProject(
    input: CompileInput,
    spec: JudgeSpec,
    compile: CompileOptions = {},
    judge?: JudgeRunOptions,
  ): Promise<JudgeProjectResult> {
    this.assertAvailable();
    const build = await this.compile(input, compile);
    if (!build.success || !build.artifact) return { build };
    return { build, judge: await this.judge(build.artifact, spec, judge) };
  }

  async execute(
    input: CompileInput,
    run: RunOptions = {},
    compile: CompileOptions = {},
  ): Promise<ExecuteResult> {
    this.assertAvailable();
    const build = await this.compile(input, compile);
    if (!build.success || !build.artifact) return { build };
    return { build, run: await this.run(build.artifact, run) };
  }

  cancel(): void {
    if (this.disposed || this.cacheClearActive) return;
    if (!this.operationScheduler.cancelActive()) this.cancelExecution();
  }

  restart(): void {
    this.assertAvailable();
    this.compilation.restart();
    this.runner.restart();
  }

  clearCache(): Promise<void> {
    this.assertActive();
    if (this.cacheClearOperation) return this.cacheClearOperation;
    if (this.operationScheduler.hasPending()) throw new ForgeError(
      "ForgeEngine cannot clear caches while submission operations are pending.",
      {
        code: "operation-conflict",
        stage: "storage",
        retryable: true,
      },
    );
    this.cacheClearActive = true;
    const operation = stableBoundary(
      () => this.clearCacheOperationInternal(),
      { code: "storage-failure", stage: "storage", retryable: true },
    );
    this.cacheClearOperation = operation;
    void operation.finally(() => {
      if (this.cacheClearOperation === operation) {
        this.cacheClearOperation = undefined;
        this.cacheClearActive = false;
      }
    }).catch(() => undefined);
    return operation;
  }

  private async clearCacheOperationInternal(): Promise<void> {
    await Promise.all([
      this.compilation.cancelAndWait(),
      this.runner.cancelAndWait(),
    ]);
    this.assertActive();
    await Promise.all([
      this.compiler.clearToolchainCache(),
      this.runner.clearRuntimeCache(),
      this.artifactStore?.clear(),
      this.dependencyManager?.clearCache(),
    ]);
  }

  dispose(): void {
    if (this.disposed) return;
    this.operationScheduler.dispose();
    this.disposed = true;
    this.compilation.dispose();
    this.runner.dispose();
    this.observationListeners.clear();
  }

  private assertActive(): void {
    if (this.disposed) throw new ForgeError("ForgeEngine is disposed.", {
      code: "disposed",
      stage: "operation",
    });
  }

  private assertAvailable(): void {
    this.assertActive();
    if (this.cacheClearActive) throw new ForgeError("ForgeEngine is clearing its caches.", {
      code: "operation-conflict",
      stage: "operation",
      retryable: true,
    });
    if (this.operationScheduler.hasPending()) throw new ForgeError(
      "Direct ForgeEngine operations are unavailable while submission operations are pending.",
      {
        code: "operation-conflict",
        stage: "operation",
        retryable: true,
      },
    );
  }

  private cancelExecution(): void {
    this.compilation.cancel();
    this.runner.cancel();
  }

  private async executeSubmission(
    request: ForgeSubmissionRequest,
    observe: (event: ForgeOperationEventPayload) => void,
  ): Promise<JudgeProjectResult> {
    this.assertActive();
    const removeCompilerProgress = this.compiler.onProgress((progress) => observe({ type: "progress", progress }));
    const removeRunnerProgress = this.runner.onProgress((progress) => observe({ type: "progress", progress }));
    const removeStream = this.runner.onStream((stream, chunk) => observe({ type: "stream", stream, chunk }));
    try {
      if (request.signal?.aborted) throw request.signal.reason;
      let build: BuildResult;
      try {
        const project = createSdkProject(request.input);
        build = await this.compilation.compile(project, {
          cache: this.artifactStore !== undefined && compileCacheRequested(request.compile ?? {}),
        });
      } catch (error) {
        throw asForgeError(error, {
          code: "compiler-failure",
          stage: "compile",
          retryable: true,
          operationId: request.id,
        });
      }
      observe({
        type: "build",
        success: build.success,
        cacheHit: build.cacheHit,
        diagnosticCount: build.diagnostics.length,
        ...(build.artifact === undefined ? {} : {
          artifact: {
            id: build.artifact.id,
            kind: build.artifact.kind,
            size: build.artifact.size,
          },
        }),
      });
      if (!build.success || !build.artifact) return { build };
      try {
        const judge = await this.judging.judge(build.artifact, request.spec, {
          ...request.judge,
          onCase: (result, completed, total) => {
            observe({
              type: "case",
              caseId: result.id,
              verdict: result.verdict,
              ...(result.message === undefined ? {} : { message: result.message }),
              completed,
              total,
            });
          },
        });
        return { build, judge };
      } catch (error) {
        throw asForgeError(error, {
          code: "judge-failure",
          stage: "judge",
          retryable: false,
          operationId: request.id,
        });
      }
    } finally {
      removeCompilerProgress();
      removeRunnerProgress();
      removeStream();
    }
  }

  private notifyObservation(event: ForgeOperationEvent): void {
    for (const listener of this.observationListeners) {
      try {
        listener(event);
      } catch {
        this.observationListeners.delete(listener);
      }
    }
  }
}

function interactiveProgramConfig(
  options: NonNullable<InteractiveOptions["contestant"]> = {},
): InteractiveProgramConfig {
  return {
    args: runStringArray(options.args, "Interactive arguments"),
    env: runEnvironment(options.env),
    files: Object.fromEntries(runFileEntries(options.files).map(([path, contents]) => [
      path,
      typeof contents === "string" ? new TextEncoder().encode(contents) : contents.slice(),
    ])),
    ...(options.cwd === undefined ? {} : { cwd: optionalString(options.cwd, "Interactive cwd")! }),
    resources: resolveResourcePolicy(options.resources),
  };
}

function compileCacheRequested(options: CompileOptions): boolean {
  dataRecord(options, "Compile options");
  if (options.cache !== undefined && typeof options.cache !== "boolean") {
    throw new TypeError("Compile cache option must be a boolean.");
  }
  return options.cache ?? true;
}

function runStringArray(value: unknown, label: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new TypeError(`${label} must be an array.`);
  return value.map((item, index) => {
    if (typeof item !== "string" || item.includes("\0")) {
      throw new TypeError(`${label} entry ${index} must be a NUL-free string.`);
    }
    return item;
  });
}

function optionalString(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new TypeError(`${label} must be a string.`);
  return value;
}

function runEnvironment(value: unknown): Record<string, string> {
  if (value === undefined) return {};
  const environment = dataRecord(value, "Run environment");
  const result: Record<string, string> = {};
  for (const [name, entry] of Object.entries(environment)) {
    if (!name || name.includes("=") || name.includes("\0")) {
      throw new TypeError(`Run environment variable name '${name}' is invalid.`);
    }
    if (typeof entry !== "string" || entry.includes("\0")) {
      throw new TypeError(`Run environment variable '${name}' must be a NUL-free string.`);
    }
    result[name] = entry;
  }
  return result;
}

function runFileEntries(value: unknown): Array<[string, string | Uint8Array]> {
  if (value === undefined) return [];
  const files = dataRecord(value, "Run files");
  return Object.entries(files).map(([path, contents]) => {
    if (typeof contents !== "string" && !(contents instanceof Uint8Array)) {
      throw new TypeError(`Run file '${path}' must be a string or Uint8Array.`);
    }
    return [path, contents];
  });
}

function dataRecord(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be a plain object.`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${label} must be a plain object.`);
  }
  for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
    if (!descriptor.enumerable) continue;
    if (!("value" in descriptor)) throw new TypeError(`${label} property '${key}' must be plain data.`);
  }
  return value as Record<string, unknown>;
}

async function stableBoundary<T>(
  operation: () => Promise<T>,
  options: Omit<ForgeErrorOptions, "cause">,
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    throw asForgeError(error, options);
  }
}

function stableInput<T>(operation: () => T, stage: ForgeErrorStage): T {
  try {
    return operation();
  } catch (error) {
    throw asForgeError(error, {
      code: "invalid-input",
      stage,
      retryable: false,
    });
  }
}

export async function createForgeEngine(
  options: ForgeEngineOptions,
): Promise<ForgeEngine> {
  const engine = new ForgeEngine(options);
  try {
    await engine.ready();
    return engine;
  } catch (error) {
    engine.dispose();
    throw error;
  }
}
