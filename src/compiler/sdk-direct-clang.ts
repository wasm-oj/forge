import {
  Directory,
  Runtime,
  Wasmer,
  type Command,
} from "@wasmer/sdk";
import { FORGE_CONTRACT_VERSION } from "../core/contract.ts";
import {
  decodeClangPins,
  instantiateClangCc1,
  instantiateClangLink,
  instantiateClangPch,
  type ClangPins,
} from "./clang-pins.ts";
import { ClangObjectCache, parseClangDependencyFile } from "./clang-object-cache.ts";
import { costProfileId } from "../core/cost-profile.ts";
import { ensureFailureDiagnostic, parseClangDiagnostics } from "../core/diagnostics.ts";
import {
  CLANG_CC1_PINS_ASSET_PATH,
  CLANG_PACKAGE_ASSET_PATH,
  CLANG_PACKAGE_SHA256,
  toolchainPackageIdentities,
} from "../core/toolchains.ts";
import { sha256Hex } from "../core/hash.ts";
import type { BuildGraphInput } from "./incremental-build-graph.ts";
import type { IncrementalBuildGraphArchive } from "./incremental-build-graph.ts";
import type {
  BuildResult,
  CompilerTraceEvent,
  CompilerTraceOperation,
  Diagnostic,
  Project,
  WasmArtifact,
  WorkerPhase,
} from "../core/types.ts";
import {
  DETERMINISTIC_NATIVE_RUNTIME,
  DETERMINISTIC_NATIVE_SOURCE_PATH,
} from "../runtime/determinism.ts";
import { MountedOutputStabilityObserver } from "../runtime/mounted-output-stability.ts";

export interface SdkDirectClangHost {
  runtime: Runtime;
  loadToolchainAsset(path: string): Promise<Uint8Array>;
  loadToolchainFile(path: string): Promise<Uint8Array>;
  progress(requestId: string, phase: WorkerPhase, label: string, value?: number): void;
  trace(requestId: string, operation: CompilerTraceOperation, state: CompilerTraceEvent["state"]): void;
}

interface LoadedToolchain {
  pkg: Wasmer;
  pins: ClangPins;
  compiler: Command;
  linker: Command;
}

let loadedToolchain: Promise<LoadedToolchain> | undefined;
const objectCache = new ClangObjectCache(64 * 1024 * 1024);
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const STAGE_OUTPUT_TIMEOUT_MS = 55_000;

interface ClangStageResult {
  diagnostics: Diagnostic[];
  object?: Uint8Array;
  dependency?: Uint8Array;
  stdout: string;
  stderr: string;
}

interface ClangPchStageResult {
  diagnostics: Diagnostic[];
  pch?: Uint8Array;
  dependency?: Uint8Array;
  stdout: string;
  stderr: string;
}

interface StageObservation<T> {
  value: T;
  stdout: string;
  stderr: string;
}

/**
 * Browser compiler that drives the pinned cc1 and wasm-ld jobs through
 * the official SDK threadpool while keeping every command and project volume
 * isolated. No Clang driver or guest subprocess is involved.
 */
