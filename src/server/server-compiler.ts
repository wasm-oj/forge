import { constants as fsConstants } from "node:fs";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { deserialize } from "node:v8";
import { gunzipSync } from "node:zlib";
import { Runtime } from "@wasmer/sdk/node";
import type { ForgeCompiler } from "../compiler/compiler.ts";
import { clearSdkDirectClangCaches } from "../compiler/sdk-direct-clang.ts";
import {
  buildProject,
  clearCompilerHostCaches,
  configureWasmerCompilerHost,
} from "../compiler/wasmer-engine.ts";
import type { BuildResult, Project, WorkerProgress } from "../core/types.ts";
import { FORGE_SCHEMAS } from "../core/contract.ts";
import { parseGoDiagnostics, parsePythonDiagnostics, parseRustDiagnostics } from "../core/diagnostics.ts";
import type { PythonFrontendRequest, PythonFrontendResult } from "../compiler/python-toolchain.ts";
import { PYTHON_COMPILE_TIMEOUT_MS } from "../compiler/python-toolchain.ts";
import type {
  RustCompileRequest,
  RustCompileResult,
} from "../compiler/rust-toolchain.ts";
import { RUST_COMPILE_TIMEOUT_MS } from "../compiler/rust-toolchain.ts";
import type { GoCompileRequest, GoCompileResult } from "../compiler/go-toolchain.ts";
import { GO_COMPILE_TIMEOUT_MS } from "../compiler/go-toolchain.ts";
import { initializeServerWasmerSdk } from "./wasmer-runtime.ts";
import { expectedToolchainAssetSha256, toolchainCacheIdentity } from "../core/toolchains.ts";
import { assertValidProject } from "../core/project-validation.ts";
import { assertCompilerCacheKey } from "../core/hash.ts";
import { BoundedByteCollector, readBoundedRegularFile } from "./bounded-transport.ts";

export interface ServerForgeCompilerOptions {
  /** Native `forge-compiler` executable built from `crates/runtime-core`. */
  compilerExecutable: string;
  /** Directory containing the pinned files from `public/toolchains`. */
  toolchainDirectory: string;
}

const IN_PROCESS_STAGE = Symbol("forge-in-process-server-compiler");
const SERVER_BUILD_TIMEOUT_MS = 20 * 60 * 1_000;
const SERVER_STAGE_LOG_LIMIT_BYTES = 1024 * 1024;
const SERVER_STAGE_PROGRESS_LINE_LIMIT_BYTES = 1024 * 1024;
const SERVER_BUILD_RESPONSE_LIMIT_BYTES = 256 * 1024 * 1024;
const SERVER_COMPILER_STAGE_RESPONSE_LIMIT_BYTES = 256 * 1024 * 1024;
const SERVER_STAGE_SCRIPTS = new Set([
  "server-build-stage.mjs",
  "python-stage.mjs",
  "rustc-stage.mjs",
  "go-stage.mjs",
]);

interface ServerCompilerOperation {
  kind: "build" | "cache-clear";
  generation: number;
  superseded: boolean;
}

/**
 * Node/server compiler host using the exact language drivers and Wasmer
 * packages used by the browser Worker.
 */
export class ServerForgeCompiler implements ForgeCompiler {
  private readonly progressListeners = new Set<(progress: WorkerProgress) => void>();
  private readonly compilerExecutable: string;
  private readonly toolchainDirectory: string;
  private initialization: Promise<void> | undefined;
  private generation = 0;
  private disposed = false;
  private readonly inProcess: boolean;
  private readonly activeChildren = new Set<ReturnType<typeof spawn>>();
  private activeOperation: ServerCompilerOperation | undefined;

  constructor(options: ServerForgeCompilerOptions);
  /** @internal */
  constructor(options: ServerForgeCompilerOptions, stage: typeof IN_PROCESS_STAGE);
  constructor(options: ServerForgeCompilerOptions, stage?: typeof IN_PROCESS_STAGE) {
    this.compilerExecutable = path.resolve(options.compilerExecutable);
    this.toolchainDirectory = path.resolve(options.toolchainDirectory);
    this.inProcess = stage === IN_PROCESS_STAGE;
  }

  cacheIdentity(project: Project): string {
    this.assertActive();
    return JSON.stringify(toolchainCacheIdentity(project.config.language));
  }

