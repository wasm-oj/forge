import { randomUUID, createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ForgeDependencyCache } from "./types.ts";

const SHA256 = /^[0-9a-f]{64}$/;
const MAX_PAYLOAD_BYTES = 512 * 1024 * 1024;

/** Atomic server-side content-addressed dependency cache. */
export class FileSystemDependencyCache implements ForgeDependencyCache {
  private readonly directory: string;
  private initialized: Promise<void> | undefined;

  constructor(directory: string) {
    if (!path.isAbsolute(directory)) throw new Error("Dependency cache directory must be absolute.");
    this.directory = directory;
  }

  async load(integritySha256: string): Promise<Uint8Array | undefined> {
    requireDigest(integritySha256);
    await this.ready();
    const file = this.pathFor(integritySha256);
    let handle;
    try {
      handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      if ((error as NodeJS.ErrnoException).code === "ELOOP") {
        await rm(file, { force: true });
        throw new Error(`Cached dependency '${integritySha256}' must not be a symbolic link.`);
      }
      throw error;
    }
    try {
      const metadata = await handle.stat();
      if (!metadata.isFile() || metadata.size > MAX_PAYLOAD_BYTES) {
        throw new Error(`Cached dependency '${integritySha256}' is not a bounded regular file.`);
      }
      const payload = new Uint8Array(await handle.readFile());
      if (digest(payload) !== integritySha256) {
        throw new Error(`Cached dependency '${integritySha256}' failed integrity verification.`);
      }
      return payload;
    } catch (error) {
      await rm(file, { force: true });
      throw error;
    } finally {
      await handle.close();
    }
  }

  async save(integritySha256: string, payload: Uint8Array): Promise<void> {
    requireDigest(integritySha256);
    if (!(payload instanceof Uint8Array) || payload.byteLength > MAX_PAYLOAD_BYTES
      || digest(payload) !== integritySha256) {
      throw new Error("Dependency cache payload digest mismatch or size limit exceeded.");
    }
    await this.ready();
    const destination = this.pathFor(integritySha256);
    const temporary = path.join(this.directory, `${integritySha256}.${randomUUID()}.tmp`);
    try {
      await writeFile(temporary, payload, { flag: "wx", mode: 0o600 });
      await rename(temporary, destination);
    } finally {
      await rm(temporary, { force: true });
    }
  }

  async delete(integritySha256: string): Promise<void> {
    requireDigest(integritySha256);
    await this.ready();
    await rm(this.pathFor(integritySha256), { force: true });
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
          throw new Error("Dependency cache path must be a real directory, not a symbolic link.");
        }
      });
    void this.initialized.catch(() => { this.initialized = undefined; });
    return this.initialized;
  }

  private pathFor(integritySha256: string): string {
    return path.join(this.directory, `${integritySha256}.bin`);
  }
}

function requireDigest(value: string): void {
  if (!SHA256.test(value)) throw new Error("Dependency integrity must be lowercase SHA-256 hexadecimal.");
}

function digest(payload: Uint8Array): string {
  return createHash("sha256").update(payload).digest("hex");
}
