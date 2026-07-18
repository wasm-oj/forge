// @vitest-environment node
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { sha256Hex } from "../core/hash.ts";
import { FileSystemDependencyCache } from "./filesystem-cache.ts";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("FileSystemDependencyCache", () => {
  it("atomically persists, reloads, deletes, and clears verified payloads", async () => {
    const root = await temporaryDirectory();
    const cache = new FileSystemDependencyCache(path.join(root, "cache"));
    const payload = new TextEncoder().encode("server dependency");
    const digest = await sha256Hex(payload);

    await cache.save(digest, payload);
    payload[0] = 0;
    expect(new TextDecoder().decode(await cache.load(digest))).toBe("server dependency");
    expect(new Uint8Array(await readFile(path.join(root, "cache", `${digest}.bin`)))).toEqual(
      new TextEncoder().encode("server dependency"),
    );
    await cache.delete(digest);
    expect(await cache.load(digest)).toBeUndefined();
    await cache.save(digest, new TextEncoder().encode("server dependency"));
    await cache.clear();
    expect(await cache.load(digest)).toBeUndefined();
  });

  it("removes corrupt payloads and refuses symbolic-link cache entries", async () => {
    const root = await temporaryDirectory();
    const directory = path.join(root, "cache");
    const cache = new FileSystemDependencyCache(directory);
    const payload = new TextEncoder().encode("expected");
    const digest = await sha256Hex(payload);
    await cache.save(digest, payload);
    await writeFile(path.join(directory, `${digest}.bin`), "tampered");
    await expect(cache.load(digest)).rejects.toThrow("integrity verification");
    expect(await cache.load(digest)).toBeUndefined();

    const outside = path.join(root, "outside.bin");
    await writeFile(outside, payload);
    await symlink(outside, path.join(directory, `${digest}.bin`));
    await expect(cache.load(digest)).rejects.toThrow("symbolic link");
    expect(new Uint8Array(await readFile(outside))).toEqual(payload);
  });

  it("rejects a cache root that is itself a symbolic link", async () => {
    const root = await temporaryDirectory();
    const real = path.join(root, "real");
    const linked = path.join(root, "linked");
    const seed = new FileSystemDependencyCache(real);
    await seed.clear();
    await symlink(real, linked);
    const cache = new FileSystemDependencyCache(linked);
    await expect(cache.load("0".repeat(64))).rejects.toThrow("real directory");
  });
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "forge-dependency-cache-"));
  directories.push(directory);
  return directory;
}
