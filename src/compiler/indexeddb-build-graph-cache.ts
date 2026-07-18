import { FORGE_STORAGE } from "../core/contract.ts";
import type { IncrementalBuildGraphArchive } from "./incremental-build-graph.ts";

const STORE = "archives";
const CLANG_KEY = "clang";

interface BuildGraphRecord {
  id: typeof CLANG_KEY;
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
      || Object.keys(value).sort().join(",") !== "archive,id"
      || (value as BuildGraphRecord).id !== CLANG_KEY) {
      throw new Error("Persisted Clang build graph record has an invalid shape.");
    }
    return structuredClone((value as BuildGraphRecord).archive);
  } finally {
    database.close();
  }
}

export async function saveClangBuildGraphArchive(archive: IncrementalBuildGraphArchive): Promise<void> {
  const database = await openDatabase();
  try {
    const transaction = database.transaction(STORE, "readwrite");
    transaction.objectStore(STORE).put({ id: CLANG_KEY, archive: structuredClone(archive) } satisfies BuildGraphRecord);
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