export async function buildClangWithSdkDirect(
  project: Project,
  cacheKey: string,
  requestId: string,
  host: SdkDirectClangHost,
): Promise<BuildResult> {
  if (project.config.target !== "wasip1" && project.config.target !== "wasix") {
    throw new Error("The output-ready Clang compiler accepts only wasip1 or wasix targets.");
  }
  if (project.config.language !== "c" && project.config.language !== "cpp") {
    throw new Error("The output-ready Clang compiler accepts only C and C++ projects.");
  }

  const started = performance.now();
  host.progress(requestId, "loading-toolchain", "Loading pinned Clang 22 toolchain", 0.15);
  const { pins, compiler, linker } = await ensureToolchain(requestId, host);
  const configKey = `${project.config.language}-${project.config.optimization}`;
  const config = pins.configs[configKey];
  if (!config) throw new Error(`The pinned Clang manifest has no '${configKey}' configuration.`);
  host.trace(requestId, "filesystemPrepare", "start");
  const projectFiles = new Map<string, Uint8Array>(
    project.files.map((file) => [file.path, encoder.encode(file.content)]),
  );
  projectFiles.set(DETERMINISTIC_NATIVE_SOURCE_PATH, encoder.encode(DETERMINISTIC_NATIVE_RUNTIME));
  const directory = new Directory(Object.fromEntries(
    [...projectFiles].map(([path, bytes]) => [`/${path}`, bytes]),
  ));
  try {
    await ensureDirectory(directory, "/build");
    await ensureDirectory(directory, "/.forge");
    host.trace(requestId, "filesystemPrepare", "end");

  const isCpp = project.config.language === "cpp";
  const extensions = isCpp ? /\.(?:cc|cpp|cxx)$/ : /\.c$/;
  const sources = project.files.filter((file) => extensions.test(file.path)).map((file) => file.path);
  if (!sources.includes(project.config.entry)) sources.unshift(project.config.entry);
  const units = [...sources, DETERMINISTIC_NATIVE_SOURCE_PATH];
  let stdout = "";
  let stderr = "";
  const objectPaths: string[] = [];
  const objectInputs: BuildGraphInput[] = [];
  let objectCacheHits = 0;
  let objectCacheStores = 0;
  let pchHits = 0;
  let pchMisses = 0;
  let pchStores = 0;
  let linkHits = 0;
  let linkMisses = 0;
  let linkStores = 0;
  const structuredDiagnostics: Diagnostic[] = [];

  const pchHeader = isCpp ? findPrecompiledHeader(project) : undefined;
  const pchPath = "/project/build/forge.pch";
  let pchInput: BuildGraphInput | undefined;
  if (pchHeader) {
    const headerBytes = projectFiles.get(pchHeader)!;
    const baseKey = await objectCache.unitManifestKey(pins, configKey, pchHeader, headerBytes);
    const pchManifestKey = await sha256Hex(JSON.stringify({ baseKey, mode: "c++-header" }));
    let pch = await objectCache.lookupPch(pchManifestKey, projectFiles);
    if (pch) {
      pchHits += 1;
      await directory.writeFile(pchPath.slice("/project".length), pch);
    } else {
      pchMisses += 1;
      const dependencyPath = "/project/build/forge.pch.d";
      const args = instantiateClangPch(config.cc1, pins.placeholders, pchHeader, pchPath);
      args.push("-dependency-file", dependencyPath, "-MT", pchPath);
      const output = await runPchStage(
        compiler,
        args,
        directory,
        host,
        requestId,
        pchPath,
        dependencyPath,
      );
      structuredDiagnostics.push(...output.diagnostics);
      stdout += output.stdout;
      stderr += output.stderr;
      if (!output.pch || !output.dependency) {
        return failedBuild(project, stdout, stderr, 1, "clang", structuredDiagnostics);
      }
      pch = output.pch;
      if (await objectCache.storePch(
        pchManifestKey,
        parseClangDependencyFile(output.dependency),
        projectFiles,
        pch,
      )) pchStores += 1;
    }
    pchInput = { kind: "pch", identity: `pch:${pchHeader}`, bytes: pch };
  }

  host.progress(requestId, "compiling", `Compiling ${units.length} translation units with SDK-direct cc1`, 0.35);
  host.trace(requestId, "commandStart", "start");
  host.trace(requestId, "commandStart", "end");
  host.trace(requestId, "commandWait", "start");
  host.trace(requestId, "projectCompile", "start");
  for (const [index, source] of units.entries()) {
    if (source === DETERMINISTIC_NATIVE_SOURCE_PATH) {
      host.trace(requestId, "projectCompile", "end");
      host.trace(requestId, "runtimeShimCompile", "start");
    }
    const objectPath = `/project/build/${String(index).padStart(4, "0")}.o`;
    const dependencyPath = `/project/build/${String(index).padStart(4, "0")}.d`;
    const sourceBytes = projectFiles.get(source);
    if (!sourceBytes) throw new Error(`SDK-direct Clang is missing source bytes for '${source}'.`);
    const baseManifestKey = await objectCache.unitManifestKey(pins, configKey, source, sourceBytes);
    const unitPchInput = source !== DETERMINISTIC_NATIVE_SOURCE_PATH ? pchInput : undefined;
    const manifestKey = unitPchInput
      ? await sha256Hex(JSON.stringify({ baseManifestKey, pch: await sha256Hex(unitPchInput.bytes!) }))
      : baseManifestKey;
    const additionalInputs = unitPchInput ? [unitPchInput] : [];
    const cached = await objectCache.lookup(manifestKey, projectFiles, additionalInputs);
    if (cached) {
      await directory.writeFile(objectPath.slice("/project".length), cached);
      objectCacheHits += 1;
      objectPaths.push(objectPath);
      objectInputs.push({ kind: "object", identity: source, bytes: cached });
      continue;
    }
    const args = instantiateClangCc1(config.cc1, pins.placeholders, source, objectPath);
    if (unitPchInput) args.splice(args.length - 1, 0, "-include-pch", pchPath);
    args.push("-dependency-file", dependencyPath, "-MT", objectPath);
    const output = await runClangStage(
      compiler,
      args,
      directory,
      host,
      requestId,
      source === DETERMINISTIC_NATIVE_SOURCE_PATH ? "runtimeShimSpawn" : "projectSpawn",
      source === DETERMINISTIC_NATIVE_SOURCE_PATH ? "runtimeShimWait" : "projectWait",
      source === DETERMINISTIC_NATIVE_SOURCE_PATH ? "runtimeShimOutputReady" : "projectOutputReady",
      objectPath,
      dependencyPath,
    );
    structuredDiagnostics.push(...output.diagnostics);
    stdout += output.stdout;
    stderr += output.stderr;
    if (!output.object || !output.dependency) {
      host.trace(
        requestId,
        source === DETERMINISTIC_NATIVE_SOURCE_PATH ? "runtimeShimCompile" : "projectCompile",
        "end",
      );
      host.trace(requestId, "commandWait", "end");
      return failedBuild(project, stdout, stderr, 1, "clang", structuredDiagnostics);
    }
    // A cached unit cannot recreate compiler warnings without rerunning cc1.
    // Cache only diagnostically clean output so cache hits preserve BuildResult.
    if (output.diagnostics.length === 0 && await objectCache.store(
      manifestKey,
      parseClangDependencyFile(output.dependency),
      projectFiles,
      output.object,
      additionalInputs,
    )) {
      objectCacheStores += 1;
    }
    objectPaths.push(objectPath);
    objectInputs.push({ kind: "object", identity: source, bytes: output.object });
  }
  host.trace(requestId, "runtimeShimCompile", "end");

  host.progress(requestId, "linking", "Linking SDK-direct Clang objects", 0.8);
  host.trace(requestId, "link", "start");
  const outputPath = "/project/build/app.wasm";
  const linkArguments = instantiateClangLink(config.link, pins.placeholders, objectPaths, outputPath);
  const linkManifestKey = await sha256Hex(JSON.stringify({
    pins: pins.sourceSha256,
    package: CLANG_PACKAGE_SHA256,
    target: project.config.target,
    arguments: config.link,
  }));
  let bytes = await objectCache.lookupLink(linkManifestKey, objectInputs);
  let linkedStdout = "";
  let linkedStderr = "";
  if (bytes) {
    linkHits += 1;
  } else {
    linkMisses += 1;
    const linked = await runLinkStage(
      linker,
      linkArguments,
      directory,
      host,
      requestId,
      "linkSpawn",
      "linkWait",
      "linkOutputReady",
      outputPath,
    );
    linkedStdout = linked.stdout;
    linkedStderr = linked.stderr;
    bytes = linked.value;
    if (bytes && await objectCache.storeLink(linkManifestKey, objectInputs, bytes)) linkStores += 1;
  }
  host.trace(requestId, "link", "end");
  host.trace(requestId, "commandWait", "end");
  stdout += linkedStdout;
  stderr += linkedStderr;
  if (!bytes) return failedBuild(project, stdout, stderr, 1, "wasm-ld", structuredDiagnostics);

  host.progress(requestId, "linking", "Reading linked WebAssembly module", 0.95);
  host.trace(requestId, "artifactReadback", "start");
  host.trace(requestId, "artifactReadback", "end");
  const diagnostics = structuredDiagnostics;
  const artifact: WasmArtifact = {
    kind: "wasm",
    forgeContract: FORGE_CONTRACT_VERSION,
    id: crypto.randomUUID(),
    projectId: project.id,
    cacheKey,
    name: `${project.name}.wasm`,
    language: project.config.language,
    target: project.config.target,
    optimization: project.config.optimization,
    createdAt: Date.now(),
    durationMs: performance.now() - started,
    size: bytes.byteLength,
    toolchains: toolchainPackageIdentities(project.config.language),
    costProfile: costProfileId(project.config.language, project.config.target, project.config.optimization),
    bytes,
  };
    return {
      success: true,
      diagnostics,
      artifact,
      stdout,
      stderr,
      cacheHit: false,
      buildGraph: {
        hits: { pch: pchHits, object: objectCacheHits, "link-result": linkHits },
        misses: { pch: pchMisses, object: units.length - objectCacheHits, "link-result": linkMisses },
        stores: { pch: pchStores, object: objectCacheStores, "link-result": linkStores },
      },
    };
  } finally {
    directory.free();
  }
}

