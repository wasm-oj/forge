import { IDBFactory } from "fake-indexeddb";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { WASM_OJ_SCHEMAS, WASM_OJ_STORAGE } from "../core/contract.ts";
import { IncrementalBuildGraph, type IncrementalBuildGraphState } from "./incremental-build-graph.ts";
import {
  ClangBuildGraphPersistenceController,
  clearClangBuildGraphCache,
  listClangBuildGraphStorageEntries,
  loadClangBuildGraphState,
  saveClangBuildGraphState,
} from "./indexeddb-build-graph-cache.ts";

const bytes = (value: string) => new TextEncoder().encode(value);

describe("browser incremental build cache", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.stubGlobal("indexedDB", new IDBFactory());
  });

  it("persists v2 graph state and deletes only the dedicated incremental cache", async () => {
    await expect(loadClangBuildGraphState()).resolves.toBeUndefined();
    const state = await sharedOutputState();
    await expect(saveClangBuildGraphState(state)).resolves.toBe(true);
    await expect(loadClangBuildGraphState()).resolves.toEqual(state);
    await clearClangBuildGraphCache();
    await expect(loadClangBuildGraphState()).resolves.toBeUndefined();
  });

  it("drops the monolithic v1 archive without touching project drafts in the main database", async () => {
    const legacyCache = await openNamedDatabase(WASM_OJ_STORAGE.incrementalBuildCache, 1, (database) => {
      database.createObjectStore("archives", { keyPath: "id" });
    });
    const legacyTransaction = legacyCache.transaction("archives", "readwrite");
    legacyTransaction.objectStore("archives").put({ id: "clang", archive: new Uint8Array([1, 2, 3]) });
    await transactionDone(legacyTransaction);
    legacyCache.close();

    const mainDatabase = await openNamedDatabase(WASM_OJ_STORAGE.database, 1, (database) => {
      database.createObjectStore("projects", { keyPath: "id" });
    });
    const draftTransaction = mainDatabase.transaction("projects", "readwrite");
    draftTransaction.objectStore("projects").put({ id: "draft-1", source: "int main() {}" });
    await transactionDone(draftTransaction);
    mainDatabase.close();

    await expect(loadClangBuildGraphState()).resolves.toBeUndefined();
    await clearClangBuildGraphCache();

    const preservedMainDatabase = await openNamedDatabase(WASM_OJ_STORAGE.database);
    const readTransaction = preservedMainDatabase.transaction("projects", "readonly");
    await expect(requestResult(readTransaction.objectStore("projects").get("draft-1"))).resolves.toEqual({
      id: "draft-1",
      source: "int main() {}",
    });
    await transactionDone(readTransaction);
    preservedMainDatabase.close();
  });

  it("stores duplicate output content once with truthful unique-byte accounting", async () => {
    const state = await sharedOutputState();
    await saveClangBuildGraphState(state);

    const database = await openCacheDatabase();
    const transaction = database.transaction(["blobs", "metadata"], "readonly");
    const blobCount = await requestResult(transaction.objectStore("blobs").count());
    const metadata = await requestResult(transaction.objectStore("metadata").get("clang") as IDBRequest<{
      blobBytes: number;
      manifestBytes: number;
      byteLength: number;
    }>);
    await transactionDone(transaction);
    database.close();

    expect(blobCount).toBe(1);
    expect(metadata.blobBytes).toBe(bytes("shared-output").byteLength);
    expect(metadata.manifestBytes).toBeGreaterThan(0);
    expect(metadata.byteLength).toBe(metadata.blobBytes + metadata.manifestBytes);
    await expect(listClangBuildGraphStorageEntries()).resolves.toEqual([
      expect.objectContaining({ key: "clang", byteLength: metadata.byteLength }),
    ]);
  });

  it("loads each unique blob once and touch rewrites metadata only", async () => {
    const state = await sharedOutputState();
    await saveClangBuildGraphState(state);
    const objectStorePrototype = await loadObjectStorePrototype();
    const getSpy = vi.spyOn(objectStorePrototype, "get");
    const putSpy = vi.spyOn(objectStorePrototype, "put");
    const addSpy = vi.spyOn(objectStorePrototype, "add");

    await expect(loadClangBuildGraphState()).resolves.toEqual(state);

    expect((getSpy.mock.instances as IDBObjectStore[]).filter((store) => store.name === "blobs")).toHaveLength(1);
    expect((putSpy.mock.instances as IDBObjectStore[]).map((store) => store.name)).toEqual(["metadata"]);
    expect(addSpy).not.toHaveBeenCalled();
  });

  it("performs no IndexedDB mutation for an unchanged graph generation", async () => {
    const state = await sharedOutputState();
    await saveClangBuildGraphState(state);
    const objectStorePrototype = await loadObjectStorePrototype();
    const putSpy = vi.spyOn(objectStorePrototype, "put");
    const addSpy = vi.spyOn(objectStorePrototype, "add");
    const deleteSpy = vi.spyOn(objectStorePrototype, "delete");

    await expect(saveClangBuildGraphState(state)).resolves.toBe(false);

    expect(putSpy).not.toHaveBeenCalled();
    expect(addSpy).not.toHaveBeenCalled();
    expect(deleteSpy).not.toHaveBeenCalled();
  });

  it("does not hydrate during non-Clang initialization and persists dirty generations once", async () => {
    let state = emptyState();
    const load = vi.fn(async () => undefined);
    const restore = vi.fn(async () => undefined);
    const save = vi.fn(async () => true);
    const controller = new ClangBuildGraphPersistenceController({
      load,
      restore,
      capture: () => state,
      save,
    });

    // Worker construction/initialize is the complete non-Clang path: no graph I/O.
    expect(load).not.toHaveBeenCalled();
    await expect(controller.persistIfDirty()).resolves.toBe(false);
    expect(load).not.toHaveBeenCalled();

    // A C/C++ build explicitly crosses the lazy hydration boundary.
    await controller.ensureLoaded();
    expect(load).toHaveBeenCalledOnce();
    expect(restore).not.toHaveBeenCalled();
    await expect(controller.persistIfDirty()).resolves.toBe(false);
    expect(save).not.toHaveBeenCalled();

    state = { ...state, manifest: { ...state.manifest, generation: 1 } };
    await expect(controller.persistIfDirty()).resolves.toBe(true);
    await expect(controller.persistIfDirty()).resolves.toBe(false);
    expect(save).toHaveBeenCalledOnce();
  });
});

