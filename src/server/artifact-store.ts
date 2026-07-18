import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { deserialize, serialize } from "node:v8";
import type { ForgeArtifactStore } from "../compiler/coordinator";
import { assertCompilerCacheKey } from "../core/hash";
import { assertValidBuildArtifact } from "../core/artifact-validation";
import type { BuildArtifact } from "../core/types";

const MAX_SERIALIZED_ARTIFACT_BYTES = 512 * 1024 * 1024;

/** Atomic, content-addressed artifact storage for the Node/server host. */
export class FileSystemArtifactStore implements ForgeArtifactStore {
  private initialized: Promise<void> | undefined;

  constructor(private readonly directory: string) {
    if (!path.isAbsolute(directory)) throw new Error("Artifact cache directory must be absolute.");
  }

  async load(cacheKey: string): Promise<BuildArtifact | undefined> {
    assertCompilerCacheKey(cacheKey);
    await this.ready();
    const file = this.pathFor(cacheKey);
    let handle;
    try {
      handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      if ((error as NodeJS.ErrnoException).code === "ELOOP") {
        await rm(file, { force: true });
        throw new Error(`Cached artifact '${cacheKey}' must not be a symbolic link.`);
      }
      throw error;
    }
    try {
      const metadata = await handle.stat();
      if (!metadata.isFile() || metadata.size > MAX_SERIALIZED_ARTIFACT_BYTES) {
        throw new Error(`Cached artifact '${cacheKey}' is not a bounded regular file.`);
      }
      const artifact: unknown = deserialize(await handle.readFile());
      assertValidBuildArtifact(artifact);
      if (artifact.cacheKey !== cacheKey) throw new Error("Cached artifact build identity does not match its key.");
      return artifact;
    } catch (error) {
      await rm(file, { force: true });
      throw error;
    } finally {
      await handle.close();
    }
  }

  async save(artifact: BuildArtifact): Promise<void> {
    assertValidBuildArtifact(artifact);
    await this.ready();
    const encoded = serialize(artifact);
    if (encoded.byteLength > MAX_SERIALIZED_ARTIFACT_BYTES) {
      throw new RangeError(`Serialized artifact exceeds ${MAX_SERIALIZED_ARTIFACT_BYTES} bytes.`);
    }
    const temporary = path.join(this.directory, `${cacheFileName(artifact.cacheKey)}.${randomUUID()}.tmp`);
    try {
      await writeFile(temporary, encoded, { flag: "wx", mode: 0o600 });
      await rename(temporary, this.pathFor(artifact.cacheKey));
    } finally {
      await rm(temporary, { force: true });
    }
  }

  async delete(cacheKey: string): Promise<void> {
    assertCompilerCacheKey(cacheKey);
    await this.ready();
    await rm(this.pathFor(cacheKey), { force: true });
  }

  async clear(): Promise<void> {
    await rm(this.directory, { recursive: true, force: true });
    this.initialized = undefined;
    await this.ready();
  }

  private ready(): Promise<void> {
    this.initialized ??= mkdir(this.directory, { recursive: true, mode: 0o700 })
      .then(async () => {
        const metadata = await lstat(this.directory);
        if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
          throw new Error("Artifact cache path must be a real directory, not a symbolic link.");
        }
      });
    void this.initialized.catch(() => { this.initialized = undefined; });
    return this.initialized;
  }

  private pathFor(cacheKey: string): string {
    return path.join(this.directory, `${cacheFileName(cacheKey)}.forge-artifact`);
  }
}

function cacheFileName(cacheKey: string): string {
  return createHash("sha256").update(cacheKey).digest("hex");
}
