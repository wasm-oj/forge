import { IDBFactory } from "fake-indexeddb";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FORGE_SCHEMAS } from "../core/contract.ts";
import {
  clearClangBuildGraphCache,
  loadClangBuildGraphArchive,
  saveClangBuildGraphArchive,
} from "./indexeddb-build-graph-cache.ts";

describe("browser incremental build cache", () => {
  beforeEach(() => {
    vi.stubGlobal("indexedDB", new IDBFactory());
  });

  it("persists Worker-neutral graph archives and deletes them explicitly", async () => {
    await expect(loadClangBuildGraphArchive()).resolves.toBeUndefined();
    const archive = {
      schema: FORGE_SCHEMAS.incrementalBuildGraph,
      entries: [],
    } as const;
    await saveClangBuildGraphArchive(archive);
    await expect(loadClangBuildGraphArchive()).resolves.toEqual(archive);
    await clearClangBuildGraphCache();
    await expect(loadClangBuildGraphArchive()).resolves.toBeUndefined();
  });
});
