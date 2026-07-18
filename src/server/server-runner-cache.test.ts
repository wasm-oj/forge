import { createHash } from "node:crypto";
import {
  access,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  truncate,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { PYTHON_PACKAGE } from "../core/toolchains";
import type { PackageFileSystemRequest } from "../runner/artifact";
import { ServerForgeRunner } from "./server-runner";

describe("ServerForgeRunner runtime cache ownership", () => {
  it("rejects a filesystem root, including a symlink alias", async () => {
    const filesystemRoot = path.parse(process.cwd()).root;
    expect(() => createRunner(filesystemRoot)).toThrow("must not be a filesystem root");

    const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "forge-cache-root-"));
    const rootAlias = path.join(temporaryDirectory, "root-alias");
    await symlink(filesystemRoot, rootAlias, "dir");
    const runner = createRunner(rootAlias);
    try {
      await expect(runner.ready()).rejects.toThrow("must not be a filesystem root");
    } finally {
      runner.dispose();
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
  });

  it("removes only exact Forge-owned regular cache entries", async () => {
    const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "forge-cache-clear-"));
    const cacheDirectory = path.join(temporaryDirectory, "shared-cache");
    const nestedDirectory = path.join(cacheDirectory, "nested");
    const sentinel = path.join(cacheDirectory, "caller-sentinel.txt");
    const nestedSentinel = path.join(nestedDirectory, "caller-data.txt");
    const finalCache = path.join(cacheDirectory, `${"a".repeat(64)}.forgefs`);
    const temporaryCache = path.join(
      cacheDirectory,
      `${"b".repeat(64)}.forgefs.00000000-0000-4000-8000-000000000000.tmp`,
    );
    const nearMiss = path.join(cacheDirectory, `${"c".repeat(64)}.forgefs.tmp`);
    const matchingDirectory = path.join(cacheDirectory, `${"d".repeat(64)}.forgefs`);
    const symlinkTarget = path.join(temporaryDirectory, "caller-target.txt");
    const matchingSymlink = path.join(cacheDirectory, `${"e".repeat(64)}.forgefs`);
    await mkdir(nestedDirectory, { recursive: true });
    await Promise.all([
      writeFile(sentinel, "sentinel"),
      writeFile(nestedSentinel, "nested"),
      writeFile(finalCache, "final"),
      writeFile(temporaryCache, "temporary"),
      writeFile(nearMiss, "near miss"),
      mkdir(matchingDirectory),
      writeFile(symlinkTarget, "target"),
    ]);
    await writeFile(path.join(matchingDirectory, "caller-data.txt"), "directory");
    await symlink(symlinkTarget, matchingSymlink, "file");

    const runner = createRunner(cacheDirectory);
    try {
      await runner.clearRuntimeCache();

      await expect(access(finalCache)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(access(temporaryCache)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(readFile(sentinel, "utf8")).resolves.toBe("sentinel");
      await expect(readFile(nestedSentinel, "utf8")).resolves.toBe("nested");
      await expect(readFile(nearMiss, "utf8")).resolves.toBe("near miss");
      await expect(readFile(path.join(matchingDirectory, "caller-data.txt"), "utf8")).resolves.toBe("directory");
      expect((await lstat(matchingSymlink)).isSymbolicLink()).toBe(true);
      await expect(readFile(symlinkTarget, "utf8")).resolves.toBe("target");
    } finally {
      runner.dispose();
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
  });

  it("re-exports an invalid archive and does not depend on cache persistence", async () => {
    const cacheDirectory = await mkdtemp(path.join(os.tmpdir(), "forge-cache-persistence-"));
    const runner = createRunner(cacheDirectory);
    const canonicalArchive = emptyRuntimeArchive();
    const expectedSha256 = createHash("sha256").update(canonicalArchive).digest("hex");
    const progressLabels: string[] = [];
    const runPackageStage = vi.fn(async () => ({
      operation: "runtime-files" as const,
      bytes: canonicalArchive.slice(),
    }));
    Object.defineProperty(runner, "runPackageStage", {
      value: runPackageStage,
    });
    const unsubscribe = runner.onProgress((progress) => progressLabels.push(progress.label));
    try {
      await runner.ready();
      const invalidRequest = runtimeFileRequest("invalid-cache", expectedSha256);
      const invalidIdentity = runtimeFileIdentity(invalidRequest);
      const invalidCachePath = runtimeFileCachePath(cacheDirectory, invalidIdentity);
      await writeFile(invalidCachePath, new Uint8Array([0, 1, 2, 3]));

      await expect(loadRuntimeFiles(runner, invalidIdentity, invalidRequest)).resolves.toEqual({});
      expect(new Uint8Array(await readFile(invalidCachePath))).toEqual(canonicalArchive);
      expect(progressLabels.some((label) => label.includes("Ignoring an invalid runtime cache archive"))).toBe(true);

      const blockedRequest = runtimeFileRequest("blocked-persistence", expectedSha256);
      const blockedIdentity = runtimeFileIdentity(blockedRequest);
      const blockedCachePath = runtimeFileCachePath(cacheDirectory, blockedIdentity);
      await mkdir(blockedCachePath);

      await expect(loadRuntimeFiles(runner, blockedIdentity, blockedRequest)).resolves.toEqual({});
      expect((await lstat(blockedCachePath)).isDirectory()).toBe(true);
      expect(progressLabels.some((label) => label.includes("Ignoring non-regular runtime cache entry"))).toBe(true);
      expect(progressLabels.some((label) => label.includes("Unable to persist the verified runtime cache archive"))).toBe(true);
      expect((await readdir(cacheDirectory)).some((name) => name.startsWith(`${path.basename(blockedCachePath)}.`))).toBe(false);

      const oversizedRequest = runtimeFileRequest("oversized-cache", expectedSha256);
      const oversizedIdentity = runtimeFileIdentity(oversizedRequest);
      const oversizedCachePath = runtimeFileCachePath(cacheDirectory, oversizedIdentity);
      await writeFile(oversizedCachePath, new Uint8Array());
      await truncate(oversizedCachePath, 64 * 1024 * 1024 + 1);

      await expect(loadRuntimeFiles(runner, oversizedIdentity, oversizedRequest)).resolves.toEqual({});
      expect(new Uint8Array(await readFile(oversizedCachePath))).toEqual(canonicalArchive);
      expect(progressLabels.some((label) => label.includes("Removing oversized runtime cache archive"))).toBe(true);
      expect(runPackageStage).toHaveBeenCalledTimes(3);
    } finally {
      unsubscribe();
      runner.dispose();
      await rm(cacheDirectory, { recursive: true, force: true });
    }
  });

  it("keeps cached runtime files immutable and clears both memory and disk ownership", async () => {
    const cacheDirectory = await mkdtemp(path.join(os.tmpdir(), "forge-runtime-files-ownership-"));
    const runner = createRunner(cacheDirectory);
    const canonicalArchive = runtimeArchive({ "/runtime.txt": new Uint8Array([1, 2, 3]) });
    const expectedSha256 = createHash("sha256").update(canonicalArchive).digest("hex");
    const request = runtimeFileRequest("immutable", expectedSha256);
    const runPackageStage = vi.fn(async () => ({
      operation: "runtime-files" as const,
      bytes: canonicalArchive.slice(),
    }));
    Object.defineProperty(runner, "runPackageStage", { value: runPackageStage });
    try {
      await runner.ready();
      const first = await loadPackageRuntimeFiles(runner, request);
      first["/runtime.txt"][0] = 255;
      const second = await loadPackageRuntimeFiles(runner, request);
      expect(second["/runtime.txt"]).toEqual(new Uint8Array([1, 2, 3]));
      expect(runPackageStage).toHaveBeenCalledOnce();

      await runner.clearRuntimeCache();
      const third = await loadPackageRuntimeFiles(runner, request);
      expect(third["/runtime.txt"]).toEqual(new Uint8Array([1, 2, 3]));
      expect(runPackageStage).toHaveBeenCalledTimes(2);
    } finally {
      runner.dispose();
      await rm(cacheDirectory, { recursive: true, force: true });
    }
  });

  it("keeps cached package-command bytes private and clears their memory ownership", async () => {
    const cacheDirectory = await mkdtemp(path.join(os.tmpdir(), "forge-command-ownership-"));
    const runner = createRunner(cacheDirectory);
    const commandBytes = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]);
    const runPackageStage = vi.fn(async () => ({
      operation: "command-binary" as const,
      bytes: commandBytes.slice(),
    }));
    Object.defineProperty(runner, "runPackageStage", { value: runPackageStage });
    try {
      await runner.ready();
      const first = await loadPackageCommand(runner);
      first[0] = 255;
      await expect(loadPackageCommand(runner)).resolves.toEqual(commandBytes);
      expect(runPackageStage).toHaveBeenCalledOnce();

      await runner.clearRuntimeCache();
      await expect(loadPackageCommand(runner)).resolves.toEqual(commandBytes);
      expect(runPackageStage).toHaveBeenCalledTimes(2);
    } finally {
      runner.dispose();
      await rm(cacheDirectory, { recursive: true, force: true });
    }
  });
});

