/// <reference lib="webworker" />

import { Runtime, init } from "@wasmer/sdk";
import wasmerWasmUrl from "@wasmer/sdk/wasm?url";
import { WASM_OJ_SCHEMAS } from "../core/contract";
import { sha256Hex } from "../core/hash";
import {
  GO_PACKAGE_ASSET_PATH,
  PYTHON_PACKAGE_ASSET_PATH,
  RUST_PACKAGE_ASSET_PATH,
} from "../core/toolchains";
import {
  browserToolchainAssetBaseUrl,
  browserToolchainAssetUrl,
  snapshotBrowserToolchainSources,
  toolchainAssetSource,
} from "../core/toolchain-sources";
import {
  buildProject,
  clearCompilerHostCaches,
  configureWasmerCompilerHost,
} from "@/src/compiler/wasmer-engine";
import {
  assertOutputReadyClangStageBudget,
  usesOutputReadyClang,
} from "@/src/compiler/browser-clang-policy";
import {
  disposeSdkDirectClangToolchain,
  exportSdkDirectClangBuildGraphState,
  restoreSdkDirectClangBuildGraphState,
} from "@/src/compiler/sdk-direct-clang";
import {
  ClangBuildGraphPersistenceController,
  loadClangBuildGraphState,
  saveClangBuildGraphState,
} from "@/src/compiler/indexeddb-build-graph-cache";
import type {
  CompilerRequest,
  CompilerResponse,
  CompilerTraceEvent,
  CompilerTraceOperation,
  BrowserToolchainSource,
  WorkerPhase,
} from "@/src/core/types";
import type {
  RustCompileRequest,
  RustCompileResult,
  RustcStageRequest,
} from "@/src/compiler/rust-toolchain";
import { RUST_COMPILE_TIMEOUT_MS } from "@/src/compiler/rust-toolchain";
import type { PythonFrontendRequest, PythonFrontendResult, PythonStageRequest } from "@/src/compiler/python-toolchain";
import { PYTHON_COMPILE_TIMEOUT_MS } from "@/src/compiler/python-toolchain";
import PythonStageWorkerUrl from "./python-stage.worker?worker&url";
import RustcStageWorkerUrl from "./rustc-stage.worker?worker&url";
import GoStageWorkerUrl from "./go-stage.worker?worker&url";
import type { GoCompileRequest, GoCompileResult, GoStageRequest } from "@/src/compiler/go-toolchain";
import { GO_COMPILE_TIMEOUT_MS } from "@/src/compiler/go-toolchain";
import { PersistentIsolatedStage, runIsolatedStage } from "./isolated-stage";
import {
  createModuleWorker,
  createModuleWorkerBootstrap,
  type ModuleWorkerBootstrap,
  moduleWorkerBaseUrl,
} from "./module-worker";
import wasmerThreadWorkerUrl from "./wasmer-thread.worker?worker&url";

const scope: DedicatedWorkerGlobalScope = self as unknown as DedicatedWorkerGlobalScope;
const workerBaseUrl = moduleWorkerBaseUrl();
let toolchainSources: readonly BrowserToolchainSource[] | undefined;
let runtime: Runtime | undefined;
let runtimeInitialization: Promise<void> | undefined;
let wasmerThreadWorkerBootstrap: ModuleWorkerBootstrap | undefined;
let rustStage: PersistentIsolatedStage<RustcStageRequest, RustCompileResult> | undefined;
let goStage: PersistentIsolatedStage<GoStageRequest, GoCompileResult> | undefined;
const clangBuildGraphPersistence = new ClangBuildGraphPersistenceController({
  load: loadClangBuildGraphState,
  restore: restoreSdkDirectClangBuildGraphState,
  capture: exportSdkDirectClangBuildGraphState,
  save: saveClangBuildGraphState,
});
let quiescing = false;

function post(response: CompilerResponse): void {
  scope.postMessage(response);
}

function progress(requestId: string, phase: WorkerPhase, label: string, value?: number): void {
  post({ type: "progress", requestId, progress: { phase, label, progress: value } });
}