async function sharedOutputState(): Promise<IncrementalBuildGraphState> {
  const graph = new IncrementalBuildGraph(1_024);
  const output = bytes("shared-output");
  await graph.store("object", "first", [
    { kind: "source", identity: "first.c", bytes: bytes("first") },
  ], output);
  await graph.store("object", "second", [
    { kind: "source", identity: "second.c", bytes: bytes("second") },
  ], output);
  return graph.exportState();
}

function emptyState(): IncrementalBuildGraphState {
  return {
    manifest: {
      schema: WASM_OJ_SCHEMAS.incrementalBuildGraph,
      version: 2,
      generation: 0,
      entries: [],
    },
    blobs: [],
  };
}

function openCacheDatabase(): Promise<IDBDatabase> {
  return openNamedDatabase(WASM_OJ_STORAGE.incrementalBuildCache);
}

function openNamedDatabase(
  name: string,
  version?: number,
  upgrade?: (database: IDBDatabase) => void,
): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = version === undefined ? indexedDB.open(name) : indexedDB.open(name, version);
    request.addEventListener("upgradeneeded", () => upgrade?.(request.result), { once: true });
    request.addEventListener("success", () => resolve(request.result), { once: true });
    request.addEventListener("error", () => reject(request.error), { once: true });
  });
}

async function loadObjectStorePrototype(): Promise<IDBObjectStore> {
  const database = await openCacheDatabase();
  const transaction = database.transaction("metadata", "readonly");
  const prototype = Object.getPrototypeOf(transaction.objectStore("metadata")) as IDBObjectStore;
  await transactionDone(transaction);
  database.close();
  return prototype;
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.addEventListener("success", () => resolve(request.result), { once: true });
    request.addEventListener("error", () => reject(request.error), { once: true });
  });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.addEventListener("complete", () => resolve(), { once: true });
    transaction.addEventListener("abort", () => reject(transaction.error), { once: true });
  });
}
