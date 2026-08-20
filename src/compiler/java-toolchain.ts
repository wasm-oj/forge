import type { Diagnostic, OptimizationLevel, ProjectFile } from "../core/types.ts";
import {
  JAVA_COMPILER_ASSET_PATH,
  JAVA_COMPILER_COMPRESSED_PACKAGE_SHA256,
  JAVA_COMPILER_PACKAGE,
  JAVA_COMPILER_PACKAGE_SHA256,
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
  compilerCompressedSha256: JAVA_COMPILER_COMPRESSED_PACKAGE_SHA256,
  compilerPackageSha256: JAVA_COMPILER_PACKAGE_SHA256,
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

export function javaMainClass(entry: string, source: string): string {
  const className = entry.split("/").at(-1)?.replace(/\.java$/u, "") ?? "";
  if (!/^[A-Za-z_$][\w$]*$/u.test(className)) {
    throw new Error(`Java entry '${entry}' must name a valid .java class file.`);
  }
  const packageName = source.match(/^\s*package\s+([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\s*;/m)?.[1];
  return packageName ? `${packageName}.${className}` : className;
}

export function parseJavaDiagnostics(output: string, fallbackFile: string): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const pattern = /^(.*?\.java):(\d+)(?::(\d+))?:\s*(?:(error|warning):\s*)?(.+)$/gim;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(output)) !== null) {
    diagnostics.push({
      severity: match[4]?.toLowerCase() === "warning" ? "warning" : "error",
      message: match[5],
      file: match[1].replace(/^\/?(?:project|workspace)\//u, ""),
      line: Number(match[2]),
      column: Number(match[3] ?? 1),
      source: "java",
    });
  }
  if (diagnostics.length === 0 && /(?:error|exception|failed)/iu.test(output)) {
    diagnostics.push({
      severity: "error",
      message: output.trim().split(/\r?\n/u).filter(Boolean).at(-1) ?? "Java compilation failed.",
      file: fallbackFile,
      line: 1,
      column: 1,
      source: "java",
    });
  }
  return diagnostics;
}
