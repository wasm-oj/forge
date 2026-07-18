import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import { Directory, init, Runtime, Wasmer } from "@wasmer/sdk/node";
import {
  RUST_FINAL_OUTPUT_PATH,
  RUST_LINKER_COMMAND,
  RUST_OBJECT_PATH,
  instantiateRustLinkerArguments,
} from "../compiler/rust-linker.ts";
import { isLlvmBitcode, selectRustAllocatorBitcodeName } from "../compiler/rust-allocator-bitcode.ts";
import {
  RUST_COMPILE_TIMEOUT_MS,
  RUST_TOOLCHAIN,
  decodeRustToolchainManifest,
  deterministicRustCompilerEnvironment,
  deterministicRustLinkerEnvironment,
  rustcObjectArguments,
} from "../compiler/rust-toolchain.ts";
import { MountedOutputStabilityObserver } from "../runtime/mounted-output-stability.ts";

const OUTPUT_QUIET_PERIOD_MS = 50;
let runtime;
let pkg;
let rustc;
let linker;
let work;
let exitCode = 0;

try {
  const encoded = JSON.parse(await readStdin());
  await init({ log: "warn" });
  runtime = new Runtime({ registry: null });
  const [packageBytes, manifest] = await Promise.all([
    loadRustPackage(encoded.toolchainDirectory),
    loadRustManifest(encoded.toolchainDirectory),
  ]);
  pkg = await Wasmer.fromFile(packageBytes, runtime);
  rustc = pkg.commands.rustc;
  if (!rustc) throw new Error("The pinned Rust WebC does not expose its rustc command.");
  linker = pkg.commands[RUST_LINKER_COMMAND];
  if (!linker) throw new Error(`The pinned Rust WebC does not expose its ${RUST_LINKER_COMMAND} command.`);

  work = new Directory(Object.fromEntries(
    encoded.request.files.map((file) => [`/${file.path}`, file.content]),
  ));
  await work.createDir("/build");
  const compiled = await runObservedStage({
    command: rustc,
    args: rustcObjectArguments(encoded.request.entry, encoded.request.optimization),
    env: deterministicRustCompilerEnvironment(),
    work,
    outputPath: RUST_OBJECT_PATH,
    stage: "rustc",
    hasTerminalError: (stderr) => parseRustDiagnostics(stderr, encoded.request.entry)
      .some((diagnostic) => diagnostic.severity === "error"),
    requiresAllocatorBitcode: true,
  });
  const diagnostics = parseRustDiagnostics(compiled.stderr, encoded.request.entry);
  if (!compiled.success) {
    writeResult({
      success: false,
      stdout: compiled.stdout,
      stderr: compiled.stderr,
      diagnostics,
    });
  } else {
    const linked = await runObservedStage({
      command: linker,
      args: instantiateRustLinkerArguments(
        manifest.linkerArguments,
        encoded.request.optimization,
        requireAllocatorBitcodePath(compiled),
      ),
      env: deterministicRustLinkerEnvironment(),
      work,
      outputPath: RUST_FINAL_OUTPUT_PATH,
      stage: "wasm-ld",
      hasTerminalError: (stderr) => /(?:wasm-ld|lld): error:/i.test(stderr),
    });
    writeResult({
      success: linked.success && Boolean(linked.bytes),
      wasmBase64: linked.bytes ? Buffer.from(linked.bytes).toString("base64") : undefined,
      stdout: `${compiled.stdout}${linked.stdout}`,
      stderr: `${compiled.stderr}${linked.stderr}`,
      diagnostics,
    });
  }
} catch (error) {
  writeFileSync(3, JSON.stringify({
    ok: false,
    error: error instanceof Error ? error.message : String(error),
  }));
  exitCode = 1;
} finally {
  work?.free();
  rustc?.free();
  linker?.free();
  pkg?.free();
  runtime?.free();
  setTimeout(() => process.exit(exitCode), 10);
}

function writeResult(result) {
  writeFileSync(3, JSON.stringify({ ok: true, result }));
}

