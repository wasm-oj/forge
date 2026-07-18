import { FORGE_CONTRACT_VERSION, FORGE_SCHEMAS } from "./contract.ts";

export const LANGUAGES = Object.freeze([
  "c",
  "cpp",
  "rust",
  "python",
  "javascript",
  "typescript",
  "go",
] as const);
export type BuiltinLanguage = (typeof LANGUAGES)[number];
/**
 * Stable language identity carried by projects and artifacts.
 *
 * Forge ships the values in `LANGUAGES`; downstream compiler implementations
 * may use their own non-empty identifier without forking the contract.
 */
export type Language = BuiltinLanguage | (string & {});

export function assertLanguageIdentifier(language: unknown): asserts language is Language {
  if (typeof language !== "string" || !language || language !== language.trim() || language.length > 128) {
    throw new Error("Language identifiers must be non-empty, trimmed, and at most 128 characters.");
  }
}

export function isBuiltinLanguage(language: string): language is BuiltinLanguage {
  return (LANGUAGES as readonly string[]).includes(language);
}
export type TargetAbi = "wasip1" | "wasix";
export type OptimizationLevel = "debug" | "release";

export interface ProjectFile {
  path: string;
  language: Language;
  content: string;
}

export interface BuildConfig {
  language: Language;
  target: TargetAbi;
  optimization: OptimizationLevel;
  entry: string;
}

export interface DeterminismConfig {
  /** Unsigned 32-bit seed used by every guest entropy source. */
  randomSeed: number;
  /** Unix epoch exposed by the first realtime-clock observation. */
  realtimeEpochMs: number;
  /** Virtual clock advancement after each clock observation. */
  clockStepNs: number;
}

export interface ResourcePolicy {
  /** Versioned baseline-normalized weighted Wasm instruction budget. */
  instructionBudget: number;
  /** Deterministic virtual elapsed-time budget, including sleeps and clock observations. */
  logicalTimeLimitMs: number;
  /** Hard upper bound for guest linear memory. */
  memoryLimitBytes: number;
  /** Combined stdout and stderr upper bound. */
  outputLimitBytes: number;
  /** Additional live VFS file bytes permitted above the mounted baseline. */
  filesystemWriteLimitBytes: number;
  /** Additional live VFS entries permitted above the mounted baseline. */
  filesystemEntryLimit: number;
  /** Host safety deadline; excluded from the deterministic transcript. */
  wallTimeLimitMs: number;
}

export type ExecutionTermination =
  | "exited"
  | "instruction-limit"
  | "logical-time-limit"
  | "memory-limit"
  | "output-limit"
  | "filesystem-limit"
  | "wall-time-limit"
  | "trap";

export interface ExecutionMetrics {
  /** Baseline-normalized weighted deterministic cost used for judging. */
  cost: number | null;
  /** Unadjusted weighted cost observed by the runtime core. */
  rawCost: number | null;
  /** Empty-program cost subtracted from rawCost. */
  baselineCost: number;
  /** Versioned compiler/runtime baseline identity. */
  costProfile: string;
  /** Meter policy used to interpret cost. */
  costModel: string;
  /** WARK-compatible static counts of original Wasm operators. */
  operations: Readonly<Record<string, number>> | null;
  /** Peak linear-memory allocation observed by the runner. */
  memoryBytes: number | null;
  /** Deterministic virtual time elapsed during execution. */
  logicalTimeNs: number | null;
  /** Peak live VFS file bytes, including the mounted baseline. */
  filesystemBytes: number | null;
  /** Peak live VFS inode count, excluding the root inode. */
  filesystemEntries: number | null;
  stdoutBytes: number | null;
  stderrBytes: number | null;
}

export interface RunConfig {
  args: string[];
  stdin: string;
  env: Record<string, string>;
  /** Absolute, normalized guest files mounted before execution. */
  files?: Record<string, Uint8Array>;
  /** Absolute, normalized guest files collected after execution. */
  outputPaths?: string[];
  /** Absolute, normalized initial working directory. */
  cwd?: string;
  determinism: DeterminismConfig;
  resources: ResourcePolicy;
}

export interface ProjectConfig extends BuildConfig, RunConfig {}

export interface Project {
  id: string;
  name: string;
  files: ProjectFile[];
  config: ProjectConfig;
  activeFile: string;
  updatedAt: number;
}

export type DiagnosticSeverity = "error" | "warning" | "info";

export interface Diagnostic {
  severity: DiagnosticSeverity;
  message: string;
  file: string;
  line: number;
  column: number;
  endLine?: number;
  endColumn?: number;
  source: string;
  code?: string;
}

export interface ArtifactMetadata {
  /** Forge compatibility contract required to consume this artifact. */
  forgeContract: typeof FORGE_CONTRACT_VERSION;
  id: string;
  projectId: string;
  cacheKey: string;
  name: string;
  language: Language;
  target: TargetAbi;
  optimization: OptimizationLevel;
  createdAt: number;
  durationMs: number;
  size: number;
  toolchains: string[];
  /** Trusted empty-program cost profile selected by the compiler contract. */
  costProfile: string;
}

