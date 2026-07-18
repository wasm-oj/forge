/// <reference lib="webworker" />

import { Directory, Runtime, Wasmer, init } from "@wasmer/sdk";
import wasmerWasmUrl from "@wasmer/sdk/wasm?url";
import {
  PYTHON_COMPILE_TIMEOUT_MS,
  type PythonFrontendResult,
  type PythonStageRequest,
  type PythonStageResponse,
} from "../compiler/python-toolchain";
import { parsePythonDiagnostics } from "../core/diagnostics";
import { sha256Hex } from "../core/hash";
import {
  contentAddressedToolchainAssetUrl,
  PYTHON_COMPRESSED_PACKAGE_SHA256,
  PYTHON_PACKAGE,
  PYTHON_PACKAGE_ASSET_PATH,
  PYTHON_PACKAGE_SHA256,
} from "../core/toolchains";
import { moduleWorkerBaseUrl } from "./module-worker";
import wasmerThreadWorkerUrl from "./wasmer-thread.worker?worker&url";

const scope: DedicatedWorkerGlobalScope = self as unknown as DedicatedWorkerGlobalScope;
const workerBaseUrl = moduleWorkerBaseUrl();

scope.addEventListener("message", (event: MessageEvent<PythonStageRequest>) => {
  void compile(event.data).then(
    (result) => {
      scope.postMessage(
        { type: "result", result } satisfies PythonStageResponse,
        Object.values(result.bytecode).map((value) => value.buffer),
      );
      scope.close();
    },
    (error) => {
      const caught = error instanceof Error ? error : new Error(String(error));
      scope.postMessage({ type: "error", message: caught.message, stack: caught.stack } satisfies PythonStageResponse);
      scope.close();
    },
  );
});

async function compile(message: PythonStageRequest): Promise<PythonFrontendResult> {
  if (message.type !== "compile") throw new Error("The Python stage received an invalid request.");
  await init({
    log: "warn",
    module: new URL(wasmerWasmUrl, workerBaseUrl),
    workerUrl: new URL(wasmerThreadWorkerUrl, workerBaseUrl),
  });
  const runtime = new Runtime({ registry: null });
  const packageBytes = await loadPythonPackage(message.assetBaseUrl);
  const pkg = await Wasmer.fromFile(packageBytes, runtime);
  const command = pkg.commands.python;
  if (!command) throw new Error(`Package '${PYTHON_PACKAGE}' does not expose python.`);
  const request = message.request;
  const pythonFiles = request.files.filter((file) => file.path.endsWith(".py"));
  const project = new Directory(Object.fromEntries(request.files.map((file) => [`/${file.path}`, file.content])));
  await project.createDir("/build");
  const instance = await command.run({
    args: ["-c", compileScript(pythonFiles.map((file) => file.path))],
    cwd: "/project",
    env: {
      PYTHONHOME: "/usr/local",
      PYTHONHASHSEED: "0",
      PYTHONDONTWRITEBYTECODE: "1",
    },
    mount: { "/project": project },
  });
  void instance;
  const completion = await waitForCompletion(project);
  const bytecode: Record<string, Uint8Array> = {};
  if (completion.success) {
    for (const file of pythonFiles) {
      const compiledPath = `build/${file.path.replace(/\.py$/, ".pyc")}`;
      const compiled = await project.readFile(`/${compiledPath}`);
      if (compiled.byteLength <= 16) throw new Error(`Python produced an incomplete '${compiledPath}'.`);
      bytecode[compiledPath] = compiled;
    }
  }
  return {
    success: completion.success,
    bytecode,
    stdout: "",
    stderr: completion.stderr,
    diagnostics: parsePythonDiagnostics(completion.stderr),
  };
}

async function loadPythonPackage(assetBaseUrl: string): Promise<Uint8Array> {
  const baseUrl = new URL(assetBaseUrl, workerBaseUrl);
  if (!baseUrl.pathname.endsWith("/")) baseUrl.pathname += "/";
  const filename = PYTHON_PACKAGE_ASSET_PATH.slice(PYTHON_PACKAGE_ASSET_PATH.lastIndexOf("/") + 1);
  const response = await fetch(contentAddressedToolchainAssetUrl(PYTHON_PACKAGE_ASSET_PATH, baseUrl));
  if (!response.ok) {
    throw new Error(`Unable to load pinned Python package '${filename}' (${response.status}).`);
  }
  const compressed = new Uint8Array(await response.arrayBuffer());
  await verifyDigest(filename, compressed, PYTHON_COMPRESSED_PACKAGE_SHA256);
  const body = new Response(compressed).body;
  if (!body) throw new Error(`Pinned Python package '${filename}' has no response body.`);
  const decompressed = body.pipeThrough(new DecompressionStream("gzip"));
  const bytes = new Uint8Array(await new Response(decompressed).arrayBuffer());
  await verifyDigest(filename, bytes, PYTHON_PACKAGE_SHA256);
  return bytes;
}

async function verifyDigest(filename: string, bytes: Uint8Array, expected: string): Promise<void> {
  const actual = await sha256Hex(bytes);
  if (actual !== expected) {
    throw new Error(`Pinned Python package '${filename}' has digest ${actual}; expected ${expected}.`);
  }
}

function compileScript(files: readonly string[]): string {
  return [
    "import json, pathlib, py_compile",
    `files = ${JSON.stringify(files)}`,
    "completion = pathlib.Path('/project/build/.forge-python-complete.json')",
    "try:",
    "    for name in files:",
    "        output = pathlib.Path('/project/build') / pathlib.Path(name).with_suffix('.pyc')",
    "        output.parent.mkdir(parents=True, exist_ok=True)",
    "        py_compile.compile('/project/' + name, cfile=str(output), doraise=True, invalidation_mode=py_compile.PycInvalidationMode.CHECKED_HASH)",
    "except py_compile.PyCompileError as error:",
    "    result = {'success': False, 'stderr': str(error)}",
    "else:",
    "    result = {'success': True, 'stderr': ''}",
    "completion.write_text(json.dumps(result, separators=(',', ':')), encoding='utf-8')",
  ].join("\n");
}

interface PythonCompletion {
  success: boolean;
  stderr: string;
}

async function waitForCompletion(project: Directory): Promise<PythonCompletion> {
  const deadline = performance.now() + PYTHON_COMPILE_TIMEOUT_MS;
  const decoder = new TextDecoder("utf-8", { fatal: true });
  while (performance.now() < deadline) {
    try {
      const bytes = await project.readFile("/build/.forge-python-complete.json");
      const parsed = JSON.parse(decoder.decode(bytes)) as Partial<PythonCompletion>;
      if (typeof parsed.success === "boolean" && typeof parsed.stderr === "string") {
        return { success: parsed.success, stderr: parsed.stderr };
      }
    } catch {
      // The marker becomes visible only after every bytecode output is complete.
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Python compilation exceeded ${PYTHON_COMPILE_TIMEOUT_MS} ms.`);
}