function trace(
  requestId: string,
  operation: CompilerTraceOperation,
  state: CompilerTraceEvent["state"],
): void {
  post({
    type: "compile-trace",
    requestId,
    event: {
      schema: WASM_OJ_SCHEMAS.compileTrace,
      operation,
      state,
      monotonicMs: performance.now(),
    },
  });
}

async function loadToolchainAsset(path: string): Promise<Uint8Array> {
  const url = assetUrl(path);
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Unable to load pinned toolchain asset '${path}' (${response.status}).`);
  }
  const compressed = new Uint8Array(await response.arrayBuffer());
  await verifyToolchainAsset(path, compressed);
  const body = new Response(compressed).body;
  if (!body) throw new Error(`Pinned toolchain asset '${path}' has no response body.`);
  const decompressed = body.pipeThrough(new DecompressionStream("gzip"));
  return new Uint8Array(await new Response(decompressed).arrayBuffer());
}

async function loadToolchainFile(path: string): Promise<Uint8Array> {
  const url = assetUrl(path);
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Unable to load pinned toolchain file '${path}' (${response.status}).`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  await verifyToolchainAsset(path, bytes);
  return bytes;
}

async function verifyToolchainAsset(path: string, bytes: Uint8Array): Promise<void> {
  const { asset } = toolchainAssetSource(requiredToolchainSources(), path);
  if (bytes.byteLength !== asset.bytes) {
    throw new Error(`Pinned toolchain asset '${path}' has ${bytes.byteLength} bytes; expected ${asset.bytes}.`);
  }
  const actual = await sha256Hex(bytes);
  if (actual !== asset.sha256) {
    throw new Error(`Pinned toolchain asset '${path}' has digest ${actual}; expected ${asset.sha256}.`);
  }
}

function requiredToolchainSources(): readonly BrowserToolchainSource[] {
  if (!toolchainSources) throw new Error("The compiler toolchain-source registry is not initialized.");
  return toolchainSources;
}

function assetUrl(path: string): URL {
  return browserToolchainAssetUrl(requiredToolchainSources(), path, workerBaseUrl);
}

function assetBaseUrl(path: string): string {
  return browserToolchainAssetBaseUrl(requiredToolchainSources(), path, workerBaseUrl).toString();
}

function compileRust(request: RustCompileRequest): Promise<RustCompileResult> {
  rustStage ??= new PersistentIsolatedStage({
    createWorker: () => createModuleWorker(RustcStageWorkerUrl, { name: "wasm-oj-rustc-stage" }),
    timeoutMs: RUST_COMPILE_TIMEOUT_MS + 5_000,
    stageLabel: "rustc",
  });
  return rustStage.run({
    type: "compile",
    request,
    assetBaseUrl: assetBaseUrl(RUST_PACKAGE_ASSET_PATH),
  });
}

function compilePython(request: PythonFrontendRequest): Promise<PythonFrontendResult> {
  const worker = createModuleWorker(PythonStageWorkerUrl, { name: "wasm-oj-python-stage" });
  return runIsolatedStage<PythonStageRequest, PythonFrontendResult>(
    worker,
    {
      type: "compile",
      request,
      assetBaseUrl: assetBaseUrl(PYTHON_PACKAGE_ASSET_PATH),
    },
    PYTHON_COMPILE_TIMEOUT_MS + 5_000,
    "Python",
  );
}

function compileGo(request: GoCompileRequest): Promise<GoCompileResult> {
  goStage ??= new PersistentIsolatedStage({
    createWorker: () => createModuleWorker(GoStageWorkerUrl, { name: "wasm-oj-go-stage" }),
    timeoutMs: GO_COMPILE_TIMEOUT_MS + 5_000,
    stageLabel: "Go",
  });
  return goStage.run({
    type: "compile",
    request,
    assetBaseUrl: assetBaseUrl(GO_PACKAGE_ASSET_PATH),
  });
}

function configureCompilerHost(): void {
  configureWasmerCompilerHost({
    getRuntime: () => {
      if (!runtime) throw new Error("The compiler Wasmer runtime is not initialized for this language.");
      return runtime;
    },
    loadToolchainAsset,
    loadToolchainFile,
    compileRust,
    compilePython,
    compileGo,
    progress,
    trace,
  });
}