  async ready(): Promise<void> {
    this.assertActive();
    const generation = this.generation;
    let initialization = this.initialization;
    if (!initialization) {
      initialization = this.initialize();
      this.initialization = initialization;
      void initialization.catch(() => {
        if (this.initialization === initialization) this.initialization = undefined;
      });
    }
    await initialization;
    this.assertActive();
    if (generation !== this.generation) throw new Error("Server compiler initialization was superseded.");
  }

  async build(project: Project, cacheKey: string): Promise<BuildResult> {
    assertValidProject(project);
    assertCompilerCacheKey(cacheKey);
    const operation = this.beginOperation("build");
    try {
      await this.ready();
      this.assertCurrent(operation, "Server compilation was cancelled before initialization completed.");
      if (!this.inProcess) return await this.buildIsolated(project, cacheKey, operation);
      const runtime = new Runtime({ registry: null });
      configureWasmerCompilerHost({
        getRuntime: () => runtime,
        loadToolchainAsset: (assetPath) => this.loadToolchainAsset(assetPath),
        loadToolchainFile: (assetPath) => this.loadToolchainFile(assetPath),
        compileRust: (request) => this.compileRust(request),
        compilePython: (request) => this.compilePython(request),
        compileGo: (request) => this.compileGo(request),
        progress: (_requestId, phase, label, value) => {
          if (!this.isCurrent(operation)) return;
          const progress = { phase, label, progress: value };
          for (const listener of this.progressListeners) listener(progress);
        },
        trace: () => undefined,
      });
      try {
        const result = await buildProject(project, cacheKey, crypto.randomUUID());
        this.assertCurrent(operation, "Server compilation was cancelled.");
        return result;
      } finally {
        await clearSdkDirectClangCaches();
        runtime.free();
      }
    } finally {
      this.endOperation(operation);
    }
  }

  onProgress(listener: (progress: WorkerProgress) => void): () => void {
    this.assertActive();
    this.progressListeners.add(listener);
    return () => this.progressListeners.delete(listener);
  }

  async clearToolchainCache(): Promise<void> {
    const operation = this.beginOperation("cache-clear");
    try {
      await this.ready();
      this.assertCurrent(operation, "Server compiler cache clearing was superseded.");
      if (this.inProcess) {
        clearCompilerHostCaches();
        await clearSdkDirectClangCaches();
        this.assertCurrent(operation, "Server compiler cache clearing was superseded.");
      }
    } finally {
      this.endOperation(operation);
    }
  }

  cancel(): void {
    if (this.disposed) return;
    if (this.activeOperation?.kind === "cache-clear") return;
    this.generation += 1;
    if (this.activeOperation) {
      this.activeOperation.superseded = true;
      this.activeOperation = undefined;
    }
    this.terminateChildren();
  }

  restart(): void {
    this.assertActive();
    if (this.activeOperation?.kind === "cache-clear") {
      throw new Error("Cannot restart ServerForgeCompiler while clearing its cache.");
    }
    this.cancel();
    if (this.inProcess) clearCompilerHostCaches();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.generation += 1;
    if (this.activeOperation) {
      this.activeOperation.superseded = true;
      this.activeOperation = undefined;
    }
    this.terminateChildren();
    this.progressListeners.clear();
  }

  private async initialize(): Promise<void> {
    await Promise.all([
      access(this.compilerExecutable, fsConstants.X_OK),
      access(this.toolchainDirectory, fsConstants.R_OK),
      this.inProcess ? initializeServerWasmerSdk() : Promise.resolve(),
    ]);
  }

