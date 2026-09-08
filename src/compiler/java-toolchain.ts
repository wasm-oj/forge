import type { Diagnostic, OptimizationLevel, ProjectFile } from "../core/types.ts";
import {
  JAVA_COMPILER_ASSET_PATH,
  JAVA_COMPILER_PACKAGE,
  JAVA_COMPILER_SHA256,
  JAVA_COMPILE_CLASSLIB_ASSET_PATH,
  JAVA_COMPILE_CLASSLIB_SHA256,
  JAVA_RUNTIME_CLASSLIB_ASSET_PATH,
  JAVA_RUNTIME_CLASSLIB_SHA256,
  JAVA_VERSION,
} from "../core/toolchains.ts";

export const JAVA_COMPILE_TIMEOUT_MS = 180_000;

export const JAVA_TOOLCHAIN = Object.freeze({
  version: JAVA_VERSION,
  package: JAVA_COMPILER_PACKAGE,
  compilerAsset: JAVA_COMPILER_ASSET_PATH,
  compilerSha256: JAVA_COMPILER_SHA256,
  compileClasslibAsset: JAVA_COMPILE_CLASSLIB_ASSET_PATH,
  compileClasslibSha256: JAVA_COMPILE_CLASSLIB_SHA256,
  runtimeClasslibAsset: JAVA_RUNTIME_CLASSLIB_ASSET_PATH,
  runtimeClasslibSha256: JAVA_RUNTIME_CLASSLIB_SHA256,
});

export interface JavaCompileRequest {
  entry: string;
  files: readonly ProjectFile[];
  optimization: OptimizationLevel;
}

export interface JavaCompileResult {
  success: boolean;
  wasm?: Uint8Array;
  stdout: string;
  stderr: string;
  diagnostics: Diagnostic[];
}

export type JavaStageRequest =
  | { type: "compile"; request: JavaCompileRequest; assetBaseUrl: string }
  | { type: "shutdown"; assetBaseUrl: string };

export type JavaStageResponse =
  | { type: "result"; result: JavaCompileResult }
  | { type: "shutdown-complete" }
  | { type: "error"; message: string; stack?: string };