async function initializeWorker(
  requestId: string,
  sources: readonly BrowserToolchainSource[],
): Promise<void> {
  if (!crossOriginIsolated) {
    throw new Error("Wasmer requires a cross-origin-isolated page. Serve this app with COOP and COEP headers.");
  }
  trace(requestId, "workerInitialize", "start");
  progress(requestId, "initializing", "Starting compiler worker", 0.2);
  toolchainSources = snapshotBrowserToolchainSources(sources);
  configureCompilerHost();
  progress(requestId, "initializing", "Compiler worker ready", 1);
  trace(requestId, "workerInitialize", "end");
}

function languageRequiresOuterRuntime(language: string): boolean {
  return language === "c"
    || language === "cpp"
    || language === "javascript"
    || language === "typescript";
}

async function ensureOuterRuntime(requestId: string): Promise<void> {
  if (runtime) return;
  runtimeInitialization ??= (async () => {
    progress(requestId, "initializing", "Starting Wasmer compiler runtime", 0.1);
    const bootstrap = createModuleWorkerBootstrap(new URL(wasmerThreadWorkerUrl, workerBaseUrl));
    wasmerThreadWorkerBootstrap = bootstrap;
    try {
      await init({
        log: "warn",
        module: new URL(wasmerWasmUrl, workerBaseUrl),
        workerUrl: bootstrap.url,
      });
      runtime = new Runtime({ registry: null });
    } catch (error) {
      if (wasmerThreadWorkerBootstrap === bootstrap) wasmerThreadWorkerBootstrap = undefined;
      bootstrap.revoke();
      throw error;
    }
    progress(requestId, "initializing", "Wasmer compiler runtime ready", 0.2);
  })();
  try {
    await runtimeInitialization;
  } catch (error) {
    runtimeInitialization = undefined;
    throw error;
  }
}

async function build(request: Extract<CompilerRequest, { type: "build" }>) {
  if (languageRequiresOuterRuntime(request.project.config.language)) {
    await ensureOuterRuntime(request.requestId);
  }
  if (usesOutputReadyClang(request.project)) {
    await clangBuildGraphPersistence.ensureLoaded();
    assertOutputReadyClangStageBudget(request.project);
  }
  const result = await buildProject(request.project, request.cacheKey, request.requestId);
  if (usesOutputReadyClang(request.project)) {
    await clangBuildGraphPersistence.persistIfDirty();
  }
  return result;
}

async function quiesce(): Promise<void> {
  if (quiescing) throw new Error("The compiler Worker is already quiescing.");
  quiescing = true;
  const activeRustStage = rustStage;
  const activeGoStage = goStage;
  rustStage = undefined;
  goStage = undefined;
  try {
    await Promise.all([
      activeRustStage?.shutdown({ type: "shutdown" }),
      activeGoStage?.shutdown({ type: "shutdown" }),
    ]);
  } finally {
    try {
      await clangBuildGraphPersistence.persistIfDirty();
      await disposeSdkDirectClangToolchain();
    } finally {
      clearCompilerHostCaches();
      runtime?.free();
      runtime = undefined;
      runtimeInitialization = undefined;
      wasmerThreadWorkerBootstrap?.revoke();
      wasmerThreadWorkerBootstrap = undefined;
    }
  }
}

scope.addEventListener("message", (event: MessageEvent<CompilerRequest>) => {
  const request = event.data;
  void (async () => {
    try {
      switch (request.type) {
        case "initialize":
          await initializeWorker(request.requestId, request.toolchains);
          post({ type: "ready", requestId: request.requestId });
          break;
        case "build":
          post({
            type: "build-result",
            requestId: request.requestId,
            result: await build(request),
          });
          break;
        case "quiesce":
          await quiesce();
          post({ type: "quiesced", requestId: request.requestId });
          scope.close();
          break;
      }
    } catch (error) {
      const caught = error instanceof Error ? error : new Error(String(error));
      post({
        type: "error",
        requestId: request.requestId,
        code: "COMPILER_ERROR",
        message: caught.message,
        stack: caught.stack,
      });
    }
  })();
});

export {};
