import type { Diagnostic, ProjectFile } from "../core/types.ts";

export const PYTHON_COMPILE_TIMEOUT_MS = 180_000;
export const PYTHON_TARGET_TRIPLE = "wasm32-wasip1" as const;

export interface PythonFrontendRequest {
  files: readonly ProjectFile[];
}

export interface PythonFrontendResult {
  success: boolean;
  bytecode: Record<string, Uint8Array>;
  stdout: string;
  stderr: string;
  diagnostics: Diagnostic[];
}

export type PythonStageRequest = {
  type: "compile";
  request: PythonFrontendRequest;
  assetBaseUrl: string;
};

export type PythonStageResponse =
  | { type: "result"; result: PythonFrontendResult }
  | { type: "error"; message: string; stack?: string };
