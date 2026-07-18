/// <reference lib="webworker" />

import { Runtime, Wasmer, init } from "@wasmer/sdk";
import wasmerWasmUrl from "@wasmer/sdk/wasm?url";
import { FORGE_STORAGE } from "@/src/core/contract";
import { sha256Hex } from "@/src/core/hash";
import {
  contentAddressedToolchainAssetUrl,
  PYTHON_COMPRESSED_PACKAGE_SHA256,
  PYTHON_PACKAGE,
  PYTHON_PACKAGE_ASSET_PATH,
  PYTHON_PACKAGE_SHA256,
  QUICKJS_ASSET_PATH,
  QUICKJS_ASSET_SHA256,
  QUICKJS_VERSION,
} from "@/src/core/toolchains";
import type {
  ExecutionTermination,
  InteractiveProcessResult,
  InteractiveRunConfig,
  InteractiveRunResult,
  RunnerRequest,
  RunnerResponse,
  RunResult,
  WorkerPhase,
} from "@/src/core/types";
import {
  createExtendedCostBaselineRegistry,
  normalizeExecutionMetrics,
  type RawExecutionMetrics,
} from "@/src/core/cost";
import {
  prepareArtifactRun,
  prepareArtifactInteraction,
  createDefaultRuntimeDrivers,
  type PackageFileSystemRequest,
  type RuntimeDriverRegistry,
  type RuntimeResolver,
} from "@/src/runner/artifact";
import {
  openOptionalRuntimeFilesCache,
  restoreOrExportRuntimeFiles,
} from "@/src/runtime/runtime-files-cache";
import {
  PackageHandleCache,
  WasmerPackageHandle,
  withHandleLease,
  withWasmerCommand,
} from "@/src/runner/package-handle-cache";
import initRuntimeCore, {
  interact_forge as interactForgeCore,
  run_forge as runForgeCore,
} from "@/src/runner/generated/runtime-core.js";
import runtimeCoreWasmUrl from "@/src/runner/generated/runtime-core_bg.wasm?url";
import {
  createModuleWorkerBootstrap,
  type ModuleWorkerBootstrap,
  moduleWorkerBaseUrl,
} from "./module-worker";
import wasmerThreadWorkerUrl from "./wasmer-thread.worker?worker&url";

const scope: DedicatedWorkerGlobalScope = self as unknown as DedicatedWorkerGlobalScope;
const workerBaseUrl = moduleWorkerBaseUrl();
const decoder = new TextDecoder();
const packages = new PackageHandleCache<string, WasmerPackageHandle>();
const packageFileSystems = new Map<string, Promise<Record<string, Uint8Array>>>();
let sdkRuntime: Runtime | undefined;
let wasmerThreadWorkerBootstrap: ModuleWorkerBootstrap | undefined;
let runtimeDrivers: RuntimeDriverRegistry | undefined;
let quickJsBytes: Promise<Uint8Array> | undefined;
let toolchainAssetBaseUrl = new URL("/toolchains/", workerBaseUrl);

interface CoreRunResult {
  code: number;
  stdout: Uint8Array;
  stderr: Uint8Array;
  files: Record<string, Uint8Array>;
  termination: ExecutionTermination;
  trapMessage?: string;
  metrics: {
    cost: number | bigint;
    costModel: string;
    operations: Record<string, number | bigint>;
    memoryBytes: number | bigint;
    logicalTimeNs: number | bigint;
    filesystemBytes: number | bigint;
    filesystemEntries: number | bigint;
    stdoutBytes: number | bigint;
    stderrBytes: number | bigint;
  };
}

interface CoreRunResponse {
  ok: boolean;
  result?: CoreRunResult;
  error?: { code: string; message: string };
}

interface CoreInteractiveProcessResult {
  code: number;
  stderr: Uint8Array;
  termination: ExecutionTermination;
  metrics: {
    cost: number | bigint;
    operations: Record<string, number | bigint>;
    logicalTimeNs: number | bigint;
    filesystemBytes: number | bigint;
    filesystemEntries: number | bigint;
    protocolBytes: number | bigint;
    stderrBytes: number | bigint;
  };
}

interface CoreInteractiveResponse {
  ok: boolean;
  result?: {
    contestant: CoreInteractiveProcessResult;
    interactor: CoreInteractiveProcessResult;
    contestantToInteractor: Uint8Array;
    interactorToContestant: Uint8Array;
  };
  error?: { code: string; message: string };
}

function post(response: RunnerResponse): void {
  scope.postMessage(response);
}

function progress(requestId: string, phase: WorkerPhase, label: string, value?: number): void {
  post({ type: "progress", requestId, progress: { phase, label, progress: value } });
}

