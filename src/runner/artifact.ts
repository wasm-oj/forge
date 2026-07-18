import type { BuildArtifact, RunConfig, RuntimeBundleArtifact } from "../core/types";
import { assertValidBuildArtifact } from "../core/artifact-validation";
import { canonicalFileEntries } from "../core/project-files";
import {
  createDefaultCostBaselineRegistry,
  resolveArtifactCostBudget,
  type CostBaselineRegistry,
  type CostBudget,
} from "../core/cost";
import {
  PYTHON_PACKAGE,
  PYTHON_RUNTIME_FILES_ARCHIVE_SHA256,
} from "../core/toolchains";
import { GO_RUNTIME_STARTUP_ENTROPY_BYTES } from "../compiler/go-toolchain";
import {
  deterministicEnvironment,
  PYTHON_RUNNER_PATH,
  quickJsDeterminismPrelude,
} from "../runtime/determinism";
import {
  PYTHON_RUNTIME_FILES_CACHE_KEY,
  PYTHON_RUNTIME_FILES_EXPORT_SCRIPT,
} from "./runtime-files";

const encoder = new TextEncoder();
export const RUN_INPUT_LIMITS = Object.freeze({
  files: 256,
  bytesPerFile: 64 * 1024 * 1024,
  totalBytes: 128 * 1024 * 1024,
  stdinBytes: 64 * 1024 * 1024,
});
const PREPARED_MOUNT_LIMITS = Object.freeze({
  files: 32_768,
  bytesPerFile: 256 * 1024 * 1024,
  totalBytes: 512 * 1024 * 1024,
});

export interface RuntimeResolver {
  quickJs(): Promise<Uint8Array>;
  packageCommand(packageSpecifier: string, command: string): Promise<Uint8Array>;
  packageFileSystem(request: PackageFileSystemRequest): Promise<Record<string, Uint8Array>>;
}

export interface PackageFileSystemRequest {
  packageSpecifier: string;
  command: string;
  args: string[];
  cacheKey: string;
  expectedSha256: string;
}

export interface PreparedRunRequest {
  wasm: Uint8Array;
  args: string[];
  env: Record<string, string>;
  stdin: Uint8Array;
  files: Record<string, Uint8Array>;
  outputPaths: string[];
  cwd?: string;
  /** Fixed runtime-internal entropy prefix; it does not consume the caller-seeded stream. */
  startupEntropyBytes: number;
  cost: CostBudget;
  determinism: {
    randomSeed: number;
    realtimeEpochMs: number;
    clockStepNs: number;
  };
  resources: {
    instructionBudget: number;
    logicalTimeLimitMs: number;
    memoryLimitBytes: number;
    outputLimitBytes: number;
    filesystemWriteLimitBytes: number;
    filesystemEntryLimit: number;
  };
}

export interface RuntimeDriver {
  readonly id: string;
  /** Declares that the prepared process consumes protocol input from fd 0 incrementally. */
  readonly interactive?: "streaming";
  supports(artifact: BuildArtifact): boolean;
  prepare(
    artifact: BuildArtifact,
    config: RunConfig,
    resolver: RuntimeResolver,
  ): Promise<PreparedRunRequest>;
}

export class RuntimeDriverRegistry {
  private readonly drivers: RuntimeDriver[] = [];
  private sealed = false;

  register(driver: RuntimeDriver): void {
    if (this.sealed) throw new Error("RuntimeDriverRegistry is sealed after its first artifact lookup.");
    if (!driver || typeof driver !== "object") throw new TypeError("Runtime drivers must be objects.");
    if (typeof driver.id !== "string" || !driver.id || driver.id !== driver.id.trim() || driver.id.length > 128) {
      throw new Error("Runtime driver IDs must be non-empty, trimmed, and at most 128 characters.");
    }
    if (typeof driver.supports !== "function" || typeof driver.prepare !== "function") {
      throw new TypeError(`Runtime driver '${driver.id}' must implement supports() and prepare().`);
    }
    if (this.drivers.some((registered) => registered.id === driver.id)) {
      throw new Error(`Runtime driver '${driver.id}' is already registered.`);
    }
    this.drivers.push(driver);
  }

