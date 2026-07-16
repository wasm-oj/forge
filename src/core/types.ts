export const LANGUAGES = ["c", "cpp", "rust", "python", "javascript", "typescript"] as const;
export type Language = (typeof LANGUAGES)[number];
export type TargetAbi = "wasi" | "wasix";
export type OptimizationLevel = "debug" | "release";

export interface ProjectFile {
  path: string;
  language: Language;
  content: string;
}

export interface ProjectConfig {
  language: Language;
  target: TargetAbi;
  optimization: OptimizationLevel;
  entry: string;
  args: string[];
  stdin: string;
  env: Record<string, string>;
}

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
  id: string;
  projectId: string;
  cacheKey: string;
  name: string;
  language: Language;
  target: TargetAbi;
  createdAt: number;
  durationMs: number;
  size: number;
  toolchains: string[];
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
}

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
  durationMs: number;
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

export type CompilerRequest =
  | { type: "initialize"; requestId: string }
  | { type: "build"; requestId: string; project: Project; cacheKey: string }
  | { type: "run"; requestId: string; artifact: BuildArtifact; config: ProjectConfig }
  | { type: "clear-toolchain-cache"; requestId: string };

export type CompilerResponse =
  | { type: "ready"; requestId: string }
  | { type: "progress"; requestId: string; progress: WorkerProgress }
  | { type: "stream"; requestId: string; stream: "stdout" | "stderr"; chunk: string }
  | { type: "build-result"; requestId: string; result: BuildResult }
  | { type: "run-result"; requestId: string; result: RunResult }
  | { type: "cache-cleared"; requestId: string }
  | { type: "error"; requestId: string; message: string; stack?: string };