function createRunner(cacheDirectory: string): ServerForgeRunner {
  return new ServerForgeRunner({
    runtimeExecutable: process.execPath,
    toolchainDirectory: path.resolve("public/toolchains"),
    cacheDirectory,
  });
}

function emptyRuntimeArchive(): Uint8Array {
  const archive = new Uint8Array(20);
  archive.set(new TextEncoder().encode("FORGEFS1"));
  return archive;
}

function runtimeArchive(files: Record<string, Uint8Array>): Uint8Array {
  const encoder = new TextEncoder();
  const chunks: Uint8Array[] = [encoder.encode("FORGEFS1")];
  for (const [filePath, contents] of Object.entries(files)) {
    const encodedPath = encoder.encode(filePath);
    const header = new Uint8Array(12);
    const view = new DataView(header.buffer);
    view.setUint32(0, encodedPath.byteLength, true);
    view.setBigUint64(4, BigInt(contents.byteLength), true);
    chunks.push(header, encodedPath, contents);
  }
  chunks.push(new Uint8Array(12));
  const archive = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.byteLength, 0));
  let offset = 0;
  for (const chunk of chunks) {
    archive.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return archive;
}

function runtimeFileRequest(cacheKey: string, expectedSha256: string): PackageFileSystemRequest {
  return {
    packageSpecifier: PYTHON_PACKAGE,
    command: "python",
    args: ["-c", "export"],
    cacheKey,
    expectedSha256,
  };
}