  driver(artifact: BuildArtifact): RuntimeDriver {
    this.sealed = true;
    const matches = this.drivers.filter((driver) => {
      const supported = driver.supports(artifact);
      if (typeof supported !== "boolean") {
        throw new TypeError(`Runtime driver '${driver.id}' supports() must return a boolean.`);
      }
      return supported;
    });
    if (matches.length !== 1) {
      throw new Error(
        matches.length === 0
          ? `No runtime driver supports '${artifact.kind}:${artifact.name}'.`
          : `Artifact '${artifact.name}' has ambiguous runtime drivers: ${matches.map((driver) => driver.id).join(", ")}.`,
      );
    }
    return matches[0];
  }
}

function baseRequest(
  artifact: BuildArtifact,
  wasm: Uint8Array,
  config: RunConfig,
  costBaselines: CostBaselineRegistry,
): PreparedRunRequest {
  const cost = resolveArtifactCostBudget(
    artifact,
    config.resources.instructionBudget,
    costBaselines,
  );
  const stdin = encoder.encode(config.stdin);
  if (stdin.byteLength > RUN_INPUT_LIMITS.stdinBytes) {
    throw new Error(`Run stdin exceeds ${RUN_INPUT_LIMITS.stdinBytes} bytes.`);
  }
  return {
    wasm,
    args: [...config.args],
    env: deterministicEnvironment(config.env, config.determinism),
    stdin,
    files: validatedRunFiles(config.files ?? {}),
    outputPaths: validatedOutputPaths(config.outputPaths ?? []),
    ...(config.cwd === undefined ? {} : { cwd: validatedGuestDirectory(config.cwd, "Run cwd") }),
    startupEntropyBytes: artifact.language === "go" ? GO_RUNTIME_STARTUP_ENTROPY_BYTES : 0,
    cost,
    determinism: { ...config.determinism },
    resources: {
      instructionBudget: cost.rawInstructionBudget,
      logicalTimeLimitMs: config.resources.logicalTimeLimitMs,
      memoryLimitBytes: config.resources.memoryLimitBytes,
      outputLimitBytes: config.resources.outputLimitBytes,
      filesystemWriteLimitBytes: config.resources.filesystemWriteLimitBytes,
      filesystemEntryLimit: config.resources.filesystemEntryLimit,
    },
  };
}

function absoluteProjectFiles(artifact: RuntimeBundleArtifact): Record<string, Uint8Array> {
  const files: Record<string, Uint8Array> = {};
  for (const [path, contents] of canonicalFileEntries(artifact.files)) {
    files[`/project/${path}`] = typeof contents === "string" ? encoder.encode(contents) : contents;
  }
  return files;
}

