import { mkdtemp, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FORGE_CONTRACT_VERSION } from "../core/contract";
import { costProfileId } from "../core/cost-profile";
import type { WasmArtifact } from "../core/types";
import { FileSystemArtifactStore } from "./artifact-store";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("FileSystemArtifactStore", () => {
  it("round-trips, deletes, and clears validated artifacts", async () => {
    const directory = await temporaryDirectory();
    const store = new FileSystemArtifactStore(path.join(directory, "artifacts"));
    const artifact = testArtifact("cache-key");

    expect(await store.load(artifact.cacheKey)).toBeUndefined();
    await store.save(artifact);
    expect(await store.load(artifact.cacheKey)).toEqual(artifact);
    await store.delete(artifact.cacheKey);
    expect(await store.load(artifact.cacheKey)).toBeUndefined();
    await store.save(artifact);
    await store.clear();
    expect(await store.load(artifact.cacheKey)).toBeUndefined();
  });

  it("rejects a symbolic-link cache directory", async () => {
    const directory = await temporaryDirectory();
    const target = await temporaryDirectory();
    const link = path.join(directory, "artifacts");
    await symlink(target, link, "dir");

    const store = new FileSystemArtifactStore(link);
    await expect(store.load("cache-key")).rejects.toThrow("not a symbolic link");
  });
});

function testArtifact(cacheKey: string): WasmArtifact {
  return {
    kind: "wasm",
    forgeContract: FORGE_CONTRACT_VERSION,
    id: "artifact",
    projectId: "project",
    cacheKey,
    name: "app.wasm",
    language: "custom",
    target: "wasip1",
    optimization: "release",
    createdAt: 0,
    durationMs: 0,
    size: 8,
    toolchains: ["custom-toolchain"],
    costProfile: costProfileId("custom", "wasip1", "release", "custom-toolchain"),
    bytes: new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]),
  };
}

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "forge-artifact-store-"));
  directories.push(directory);
  return directory;
}
