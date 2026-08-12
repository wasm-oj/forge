/**
 * Host-neutral protocol surface shared by every WASM-OJ package.
 *
 * Keep this entry free of browser and Node.js adapters. Runtime hosts import
 * these values and types through `@wasm-oj/contracts` so protocol identity is
 * owned by exactly one package.
 */
export {
  WASM_OJ_CONTRACT_ID,
  WASM_OJ_CONTRACT_VERSION,
  WASM_OJ_SCHEMAS,
  WASM_OJ_STORAGE,
} from "../core/contract";

export {
  DEPENDENCY_ECOSYSTEMS,
  LANGUAGES,
  assertLanguageIdentifier,
  isBuiltinLanguage,
} from "../core/types";

export type {
  ArtifactMetadata,
  BrowserRuntimeDriverPlugin,
  BrowserToolchainSource,
  BuildArtifact,
  BuildConfig,
  BuildResult,
  BuiltinLanguage,
  CompilerRequest,
  CompilerResponse,
  CompilerTraceEvent,
  CompilerTraceOperation,
  DependencyBuildBundle,
  DependencyEcosystem,
  DependencyLock,
  DependencyManifest,
  DependencyRequirement,
  DependencySourceFile,
  DeterminismConfig,
  Diagnostic,
  DiagnosticSeverity,
  ExecutionMetrics,
  ExecutionTermination,
  InteractiveProcessResult,
  InteractiveProgramConfig,
  InteractiveRunConfig,
  InteractiveRunResult,
  Language,
  LockedDependencyPackage,
  MaterializedDependencyPackage,
  OptimizationLevel,
  Project,
  ProjectConfig,
  ProjectFile,
  ResourcePolicy,
  RunConfig,
  RunResult,
  RunnerRequest,
  RunnerResponse,
  RuntimeBundleArtifact,
  ServerToolchainSource,
  TargetAbi,
  ToolchainAssetDescriptor,
  ToolchainDescriptor,
  ToolchainProfile,
  ToolchainSource,
  WasmArtifact,
  WorkerPhase,
  WorkerProgress,
} from "../core/types";

export {
  WASM_OJ_ERROR_CODES,
  WASM_OJ_ERROR_STAGES,
  WasmOjError,
  asWasmOjError,
} from "../core/errors";

export type {
  WasmOjErrorCode,
  WasmOjErrorOptions,
  WasmOjErrorRecord,
  WasmOjErrorStage,
} from "../core/errors";