  private async buildIsolated(
    project: Project,
    cacheKey: string,
    operation: ServerCompilerOperation,
  ): Promise<BuildResult> {
    const transportDirectory = await mkdtemp(path.join(os.tmpdir(), "forge-build-response-"));
    const responsePath = path.join(transportDirectory, "response.v8");
    try {
      this.assertCurrent(operation, "Server compilation was cancelled before its isolated stage started.");
      return await new Promise((resolve, reject) => {
        const script = resolveStageScript("server-build-stage.mjs");
        const child = spawn(process.execPath, ["--experimental-strip-types", script], {
          // Progress on fd 3 is best-effort. The artifact response uses a private
          // one-shot file because Wasmer worker transports may claim inherited fds.
          stdio: ["pipe", "pipe", "pipe", "pipe"],
          env: { ...process.env, FORGE_BUILD_RESPONSE: responsePath },
        });
        this.activeChildren.add(child);
        let progressBuffer = "";
        let timedOut = false;
        let transportError: Error | undefined;
        const failTransport = (error: Error) => {
          transportError ??= error;
          child.kill("SIGKILL");
        };
        const stdout = new BoundedByteCollector(
          "Isolated server compiler stdout",
          SERVER_STAGE_LOG_LIMIT_BYTES,
          failTransport,
        );
        const stderr = new BoundedByteCollector(
          "Isolated server compiler stderr",
          SERVER_STAGE_LOG_LIMIT_BYTES,
          failTransport,
        );
        child.stdout.on("data", (chunk: Buffer) => stdout.append(chunk));
        child.stderr.on("data", (chunk: Buffer) => stderr.append(chunk));
        child.on("error", (error) => { transportError = error; });
        child.stdin.on("error", (error) => { transportError ??= error; });
        const progressStream = child.stdio[3];
        if (!progressStream || typeof progressStream === "number") {
          child.kill("SIGKILL");
          this.activeChildren.delete(child);
          reject(new Error("The isolated server compiler did not expose its progress channel."));
          return;
        }
        progressStream.on("data", (chunk: Buffer) => {
          if (Buffer.byteLength(progressBuffer, "utf8") + chunk.byteLength > SERVER_STAGE_PROGRESS_LINE_LIMIT_BYTES) {
            failTransport(new Error(
              `Isolated server compiler progress exceeded the ${SERVER_STAGE_PROGRESS_LINE_LIMIT_BYTES} byte line boundary.`,
            ));
            return;
          }
          progressBuffer += chunk.toString("utf8");
          const lines = progressBuffer.split("\n");
          progressBuffer = lines.pop() ?? "";
          for (const line of lines) {
            if (!line) continue;
            try {
              const progress = JSON.parse(line) as WorkerProgress;
              if (this.isCurrent(operation)) {
                for (const listener of this.progressListeners) listener(progress);
              }
            } catch {
              // ForgeCompiler internals may write non-protocol data to fd 3.
            }
          }
        });
        const timer = setTimeout(() => {
          timedOut = true;
          child.kill("SIGKILL");
        }, SERVER_BUILD_TIMEOUT_MS);
        child.on("close", async () => {
          clearTimeout(timer);
          this.activeChildren.delete(child);
          try {
            this.assertCurrent(operation, "Server compilation was cancelled.");
            if (timedOut) throw new Error(`Server compilation exceeded ${SERVER_BUILD_TIMEOUT_MS} ms.`);
            if (transportError) throw transportError;
            let encodedResponse: Buffer;
            try {
              encodedResponse = await readBoundedRegularFile(responsePath, SERVER_BUILD_RESPONSE_LIMIT_BYTES);
            } catch (error) {
              const stageError = stderr.text().trim() || stdout.text().trim();
              if (stageError) throw new Error(stageError, { cause: error });
              throw error;
            }
            const response = deserialize(encodedResponse) as {
              ok: boolean;
              result?: BuildResult;
              error?: string;
            };
            if (!response.ok || !response.result) {
              throw new Error(
                response.error
                || stderr.text()
                || stdout.text()
                || "The isolated server compiler failed.",
              );
            }
            resolve(response.result);
          } catch (error) {
            reject(error);
          }
        });
        child.stdin.end(JSON.stringify({
          compilerExecutable: this.compilerExecutable,
          toolchainDirectory: this.toolchainDirectory,
          project,
          cacheKey,
        }));
      });
    } finally {
      await rm(transportDirectory, { recursive: true, force: true });
    }
  }

  private async compileRust(request: RustCompileRequest): Promise<RustCompileResult> {
    const result = await this.runCompilerStage<Omit<RustCompileResult, "wasm"> & { wasmBase64?: string }>(
      "rustc-stage.mjs",
      { request },
      RUST_COMPILE_TIMEOUT_MS,
    );
    return {
      ...result,
      diagnostics: parseRustDiagnostics(result.stderr),
      wasm: result.wasmBase64
        ? new Uint8Array(Buffer.from(result.wasmBase64, "base64"))
        : undefined,
    };
  }