async function initializeRuntime(
  requestId: string,
  assetBaseUrl?: string,
  additionalCostBaselines?: Readonly<Record<string, number>>,
): Promise<void> {
  if (!crossOriginIsolated) {
    throw new Error("The deterministic runner requires a cross-origin-isolated page with COOP and COEP headers.");
  }
  toolchainAssetBaseUrl = new URL(assetBaseUrl ?? "/toolchains/", workerBaseUrl);
  if (!toolchainAssetBaseUrl.pathname.endsWith("/")) toolchainAssetBaseUrl.pathname += "/";

  progress(requestId, "initializing", "Starting deterministic Wasmer runner", 0.1);
  await initRuntimeCore({ module_or_path: new URL(runtimeCoreWasmUrl, workerBaseUrl) });
  progress(requestId, "initializing", "Starting Wasmer package resolver", 0.55);
  const bootstrap = createModuleWorkerBootstrap(new URL(wasmerThreadWorkerUrl, workerBaseUrl));
  wasmerThreadWorkerBootstrap = bootstrap;
  try {
      await init({
        log: "warn",
        module: new URL(wasmerWasmUrl, workerBaseUrl),
        workerUrl: bootstrap.url,
      });
      sdkRuntime = new Runtime({ registry: null });
    } catch (error) {
      if (wasmerThreadWorkerBootstrap === bootstrap) wasmerThreadWorkerBootstrap = undefined;
      bootstrap.revoke();
      throw error;
    }
  runtimeDrivers = createDefaultRuntimeDrivers(
    createExtendedCostBaselineRegistry(additionalCostBaselines),
  );
  progress(requestId, "initializing", "Deterministic Wasmer runner ready", 1);
}

function requireRuntime(): Runtime {
  if (!sdkRuntime) throw new Error("The Wasmer package resolver is not initialized.");
  return sdkRuntime;
}

function toolchainAssetUrl(path: string): URL {
  return contentAddressedToolchainAssetUrl(path, toolchainAssetBaseUrl);
}

async function loadCompressedAsset(
  path: string,
  label: string,
  compressedSha256: string,
  expandedSha256?: string,
): Promise<Uint8Array> {
  const response = await fetch(toolchainAssetUrl(path));
  if (!response.ok) {
    throw new Error(`Unable to load ${label} (${response.status}).`);
  }
  const compressed = new Uint8Array(await response.arrayBuffer());
  const actual = await sha256Hex(compressed);
  if (actual !== compressedSha256) {
    throw new Error(`Pinned ${label} asset has digest ${actual}; expected ${compressedSha256}.`);
  }
  const body = new Response(compressed).body;
  if (!body) throw new Error(`Pinned ${label} asset '${path}' has no response body.`);
  const decompressed = body.pipeThrough(new DecompressionStream("gzip"));
  const bytes = new Uint8Array(await new Response(decompressed).arrayBuffer());
  if (expandedSha256) {
    const expandedDigest = await sha256Hex(bytes);
    if (expandedDigest !== expandedSha256) {
      throw new Error(`Pinned ${label} payload has digest ${expandedDigest}; expected ${expandedSha256}.`);
    }
  }
  return bytes;
}

function acquirePackage(specifier: string) {
  if (specifier !== PYTHON_PACKAGE) {
    throw new Error(`No pinned Forge runtime package is declared for '${specifier}'.`);
  }
  return packages.acquire(specifier, async () => {
    const bytes = await loadCompressedAsset(
      PYTHON_PACKAGE_ASSET_PATH,
      "Python/WASI package",
      PYTHON_COMPRESSED_PACKAGE_SHA256,
      PYTHON_PACKAGE_SHA256,
    );
    return new WasmerPackageHandle(await Wasmer.fromFile(bytes, requireRuntime()));
  });
}

function runtimeFilesCacheRequest(request: PackageFileSystemRequest): Request {
  const identity = `${request.packageSpecifier}\n${request.command}\n${request.cacheKey}\n${request.expectedSha256}`;
  const encoded = encodeURIComponent(identity);
  return new Request(new URL(`/__wasm_oj_forge_runtime_files__/${encoded}`, workerBaseUrl));
}

