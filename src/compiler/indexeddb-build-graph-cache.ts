import { WASM_OJ_SCHEMAS, WASM_OJ_STORAGE } from "../core/contract.ts";
import type {
  IncrementalBuildGraphBlob,
  IncrementalBuildGraphManifest,
  IncrementalBuildGraphState,
} from "./incremental-build-graph.ts";
import type { StorageEntry, StorageParticipant } from "../storage/types.ts";

const DATABASE_VERSION = 2;
const MANIFEST_STORE = "manifests";
const METADATA_STORE = "metadata";
const BLOB_STORE = "blobs";
const CLANG_KEY = "clang";
const encoder = new TextEncoder();

interface BuildGraphManifestRecord extends IncrementalBuildGraphManifest {
  id: typeof CLANG_KEY;
}

interface BuildGraphMetadataRecord {
  id: typeof CLANG_KEY;
  generation: number;
  blobBytes: number;
  manifestBytes: number;
  byteLength: number;
  lastAccessedAt: number;
}

interface BuildGraphBlobRecord extends IncrementalBuildGraphBlob {
  byteLength: number;
}

export interface ClangBuildGraphPersistenceAdapter {
  load: () => Promise<IncrementalBuildGraphState | undefined>;
  restore: (state: IncrementalBuildGraphState) => Promise<void>;
  capture: () => IncrementalBuildGraphState;
  save: (state: IncrementalBuildGraphState) => Promise<boolean>;
}

/**
 * Per-compiler-Worker persistence lifecycle. Merely constructing the
 * controller performs no I/O, so non-Clang worker initialization cannot
 * hydrate the graph. Persistence is skipped before IndexedDB when the graph's
 * mutation generation has not advanced.
 */
export class ClangBuildGraphPersistenceController {
  private readonly adapter: ClangBuildGraphPersistenceAdapter;
  private restoration: Promise<void> | undefined;
  private ready = false;
  private persistedGeneration = 0;

  constructor(adapter: ClangBuildGraphPersistenceAdapter) {
    this.adapter = adapter;
  }

  async ensureLoaded(): Promise<void> {
    if (this.ready) return;
    this.restoration ??= this.loadOnce();
    try {
      await this.restoration;
    } catch (error) {
      this.restoration = undefined;
      throw error;
    }
  }

  async persistIfDirty(): Promise<boolean> {
    if (!this.ready) return false;
    const state = this.adapter.capture();
    const generation = state.manifest.generation;
    if (generation === this.persistedGeneration) return false;
    if (generation < this.persistedGeneration) {
      throw new Error("Clang build graph generation moved backwards within one compiler Worker.");
    }
    const persisted = await this.adapter.save(state);
    this.persistedGeneration = generation;
    return persisted;
  }

  private async loadOnce(): Promise<void> {
    const state = await this.adapter.load();
    if (state) await this.adapter.restore(state);
    const generation = this.adapter.capture().manifest.generation;
    if (state && generation !== state.manifest.generation) {
      throw new Error("Restored Clang build graph generation does not match persisted state.");
    }
    this.persistedGeneration = generation;
    this.ready = true;
  }
}

/**
 * Load each referenced output blob exactly once, then update only the tiny
 * access-metadata record. The manifest never embeds artifact bytes.
 */
export async function loadClangBuildGraphState(): Promise<IncrementalBuildGraphState | undefined> {
  const database = await openDatabase();
  try {
    const transaction = database.transaction([MANIFEST_STORE, METADATA_STORE, BLOB_STORE], "readonly");
    const manifestRequest = transaction.objectStore(MANIFEST_STORE).get(CLANG_KEY) as IDBRequest<unknown>;
    const metadataRequest = transaction.objectStore(METADATA_STORE).get(CLANG_KEY) as IDBRequest<unknown>;
    const [manifestValue, metadataValue] = await Promise.all([
      requestResult(manifestRequest),
      requestResult(metadataRequest),
    ]);
    if (manifestValue === undefined && metadataValue === undefined) {
      await transactionDone(transaction);
      return undefined;
    }
    const manifest = parseManifestRecord(manifestValue);
    const metadata = parseMetadataRecord(metadataValue);
    if (metadata.generation !== manifest.generation) {
      throw new Error("Persisted Clang build graph generation metadata does not match its manifest.");
    }
    const referencedDigests = [...new Set(manifest.entries.map((entry) => entry.outputDigest))].sort();
    const blobStore = transaction.objectStore(BLOB_STORE);
    const blobValues = await Promise.all(referencedDigests.map((digest) => (
      requestResult(blobStore.get(digest) as IDBRequest<unknown>)
    )));
    await transactionDone(transaction);
    const blobs = blobValues.map((value, index) => parseBlobRecord(value, referencedDigests[index]!));
    assertStorageAccounting(stripManifestId(manifest), blobs, metadata);
    await touchBuildGraphMetadata(database, metadata);
    return {
      manifest: stripManifestId(manifest),
      blobs: blobs.map(({ digest, bytes }) => ({ digest, bytes })),
    };
  } finally {
    database.close();
  }
}

