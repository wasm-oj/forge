import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { gunzipSync } from "node:zlib";
import {
  GO_ARCHIVE_PATH,
  GO_OUTPUT_PATH,
  GO_TOOLCHAIN,
  decodeGoStandardLibrary,
  decodeGoToolchainManifest,
  deterministicGoCompilerEnvironment,
  goCompileArguments,
  goImportConfig,
  goLinkArguments,
} from "../compiler/go-toolchain.ts";

const COMPILER_MEMORY_LIMIT_BYTES = 512 * 1024 * 1024;
const COMPILER_OUTPUT_LIMIT_BYTES = 32 * 1024 * 1024;
const COMPILER_RESPONSE_LIMIT_BYTES = 256 * 1024 * 1024;

let temporaryDirectory;
try {
  const encoded = JSON.parse(await readStdin());
  const [packageBytes, manifest, standardLibrary] = await Promise.all([
    loadGoPackage(encoded.toolchainDirectory),
    loadGoManifest(encoded.toolchainDirectory),
    loadGoStandardLibrary(encoded.toolchainDirectory),
  ]);
  temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "forge-go-toolchain-"));
  const packagePath = path.join(temporaryDirectory, "go.webc");
  await writeFile(packagePath, packageBytes, { flag: "wx", mode: 0o600 });

  const sourceFiles = Object.fromEntries(encoded.request.files.map((file) => [
    `/work/${file.path}`,
    file.content,
  ]));
  const sharedFilesBase64 = Object.fromEntries(Object.entries({
    ...decodeGoStandardLibrary(standardLibrary, manifest.packages),
    ...sourceFiles,
    "/work/importcfg": goImportConfig(manifest.packages, false),
    "/work/importcfg.link": goImportConfig(manifest.packages, true),
  }).map(([guestPath, contents]) => [
    guestPath,
    Buffer.from(contents).toString("base64"),
  ]));
  const common = {
    env: deterministicGoCompilerEnvironment(),
    stdinBase64: "",
    filesBase64: {},
    cwd: "/work",
    outputLimitBytes: COMPILER_OUTPUT_LIMIT_BYTES,
  };
  const pipeline = await runCompiler(encoded.compilerExecutable, {
    schema: encoded.compileBatchSchema,
    packagePath,
    memoryLimitBytes: COMPILER_MEMORY_LIMIT_BYTES,
    sharedFilesBase64,
    requests: [
      {
        ...common,
        command: "go-compile",
        args: goCompileArguments(encoded.request.files, encoded.request.optimization),
        outputPaths: [GO_ARCHIVE_PATH],
      },
      {
        ...common,
        command: "go-link",
        args: goLinkArguments(encoded.request.optimization),
        outputPaths: [GO_OUTPUT_PATH],
      },
    ],
  });
  const results = pipeline.responses.flatMap((response) => response.result ? [response.result] : []);
  const stdout = results.map((result) => Buffer.from(result.stdoutBase64, "base64").toString("utf8")).join("");
  const stderr = results.map((result) => Buffer.from(result.stderrBase64, "base64").toString("utf8")).join("");
  const linked = results.at(1);
  const wasmBase64 = linked?.code === 0 ? linked.outputFilesBase64?.[GO_OUTPUT_PATH] : undefined;
  writeResult({
    success: results.length === 2 && results.every((result) => result.code === 0) && typeof wasmBase64 === "string",
    wasmBase64,
    stdout,
    stderr,
  });
} catch (error) {
  writeResult(undefined, error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
} finally {
  if (temporaryDirectory) await rm(temporaryDirectory, { recursive: true, force: true });
}

function runCompiler(executable, request) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, [], { stdio: ["pipe", "pipe", "pipe"] });
    const stdout = [];
    const stderr = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let failure;
    const fail = (error) => {
      failure ??= error;
      child.kill("SIGKILL");
    };
    child.stdout.on("data", (chunk) => {
      stdoutBytes += chunk.byteLength;
      if (stdoutBytes > COMPILER_RESPONSE_LIMIT_BYTES) {
        fail(new Error(`Forge compiler response exceeded ${COMPILER_RESPONSE_LIMIT_BYTES} bytes.`));
      } else stdout.push(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderrBytes += chunk.byteLength;
      if (stderrBytes > COMPILER_OUTPUT_LIMIT_BYTES) {
        fail(new Error(`Forge compiler diagnostics exceeded ${COMPILER_OUTPUT_LIMIT_BYTES} bytes.`));
      } else stderr.push(chunk);
    });
    child.on("error", fail);
    child.stdin.on("error", fail);
    child.on("close", () => {
      if (failure) {
        reject(failure);
        return;
      }
      try {
        const text = Buffer.concat(stdout).toString("utf8");
        if (!text) throw new Error(Buffer.concat(stderr).toString("utf8") || "Forge compiler returned no response.");
        resolve(JSON.parse(text));
      } catch (error) {
        reject(error);
      }
    });
    child.stdin.end(JSON.stringify(request));
  });
}

function writeResult(result, error) {
  const response = result ? { ok: true, result } : { ok: false, error };
  writeFileSync(3, JSON.stringify(response));
}

async function loadGoPackage(toolchainDirectory) {
  const filename = path.basename(GO_TOOLCHAIN.packageAsset);
  const compressed = await readFile(path.join(toolchainDirectory, filename));
  verifyDigest(filename, compressed, GO_TOOLCHAIN.packageCompressedSha256);
  const bytes = new Uint8Array(gunzipSync(compressed));
  verifyDigest("decompressed Go WebC", bytes, GO_TOOLCHAIN.packageSha256);
  return bytes;
}

async function loadGoManifest(toolchainDirectory) {
  const filename = path.basename(GO_TOOLCHAIN.manifestAsset);
  const bytes = new Uint8Array(await readFile(path.join(toolchainDirectory, filename)));
  verifyDigest(filename, bytes, GO_TOOLCHAIN.manifestSha256);
  return decodeGoToolchainManifest(bytes);
}

async function loadGoStandardLibrary(toolchainDirectory) {
  const filename = path.basename(GO_TOOLCHAIN.standardLibraryAsset);
  const compressed = await readFile(path.join(toolchainDirectory, filename));
  verifyDigest(filename, compressed, GO_TOOLCHAIN.standardLibraryCompressedSha256);
  const bytes = new Uint8Array(gunzipSync(compressed));
  verifyDigest("decompressed Go standard library", bytes, GO_TOOLCHAIN.standardLibrarySha256);
  return bytes;
}

function verifyDigest(label, bytes, expected) {
  const actual = createHash("sha256").update(bytes).digest("hex");
  if (actual !== expected) {
    throw new Error(`Pinned Go toolchain asset '${label}' has digest ${actual}; expected ${expected}.`);
  }
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}
