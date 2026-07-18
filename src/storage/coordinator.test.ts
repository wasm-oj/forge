import { describe, expect, it, vi } from "vitest";
import { ForgeStorageCoordinator } from "./coordinator.ts";
import type { ForgeStorageEntry, ForgeStorageParticipant } from "./types.ts";

describe("ForgeStorageCoordinator", () => {
  it("evicts by retention class and then LRU under one cross-tab lock", async () => {
    const build = participant("build", 10, [
      { key: "recent-build", byteLength: 20, lastAccessedAt: 20 },
      { key: "old-build", byteLength: 30, lastAccessedAt: 10 },
    ]);
    const toolchains = participant("toolchains", 100, [
      { key: "compiler", byteLength: 40, lastAccessedAt: 1 },
    ]);
    const request = vi.fn(async (_name: string, _options: LockOptions, callback: () => Promise<unknown>) => callback());
    const coordinator = new ForgeStorageCoordinator({
      storageManager: storageManager(90, 1_000),
      lockManager: { request } as unknown as LockManager,
      participants: [toolchains.api, build.api],
      maxCacheBytes: 100,
      minimumFreeBytes: 0,
      quotaFraction: 1,
    });

    const result = await coordinator.maintain(40);

    expect(result.evicted).toEqual([{ participantId: "build", key: "old-build", byteLength: 30 }]);
    expect(build.deleted).toEqual(["old-build"]);
    expect(toolchains.deleted).toEqual([]);
    expect(request).toHaveBeenCalledWith(expect.stringContaining(":coordinator"), { mode: "exclusive" }, expect.any(Function));
    expect(result.after.logicalCacheBytes).toBe(60);
  });

  it("rejects admission when coordinated caches cannot create enough headroom", async () => {
    const cache = participant("cache", 10, [{ key: "only", byteLength: 10, lastAccessedAt: 1 }]);
    const coordinator = new ForgeStorageCoordinator({
      storageManager: storageManager(95, 100),
      lockManager: immediateLocks(),
      participants: [cache.api],
      maxCacheBytes: 100,
      minimumFreeBytes: 20,
      quotaFraction: 1,
    });

    await expect(coordinator.admit(20)).rejects.toMatchObject({ name: "QuotaExceededError" });
    expect(cache.deleted).toEqual(["only"]);
  });

  it("requests persistent browser storage through the same coordinator", async () => {
    const persist = vi.fn(async () => true);
    const coordinator = new ForgeStorageCoordinator({
      storageManager: { ...storageManager(0, 100), persist } as StorageManager,
      lockManager: immediateLocks(),
      participants: [],
      maxCacheBytes: 100,
      minimumFreeBytes: 0,
      quotaFraction: 1,
    });

    await expect(coordinator.requestPersistence()).resolves.toBe(true);
    expect(persist).toHaveBeenCalledOnce();
  });
});

function participant(id: string, retentionPriority: number, initial: ForgeStorageEntry[]): {
  api: ForgeStorageParticipant;
  deleted: string[];
} {
  const entries = new Map(initial.map((entry) => [entry.key, entry]));
  const deleted: string[] = [];
  return {
    deleted,
    api: {
      id,
      retentionPriority,
      async list() { return [...entries.values()]; },
      async delete(key) { deleted.push(key); entries.delete(key); },
      async clear() { entries.clear(); },
    },
  };
}

function storageManager(usage: number, quota: number): StorageManager {
  return {
    estimate: async () => ({ usage, quota }),
    persist: async () => false,
  } as StorageManager;
}

function immediateLocks(): LockManager {
  return {
    request: async (_name: string, _options: LockOptions, callback: () => Promise<unknown>) => callback(),
  } as unknown as LockManager;
}
