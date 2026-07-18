import { IDBFactory } from "fake-indexeddb";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FORGE_STORAGE } from "../core/contract.ts";
import { sha256Hex } from "../core/hash.ts";
import { IndexedDbDependencyCache } from "./indexeddb-cache.ts";

describe("IndexedDbDependencyCache", () => {
  beforeEach(() => {
    vi.stubGlobal("indexedDB", new IDBFactory());
  });

  it("persists defensive copies and clears the content-addressed store", async () => {
    const payload = new TextEncoder().encode("browser dependency");
    const digest = await sha256Hex(payload);
    const first = new IndexedDbDependencyCache();
    await first.save(digest, payload);
    payload[0] = 0;
    first.close();

    const second = new IndexedDbDependencyCache();
    const restored = await second.load(digest);
    expect(new TextDecoder().decode(restored)).toBe("browser dependency");
    restored![0] = 0;
    expect(new TextDecoder().decode(await second.load(digest))).toBe("browser dependency");
    await second.clear();
    expect(await second.load(digest)).toBeUndefined();
    second.close();
  });

  it("deletes and rejects a tampered IndexedDB record", async () => {
    const payload = new TextEncoder().encode("trusted");
    const digest = await sha256Hex(payload);
    const cache = new IndexedDbDependencyCache();
    await cache.save(digest, payload);

    const database = await openDatabase();
    const transaction = database.transaction("payloads", "readwrite");
    transaction.objectStore("payloads").put({ digest, payload: new Uint8Array([42]) });
    await transactionComplete(transaction);
    database.close();

    await expect(cache.load(digest)).rejects.toThrow("integrity verification");
    expect(await cache.load(digest)).toBeUndefined();
    cache.close();
  });
});

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(FORGE_STORAGE.dependencyCache, 1);
    request.addEventListener("success", () => resolve(request.result), { once: true });
    request.addEventListener("error", () => reject(request.error), { once: true });
  });
}

function transactionComplete(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.addEventListener("complete", () => resolve(), { once: true });
    transaction.addEventListener("abort", () => reject(transaction.error), { once: true });
  });
}
