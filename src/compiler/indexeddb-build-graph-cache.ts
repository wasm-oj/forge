import { FORGE_STORAGE } from "../core/contract.ts";
import type { IncrementalBuildGraphArchive } from "./incremental-build-graph.ts";
import type { ForgeStorageEntry, ForgeStorageParticipant } from "../storage/types.ts";

const STORE = "archives";
const CLANG_KEY = "clang";

interface BuildGraphRecord {
  byteLength: number;
  id: typeof CLANG_KEY;
  lastAccessedAt: number;
  archive: IncrementalBuildGraphArchive;
}

export async function loadClangBuildGraphArchive(): Promise<IncrementalBuildGraphArchive | undefined> {
  const database = await openDatabase();
  try {
    const transaction = database.transaction(STORE, "readonly");
    const value = await requestResult(transaction.objectStore(STORE).get(CLANG_KEY) as IDBRequest<unknown>);
    await transactionDone(transaction);
    if (value === undefined) return undefined;
    if (!value || typeof value !== "object" || Array.isArray(value)
      || Object.keys(value).sort().join(",") !== "archive,byteLength,id,lastAccessedAt"
      || (value as BuildGraphRecord).id !== CLANG_KEY) {
      throw new Error("Persisted Clang build graph record has an invalid shape.");
    }
    const record = value as BuildGraphRecord;
    if (!Number.isSafeInteger(record.byteLength) || record.byteLength < 0
      || !Number.isSafeInteger(record.lastAccessedAt) || record.lastAccessedAt < 0) {
      throw new Error("Persisted Clang build graph record has invalid storage metadata.");
    }
    const archive = structuredClone(record.archive);
    await touchBuildGraph();
    return archive;
  } finally {
    database.close();
  }
}

export async function saveClangBuildGraphArchive(archive: IncrementalBuildGraphArchive): Promise<void> {
  const database = await openDatabase();
  try {
    const transaction = database.transaction(STORE, "readwrite");
    transaction.objectStore(STORE).put({
      id: CLANG_KEY,
      archive: structuredClone(archive),
      byteLength: archiveByteLength(archive),
      lastAccessedAt: Date.now(),
    } satisfies BuildGraphRecord);
    await transactionDone(transaction);
  } finally {
    database.close();
  }
}

export function clearClangBuildGraphCache(): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(FORGE_STORAGE.incrementalBuildCache);
    request.addEventListener("success", () => resolve(), { once: true });
    request.addEventListener("error", () => {
      reject(request.error ?? new Error("Unable to delete the incremental build cache."));
    }, { once: true });
    request.addEventListener("blocked", () => {
      reject(new Error("Incremental build cache deletion is blocked by another open tab."));
    }, { once: true });
  });
}

export async function listClangBuildGraphStorageEntries(): Promise<ForgeStorageEntry[]> {
  const database = await openDatabase();
  try {
    const transaction = database.transaction(STORE, "readonly");
    const value = await requestResult(transaction.objectStore(STORE).get(CLANG_KEY) as IDBRequest<unknown>);
    await transactionDone(transaction);
    if (value === undefined) return [];
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("Persisted Clang build graph record has an invalid shape.");
    }
    const record = value as BuildGraphRecord;
    if (record.id !== CLANG_KEY || !Number.isSafeInteger(record.byteLength) || record.byteLength < 0
      || !Number.isSafeInteger(record.lastAccessedAt) || record.lastAccessedAt < 0) {
      throw new Error("Persisted Clang build graph record has invalid storage metadata.");
    }
    return [{ key: CLANG_KEY, byteLength: record.byteLength, lastAccessedAt: record.lastAccessedAt }];
  } finally {
    database.close();
  }
}

export function clangBuildGraphStorageParticipant(): ForgeStorageParticipant {
  return {
    id: "incremental-build-graph",
    retentionPriority: 10,
    list: listClangBuildGraphStorageEntries,
    delete: async (key) => {
      if (key !== CLANG_KEY) throw new Error(`Unknown build graph storage key '${key}'.`);
      await clearClangBuildGraphCache();
    },
    clear: clearClangBuildGraphCache,
  };
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(FORGE_STORAGE.incrementalBuildCache, 1);
    request.addEventListener("upgradeneeded", () => {
      if (!request.result.objectStoreNames.contains(STORE)) {
        request.result.createObjectStore(STORE, { keyPath: "id" });
      }
    });
    request.addEventListener("success", () => resolve(request.result), { once: true });
    request.addEventListener("error", () => {
      reject(request.error ?? new Error("Unable to open the incremental build cache."));
    }, { once: true });
    request.addEventListener("blocked", () => {
      reject(new Error("Incremental build cache open is blocked by another tab."));
    }, { once: true });
  });
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.addEventListener("success", () => resolve(request.result), { once: true });
    request.addEventListener("error", () => reject(request.error ?? new Error("IndexedDB request failed.")), { once: true });
  });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.addEventListener("complete", () => resolve(), { once: true });
    transaction.addEventListener("abort", () => reject(transaction.error ?? new Error("IndexedDB transaction aborted.")), { once: true });
    transaction.addEventListener("error", () => reject(transaction.error ?? new Error("IndexedDB transaction failed.")), { once: true });
  });
}

async function touchBuildGraph(): Promise<void> {
  const database = await openDatabase();
  try {
    const transaction = database.transaction(STORE, "readwrite");
    const store = transaction.objectStore(STORE);
    const value = await requestResult(store.get(CLANG_KEY) as IDBRequest<unknown>);
    if (value && typeof value === "object" && !Array.isArray(value)) {
      store.put({ ...(value as BuildGraphRecord), lastAccessedAt: Date.now() } satisfies BuildGraphRecord);
    }
    await transactionDone(transaction);
  } finally {
    database.close();
  }
}

function archiveByteLength(archive: IncrementalBuildGraphArchive): number {
  const digests = new Set<string>();
  let total = 0;
  for (const entry of archive.entries) {
    if (digests.has(entry.outputDigest)) continue;
    digests.add(entry.outputDigest);
    total += entry.output.byteLength;
    if (!Number.isSafeInteger(total)) throw new Error("Incremental build graph byte length exceeds the safe integer range.");
  }
  return total;
}
