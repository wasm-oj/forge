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
import type { JudgeSpec } from "../judge/spec";
import { createSdkProject, type CompileInput } from "./project";
import type { CompileOptions, ExecuteResult, InteractiveOptions, RunOptions } from "./types";
import {
  replayForgeBundle,
  type ForgeReplayBundle,
  type ForgeReplayOptions,
  type ForgeReplayResult,
} from "../replay/bundle";
import { assertValidProject } from "../core/project-validation";
import type { Project } from "../core/types";

export type { ForgeArtifactStore } from "../compiler/coordinator";

export interface ForgeEngineOptions {
  compiler: ForgeCompiler;
  runner: ForgeRunner;
  artifactStore?: ForgeArtifactStore;
  judge?: JudgeEngineOptions;
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
  private readonly compilation: CompileCoordinator;
  private disposed = false;
  private cacheClearActive = false;
  private cacheClearOperation?: Promise<void>;
  /** Extensible judge registry for custom input providers and output matchers. */
  readonly judging: JudgeEngine;

  constructor(options: ForgeEngineOptions) {
    this.compiler = options.compiler;
    this.runner = options.runner;
    this.artifactStore = options.artifactStore;
    this.compilation = new CompileCoordinator(options.compiler, options.artifactStore);
    this.judging = new JudgeEngine(
      createJudgeExecutor({
        run: (artifact, run) => this.run(artifact, run),
        interact: (contestant, interactor, interaction) => this.runner.interact(
          contestant,
          interactor,
          interaction,
        ),
      }),
      options.judge,
    );
  }

  async ready(): Promise<void> {
    this.assertAvailable();
    await Promise.all([this.compiler.ready(), this.runner.ready()]);
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

  async compile(input: CompileInput, options: CompileOptions = {}): Promise<BuildResult> {
    this.assertAvailable();
    const project = createSdkProject(input);
    return this.compilation.compile(project, {
      cache: this.artifactStore !== undefined && (options.cache ?? true),
    });
  }

  /** Compile an already-normalized Project without reconstructing its library identity. */
  compileProject(project: Project, options: CompileOptions = {}): Promise<BuildResult> {
    this.assertAvailable();
    assertValidProject(project);
    return this.compilation.compile(structuredClone(project), {
      cache: this.artifactStore !== undefined && (options.cache ?? true),
    });
  }

  replay(bundle: ForgeReplayBundle, options?: ForgeReplayOptions): Promise<ForgeReplayResult> {
    this.assertAvailable();
    return replayForgeBundle(this, bundle, options);
  }

  /** Compile during idle time; a matching foreground compile joins this exact request. */
  precompile(input: CompileInput): Promise<PrecompileOutcome> {
    this.assertAvailable();
    return this.compilation.precompile(createSdkProject(input));
  }

  /** Supersede only speculative work; a foreground build is never cancelled here. */
  supersedePrecompile(): void {
    if (this.disposed || this.cacheClearActive) return;
    this.compilation.supersedeBackground();
  }

  run(artifact: BuildArtifact, options: RunOptions = {}): Promise<RunResult> {
    this.assertAvailable();
    return this.runner.run(artifact, {
      args: [...(options.args ?? [])],
      stdin: options.stdin ?? "",
      env: { ...(options.env ?? {}) },
      files: Object.fromEntries(Object.entries(options.files ?? {}).map(([path, contents]) => [
        path,
        typeof contents === "string" ? new TextEncoder().encode(contents) : contents.slice(),
      ])),
      outputPaths: [...(options.outputPaths ?? [])],
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      determinism: resolveDeterminism(options.determinism),
      resources: resolveResourcePolicy(options.resources),
    });
  }

  interact(
    contestant: BuildArtifact,
    interactor: BuildArtifact,
    options: InteractiveOptions = {},
  ): Promise<InteractiveRunResult> {
    this.assertAvailable();
    return this.runner.interact(contestant, interactor, {
      contestant: interactiveProgramConfig(options.contestant),
      interactor: interactiveProgramConfig(options.interactor),
      determinism: resolveDeterminism(options.determinism),
    });
  }

  judge(artifact: BuildArtifact, spec: JudgeSpec, options?: JudgeRunOptions): Promise<JudgeResult> {
    this.assertAvailable();
    return this.judging.judge(artifact, spec, options);
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
    this.compilation.cancel();
    this.runner.cancel();
  }

  restart(): void {
    this.assertAvailable();
    this.compilation.restart();
    this.runner.restart();
  }

  clearCache(): Promise<void> {
    this.assertActive();
    if (this.cacheClearOperation) return this.cacheClearOperation;
    this.cacheClearActive = true;
    const operation = this.clearCacheOperationInternal();
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
    ]);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.compilation.dispose();
    this.runner.dispose();
  }

  private assertActive(): void {
    if (this.disposed) throw new Error("ForgeEngine is disposed.");
  }

  private assertAvailable(): void {
    this.assertActive();
    if (this.cacheClearActive) throw new Error("ForgeEngine is clearing its caches.");
  }
}

function interactiveProgramConfig(
  options: NonNullable<InteractiveOptions["contestant"]> = {},
): InteractiveProgramConfig {
  return {
    args: [...(options.args ?? [])],
    env: { ...(options.env ?? {}) },
    files: Object.fromEntries(Object.entries(options.files ?? {}).map(([path, contents]) => [
      path,
      typeof contents === "string" ? new TextEncoder().encode(contents) : contents.slice(),
    ])),
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    resources: resolveResourcePolicy(options.resources),
  };
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
