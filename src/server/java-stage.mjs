import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import { Directory, init, Runtime, Wasmer } from "@wasmer/sdk/node";
import {
  JAVA_COMPILER_ASSET_PATH,
  JAVA_COMPILER_COMPRESSED_PACKAGE_SHA256,
  JAVA_COMPILER_PACKAGE_SHA256,
  JAVA_COMPILE_CLASSLIB_ASSET_PATH,
  JAVA_COMPILE_CLASSLIB_SHA256,
  JAVA_RUNTIME_CLASSLIB_ASSET_PATH,
  JAVA_RUNTIME_CLASSLIB_SHA256,
} from "../core/toolchains.ts";
import { JAVA_COMPILE_TIMEOUT_MS, javaMainClass, parseJavaDiagnostics } from "../compiler/java-toolchain.ts";

let runtime;
let packageHandle;
let project;
let toolchain;
let exitCode = 0;

try {
  const encoded = JSON.parse(await readStdin());
  if (encoded.request?.entry === undefined) throw new Error("The Java compiler stage received no entry file.");
  await init({ log: "error" });
  runtime = new Runtime({ registry: null });
  const compilerBytes = await loadCompiler(requiredToolchainAsset(encoded, JAVA_COMPILER_ASSET_PATH), encoded.verifiedToolchain === true);
  packageHandle = await Wasmer.fromFile(compilerBytes, runtime);
  const command = packageHandle.commands["java-compiler"];
  if (!command) throw new Error("The pinned Java compiler package does not expose java-compiler.");
  project = new Directory(Object.fromEntries(encoded.request.files.map((file) => [`/${file.path}`, file.content])));
  await project.createDir("/build");
  toolchain = new Directory({
    "/compile-classlib-teavm.bin": await loadRaw(requiredToolchainAsset(encoded, JAVA_COMPILE_CLASSLIB_ASSET_PATH), JAVA_COMPILE_CLASSLIB_SHA256, encoded.verifiedToolchain === true),
    "/runtime-classlib-teavm.bin": await loadRaw(requiredToolchainAsset(encoded, JAVA_RUNTIME_CLASSLIB_ASSET_PATH), JAVA_RUNTIME_CLASSLIB_SHA256, encoded.verifiedToolchain === true),
  });
  const entrySource = encoded.request.files.find((file) => file.path === encoded.request.entry);
  if (!entrySource) throw new Error(`Java entry '${encoded.request.entry}' does not exist.`);
  const instance = await command.run({
    args: [
      "/toolchain/compile-classlib-teavm.bin",
      "/toolchain/runtime-classlib-teavm.bin",
      javaMainClass(encoded.request.entry, entrySource.content),
      "/project/build/app.wasm",
      ...encoded.request.files.filter((file) => file.path.endsWith(".java")).map((file) => `/project/${file.path}`),
    ],
    mount: { "/project": project, "/toolchain": toolchain },
  });
  const output = await withTimeout(instance.wait(), JAVA_COMPILE_TIMEOUT_MS);
  const diagnostics = parseJavaDiagnostics(`${output.stderr}\n${output.stdout}`, encoded.request.entry);
  let wasmBase64;
  if (output.ok) {
    const wasm = await project.readFile("/build/app.wasm");
    await WebAssembly.compile(wasm);
    wasmBase64 = Buffer.from(wasm).toString("base64");
  }
  writeResult({
    success: output.ok && typeof wasmBase64 === "string",
    wasmBase64,
    stdout: output.stdout,
    stderr: output.stderr,
    diagnostics,
  });
} catch (error) {
  writeResult(undefined, error instanceof Error ? error.message : String(error));
  exitCode = 1;
} finally {
  toolchain?.free();
  project?.free();
  packageHandle?.free();
  runtime?.free();
  setTimeout(() => process.exit(exitCode), 10);
}

async function loadCompiler(file, verified) {
  const compressed = await readFile(file);
  if (!verified) verifyDigest(file, compressed, JAVA_COMPILER_COMPRESSED_PACKAGE_SHA256);
  const bytes = new Uint8Array(gunzipSync(compressed));
  if (!verified) verifyDigest(file, bytes, JAVA_COMPILER_PACKAGE_SHA256);
  return bytes;
}

async function loadRaw(file, expected, verified) {
  const bytes = new Uint8Array(await readFile(file));
  if (!verified) verifyDigest(file, bytes, expected);
  return bytes;
}

function requiredToolchainAsset(encoded, assetPath) {
  const file = encoded?.toolchainAssets?.[assetPath];
  if (typeof file !== "string" || !path.isAbsolute(file)) {
    throw new Error(`The Java compiler stage did not receive absolute asset '${assetPath}'.`);
  }
  return file;
}

function verifyDigest(label, bytes, expected) {
  const actual = createHash("sha256").update(bytes).digest("hex");
  if (actual !== expected) throw new Error(`Pinned Java asset '${label}' has digest ${actual}; expected ${expected}.`);
}

function withTimeout(promise, timeoutMs) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Java compilation exceeded ${timeoutMs} ms.`)), timeoutMs);
    }),
  ]).finally(() => clearTimeout(timer));
}

function writeResult(result, error) {
  writeFileSync(3, JSON.stringify(result ? { ok: true, result } : { ok: false, error }));
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}