  private async compilePython(request: PythonFrontendRequest): Promise<PythonFrontendResult> {
    const result = await this.runCompilerStage<Omit<PythonFrontendResult, "bytecode"> & { bytecodeBase64: Record<string, string> }>(
      "python-stage.mjs",
      { request },
      PYTHON_COMPILE_TIMEOUT_MS,
    );
    return {
      ...result,
      bytecode: Object.fromEntries(Object.entries(result.bytecodeBase64).map(([path, base64]) => [
        path,
        new Uint8Array(Buffer.from(base64, "base64")),
      ])),
      diagnostics: parsePythonDiagnostics(`${result.stderr}\n${result.stdout}`),
    };
  }

  private async compileGo(request: GoCompileRequest): Promise<GoCompileResult> {
    const result = await this.runCompilerStage<Omit<GoCompileResult, "wasm" | "diagnostics"> & { wasmBase64?: string }>(
      "go-stage.mjs",
      { compilerExecutable: this.compilerExecutable, compileBatchSchema: FORGE_SCHEMAS.compileBatch, request },
      GO_COMPILE_TIMEOUT_MS,
    );
    return {
      ...result,
      diagnostics: parseGoDiagnostics(result.stderr),
      wasm: result.wasmBase64
        ? new Uint8Array(Buffer.from(result.wasmBase64, "base64"))
        : undefined,
    };
  }

  private runCompilerStage<T>(scriptName: string, input: object, timeoutMs: number): Promise<T> {
    const operation = this.activeOperation;
    if (!operation || operation.kind !== "build") {
      return Promise.reject(new Error("Server compilation was cancelled before its compiler stage started."));
    }
    this.assertCurrent(operation, "Server compilation was cancelled before its compiler stage started.");
    return new Promise((resolve, reject) => {
      const script = resolveStageScript(scriptName);
      const child = spawn(
        process.execPath,
        ["--experimental-strip-types", "--disable-warning=ExperimentalWarning", script],
        { stdio: ["pipe", "pipe", "pipe", "pipe"] },
      );
      this.activeChildren.add(child);
      let transportError: Error | undefined;
      let timedOut = false;
      const failTransport = (error: Error) => {
        transportError ??= error;
        child.kill("SIGKILL");
      };
      const stdout = new BoundedByteCollector(
        `Isolated compiler stage '${scriptName}' stdout`,
        SERVER_STAGE_LOG_LIMIT_BYTES,
        failTransport,
      );
      const stderr = new BoundedByteCollector(
        `Isolated compiler stage '${scriptName}' stderr`,
        SERVER_STAGE_LOG_LIMIT_BYTES,
        failTransport,
      );
      const responseBytes = new BoundedByteCollector(
        `Isolated compiler stage '${scriptName}' response`,
        SERVER_COMPILER_STAGE_RESPONSE_LIMIT_BYTES,
        failTransport,
      );
      child.stdout.on("data", (chunk: Buffer) => stdout.append(chunk));
      child.stderr.on("data", (chunk: Buffer) => stderr.append(chunk));
      child.on("error", (error) => { transportError = error; });
      child.stdin.on("error", (error) => { transportError ??= error; });
      const responseStream = child.stdio[3];
      if (!responseStream || typeof responseStream === "number") {
        child.kill("SIGKILL");
        this.activeChildren.delete(child);
        reject(new Error(`The isolated compiler stage '${scriptName}' did not expose its response channel.`));
        return;
      }
      responseStream.on("data", (chunk: Buffer) => responseBytes.append(chunk));
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGKILL");
      }, timeoutMs + 5_000);
      child.on("close", () => {
        clearTimeout(timer);
        this.activeChildren.delete(child);
        try {
          if (transportError) throw transportError;
          if (timedOut) throw new Error(`The isolated compiler stage '${scriptName}' exceeded ${timeoutMs + 5_000} ms.`);
          const response = JSON.parse(responseBytes.text()) as {
            ok: boolean;
            result?: T;
            error?: string;
          };
          if (!response.ok || !response.result) {
            throw new Error(
              response.error
              || stderr.text()
              || stdout.text()
              || `The isolated compiler stage '${scriptName}' failed.`,
            );
          }
          resolve(response.result);
        } catch (error) {
          reject(error);
        }
      });
      child.stdin.end(JSON.stringify({ toolchainDirectory: this.toolchainDirectory, ...input }));
    });
  }

  private async loadToolchainAsset(assetPath: string): Promise<Uint8Array> {
    const filename = path.basename(assetPath);
    const resolved = path.resolve(this.toolchainDirectory, filename);
    const relative = path.relative(this.toolchainDirectory, resolved);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new Error(`Toolchain asset escapes the configured directory: '${assetPath}'.`);
    }
    const compressed = await readFile(resolved);
    this.verifyToolchainAsset(assetPath, compressed);
    return new Uint8Array(gunzipSync(compressed));
  }

  private async loadToolchainFile(assetPath: string): Promise<Uint8Array> {
    const filename = path.basename(assetPath);
    const resolved = path.resolve(this.toolchainDirectory, filename);
    const relative = path.relative(this.toolchainDirectory, resolved);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new Error(`Toolchain file escapes the configured directory: '${assetPath}'.`);
    }
    const bytes = await readFile(resolved);
    this.verifyToolchainAsset(assetPath, bytes);
    return new Uint8Array(bytes);
  }

  private verifyToolchainAsset(assetPath: string, bytes: Uint8Array): void {
    const expected = expectedToolchainAssetSha256(assetPath);
    const actual = createHash("sha256").update(bytes).digest("hex");
    if (actual !== expected) {
      throw new Error(`Pinned toolchain asset '${assetPath}' has digest ${actual}; expected ${expected}.`);
    }
  }

  private beginOperation(kind: ServerCompilerOperation["kind"]): ServerCompilerOperation {
    this.assertActive();
    if (this.activeOperation) throw new Error("ServerForgeCompiler accepts one active operation at a time.");
    const operation = { kind, generation: this.generation, superseded: false };
    this.activeOperation = operation;
    return operation;
  }

  private endOperation(operation: ServerCompilerOperation): void {
    if (this.activeOperation === operation) this.activeOperation = undefined;
  }

  private assertCurrent(operation: ServerCompilerOperation, message: string): void {
    this.assertActive();
    if (!this.isCurrent(operation)) throw new Error(message);
  }

  private isCurrent(operation: ServerCompilerOperation): boolean {
    return !this.disposed && !operation.superseded && operation.generation === this.generation;
  }

  private terminateChildren(): void {
    for (const child of this.activeChildren) {
      if (this.inProcess) {
        child.kill("SIGKILL");
        continue;
      }
      child.kill("SIGTERM");
      setTimeout(() => {
        if (this.activeChildren.has(child)) child.kill("SIGKILL");
      }, 1_000).unref();
    }
  }

  private assertActive(): void {
    if (this.disposed) throw new Error("ServerForgeCompiler is disposed.");
  }
}