function runtimeFileIdentity(request: PackageFileSystemRequest): string {
  return [request.packageSpecifier, request.command, request.cacheKey, request.expectedSha256].join("\n");
}

function runtimeFileCachePath(cacheDirectory: string, identity: string): string {
  const digest = createHash("sha256").update(identity).digest("hex");
  return path.join(cacheDirectory, `${digest}.forgefs`);
}

function loadRuntimeFiles(
  runner: ServerForgeRunner,
  identity: string,
  request: PackageFileSystemRequest,
): Promise<Record<string, Uint8Array>> {
  const internal = runner as unknown as {
    loadOrExportPackageFileSystem(
      operation: { generation: number; superseded: boolean },
      cacheIdentity: string,
      cacheRequest: PackageFileSystemRequest,
    ): Promise<Record<string, Uint8Array>>;
  };
  return internal.loadOrExportPackageFileSystem(
    { generation: 0, superseded: false },
    identity,
    request,
  );
}

function loadPackageRuntimeFiles(
  runner: ServerForgeRunner,
  request: PackageFileSystemRequest,
): Promise<Record<string, Uint8Array>> {
  const internal = runner as unknown as {
    packageFileSystem(
      operation: {
        generation: number;
        superseded: boolean;
        track<T>(task: Promise<T>): Promise<T>;
      },
      cacheRequest: PackageFileSystemRequest,
    ): Promise<Record<string, Uint8Array>>;
  };
  return internal.packageFileSystem(
    {
      generation: 0,
      superseded: false,
      track: <T>(task: Promise<T>) => task,
    },
    request,
  );
}

function loadPackageCommand(runner: ServerForgeRunner): Promise<Uint8Array> {
  const internal = runner as unknown as {
    packageCommand(
      operation: {
        generation: number;
        superseded: boolean;
        track<T>(task: Promise<T>): Promise<T>;
      },
      packageSpecifier: string,
      command: string,
    ): Promise<Uint8Array>;
  };
  return internal.packageCommand(
    {
      generation: 0,
      superseded: false,
      track: <T>(task: Promise<T>) => task,
    },
    PYTHON_PACKAGE,
    "python",
  );
}
