import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { access, lstat, mkdir, open } from "node:fs/promises";
import path from "node:path";
import type { ServerToolchainSource } from "@wasm-oj/contracts";
import {
  asWasmOjError,
  createDefaultDependencyManager,
  createEngine,
  type Engine,
  type JudgeEngineOptions,
  type RuntimeDriverRegistry,
} from "@wasm-oj/core";
import { FileSystemArtifactStore } from "./artifact-store";
import { ServerCompiler } from "./server-compiler";
import { ServerRunner } from "./server-runner";
import { FileSystemDependencyCache } from "../dependencies/filesystem-cache";
import {
  assertVerifiedServerDistribution,
  type VerifiedServerDistribution,
} from "./verified-distribution";
import {
  serverToolchainAssetFile,
  serverToolchainDirectories,
  snapshotServerToolchainSources,
} from "./toolchain-sources";

export interface ServerEngineOptions {
  /** Directory containing provisioned `wasm-oj-compiler` and `wasm-oj-runner` binaries. */
  runtimeDirectory: string;
  /** Explicit package-owned toolchain sources. No toolchain is installed implicitly. */
  toolchains: readonly ServerToolchainSource[];
  /** Writable WASM-OJ cache root. Defaults to `<cwd>/.wasm-oj`. */
  cacheDirectory?: string;
  /** Set false to disable the server artifact cache. */
  artifactCache?: boolean;
  runtimeDrivers?: RuntimeDriverRegistry;
  additionalCostBaselines?: Readonly<Record<string, number>>;
  judge?: JudgeEngineOptions;
  /** @internal Process-local capability emitted by container identity verification. */
  verifiedDistribution?: VerifiedServerDistribution;
}

export interface ResolvedServerPaths {
  compilerExecutable: string;
  runtimeExecutable: string;
  toolchains: readonly ServerToolchainSource[];
  cacheDirectory: string;
}

/** Resolve an explicitly provisioned WASM-OJ distribution without performing I/O. */
export function resolveServerPaths(options: ServerEngineOptions): ResolvedServerPaths {
  if (typeof options?.runtimeDirectory !== "string" || !options.runtimeDirectory.trim()) {
    throw new Error("ServerEngineOptions.runtimeDirectory is required.");
  }
  const runtimeDirectory = path.resolve(options.runtimeDirectory);
  const toolchains = snapshotServerToolchainSources(options.toolchains);
  const suffix = process.platform === "win32" ? ".exe" : "";
  return Object.freeze({
    compilerExecutable: path.join(runtimeDirectory, `wasm-oj-compiler${suffix}`),
    runtimeExecutable: path.join(runtimeDirectory, `wasm-oj-runner${suffix}`),
    toolchains,
    cacheDirectory: path.resolve(options.cacheDirectory ?? path.join(process.cwd(), ".wasm-oj")),
  });
}

/** Verify the explicit local distribution and construct one ready server engine. */
export async function createServerEngine(options: ServerEngineOptions): Promise<Engine> {
  const paths = resolveServerPaths(options);
  try {
    if (path.parse(paths.cacheDirectory).root === paths.cacheDirectory) {
      throw new Error("WASM-OJ server cache directory cannot be a filesystem root.");
    }
    if (options.verifiedDistribution) {
      assertVerifiedServerDistribution(options.verifiedDistribution, paths, paths.toolchains);
    } else {
      await Promise.all([
        verifyExecutable(paths.compilerExecutable, "WASM-OJ compiler"),
        verifyExecutable(paths.runtimeExecutable, "WASM-OJ runner"),
      ]);
      await verifyToolchainSources(paths.toolchains);
    }
    await mkdir(paths.cacheDirectory, { recursive: true, mode: 0o700 });

    const compiler = new ServerCompiler({
      compilerExecutable: paths.compilerExecutable,
      toolchains: paths.toolchains,
      verifiedDistribution: options.verifiedDistribution,
    });
    const runner = new ServerRunner({
      runtimeExecutable: paths.runtimeExecutable,
      toolchains: paths.toolchains,
      cacheDirectory: path.join(paths.cacheDirectory, "runtime"),
      runtimeDrivers: options.runtimeDrivers,
      additionalCostBaselines: options.additionalCostBaselines,
      verifiedDistribution: options.verifiedDistribution,
    });
    return await createEngine({
      compiler,
      runner,
      artifactStore: options.artifactCache === false
        ? undefined
        : new FileSystemArtifactStore(path.join(paths.cacheDirectory, "artifacts")),
      judge: options.judge,
      dependencyManager: createDefaultDependencyManager(
        new FileSystemDependencyCache(path.join(paths.cacheDirectory, "dependencies")),
      ),
    });
  } catch (error) {
    throw asWasmOjError(error, {
      code: "initialization-failure",
      stage: "initialize",
      retryable: false,
    });
  }
}

async function verifyExecutable(file: string, label: string): Promise<void> {
  const metadata = await lstat(file);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error(`${label} must be a real regular file: '${file}'.`);
  }
  await access(file, constants.X_OK);
}

async function verifyToolchainSources(toolchains: readonly ServerToolchainSource[]): Promise<void> {
  for (const directory of serverToolchainDirectories(toolchains)) {
    const metadata = await lstat(directory);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw new Error(`Toolchain package path must be a real directory: '${directory}'.`);
    }
  }
  for (const source of toolchains) {
    for (const asset of source.descriptor.assets) {
      const file = serverToolchainAssetFile(toolchains, asset.path);
      const fileMetadata = await lstat(file);
      if (!fileMetadata.isFile() || fileMetadata.isSymbolicLink()) {
        throw new Error(`Pinned toolchain asset must be a real regular file: '${file}'.`);
      }
      if (fileMetadata.size !== asset.bytes) {
        throw new Error(
          `Pinned toolchain asset '${file}' has ${fileMetadata.size} bytes; expected ${asset.bytes}.`,
        );
      }
      const actual = await digestFile(file);
      if (actual !== asset.sha256) {
        throw new Error(`Pinned toolchain asset '${file}' has digest ${actual}; expected ${asset.sha256}.`);
      }
    }
  }
}

async function digestFile(file: string): Promise<string> {
  const digest = createHash("sha256");
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    for await (const chunk of handle.createReadStream({ autoClose: false })) digest.update(chunk as Buffer);
    return digest.digest("hex");
  } finally {
    await handle.close();
  }
}
