/// <reference lib="webworker" />

import initRuntimeCore, { GoCompilerSession as RuntimeCoreGoCompilerSession } from "../runner/generated/runtime-core.js";
import runtimeCoreWasmUrl from "../runner/generated/runtime-core_bg.wasm?url";
import {
  GO_ARCHIVE_PATH,
  GO_OUTPUT_PATH,
  GO_TOOLCHAIN,
  decodeGoStandardLibrary,
  decodeGoToolchainManifest,
  deterministicGoCompilerEnvironment,
  encodeGoCompilerFiles,
  goCompileArguments,
  goCompileDependencyArguments,
  goImportConfig,
  goLinkArguments,
  reachableGoDependencies,
  type GoCompileResult,
  type GoStageRequest,
  type GoStageResponse,
} from "../compiler/go-toolchain";
import { parseGoDiagnostics } from "../core/diagnostics";
import { sha256Hex } from "../core/hash";
import { contentAddressedToolchainAssetUrl } from "../core/toolchains";
import {
  BrowserGoCompilerSession,
  type RuntimeCoreCompileStage,
  type RuntimeCoreGoSessionConstructor,
} from "./go-compiler-session";
import { moduleWorkerBaseUrl } from "./module-worker";

const scope: DedicatedWorkerGlobalScope = self as unknown as DedicatedWorkerGlobalScope;
const workerBaseUrl = moduleWorkerBaseUrl();
const COMPILER_MEMORY_LIMIT_BYTES = 512 * 1024 * 1024;
const COMPILER_OUTPUT_LIMIT_BYTES = 32 * 1024 * 1024;

let requestTail = Promise.resolve();
let toolchain: Promise<GoStageToolchain> | undefined;
let resolvedToolchain: GoStageToolchain | undefined;
let toolchainBaseUrl: string | undefined;

scope.addEventListener("message", (event: MessageEvent<GoStageRequest>) => {
  requestTail = requestTail.then(() => respond(event.data), () => respond(event.data));
});

interface CompilerPipelineResult {
  ok: boolean;
  result?: {
    stages: Array<{
      code: number;
      stdout: Uint8Array;
      stderr: Uint8Array;
      outputFiles: Record<string, Uint8Array>;
      termination: string;
    }>;
  };
  error?: { code: string; message: string };
}

type CompilerPipelineOutput = NonNullable<CompilerPipelineResult["result"]>;

interface GoStageToolchain {
  manifest: ReturnType<typeof decodeGoToolchainManifest>;
  session: BrowserGoCompilerSession<CompilerPipelineOutput>;
}

async function compile(message: Extract<GoStageRequest, { type: "compile" }>): Promise<GoCompileResult> {
  const baseUrl = new URL(message.assetBaseUrl, workerBaseUrl);
  if (!baseUrl.pathname.endsWith("/")) baseUrl.pathname += "/";
  const loaded = await loadToolchain(baseUrl);
  const dependencies = reachableGoDependencies(
    message.request.files,
    message.request.dependencies ?? [],
    loaded.manifest.packages,
  );
  const importPackages = [
    ...loaded.manifest.packages,
    ...dependencies.map((item) => ({ importPath: item.importPath, archivePath: item.archivePath })),
  ];
  const files = encodeGoCompilerFiles({
    ...Object.fromEntries(message.request.files.map((file) => [`/work/${file.path}`, file.content])),
    ...Object.fromEntries((message.request.dependencyFiles ?? []).map((file) => [`/work/${file.path}`, file.content])),
    "/work/importcfg": goImportConfig(importPackages, false),
    "/work/importcfg.link": goImportConfig(importPackages, true),
  });
  const common = {
    env: deterministicGoCompilerEnvironment(),
    stdin: new Uint8Array(),
    files: {},
    cwd: "/work",
    outputLimitBytes: COMPILER_OUTPUT_LIMIT_BYTES,
  };
  const stages: RuntimeCoreCompileStage[] = [
      ...dependencies.map((dependency) => ({
        ...common,
        command: "go-compile",
        args: goCompileDependencyArguments(dependency, message.request.optimization),
        outputPaths: [dependency.archivePath],
      })),
      {
        ...common,
        command: "go-compile",
        args: goCompileArguments(message.request.files, message.request.optimization),
        outputPaths: [GO_ARCHIVE_PATH],
      },
      {
        ...common,
        command: "go-link",
        args: goLinkArguments(message.request.optimization),
        outputPaths: [GO_OUTPUT_PATH],
      },
    ];
  const response = await loaded.session.compile(files, stages) as CompilerPipelineResult;
  if (!response.ok || !response.result) {
    throw new Error(response.error?.message ?? "The WASM-OJ Go compiler pipeline failed.");
  }
  const decoder = new TextDecoder();
  const stdout = response.result.stages.map((stage) => decoder.decode(stage.stdout)).join("");
  const stderr = response.result.stages.map((stage) => decoder.decode(stage.stderr)).join("");
  const linked = response.result.stages.at(-1);
  const wasm = linked?.code === 0 ? linked.outputFiles[GO_OUTPUT_PATH] : undefined;
  const validWasm = wasm === undefined
    ? false
    : WebAssembly.validate(Uint8Array.from(wasm));
  return {
    success: response.result.stages.length === dependencies.length + 2
      && response.result.stages.every((stage) => stage.code === 0)
      && validWasm,
    wasm,
    stdout,
    stderr,
    diagnostics: parseGoDiagnostics(stderr),
  };
}

