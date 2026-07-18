import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { access, lstat, mkdir, open } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { JudgeEngineOptions } from "../judge/engine";
import type { RuntimeDriverRegistry } from "../runner/artifact";
import { createForgeEngine, type ForgeEngine } from "../sdk/engine";
import { PINNED_TOOLCHAIN_ASSET_SHA256 } from "../core/toolchains";
import { asForgeError } from "../core/errors";
import { FileSystemArtifactStore } from "./artifact-store";
import { ServerForgeCompiler } from "./server-compiler";
import { ServerForgeRunner } from "./server-runner";
import { FileSystemDependencyCache } from "../dependencies/filesystem-cache";
import { createDefaultDependencyManager } from "../dependencies/manager";

export interface CreateServerForgeOptions {
  /** Directory containing provisioned `forge-compiler` and `forge-runner` binaries. */
  runtimeDirectory?: string;
  /** Directory containing the exact package-exported toolchain files. */
  toolchainDirectory?: string;
  /** Writable Forge cache root. Defaults to `<cwd>/.forge`. */
  cacheDirectory?: string;
  /** Set false to disable the server artifact cache. */
  artifactCache?: boolean;
  runtimeDrivers?: RuntimeDriverRegistry;
  additionalCostBaselines?: Readonly<Record<string, number>>;
  judge?: JudgeEngineOptions;
}

export interface ResolvedServerForgePaths {
  packageRoot: string;
  compilerExecutable: string;
  runtimeExecutable: string;
  toolchainDirectory: string;
  cacheDirectory: string;
}

/** Resolve the provisioned Forge distribution without performing I/O. */
export function resolveServerForgePaths(options: CreateServerForgeOptions = {}): ResolvedServerForgePaths {
  const packageRoot = path.dirname(fileURLToPath(import.meta.resolve("@wasm-oj/forge/package.json")));
  const runtimeDirectory = path.resolve(options.runtimeDirectory
    ?? path.join(packageRoot, "crates", "runtime-core", "target", "release"));
  const suffix = process.platform === "win32" ? ".exe" : "";
  return Object.freeze({
    packageRoot,
    compilerExecutable: path.join(runtimeDirectory, `forge-compiler${suffix}`),
    runtimeExecutable: path.join(runtimeDirectory, `forge-runner${suffix}`),
    toolchainDirectory: path.resolve(options.toolchainDirectory ?? path.join(packageRoot, "public", "toolchains")),
    cacheDirectory: path.resolve(options.cacheDirectory ?? path.join(process.cwd(), ".forge")),
  });
}

/** Verify the local distribution and construct one ready server Forge engine. */
export async function createServerForge(options: CreateServerForgeOptions = {}): Promise<ForgeEngine> {
  const paths = resolveServerForgePaths(options);
  try {
    if (path.parse(paths.cacheDirectory).root === paths.cacheDirectory) {
      throw new Error("Forge server cache directory cannot be a filesystem root.");
    }
    await Promise.all([
      verifyExecutable(paths.compilerExecutable, "Forge compiler"),
      verifyExecutable(paths.runtimeExecutable, "Forge runner"),
    ]);
    await verifyPinnedToolchainDirectory(paths.toolchainDirectory);
    await mkdir(paths.cacheDirectory, { recursive: true, mode: 0o700 });

    const compiler = new ServerForgeCompiler({
      compilerExecutable: paths.compilerExecutable,
      toolchainDirectory: paths.toolchainDirectory,
    });
    const runner = new ServerForgeRunner({
      runtimeExecutable: paths.runtimeExecutable,
      toolchainDirectory: paths.toolchainDirectory,
      cacheDirectory: path.join(paths.cacheDirectory, "runtime"),
      runtimeDrivers: options.runtimeDrivers,
      additionalCostBaselines: options.additionalCostBaselines,
    });
    return await createForgeEngine({
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
    throw asForgeError(error, {
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

async function verifyPinnedToolchainDirectory(directory: string): Promise<void> {
  const metadata = await lstat(directory);
  if (!metadata.isDirectory()) throw new Error(`Forge toolchain path is not a directory: '${directory}'.`);
  for (const [assetPath, expected] of Object.entries(PINNED_TOOLCHAIN_ASSET_SHA256)) {
    const file = path.join(directory, path.basename(assetPath));
    const fileMetadata = await lstat(file);
    if (!fileMetadata.isFile() || fileMetadata.isSymbolicLink()) {
      throw new Error(`Pinned toolchain asset must be a real regular file: '${file}'.`);
    }
    const actual = await digestFile(file);
    if (actual !== expected) {
      throw new Error(`Pinned toolchain asset '${file}' has digest ${actual}; expected ${expected}.`);
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
