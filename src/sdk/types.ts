import type {
  BuildResult,
  DeterminismConfig,
  InteractiveRunResult,
  ResourcePolicy,
  RunResult,
} from "../core/types";

export interface CompileOptions {
  /** Read and write the configured artifact store for this build. Defaults to true. */
  cache?: boolean;
}

export interface RunOptions {
  args?: readonly string[];
  stdin?: string;
  env?: Readonly<Record<string, string>>;
  files?: Readonly<Record<string, string | Uint8Array>>;
  outputPaths?: readonly string[];
  cwd?: string;
  determinism?: Partial<DeterminismConfig>;
  resources?: Partial<ResourcePolicy>;
}

export interface InteractiveProgramOptions {
  args?: readonly string[];
  env?: Readonly<Record<string, string>>;
  files?: Readonly<Record<string, string | Uint8Array>>;
  cwd?: string;
  resources?: Partial<ResourcePolicy>;
}

export interface InteractiveOptions {
  contestant?: InteractiveProgramOptions;
  interactor?: InteractiveProgramOptions;
  determinism?: Partial<DeterminismConfig>;
}

export interface InteractiveExecuteResult {
  contestantBuild: BuildResult;
  interactorBuild: BuildResult;
  run?: InteractiveRunResult;
}

export interface ExecuteResult {
  build: BuildResult;
  run?: RunResult;
}