function resolveStageScript(scriptName: string): string {
  if (!SERVER_STAGE_SCRIPTS.has(scriptName)) {
    throw new Error(`Unknown isolated server compiler stage '${scriptName}'.`);
  }
  const modulePath = fileURLToPath(import.meta.url);
  const moduleDirectory = path.dirname(modulePath);
  const moduleFilename = path.basename(modulePath);
  let stageDirectory: string;
  if (moduleFilename === "server-compiler.ts" && path.basename(moduleDirectory) === "server") {
    stageDirectory = moduleDirectory;
  } else if (moduleFilename === "server-compiler.js" && path.basename(moduleDirectory) === "chunks") {
    stageDirectory = path.dirname(moduleDirectory);
  } else {
    throw new Error(`Unsupported ServerForgeCompiler module layout '${modulePath}'.`);
  }
  return path.join(stageDirectory, scriptName);
}

/** @internal Entry point used only by the isolated Node compiler process. */
export async function buildServerProjectInProcess(
  options: ServerForgeCompilerOptions,
  project: Project,
  cacheKey: string,
  onProgress: (progress: WorkerProgress) => void,
): Promise<BuildResult> {
  const compiler = new ServerForgeCompiler(options, IN_PROCESS_STAGE);
  const removeProgress = compiler.onProgress(onProgress);
  const terminate = () => compiler.dispose();
  process.once("SIGTERM", terminate);
  try {
    return await compiler.build(project, cacheKey);
  } finally {
    process.off("SIGTERM", terminate);
    removeProgress();
    compiler.dispose();
  }
}
