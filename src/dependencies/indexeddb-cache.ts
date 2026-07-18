import { FORGE_STORAGE } from "../core/contract.ts";
import { sha256Hex } from "../core/hash.ts";
import type { ForgeDependencyCache } from "./types.ts";

const STORE = "payloads";
const SHA256 = /^[0-9a-f]{64}$/;

interface DependencyPayloadRecord {
  digest: string;
  payload: Uint8Array;
}

/** Persistent browser content-addressed dependency cache. */
export class IndexedDbDependencyCache implements ForgeDependencyCache {
  private database: Promise<IDBDatabase> | undefined;

  async load(integritySha256: string): Promise<Uint8Array | undefined> {
    requireDigest(integritySha256);
    const database = await this.open();
    const transaction = database.transaction(STORE, "readonly");
    const value = await requestResult(transaction.objectStore(STORE).get(integritySha256) as IDBRequest<unknown>);
    await transactionDone(transaction);
    if (value === undefined) return undefined;
    if (!isRecord(value) || value.digest !== integritySha256 || !(value.payload instanceof Uint8Array)
      || await sha256Hex(value.payload) !== integritySha256) {
      await this.delete(integritySha256);
      throw new Error(`Cached dependency '${integritySha256}' failed integrity verification.`);
    }
    return value.payload.slice();
  }

  async save(integritySha256: string, payload: Uint8Array): Promise<void> {
    requireDigest(integritySha256);
    if (!(payload instanceof Uint8Array) || await sha256Hex(payload) !== integritySha256) {
      throw new Error("Dependency cache payload digest mismatch.");
    }
    const database = await this.open();
    const transaction = database.transaction(STORE, "readwrite");
    transaction.objectStore(STORE).put({ digest: integritySha256, payload: payload.slice() } satisfies DependencyPayloadRecord);
    await transactionDone(transaction);
  }

  async delete(integritySha256: string): Promise<void> {
    requireDigest(integritySha256);
    const database = await this.open();
    const transaction = database.transaction(STORE, "readwrite");
    transaction.objectStore(STORE).delete(integritySha256);
    await transactionDone(transaction);
  }

  async clear(): Promise<void> {
    const database = await this.open();
    const transaction = database.transaction(STORE, "readwrite");
    transaction.objectStore(STORE).clear();
    await transactionDone(transaction);
  }

  close(): void {
    const pending = this.database;
    this.database = undefined;
    void pending?.then((database) => database.close()).catch(() => undefined);
  }

  private open(): Promise<IDBDatabase> {
    this.database ??= new Promise((resolve, reject) => {
      const request = indexedDB.open(FORGE_STORAGE.dependencyCache, 1);
      request.addEventListener("upgradeneeded", () => {
        if (!request.result.objectStoreNames.contains(STORE)) {
          request.result.createObjectStore(STORE, { keyPath: "digest" });
        }
      });
      request.addEventListener("success", () => resolve(request.result), { once: true });
      request.addEventListener("error", () => reject(request.error ?? new Error("Unable to open dependency cache.")), { once: true });
      request.addEventListener("blocked", () => reject(new Error("Dependency cache upgrade is blocked by another tab.")), { once: true });
    });
    void this.database.catch(() => { this.database = undefined; });
    return this.database;
  }
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

function isRecord(value: unknown): value is DependencyPayloadRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    && Object.keys(value).sort().join(",") === "digest,payload";
}

function requireDigest(value: string): void {
  if (!SHA256.test(value)) throw new Error("Dependency integrity must be lowercase SHA-256 hexadecimal.");
}