/**
 * Persist only a new graph generation. Existing digest records are retained
 * without a put, new digests are added once, and no-longer-referenced digests
 * are removed in the same transaction as the manifest swap.
 */
export async function saveClangBuildGraphState(state: IncrementalBuildGraphState): Promise<boolean> {
  const manifest = parseStateManifest(state);
  const blobs = parseStateBlobs(state);
  const database = await openDatabase();
  try {
    const transaction = database.transaction([MANIFEST_STORE, METADATA_STORE, BLOB_STORE], "readwrite");
    const metadataStore = transaction.objectStore(METADATA_STORE);
    const currentValue = await requestResult(metadataStore.get(CLANG_KEY) as IDBRequest<unknown>);
    if (currentValue !== undefined) {
      const current = parseMetadataRecord(currentValue);
      if (current.generation === manifest.generation) {
        await transactionDone(transaction);
        return false;
      }
    }

    const blobStore = transaction.objectStore(BLOB_STORE);
    const existingKeys = new Set((await requestResult(blobStore.getAllKeys())).map(String));
    const nextDigests = new Set(blobs.map((blob) => blob.digest));
    for (const blob of blobs) {
      if (existingKeys.has(blob.digest)) continue;
      blobStore.add({
        digest: blob.digest,
        byteLength: blob.bytes.byteLength,
        bytes: blob.bytes,
      } satisfies BuildGraphBlobRecord);
    }
    for (const digest of existingKeys) {
      if (!nextDigests.has(digest)) blobStore.delete(digest);
    }

    const manifestRecord: BuildGraphManifestRecord = { id: CLANG_KEY, ...manifest };
    const blobBytes = uniqueBlobBytes(blobs);
    const manifestBytes = persistedManifestByteLength(manifest);
    const byteLength = checkedAdd(blobBytes, manifestBytes);
    transaction.objectStore(MANIFEST_STORE).put(manifestRecord);
    metadataStore.put({
      id: CLANG_KEY,
      generation: manifest.generation,
      blobBytes,
      manifestBytes,
      byteLength,
      lastAccessedAt: Date.now(),
    } satisfies BuildGraphMetadataRecord);
    await transactionDone(transaction);
    return true;
  } finally {
    database.close();
  }
}

export function clearClangBuildGraphCache(): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(WASM_OJ_STORAGE.incrementalBuildCache);
    request.addEventListener("success", () => resolve(), { once: true });
    request.addEventListener("error", () => {
      reject(request.error ?? new Error("Unable to delete the incremental build cache."));
    }, { once: true });
    request.addEventListener("blocked", () => {
      reject(new Error("Incremental build cache deletion is blocked by another open tab."));
    }, { once: true });
  });
}

export async function listClangBuildGraphStorageEntries(): Promise<StorageEntry[]> {
  const database = await openDatabase();
  try {
    const transaction = database.transaction(METADATA_STORE, "readonly");
    const value = await requestResult(transaction.objectStore(METADATA_STORE).get(CLANG_KEY) as IDBRequest<unknown>);
    await transactionDone(transaction);
    if (value === undefined) return [];
    const metadata = parseMetadataRecord(value);
    return [{ key: CLANG_KEY, byteLength: metadata.byteLength, lastAccessedAt: metadata.lastAccessedAt }];
  } finally {
    database.close();
  }
}