export function quickJsBundle(
  artifact: RuntimeBundleArtifact,
  stdin: string,
  config: RunConfig,
): string {
  const modules = Object.fromEntries(
    canonicalFileEntries(artifact.files)
      .filter(([path, value]) => /\.(?:js|cjs)$/.test(path) && typeof value === "string"),
  );
  const packageManifests = Object.fromEntries(
    canonicalFileEntries(artifact.files)
      .filter(([path, value]) => /(?:^|\/)package\.json$/.test(path) && typeof value === "string")
      .map(([path, value]) => [path, JSON.parse(value as string)]),
  );
  return String.raw`
"use strict";
${quickJsDeterminismPrelude(config.determinism)}
const __modules = ${JSON.stringify(modules)};
const __packageManifests = ${JSON.stringify(packageManifests)};
const __input = ${JSON.stringify(stdin)};
const __cache = Object.create(null);
const __std = {
  in: { readAsString: () => __input },
  out: { puts: (value) => __forge_write_stdout(String(value)) },
  err: { puts: (value) => __forge_write_stderr(String(value)) },
};
function __resolve(request, parent) {
  if (request === "std") return request;
  if (request.includes("\\")) throw new Error("Module paths must use canonical forward slashes.");
  let parts;
  let requestedParts;
  if (!request.startsWith(".")) {
    const requestParts = request.split("/");
    const packageName = request.startsWith("@") ? requestParts.splice(0, 2).join("/") : requestParts.shift();
    if (!packageName || packageName === "@" || requestParts.some((part) => !part || part === "." || part === "..")) {
      throw new Error("Module '" + request + "' is not a canonical package request.");
    }
    const packageRoot = "node_modules/" + packageName;
    parts = packageRoot.split("/");
    if (requestParts.length) requestedParts = requestParts;
    else {
      const manifest = __packageManifests[packageRoot + "/package.json"] || {};
      const entry = typeof manifest.main === "string" ? manifest.main : "index.js";
      if (entry.startsWith("/") || entry.includes("\\")) throw new Error("Package '" + packageName + "' has an invalid main entry.");
      requestedParts = entry.split("/");
    }
  } else {
    parts = parent.split("/");
    parts.pop();
    requestedParts = request.split("/");
  }
  for (const part of requestedParts) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (parts.length === 0) throw new Error("Module '" + request + "' escapes the project root.");
      parts.pop();
    } else parts.push(part);
  }
  let resolved = parts.join("/");
  if (!Object.prototype.hasOwnProperty.call(__modules, resolved) && Object.prototype.hasOwnProperty.call(__modules, resolved + ".js")) resolved += ".js";
  if (!Object.prototype.hasOwnProperty.call(__modules, resolved) && Object.prototype.hasOwnProperty.call(__modules, resolved + ".cjs")) resolved += ".cjs";
  if (!Object.prototype.hasOwnProperty.call(__modules, resolved) && Object.prototype.hasOwnProperty.call(__modules, resolved + "/index.js")) resolved += "/index.js";
  if (!Object.prototype.hasOwnProperty.call(__modules, resolved)) throw new Error("Module '" + request + "' was not found from '" + parent + "'.");
  return resolved;
}
function __load(id) {
  if (id === "std") return __std;
  if (__cache[id]) return __cache[id].exports;
  const module = { exports: {} };
  __cache[id] = module;
  const factory = new Function("require", "module", "exports", __modules[id] + "\n//# sourceURL=/project/" + id);
  factory((request) => __load(__resolve(request, id)), module, module.exports);
  return module.exports;
}
__load(${JSON.stringify(artifact.entry)});
`;
}

export function createDefaultRuntimeDrivers(
  costBaselines = createDefaultCostBaselineRegistry(),
): RuntimeDriverRegistry {
  const registry = new RuntimeDriverRegistry();
  registry.register({
    id: "standalone-wasm",
    interactive: "streaming",
    supports: (artifact) => artifact.kind === "wasm",
    prepare: async (artifact, config) => {
      if (artifact.kind !== "wasm") throw new Error("Expected a standalone Wasm artifact.");
      return baseRequest(artifact, artifact.bytes, config, costBaselines);
    },
  });
  registry.register({
    id: "quickjs",
    supports: (artifact) => artifact.kind === "runtime-bundle" && artifact.command === "qjs",
    prepare: async (artifact, config, resolver) => {
      if (artifact.kind !== "runtime-bundle") throw new Error("Expected a QuickJS runtime bundle.");
      const request = baseRequest(artifact, await resolver.quickJs(), config, costBaselines);
      request.stdin = encoder.encode(quickJsBundle(artifact, config.stdin, config));
      return request;
    },
  });
  registry.register({
    id: "cpython",
    interactive: "streaming",
    supports: (artifact) => artifact.kind === "runtime-bundle"
      && artifact.runtimePackage === PYTHON_PACKAGE
      && artifact.command === "python",
    prepare: async (artifact, config, resolver) => {
      if (artifact.kind !== "runtime-bundle") throw new Error("Expected a CPython runtime bundle.");
      const request = baseRequest(
        artifact,
        await resolver.packageCommand(artifact.runtimePackage, artifact.command),
        config,
        costBaselines,
      );
      request.args = [
        `/project/${PYTHON_RUNNER_PATH}`,
        `/project/${artifact.entry}`,
        ...config.args,
      ];
      request.env = {
        ...request.env,
        PYTHONHOME: "/cpython",
        PYTHONHASHSEED: "0",
        PYTHONPATH: "/project/build/site-packages:/project/site-packages:/project/src:/project",
        PYTHONDONTWRITEBYTECODE: "1",
      };
      const runtimeFiles = await resolver.packageFileSystem({
        packageSpecifier: artifact.runtimePackage,
        command: artifact.command,
        args: ["-c", PYTHON_RUNTIME_FILES_EXPORT_SCRIPT],
        cacheKey: PYTHON_RUNTIME_FILES_CACHE_KEY,
        expectedSha256: PYTHON_RUNTIME_FILES_ARCHIVE_SHA256,
      });
      request.files = mergeGuestFiles(request.files, {
        ...runtimeFiles,
        "/cpython/lib/python3.14/.keep": new Uint8Array(),
        "/cpython/lib/python3.14/lib-dynload/.keep": new Uint8Array(),
        ...absoluteProjectFiles(artifact),
      });
      request.cwd = "/project";
      return request;
    },
  });
  return registry;
}