export interface WasmArtifact extends ArtifactMetadata {
  kind: "wasm";
  bytes: Uint8Array;
}

export interface RuntimeBundleArtifact extends ArtifactMetadata {
  kind: "runtime-bundle";
  runtimePackage: string;
  command: string;
  entry: string;
  files: Record<string, string | Uint8Array>;
  manifest: string;
}

export type BuildArtifact = WasmArtifact | RuntimeBundleArtifact;

export interface BuildResult {
  success: boolean;
  diagnostics: Diagnostic[];
  artifact?: BuildArtifact;
  stdout: string;
  stderr: string;
  cacheHit: boolean;
  buildGraph?: {
    hits: Partial<Record<"pch" | "object" | "link-result", number>>;
    misses: Partial<Record<"pch" | "object" | "link-result", number>>;
    stores: Partial<Record<"pch" | "object" | "link-result", number>>;
  };
}

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
  /** Requested output files that existed when the process terminated. */
  files: Record<string, Uint8Array>;
  durationMs: number;
  determinism: DeterminismConfig;
  resources: ResourcePolicy;
  termination: ExecutionTermination;
  /** Runtime trap text when termination is `trap`; absent for normal guest exits. */
  trapMessage?: string;
  metrics: ExecutionMetrics;
}

export interface InteractiveProgramConfig {
  args: string[];
  env: Record<string, string>;
  files?: Record<string, Uint8Array>;
  cwd?: string;
  resources: ResourcePolicy;
}

export interface InteractiveRunConfig {
  contestant: InteractiveProgramConfig;
  interactor: InteractiveProgramConfig;
  determinism: DeterminismConfig;
}

export interface InteractiveProcessResult {
  code: number;
  stderr: string;
  termination: ExecutionTermination;
  metrics: ExecutionMetrics;
}

export interface InteractiveRunResult {
  contestant: InteractiveProcessResult;
  interactor: InteractiveProcessResult;
  contestantToInteractor: string;
  interactorToContestant: string;
  durationMs: number;
  determinism: DeterminismConfig;
}

export type WorkerPhase =
  | "initializing"
  | "restoring-cache"
  | "loading-toolchain"
  | "checking"
  | "compiling"
  | "linking"
  | "packaging"
  | "running";

export interface WorkerProgress {
  phase: WorkerPhase;
  label: string;
  progress?: number;
}

export type CompilerTraceOperation =
  | "workerInitialize"
  | "toolchainFetch"
  | "toolchainDecode"
  | "toolchainLoad"
  | "filesystemPrepare"
  | "commandStart"
  | "commandWait"
  | "projectCompile"
  | "runtimeShimCompile"
  | "link"
  | "projectSpawn"
  | "projectWait"
  | "runtimeShimSpawn"
  | "runtimeShimWait"
  | "linkSpawn"
  | "linkWait"
  | "projectOutputReady"
  | "runtimeShimOutputReady"
  | "linkOutputReady"
  | "artifactReadback";

/** Host-observed compiler timing mark; excluded from deterministic contracts and cache keys. */
export interface CompilerTraceEvent {
  schema: typeof FORGE_SCHEMAS.compileTrace;
  operation: CompilerTraceOperation;
  state: "start" | "end";
  monotonicMs: number;
}

export type CompilerRequest =
  | { type: "initialize"; requestId: string; assetBaseUrl?: string }
  | { type: "build"; requestId: string; project: Project; cacheKey: string }
  | { type: "quiesce"; requestId: string };

export type RunnerRequest =
  | {
    type: "initialize";
    requestId: string;
    assetBaseUrl?: string;
    additionalCostBaselines?: Readonly<Record<string, number>>;
  }
  | { type: "run"; requestId: string; artifact: BuildArtifact; config: RunConfig }
  | {
    type: "interact";
    requestId: string;
    contestant: BuildArtifact;
    interactor: BuildArtifact;
    config: InteractiveRunConfig;
  }
  | { type: "clear-runtime-cache"; requestId: string };

export type CompilerResponse =
  | { type: "ready"; requestId: string }
  | { type: "quiesced"; requestId: string }
  | { type: "progress"; requestId: string; progress: WorkerProgress }
  | { type: "compile-trace"; requestId: string; event: CompilerTraceEvent }
  | { type: "build-result"; requestId: string; result: BuildResult }
  | { type: "error"; requestId: string; code: string; message: string; stack?: string };

export type RunnerResponse =
  | { type: "ready"; requestId: string }
  | { type: "progress"; requestId: string; progress: WorkerProgress }
  | { type: "stream"; requestId: string; stream: "stdout" | "stderr"; chunk: string }
  | { type: "run-result"; requestId: string; result: RunResult }
  | { type: "interactive-result"; requestId: string; result: InteractiveRunResult }
  | { type: "runtime-cache-cleared"; requestId: string }
  | { type: "error"; requestId: string; code: string; message: string; stack?: string };