async function exportPackageFileSystem(
  request: PackageFileSystemRequest,
): Promise<Record<string, Uint8Array>> {
  const key = `${request.packageSpecifier}\n${request.command}\n${request.cacheKey}\n${request.expectedSha256}`;
  let pending = packageFileSystems.get(key);
  if (pending) return pending;

  pending = (async () => {
    const cache = await openOptionalRuntimeFilesCache(caches, FORGE_STORAGE.runtimeFilesCache);
    const cacheRequest = runtimeFilesCacheRequest(request);
    return restoreOrExportRuntimeFiles(
      cache,
      {
        cacheRequest,
        cacheKey: request.cacheKey,
        expectedSha256: request.expectedSha256,
      },
      async () => {
        const lease = await acquirePackage(request.packageSpecifier);
        const output = await withHandleLease(
          lease,
          (pkg) => withWasmerCommand(pkg, request.command, async (command) => {
            const instance = await command.run({
              args: request.args,
              env: {
                PYTHONHOME: "/usr/local",
                PYTHONHASHSEED: "0",
                PYTHONDONTWRITEBYTECODE: "1",
              },
            });
            return instance.wait();
          }),
        );
        if (!output.ok) {
          throw new Error(
            `Unable to export runtime files from ${request.packageSpecifier}: exit ${output.code}: ${output.stderr}`,
          );
        }
        return output.stdoutBytes.slice();
      },
    );
  })();
  packageFileSystems.set(key, pending);
  try {
    return await pending;
  } catch (error) {
    if (packageFileSystems.get(key) === pending) packageFileSystems.delete(key);
    throw error;
  }
}

function loadQuickJs(): Promise<Uint8Array> {
  const cached = quickJsBytes;
  if (cached) return cached;
  const pending = loadCompressedAsset(
    QUICKJS_ASSET_PATH,
    `the pinned QuickJS-ng ${QUICKJS_VERSION}/WASI runtime`,
    QUICKJS_ASSET_SHA256,
  );
  quickJsBytes = pending;
  void pending.catch(() => {
    if (quickJsBytes === pending) quickJsBytes = undefined;
  });
  return pending;
}

const resolver: RuntimeResolver = {
  quickJs() {
    return loadQuickJs();
  },
  async packageCommand(packageSpecifier, commandName) {
    const lease = await acquirePackage(packageSpecifier);
    return withHandleLease(
      lease,
      (pkg) => withWasmerCommand(pkg, commandName, (command) => command.binary()),
    );
  },
  packageFileSystem: exportPackageFileSystem,
};

async function clearRuntimeCaches(): Promise<void> {
  const packageRetirement = packages.retireAll();
  packageFileSystems.clear();
  quickJsBytes = undefined;
  await packageRetirement.wait();
  await caches.delete(FORGE_STORAGE.runtimeFilesCache);
}

function number(value: number | bigint): number {
  const converted = Number(value);
  if (!Number.isSafeInteger(converted) || converted < 0) {
    throw new Error(`ForgeRunner returned an invalid numeric metric: ${String(value)}.`);
  }
  return converted;
}

function rawMetrics(value: CoreRunResult["metrics"]): RawExecutionMetrics {
  return {
    cost: number(value.cost),
    costModel: value.costModel,
    operations: Object.fromEntries(
      Object.entries(value.operations).map(([opcode, count]) => [opcode, number(count)]),
    ),
    memoryBytes: number(value.memoryBytes),
    logicalTimeNs: number(value.logicalTimeNs),
    filesystemBytes: number(value.filesystemBytes),
    filesystemEntries: number(value.filesystemEntries),
    stdoutBytes: number(value.stdoutBytes),
    stderrBytes: number(value.stderrBytes),
  };
}

async function runArtifact(request: Extract<RunnerRequest, { type: "run" }>): Promise<RunResult> {
  const started = performance.now();
  progress(request.requestId, "loading-toolchain", `Resolving runtime for ${request.artifact.name}`, 0.1);
  if (!runtimeDrivers) throw new Error("The Forge runtime-driver registry is not initialized.");
  const prepared = await prepareArtifactRun(request.artifact, request.config, resolver, runtimeDrivers);
  progress(request.requestId, "running", `Running ${request.artifact.name} with deterministic Wasmer`, 0.25);
  const response = runForgeCore(prepared) as CoreRunResponse;
  if (!response.ok || !response.result) {
    const error = response.error ?? { code: "RUNTIME_ERROR", message: "The runtime core returned no result." };
    throw Object.assign(new Error(error.message), { code: error.code });
  }
  const stdout = decoder.decode(response.result.stdout);
  const stderr = decoder.decode(response.result.stderr);
  if (stdout) post({ type: "stream", requestId: request.requestId, stream: "stdout", chunk: stdout });
  if (stderr) post({ type: "stream", requestId: request.requestId, stream: "stderr", chunk: stderr });
  return {
    code: response.result.code,
    stdout,
    stderr,
    files: Object.fromEntries(Object.entries(response.result.files).map(([path, contents]) => [path, contents.slice()])),
    durationMs: performance.now() - started,
    determinism: { ...request.config.determinism },
    resources: { ...request.config.resources },
    termination: response.result.termination,
    trapMessage: response.result.trapMessage,
    metrics: normalizeExecutionMetrics(rawMetrics(response.result.metrics), prepared.cost),
  };
}