export function clangBuildGraphStorageParticipant(): StorageParticipant {
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
    const request = indexedDB.open(WASM_OJ_STORAGE.incrementalBuildCache, DATABASE_VERSION);
    request.addEventListener("upgradeneeded", () => {
      const database = request.result;
      for (const storeName of [...database.objectStoreNames]) database.deleteObjectStore(storeName);
      database.createObjectStore(MANIFEST_STORE, { keyPath: "id" });
      database.createObjectStore(METADATA_STORE, { keyPath: "id" });
      database.createObjectStore(BLOB_STORE, { keyPath: "digest" });
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

async function touchBuildGraphMetadata(
  database: IDBDatabase,
  metadata: BuildGraphMetadataRecord,
): Promise<void> {
  const transaction = database.transaction(METADATA_STORE, "readwrite");
  transaction.objectStore(METADATA_STORE).put({ ...metadata, lastAccessedAt: Date.now() } satisfies BuildGraphMetadataRecord);
  await transactionDone(transaction);
}

function parseStateManifest(state: IncrementalBuildGraphState): IncrementalBuildGraphManifest {
  if (!state || typeof state !== "object" || Array.isArray(state)
    || Object.keys(state).sort().join(",") !== "blobs,manifest") {
    throw new Error("Clang build graph state has an invalid shape.");
  }
  return stripManifestId(parseManifestRecord({ id: CLANG_KEY, ...state.manifest }));
}

function parseStateBlobs(state: IncrementalBuildGraphState): IncrementalBuildGraphBlob[] {
  if (!Array.isArray(state.blobs)) throw new Error("Clang build graph state blobs must be an array.");
  const blobs = state.blobs.map((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)
      || Object.keys(value).sort().join(",") !== "bytes,digest") {
      throw new Error("Clang build graph state contains a malformed blob.");
    }
    if (typeof value.digest !== "string" || !/^[0-9a-f]{64}$/.test(value.digest)
      || !(value.bytes instanceof Uint8Array)) {
      throw new Error("Clang build graph state contains invalid blob metadata.");
    }
    return value;
  });
  for (let index = 0; index < blobs.length; index += 1) {
    if (index > 0 && blobs[index - 1]!.digest >= blobs[index]!.digest) {
      throw new Error("Clang build graph state blobs are not canonical or contain duplicates.");
    }
  }
  const referenced = new Set(state.manifest.entries.map((entry) => entry.outputDigest));
  if (referenced.size !== blobs.length || blobs.some((blob) => !referenced.has(blob.digest))) {
    throw new Error("Clang build graph state blobs do not exactly match its manifest references.");
  }
  return blobs;
}

function parseManifestRecord(value: unknown): BuildGraphManifestRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Persisted Clang build graph manifest has an invalid shape.");
  }
  const record = value as BuildGraphManifestRecord;
  if (Object.keys(record).sort().join(",") !== "entries,generation,id,schema,version"
    || record.id !== CLANG_KEY
    || record.schema !== WASM_OJ_SCHEMAS.incrementalBuildGraph
    || record.version !== 2
    || !Number.isSafeInteger(record.generation)
    || record.generation < 0
    || !Array.isArray(record.entries)) {
    throw new Error("Persisted Clang build graph manifest does not use the active storage contract.");
  }
  return record;
}

function parseMetadataRecord(value: unknown): BuildGraphMetadataRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Persisted Clang build graph metadata has an invalid shape.");
  }
  const record = value as BuildGraphMetadataRecord;
  if (Object.keys(record).sort().join(",") !== "blobBytes,byteLength,generation,id,lastAccessedAt,manifestBytes"
    || record.id !== CLANG_KEY
    || !validStorageInteger(record.generation)
    || !validStorageInteger(record.blobBytes)
    || !validStorageInteger(record.manifestBytes)
    || !validStorageInteger(record.byteLength)
    || !validStorageInteger(record.lastAccessedAt)
    || checkedAdd(record.blobBytes, record.manifestBytes) !== record.byteLength) {
    throw new Error("Persisted Clang build graph metadata has invalid storage accounting.");
  }
  return record;
}

function parseBlobRecord(value: unknown, expectedDigest: string): BuildGraphBlobRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Persisted Clang build graph blob '${expectedDigest}' is missing.`);
  }
  const record = value as BuildGraphBlobRecord;
  if (Object.keys(record).sort().join(",") !== "byteLength,bytes,digest"
    || record.digest !== expectedDigest
    || !validStorageInteger(record.byteLength)
    || !(record.bytes instanceof Uint8Array)
    || record.bytes.byteLength !== record.byteLength) {
    throw new Error(`Persisted Clang build graph blob '${expectedDigest}' has invalid metadata.`);
  }
  return record;
}

function stripManifestId(record: BuildGraphManifestRecord): IncrementalBuildGraphManifest {
  return {
    schema: record.schema,
    version: record.version,
    generation: record.generation,
    entries: record.entries,
  };
}

function assertStorageAccounting(
  manifest: IncrementalBuildGraphManifest,
  blobs: readonly IncrementalBuildGraphBlob[],
  metadata: BuildGraphMetadataRecord,
): void {
  if (uniqueBlobBytes(blobs) !== metadata.blobBytes
    || persistedManifestByteLength(manifest) !== metadata.manifestBytes) {
    throw new Error("Persisted Clang build graph storage accounting does not match its records.");
  }
}

function uniqueBlobBytes(blobs: readonly IncrementalBuildGraphBlob[]): number {
  let total = 0;
  const digests = new Set<string>();
  for (const blob of blobs) {
    if (digests.has(blob.digest)) throw new Error(`Clang build graph repeats blob '${blob.digest}'.`);
    digests.add(blob.digest);
    total = checkedAdd(total, blob.bytes.byteLength);
  }
  return total;
}

function persistedManifestByteLength(manifest: IncrementalBuildGraphManifest): number {
  return encoder.encode(JSON.stringify(manifest)).byteLength;
}

function checkedAdd(left: number, right: number): number {
  const result = left + right;
  if (!Number.isSafeInteger(result) || result < 0) {
    throw new Error("Incremental build graph byte length exceeds the safe integer range.");
  }
  return result;
}

function validStorageInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}