export async function clearSdkDirectClangCaches(): Promise<void> {
  await disposeSdkDirectClangToolchain();
  objectCache.clear();
}

export function exportSdkDirectClangBuildGraph(): IncrementalBuildGraphArchive {
  return objectCache.exportArchive();
}

export function restoreSdkDirectClangBuildGraph(archive: IncrementalBuildGraphArchive): Promise<void> {
  return objectCache.restoreArchive(archive);
}

/** Release all SDK resources tied to one Runtime while preserving object-cache bytes. */
export async function disposeSdkDirectClangToolchain(): Promise<void> {
  const pending = loadedToolchain;
  loadedToolchain = undefined;
  if (!pending) return;
  const { pkg, compiler, linker } = await pending;
  compiler.free();
  linker.free();
  pkg.free();
}

async function ensureToolchain(
  requestId: string,
  host: SdkDirectClangHost,
): Promise<LoadedToolchain> {
  if (loadedToolchain) {
    for (const operation of ["toolchainFetch", "toolchainDecode", "toolchainLoad"] as const) {
      host.trace(requestId, operation, "start");
      host.trace(requestId, operation, "end");
    }
    return loadedToolchain;
  }
  loadedToolchain = (async () => {
    host.trace(requestId, "toolchainFetch", "start");
    const [packageBytes, pinsBytes] = await Promise.all([
      host.loadToolchainAsset(CLANG_PACKAGE_ASSET_PATH),
      host.loadToolchainFile(CLANG_CC1_PINS_ASSET_PATH),
    ]);
    host.trace(requestId, "toolchainFetch", "end");
    host.trace(requestId, "toolchainDecode", "start");
    const pins = await decodeClangPins(pinsBytes);
    const packageSha256 = await sha256Hex(packageBytes);
    if (packageSha256 !== CLANG_PACKAGE_SHA256) {
      throw new Error(`Pinned Clang package digest mismatch: received ${packageSha256}.`);
    }
    host.trace(requestId, "toolchainDecode", "end");
    host.trace(requestId, "toolchainLoad", "start");
    const pkg = await Wasmer.fromFile(packageBytes, host.runtime);
    const compiler = requireCommand(pkg, pins.command);
    const linker = requireCommand(pkg, pins.linkerCommand);
    host.trace(requestId, "toolchainLoad", "end");
    return { pkg, pins, compiler, linker };
  })();
  try {
    return await loadedToolchain;
  } catch (error) {
    loadedToolchain = undefined;
    throw error;
  }
}

