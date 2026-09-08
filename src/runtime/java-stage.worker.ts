/// <reference lib="webworker" />

import {
  JAVA_COMPILER_ASSET_PATH,
  JAVA_COMPILER_SHA256,
  JAVA_COMPILE_CLASSLIB_ASSET_PATH,
  JAVA_COMPILE_CLASSLIB_SHA256,
  JAVA_RUNTIME_CLASSLIB_ASSET_PATH,
  JAVA_RUNTIME_CLASSLIB_SHA256,
  contentAddressedToolchainAssetUrl,
} from "../core/toolchains";
import type { JavaStageRequest, JavaStageResponse } from "../compiler/java-toolchain";
import { compileJavaGc, loadJavaGcEngine, type JavaGcEngine } from "../compiler/java-gc";
import { sha256Hex } from "../core/hash";
import { moduleWorkerBaseUrl } from "./module-worker";

const scope: DedicatedWorkerGlobalScope = self as unknown as DedicatedWorkerGlobalScope;
const workerBaseUrl = moduleWorkerBaseUrl();
let engine: JavaGcEngine | undefined;
let classlibs: { sdk: Uint8Array; runtime: Uint8Array } | undefined;

scope.addEventListener("message", (event: MessageEvent<JavaStageRequest>) => {
  void respond(event.data);
});

async function respond(message: JavaStageRequest): Promise<void> {
  try {
    if (message.type === "shutdown") {
      engine = undefined;
      classlibs = undefined;
      scope.postMessage({ type: "shutdown-complete" } satisfies JavaStageResponse);
      scope.close();
      return;
    }
    if (!engine || !classlibs) {
      const [compiler, sdk, runtime] = await Promise.all([
        loadAsset(message.assetBaseUrl, JAVA_COMPILER_ASSET_PATH, JAVA_COMPILER_SHA256),
        loadAsset(message.assetBaseUrl, JAVA_COMPILE_CLASSLIB_ASSET_PATH, JAVA_COMPILE_CLASSLIB_SHA256),
        loadAsset(message.assetBaseUrl, JAVA_RUNTIME_CLASSLIB_ASSET_PATH, JAVA_RUNTIME_CLASSLIB_SHA256),
      ]);
      engine = await loadJavaGcEngine(compiler);
      classlibs = { sdk, runtime };
    }
    const result = await compileJavaGc(engine, message.request, classlibs);
    scope.postMessage(
      { type: "result", result } satisfies JavaStageResponse,
      result.wasm ? [result.wasm.buffer] : [],
    );
  } catch (error) {
    const caught = error instanceof Error ? error : new Error(String(error));
    scope.postMessage({ type: "error", message: caught.message, stack: caught.stack } satisfies JavaStageResponse);
  }
}

async function loadAsset(assetBaseUrl: string, assetPath: string, expected: string): Promise<Uint8Array> {
  const baseUrl = new URL(assetBaseUrl, workerBaseUrl);
  if (!baseUrl.pathname.endsWith("/")) baseUrl.pathname += "/";
  const response = await fetch(contentAddressedToolchainAssetUrl(assetPath, baseUrl));
  if (!response.ok) throw new Error(`Unable to load pinned Java asset '${assetPath}' (${response.status}).`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  const actual = await sha256Hex(bytes);
  if (actual !== expected) throw new Error(`Pinned Java asset '${assetPath}' has digest ${actual}; expected ${expected}.`);
  return bytes;
}