async function interactArtifacts(
  request: Extract<RunnerRequest, { type: "interact" }>,
): Promise<InteractiveRunResult> {
  const started = performance.now();
  if (!runtimeDrivers) throw new Error("The Forge runtime-driver registry is not initialized.");
  if (request.interactor.kind !== "wasm") {
    throw new Error("Interactive judge artifacts must be standalone Wasm modules.");
  }
  progress(request.requestId, "loading-toolchain", "Resolving contestant and interactor runtimes", 0.1);
  const [contestant, interactor] = await Promise.all([
    prepareArtifactInteraction(
      request.contestant,
      interactiveRunConfig(request.config.contestant, request.config.determinism),
      resolver,
      runtimeDrivers,
    ),
    prepareArtifactInteraction(
      request.interactor,
      interactiveRunConfig(request.config.interactor, request.config.determinism),
      resolver,
      runtimeDrivers,
    ),
  ]);
  progress(request.requestId, "running", "Running interactive session with deterministic Wasmer", 0.25);
  const response = await interactForgeCore({
    contestant: interactiveCoreProgram(contestant),
    interactor: interactiveCoreProgram(interactor),
    determinism: request.config.determinism,
  }) as CoreInteractiveResponse;
  if (!response.ok || !response.result) {
    const error = response.error ?? { code: "RUNTIME_ERROR", message: "The interactive runtime returned no result." };
    throw Object.assign(new Error(error.message), { code: error.code });
  }
  return {
    contestant: interactiveProcessResult(response.result.contestant, contestant),
    interactor: interactiveProcessResult(response.result.interactor, interactor),
    contestantToInteractor: decoder.decode(response.result.contestantToInteractor),
    interactorToContestant: decoder.decode(response.result.interactorToContestant),
    durationMs: performance.now() - started,
    determinism: { ...request.config.determinism },
  };
}

function interactiveRunConfig(
  program: InteractiveRunConfig["contestant"],
  determinism: InteractiveRunConfig["determinism"],
) {
  return {
    args: [...program.args],
    stdin: "",
    env: { ...program.env },
    files: Object.fromEntries(Object.entries(program.files ?? {}).map(([path, contents]) => [path, contents.slice()])),
    outputPaths: [],
    ...(program.cwd === undefined ? {} : { cwd: program.cwd }),
    determinism: { ...determinism },
    resources: { ...program.resources },
  };
}

function interactiveCoreProgram(prepared: Awaited<ReturnType<typeof prepareArtifactRun>>) {
  return {
    wasm: prepared.wasm,
    args: prepared.args,
    env: prepared.env,
    files: prepared.files,
    cwd: prepared.cwd,
    resources: prepared.resources,
  };
}

function interactiveProcessResult(
  result: CoreInteractiveProcessResult,
  prepared: Awaited<ReturnType<typeof prepareArtifactRun>>,
): InteractiveProcessResult {
  const metrics = normalizeExecutionMetrics({
    cost: number(result.metrics.cost),
    costModel: "weighted",
    operations: Object.fromEntries(
      Object.entries(result.metrics.operations).map(([opcode, count]) => [opcode, number(count)]),
    ),
    memoryBytes: 0,
    logicalTimeNs: number(result.metrics.logicalTimeNs),
    filesystemBytes: number(result.metrics.filesystemBytes),
    filesystemEntries: number(result.metrics.filesystemEntries),
    stdoutBytes: number(result.metrics.protocolBytes),
    stderrBytes: number(result.metrics.stderrBytes),
  }, prepared.cost);
  return {
    code: result.code,
    stderr: decoder.decode(result.stderr),
    termination: result.termination,
    metrics: { ...metrics, memoryBytes: null },
  };
}

scope.addEventListener("message", (event: MessageEvent<RunnerRequest>) => {
  const request = event.data;
  void (async () => {
    try {
      switch (request.type) {
        case "initialize":
          await initializeRuntime(
            request.requestId,
            request.assetBaseUrl,
            request.additionalCostBaselines,
          );
          post({ type: "ready", requestId: request.requestId });
          break;
        case "run":
          post({ type: "run-result", requestId: request.requestId, result: await runArtifact(request) });
          break;
        case "interact":
          post({
            type: "interactive-result",
            requestId: request.requestId,
            result: await interactArtifacts(request),
          });
          break;
        case "clear-runtime-cache":
          await clearRuntimeCaches();
          post({ type: "runtime-cache-cleared", requestId: request.requestId });
          break;
      }
    } catch (error) {
      const caught = error instanceof Error ? error : new Error(String(error));
      const code = typeof (caught as Error & { code?: unknown }).code === "string"
        ? (caught as Error & { code: string }).code
        : "RUNNER_ERROR";
      post({ type: "error", requestId: request.requestId, code, message: caught.message, stack: caught.stack });
    }
  })();
});

export {};