function requireCommand(pkg: Wasmer, name: string): Command {
  const selected = pkg.commands[name];
  if (!selected) throw new Error(`The SDK-direct Clang package does not expose '${name}'.`);
  return selected;
}

function findPrecompiledHeader(project: Project): string | undefined {
  const headers = project.files
    .map((file) => file.path)
    .filter((path) => path.split("/").at(-1) === "forge.pch.hpp");
  if (headers.length > 1) {
    throw new Error(`C++ projects may contain at most one forge.pch.hpp; received ${headers.join(", ")}.`);
  }
  return headers[0];
}

function runPchStage(
  command: Command,
  args: string[],
  directory: Directory,
  host: SdkDirectClangHost,
  requestId: string,
  outputPath: string,
  dependencyPath: string,
): Promise<ClangPchStageResult> {
  const stability = new MountedOutputStabilityObserver();
  return runUntilOutputReady(
    command,
    args,
    directory,
    host,
    requestId,
    "projectSpawn",
    "projectWait",
    "projectOutputReady",
    async (capturedStderr) => {
      const [snapshot, dependency] = await Promise.all([
        readOptionalFile(directory, outputPath),
        readOptionalFile(directory, dependencyPath),
      ]);
      const pch = stability.observe(snapshot?.byteLength ? snapshot : undefined, performance.now());
      if (pch && dependency?.byteLength && decoder.decode(dependency).endsWith("\n")) {
        return { pch, dependency };
      }
      return /\d+ errors? generated\.\s*$/.test(capturedStderr) ? {} : undefined;
    },
  ).then((observed) => ({
    ...observed.value,
    diagnostics: parseClangDiagnostics(`${observed.stderr}\n${observed.stdout}`),
    stdout: observed.stdout,
    stderr: observed.stderr,
  }));
}