function validatedGuestPath(path: string, label: string): string {
  if (typeof path !== "string" || !path.startsWith("/") || path.includes("\\")
    || path.length > 4_096 || path.includes("\0") || path.endsWith("/")
    || path.includes("//") || path.split("/").some((part) => part === "." || part === "..")) {
    throw new Error(`${label} must be an absolute, normalized guest file path.`);
  }
  return path;
}

function validatedGuestDirectory(path: string, label: string): string {
  if (path === "/") return path;
  return validatedGuestPath(path, label);
}

function validatedRunFiles(files: Readonly<Record<string, Uint8Array>>): Record<string, Uint8Array> {
  const entries = Object.entries(files);
  assertFileBudget(entries, RUN_INPUT_LIMITS, "Run input files");
  const result: Record<string, Uint8Array> = {};
  for (const [path, contents] of entries.sort(([left], [right]) => left.localeCompare(right))) {
    validatedGuestPath(path, "Run input path");
    if (!(contents instanceof Uint8Array)) throw new TypeError(`Run input file '${path}' must be a Uint8Array.`);
    result[path] = contents.slice();
  }
  return result;
}

function validatedOutputPaths(paths: readonly string[]): string[] {
  if (!Array.isArray(paths) || paths.length > 256) throw new Error("Run output paths may contain at most 256 entries.");
  const result = paths.map((path) => validatedGuestPath(path, "Run output path")).sort();
  if (result.some((path, index) => index > 0 && result[index - 1] === path)) {
    throw new Error("Run output paths must be unique.");
  }
  return result;
}

function mergeGuestFiles(
  callerFiles: Readonly<Record<string, Uint8Array>>,
  runtimeFiles: Readonly<Record<string, Uint8Array>>,
): Record<string, Uint8Array> {
  const collision = Object.keys(callerFiles).find((path) => Object.hasOwn(runtimeFiles, path));
  if (collision) throw new Error(`Run input file '${collision}' collides with a protected runtime file.`);
  const merged = { ...callerFiles, ...runtimeFiles };
  assertFileBudget(Object.entries(merged), PREPARED_MOUNT_LIMITS, "Prepared runtime files");
  return merged;
}

function assertFileBudget(
  entries: ReadonlyArray<readonly [string, Uint8Array]>,
  limits: { files: number; bytesPerFile: number; totalBytes: number },
  label: string,
): void {
  if (entries.length > limits.files) {
    throw new Error(`${label} may contain at most ${limits.files} entries.`);
  }
  let totalBytes = 0;
  for (const [path, contents] of entries) {
    if (!(contents instanceof Uint8Array)) throw new TypeError(`${label} '${path}' must be a Uint8Array.`);
    if (contents.byteLength > limits.bytesPerFile) {
      throw new Error(`${label} '${path}' exceeds ${limits.bytesPerFile} bytes.`);
    }
    totalBytes += contents.byteLength;
    if (!Number.isSafeInteger(totalBytes) || totalBytes > limits.totalBytes) {
      throw new Error(`${label} exceed ${limits.totalBytes} total bytes.`);
    }
  }
}

export async function prepareArtifactRun(
  artifact: BuildArtifact,
  config: RunConfig,
  resolver: RuntimeResolver,
  registry = createDefaultRuntimeDrivers(),
): Promise<PreparedRunRequest> {
  assertValidBuildArtifact(artifact);
  return registry.driver(artifact).prepare(artifact, config, resolver);
}

export async function prepareArtifactInteraction(
  artifact: BuildArtifact,
  config: RunConfig,
  resolver: RuntimeResolver,
  registry = createDefaultRuntimeDrivers(),
): Promise<PreparedRunRequest> {
  assertValidBuildArtifact(artifact);
  const driver = registry.driver(artifact);
  if (driver.interactive !== "streaming") {
    throw new Error(
      `Runtime driver '${driver.id}' does not support streaming interactive execution.`,
    );
  }
  return driver.prepare(artifact, config, resolver);
}