async function respond(message: GoStageRequest): Promise<void> {
  try {
    if (message.type === "shutdown") {
      resolvedToolchain?.session.dispose();
      resolvedToolchain = undefined;
      toolchain = undefined;
      toolchainBaseUrl = undefined;
      scope.postMessage({ type: "shutdown-complete" } satisfies GoStageResponse);
      scope.close();
      return;
    }
    const result = await compile(message);
    scope.postMessage(
      { type: "result", result } satisfies GoStageResponse,
      result.wasm ? [result.wasm.buffer] : [],
    );
  } catch (error) {
    const caught = error instanceof Error ? error : new Error(String(error));
    scope.postMessage({ type: "error", message: caught.message, stack: caught.stack } satisfies GoStageResponse);
  }
}

function loadToolchain(baseUrl: URL): Promise<GoStageToolchain> {
  if (toolchainBaseUrl !== undefined && toolchainBaseUrl !== baseUrl.href) {
    throw new Error("The persistent Go stage cannot change its toolchain asset base URL.");
  }
  toolchainBaseUrl = baseUrl.href;
  toolchain ??= initializeToolchain(baseUrl);
  return toolchain;
}

async function initializeToolchain(baseUrl: URL): Promise<GoStageToolchain> {
  const [, packageBytes, manifest, standardLibrary] = await Promise.all([
    initRuntimeCore({ module_or_path: new URL(runtimeCoreWasmUrl, workerBaseUrl) }),
    loadGoPackage(baseUrl),
    loadGoManifest(baseUrl),
    loadGoStandardLibrary(baseUrl),
  ]);
  const loaded = {
    manifest,
    session: BrowserGoCompilerSession.hydrate<CompilerPipelineOutput>(
      RuntimeCoreGoCompilerSession as RuntimeCoreGoSessionConstructor<CompilerPipelineOutput>,
      {
        digest: GO_TOOLCHAIN.manifestSha256,
        toolchain: {
          package: packageBytes,
          memoryLimitBytes: COMPILER_MEMORY_LIMIT_BYTES,
        },
        standardLibraryFiles: decodeGoStandardLibrary(standardLibrary, manifest.packages),
      },
    ),
  };
  resolvedToolchain = loaded;
  return loaded;
}

async function loadGoPackage(baseUrl: URL): Promise<Uint8Array> {
  const compressed = await loadVerifiedAssetResponse(baseUrl, GO_TOOLCHAIN.packageAsset, GO_TOOLCHAIN.packageCompressedSha256);
  const bytes = await gunzip(compressed, "Go WebC");
  await verifyDigest("decompressed Go WebC", bytes, GO_TOOLCHAIN.packageSha256);
  return bytes;
}

async function loadGoManifest(baseUrl: URL) {
  const bytes = await loadVerifiedAsset(baseUrl, GO_TOOLCHAIN.manifestAsset, GO_TOOLCHAIN.manifestSha256);
  return decodeGoToolchainManifest(bytes);
}

async function loadGoStandardLibrary(baseUrl: URL): Promise<Uint8Array> {
  const compressed = await loadVerifiedAssetResponse(
    baseUrl,
    GO_TOOLCHAIN.standardLibraryAsset,
    GO_TOOLCHAIN.standardLibraryCompressedSha256,
  );
  const bytes = await gunzip(compressed, "Go standard library");
  await verifyDigest("decompressed Go standard library", bytes, GO_TOOLCHAIN.standardLibrarySha256);
  return bytes;
}

async function gunzip(compressed: Response, label: string): Promise<Uint8Array> {
  const body = compressed.body;
  if (!body) throw new Error(`Pinned ${label} response has no body.`);
  return new Uint8Array(await new Response(body.pipeThrough(new DecompressionStream("gzip"))).arrayBuffer());
}

async function loadVerifiedAssetResponse(baseUrl: URL, assetPath: string, expected: string): Promise<Response> {
  const response = await fetch(contentAddressedToolchainAssetUrl(assetPath, baseUrl));
  if (!response.ok) throw new Error(`Unable to load pinned Go toolchain asset '${assetPath}' (${response.status}).`);
  const bytes = new Uint8Array(await response.clone().arrayBuffer());
  await verifyDigest(assetPath, bytes, expected);
  return response;
}

async function loadVerifiedAsset(baseUrl: URL, assetPath: string, expected: string): Promise<Uint8Array> {
  const response = await fetch(contentAddressedToolchainAssetUrl(assetPath, baseUrl));
  if (!response.ok) throw new Error(`Unable to load pinned Go toolchain asset '${assetPath}' (${response.status}).`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  await verifyDigest(assetPath, bytes, expected);
  return bytes;
}

async function verifyDigest(label: string, bytes: Uint8Array, expected: string): Promise<void> {
  const actual = await sha256Hex(bytes);
  if (actual !== expected) {
    throw new Error(`Pinned Go toolchain asset '${label}' has digest ${actual}; expected ${expected}.`);
  }
}