function runClangStage(
  command: Command,
  args: string[],
  directory: Directory,
  host: SdkDirectClangHost,
  requestId: string,
  spawnOperation: CompilerTraceOperation,
  waitOperation: CompilerTraceOperation,
  outputReadyOperation: CompilerTraceOperation,
  outputPath: string,
  dependencyPath: string,
): Promise<ClangStageResult> {
  return runUntilOutputReady(
    command,
    args,
    directory,
    host,
    requestId,
    spawnOperation,
    waitOperation,
    outputReadyOperation,
    async (capturedStderr) => {
      const [object, dependency] = await Promise.all([
        readValidWasmFile(directory, outputPath),
        readOptionalFile(directory, dependencyPath),
      ]);
      if (object && dependency?.byteLength && decoder.decode(dependency).endsWith("\n")) {
        return { object, dependency };
      }
      return /\d+ errors? generated\.\s*$/.test(capturedStderr) ? {} : undefined;
    },
  ).then((observed) => ({
    ...observed.value,
    diagnostics: parseClangDiagnostics(`${observed.stderr}\n${observed.stdout}`),
    stdout: observed.stdout,
    stderr: observed.stderr,
  }));
}

function runLinkStage(
  command: Command,
  args: string[],
  directory: Directory,
  host: SdkDirectClangHost,
  requestId: string,
  spawnOperation: CompilerTraceOperation,
  waitOperation: CompilerTraceOperation,
  outputReadyOperation: CompilerTraceOperation,
  outputPath: string,
): Promise<StageObservation<Uint8Array | undefined>> {
  return runUntilOutputReady(
    command,
    args,
    directory,
    host,
    requestId,
    spawnOperation,
    waitOperation,
    outputReadyOperation,
    async (capturedStderr) => {
      const output = await readValidWasmFile(directory, outputPath);
      if (output) return output;
      return /(?:wasm-ld|lld): error:/i.test(capturedStderr) ? null : undefined;
    },
  ).then((observed) => ({ ...observed, value: observed.value ?? undefined }));
}