async function runObservedStage({
  command,
  args,
  env,
  work,
  outputPath,
  stage,
  hasTerminalError,
  requiresAllocatorBitcode = false,
}) {
  const instance = await command.run({ args, env, mount: { "/work": work }, cwd: "/work" });
  const stdout = captureReadable(instance.stdout);
  const stderr = captureReadable(instance.stderr);
  const outputStability = new MountedOutputStabilityObserver();
  let allocatorStability = new MountedOutputStabilityObserver();
  let allocatorCandidatePath;
  const deadline = performance.now() + RUST_COMPILE_TIMEOUT_MS;
  try {
    while (performance.now() < deadline) {
      const stderrText = stderr.text();
      const quiet = stdout.quietFor(OUTPUT_QUIET_PERIOD_MS) && stderr.quietFor(OUTPUT_QUIET_PERIOD_MS);
      const observedAt = performance.now();
      const bytes = outputStability.observe(await readValidWasm(work, outputPath), observedAt);
      const allocator = requiresAllocatorBitcode ? await readRustAllocatorBitcode(work) : undefined;
      if (allocator?.path !== allocatorCandidatePath) {
        allocatorCandidatePath = allocator?.path;
        allocatorStability = new MountedOutputStabilityObserver();
      }
      const allocatorBytes = requiresAllocatorBitcode
        ? allocatorStability.observe(allocator?.bytes, observedAt)
        : undefined;
      const allocatorReady = !requiresAllocatorBitcode || Boolean(allocatorBytes && allocatorCandidatePath);
      if (bytes && allocatorReady && quiet) {
        await new Promise((resolve) => setTimeout(resolve, 0));
        return {
          success: true,
          bytes,
          allocatorBitcodePath: allocatorCandidatePath,
          stdout: stdout.text(),
          stderr: stderr.text(),
        };
      }
      if (quiet && hasTerminalError(stderrText)) {
        return { success: false, stdout: stdout.text(), stderr: stderrText };
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error(`${stage} exceeded ${RUST_COMPILE_TIMEOUT_MS} ms.`);
  } finally {
    await Promise.all([stdout.cancel(), stderr.cancel()]);
    instance.free();
  }
}

function requireAllocatorBitcodePath(observation) {
  if (!observation.allocatorBitcodePath) {
    throw new Error("rustc completed without its allocator bitcode module.");
  }
  return observation.allocatorBitcodePath;
}

function captureReadable(stream) {
  const reader = stream.getReader();
  const chunks = [];
  let lastUpdate = performance.now();
  void (async () => {
    try {
      while (true) {
        const result = await reader.read();
        if (result.done) return;
        const bytes = result.value instanceof Uint8Array
          ? result.value
          : new Uint8Array(result.value);
        chunks.push(bytes.slice());
        lastUpdate = performance.now();
      }
    } catch {
      // Cancellation is expected once the complete mounted output is observed.
    }
  })();
  return {
    text: () => new TextDecoder().decode(concatenate(chunks)),
    quietFor: (milliseconds) => performance.now() - lastUpdate >= milliseconds,
    cancel: async () => {
      try {
        await reader.cancel();
      } catch {
        // The guest may close the stream concurrently with mounted-output observation.
      }
    },
  };
}

function concatenate(chunks) {
  const output = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.byteLength, 0));
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

async function readValidWasm(work, guestPath) {
  const mountRelativePath = guestPath.startsWith("/work/") ? guestPath.slice("/work".length) : guestPath;
  try {
    const bytes = (await work.readFile(mountRelativePath)).slice();
    return bytes.byteLength > 8 && WebAssembly.validate(bytes) ? bytes : undefined;
  } catch {
    return undefined;
  }
}

async function readRustAllocatorBitcode(work) {
  try {
    const name = selectRustAllocatorBitcodeName((await work.readDir("/build")).map((entry) => entry.name));
    if (!name) return undefined;
    const bytes = (await work.readFile(`/build/${name}`)).slice();
    return isLlvmBitcode(bytes) ? { path: `/work/build/${name}`, bytes } : undefined;
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("rustc emitted multiple")) throw error;
    return undefined;
  }
}

async function loadRustPackage(toolchainDirectory) {
  const filename = path.basename(RUST_TOOLCHAIN.packageAsset);
  const compressed = await readFile(path.join(toolchainDirectory, filename));
  verifyDigest(filename, compressed, RUST_TOOLCHAIN.packageCompressedSha256);
  const bytes = new Uint8Array(gunzipSync(compressed));
  verifyDigest("decompressed Rust WebC", bytes, RUST_TOOLCHAIN.packageSha256);
  return bytes;
}

async function loadRustManifest(toolchainDirectory) {
  const filename = path.basename(RUST_TOOLCHAIN.manifestAsset);
  const bytes = new Uint8Array(await readFile(path.join(toolchainDirectory, filename)));
  verifyDigest(filename, bytes, RUST_TOOLCHAIN.manifestSha256);
  return decodeRustToolchainManifest(bytes);
}

function verifyDigest(filename, bytes, expected) {
  const actual = createHash("sha256").update(bytes).digest("hex");
  if (actual !== expected) {
    throw new Error(`Pinned Rust toolchain asset '${filename}' has digest ${actual}; expected ${expected}.`);
  }
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

function parseRustDiagnostics(output, entry) {
  const diagnostics = [];
  for (const line of output.split(/\r?\n/)) {
    if (!line.startsWith("{")) continue;
    let value;
    try { value = JSON.parse(line); } catch { continue; }
    if (value?.$message_type !== "diagnostic" || typeof value.message !== "string") continue;
    const spans = Array.isArray(value.spans) ? value.spans : [];
    const location = spans.find((span) => span?.is_primary) ?? spans[0];
    diagnostics.push({
      severity: value.level === "warning" ? "warning" : value.level === "note" ? "info" : "error",
      message: value.message,
      file: String(location?.file_name ?? entry).replace(/^\/work\//, ""),
      line: Number(location?.line_start ?? 1),
      column: Number(location?.column_start ?? 1),
      endLine: location?.line_end,
      endColumn: location?.column_end,
      source: "rustc",
      code: value.code?.code,
    });
  }
  return diagnostics;
}
