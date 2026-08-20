/// <reference lib="webworker" />

import { Directory, Runtime, Wasmer, init } from "@wasmer/sdk";
import wasmerWasmUrl from "@wasmer/sdk/wasm?url";
import {
  JAVA_COMPILER_ASSET_PATH,
  JAVA_COMPILER_COMPRESSED_PACKAGE_SHA256,
  JAVA_COMPILER_PACKAGE_SHA256,
  JAVA_COMPILE_CLASSLIB_ASSET_PATH,
  JAVA_COMPILE_CLASSLIB_SHA256,
  JAVA_RUNTIME_CLASSLIB_ASSET_PATH,
  JAVA_RUNTIME_CLASSLIB_SHA256,
} from "../core/toolchains";
import {
  contentAddressedToolchainAssetUrl,
} from "../core/toolchains";
import { parseJavaDiagnostics, javaMainClass, type JavaStageRequest, type JavaStageResponse, type JavaCompileResult } from "../compiler/java-toolchain";
import { sha256Hex } from "../core/hash";
import { createModuleWorkerBootstrap, moduleWorkerBaseUrl } from "./module-worker";
import wasmerThreadWorkerUrl from "./wasmer-thread.worker?worker&url";

const scope: DedicatedWorkerGlobalScope = self as unknown as DedicatedWorkerGlobalScope;
const workerBaseUrl = moduleWorkerBaseUrl();
let runtime: Runtime | undefined;
let compiler: Awaited<ReturnType<typeof Wasmer.fromFile>> | undefined;

scope.addEventListener("message", (event: MessageEvent<JavaStageRequest>) => {
  void respond(event.data);
});

async function respond(message: JavaStageRequest): Promise<void> {
  try {
    if (message.type === "shutdown") {
      compiler?.free();
      compiler = undefined;
      runtime?.free();
      runtime = undefined;
      scope.postMessage({ type: "shutdown-complete" } satisfies JavaStageResponse);
      scope.close();
      return;
    }
    const result = await compile(message);
    scope.postMessage(
      { type: "result", result } satisfies JavaStageResponse,
      result.wasm ? [result.wasm.buffer] : [],
    );
  } catch (error) {
    const caught = error instanceof Error ? error : new Error(String(error));
    scope.postMessage({ type: "error", message: caught.message, stack: caught.stack } satisfies JavaStageResponse);
  }
}

async function compile(message: Extract<JavaStageRequest, { type: "compile" }>): Promise<JavaCompileResult> {
  const request = message.request;
  if (!request) throw new Error("The Java stage received no compile request.");
  const bootstrap = createModuleWorkerBootstrap(new URL(wasmerThreadWorkerUrl, workerBaseUrl));
  try {
    if (!runtime) {
      await init({
        log: "warn",
        module: new URL(wasmerWasmUrl, workerBaseUrl),
        workerUrl: bootstrap.url,
      });
      runtime = new Runtime({ registry: null });
    }
    if (!compiler) {
      compiler = await Wasmer.fromFile(await loadCompressedAsset(message.assetBaseUrl), runtime);
    }
    const command = compiler.commands["java-compiler"];
    if (!command) throw new Error("The pinned Java compiler package does not expose java-compiler.");
    const project = new Directory(Object.fromEntries(request.files.map((file) => [`/${file.path}`, file.content])));
    await project.createDir("/build");
    const toolchain = new Directory({
      "/compile-classlib-teavm.bin": await loadAsset(message.assetBaseUrl, JAVA_COMPILE_CLASSLIB_ASSET_PATH, JAVA_COMPILE_CLASSLIB_SHA256),
      "/runtime-classlib-teavm.bin": await loadAsset(message.assetBaseUrl, JAVA_RUNTIME_CLASSLIB_ASSET_PATH, JAVA_RUNTIME_CLASSLIB_SHA256),
    });
    const entrySource = request.files.find((file) => file.path === request.entry);
    if (!entrySource) throw new Error(`Java entry '${request.entry}' does not exist.`);
    const instance = await command.run({
      args: [
        "/toolchain/compile-classlib-teavm.bin",
        "/toolchain/runtime-classlib-teavm.bin",
        javaMainClass(request.entry, entrySource.content),
        "/project/build/app.wasm",
        ...request.files.filter((file) => file.path.endsWith(".java")).map((file) => `/project/${file.path}`),
      ],
      mount: { "/project": project, "/toolchain": toolchain },
    });
    const output = await instance.wait();
    const diagnostics = parseJavaDiagnostics(`${output.stderr}\n${output.stdout}`, request.entry);
    let wasm: Uint8Array | undefined;
    if (output.ok) {
      wasm = await project.readFile("/build/app.wasm");
      await WebAssembly.compile(wasm as unknown as BufferSource);
    }
    toolchain.free();
    project.free();
    return { success: output.ok && wasm !== undefined, wasm, stdout: output.stdout, stderr: output.stderr, diagnostics };
  } finally {
    bootstrap.revoke();
  }
}

async function loadCompressedAsset(assetBaseUrl: string): Promise<Uint8Array> {
  const compressed = await loadAsset(assetBaseUrl, JAVA_COMPILER_ASSET_PATH, JAVA_COMPILER_COMPRESSED_PACKAGE_SHA256);
  const body = new Response(compressed as unknown as BodyInit).body;
  if (!body) throw new Error("The Java compiler package has no response body.");
  const expanded = new Uint8Array(await new Response(body.pipeThrough(new DecompressionStream("gzip"))).arrayBuffer());
  await verifyDigest("Java compiler WebC", expanded, JAVA_COMPILER_PACKAGE_SHA256);
  return expanded;
}

async function loadAsset(assetBaseUrl: string, assetPath: string, expected: string): Promise<Uint8Array> {
  const baseUrl = new URL(assetBaseUrl, workerBaseUrl);
  if (!baseUrl.pathname.endsWith("/")) baseUrl.pathname += "/";
  const response = await fetch(contentAddressedToolchainAssetUrl(assetPath, baseUrl));
  if (!response.ok) throw new Error(`Unable to load pinned Java asset '${assetPath}' (${response.status}).`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  await verifyDigest(assetPath, bytes, expected);
  return bytes;
}

async function verifyDigest(label: string, bytes: Uint8Array, expected: string): Promise<void> {
  const actual = await sha256Hex(bytes);
  if (actual !== expected) throw new Error(`Pinned Java asset '${label}' has digest ${actual}; expected ${expected}.`);
}