async function runUntilOutputReady<T>(
  command: Command,
  args: string[],
  directory: Directory,
  host: SdkDirectClangHost,
  requestId: string,
  spawnOperation: CompilerTraceOperation,
  waitOperation: CompilerTraceOperation,
  outputReadyOperation: CompilerTraceOperation,
  probe: (capturedStderr: string) => Promise<T | null | undefined>,
): Promise<StageObservation<T | null>> {
  host.trace(requestId, spawnOperation, "start");
  const instance = await command.run({
    args,
    cwd: "/project",
    env: {
      PATH: "/bin",
      SOURCE_DATE_EPOCH: "946684800",
      TZ: "UTC",
      LC_ALL: "C",
    },
    mount: { "/project": directory },
  });
  host.trace(requestId, spawnOperation, "end");
  host.trace(requestId, waitOperation, "start");
  host.trace(requestId, outputReadyOperation, "start");
  const stdoutCapture = captureReadable(instance.stdout);
  const stderrCapture = captureReadable(instance.stderr);
  const deadline = performance.now() + STAGE_OUTPUT_TIMEOUT_MS;
  try {
    while (performance.now() < deadline) {
      const result = await probe(stderrCapture.text());
      if (result !== undefined) {
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
        return {
          value: result,
          stdout: stdoutCapture.text(),
          stderr: stderrCapture.text(),
        };
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
    }
    throw new Error(`ForgeCompiler stage did not produce a complete output within ${STAGE_OUTPUT_TIMEOUT_MS} ms.`);
  } finally {
    host.trace(requestId, outputReadyOperation, "end");
    host.trace(requestId, waitOperation, "end");
    await Promise.all([stdoutCapture.cancel(), stderrCapture.cancel()]);
    instance.free();
  }
}

function captureReadable(stream: ReadableStream): { text(): string; cancel(): Promise<void> } {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  void (async () => {
    try {
      while (true) {
        const result = await reader.read();
        if (result.done) return;
        const bytes = result.value instanceof Uint8Array
          ? result.value
          : new Uint8Array(result.value as ArrayBuffer);
        chunks.push(bytes.slice());
      }
    } catch {
      // Cancellation is expected when a complete mounted output is observed.
    }
  })();
  return {
    text: () => decoder.decode(concatenate(chunks)),
    cancel: async () => {
      try {
        await reader.cancel();
      } catch {
        // The process may have closed the stream between observation and cancellation.
      }
    },
  };
}

function concatenate(chunks: readonly Uint8Array[]): Uint8Array {
  const output = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.byteLength, 0));
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

async function readValidWasmFile(directory: Directory, guestPath: string): Promise<Uint8Array | undefined> {
  const bytes = await readOptionalFile(directory, guestPath);
  if (!bytes || bytes.byteLength <= 8) return undefined;
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return WebAssembly.validate(copy.buffer) ? copy : undefined;
}

async function ensureDirectory(directory: Directory, path: string): Promise<void> {
  try {
    await directory.createDir(path);
  } catch (error) {
    if (!String(error).toLowerCase().includes("exist")) throw error;
  }
}

async function readOptionalFile(directory: Directory, guestPath: string): Promise<Uint8Array | undefined> {
  const mountRelativePath = guestPath.startsWith("/project/")
    ? guestPath.slice("/project".length)
    : guestPath;
  try {
    return await directory.readFile(mountRelativePath);
  } catch {
    return undefined;
  }
}

function failedBuild(
  project: Project,
  stdout: string,
  stderr: string,
  code: number,
  source: "clang" | "wasm-ld",
  providedDiagnostics?: Diagnostic[],
): BuildResult {
  const diagnostics = providedDiagnostics ?? parseClangDiagnostics(`${stderr}\n${stdout}`);
  return {
    success: false,
    diagnostics: ensureFailureDiagnostic(diagnostics, {
      file: project.config.entry,
      source,
      message: stderr.trim() || `${source} exited with code ${code}.`,
    }),
    stdout,
    stderr,
    cacheHit: false,
  };
}
