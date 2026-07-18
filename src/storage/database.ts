import { artifactPayloadSha256 } from "../core/artifact-payload";
import { assertValidBuildArtifact } from "../core/artifact-validation";
import { FORGE_STORAGE } from "../core/contract";
import type { BuildArtifact, Project } from "../core/types";
import { assertValidProject } from "../core/project-validation";

const PROJECTS = "projects";
const ARTIFACTS = "artifacts";
const SHA256_HEX = /^[0-9a-f]{64}$/u;

interface PersistedArtifactRecord {
  artifact: BuildArtifact;
  cacheKey: string;
  createdAt: number;
  payloadSha256: string;
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.addEventListener("success", () => resolve(request.result), { once: true });
    request.addEventListener("error", () => {
      reject(request.error ?? new Error("IndexedDB request failed without an error."));
    }, { once: true });
  });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.addEventListener("complete", () => resolve(), { once: true });
    transaction.addEventListener("abort", () => {
      reject(transaction.error ?? new Error("IndexedDB transaction aborted without an error."));
    }, { once: true });
    transaction.addEventListener("error", () => {
      reject(transaction.error ?? new Error("IndexedDB transaction failed without an error."));
    }, { once: true });
  });
}

let databasePromise: Promise<IDBDatabase> | undefined;

function openDatabase(): Promise<IDBDatabase> {
  if (databasePromise) return databasePromise;
  const pending = new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(FORGE_STORAGE.database, FORGE_STORAGE.databaseVersion);
    let settled = false;
    const rejectOpen = (error: Error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    request.addEventListener("upgradeneeded", () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(PROJECTS)) {
        const store = database.createObjectStore(PROJECTS, { keyPath: "id" });
        store.createIndex("updatedAt", "updatedAt");
      }
      if (!database.objectStoreNames.contains(ARTIFACTS)) {
        const store = database.createObjectStore(ARTIFACTS, { keyPath: "cacheKey" });
        store.createIndex("createdAt", "createdAt");
      }
    });
    request.addEventListener("success", () => {
      const database = request.result;
      if (settled) {
        // A blocked request can still succeed after its public Promise has
        // rejected. Never leave that late connection holding the schema open.
        database.close();
        return;
      }
      settled = true;
      const release = () => {
        if (databasePromise === pending) databasePromise = undefined;
      };
      database.addEventListener("versionchange", () => {
        database.close();
        release();
      }, { once: true });
      database.addEventListener("close", release, { once: true });
      resolve(database);
    }, { once: true });
    request.addEventListener("error", () => {
      rejectOpen(request.error ?? new Error("Unable to open Forge storage."));
    }, { once: true });
    request.addEventListener("blocked", () => {
      rejectOpen(new Error("Forge storage upgrade is blocked by another open tab."));
    }, { once: true });
  });
  databasePromise = pending;
  void pending.catch(() => {
    if (databasePromise === pending) databasePromise = undefined;
  });
  return pending;
}

export async function saveProject(project: Project): Promise<void> {
  assertValidProject(project);
  const database = await openDatabase();
  const transaction = database.transaction(PROJECTS, "readwrite");
  transaction.objectStore(PROJECTS).put(project);
  await transactionDone(transaction);
}

export async function loadLatestProject(): Promise<Project | undefined> {
  return (await listProjects())[0];
}

export async function listProjects(): Promise<Project[]> {
  const database = await openDatabase();
  const transaction = database.transaction(PROJECTS, "readwrite");
  const projects = scanValidProjects(transaction.objectStore(PROJECTS));
  const [valid] = await Promise.all([projects, transactionDone(transaction)]);
  return valid.sort((left, right) => {
    const updated = right.updatedAt - left.updatedAt;
    return updated || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
  });
}

function scanValidProjects(store: IDBObjectStore): Promise<Project[]> {
  return new Promise((resolve, reject) => {
    const projects: Project[] = [];
    const request = store.openCursor();
    request.addEventListener("error", () => {
      reject(request.error ?? new Error("Unable to scan stored Forge projects."));
    }, { once: true });
    request.addEventListener("success", () => {
      const cursor = request.result;
      if (!cursor) {
        resolve(projects);
        return;
      }
      const candidate: unknown = cursor.value;
      try {
        assertValidProject(candidate);
        projects.push(candidate);
      } catch {
        try {
          cursor.delete();
        } catch (error) {
          reject(error);
          return;
        }
      }
      try {
        cursor.continue();
      } catch (error) {
        reject(error);
      }
    });
  });
}

export async function saveArtifact(artifact: BuildArtifact): Promise<void> {
  const snapshot = structuredClone(artifact);
  assertValidBuildArtifact(snapshot);
  const record: PersistedArtifactRecord = {
    artifact: snapshot,
    cacheKey: snapshot.cacheKey,
    createdAt: snapshot.createdAt,
    payloadSha256: await artifactPayloadSha256(snapshot),
  };
  const database = await openDatabase();
  const transaction = database.transaction(ARTIFACTS, "readwrite");
  transaction.objectStore(ARTIFACTS).put(record);
  await transactionDone(transaction);
  await pruneArtifacts(20);
}

export async function loadArtifact(cacheKey: string): Promise<BuildArtifact | undefined> {
  const database = await openDatabase();
  const transaction = database.transaction(ARTIFACTS, "readonly");
  const stored = await requestResult(transaction.objectStore(ARTIFACTS).get(cacheKey) as IDBRequest<unknown>);
  await transactionDone(transaction);
  if (stored === undefined) return undefined;

  let record: PersistedArtifactRecord;
  try {
    record = assertPersistedArtifactRecord(stored, cacheKey);
  } catch (error) {
    await evictInvalidArtifact(cacheKey, error);
    return undefined;
  }

  const actualDigest = await artifactPayloadSha256(record.artifact);
  if (actualDigest !== record.payloadSha256) {
    await evictInvalidArtifact(cacheKey, new Error("Artifact payload SHA-256 does not match its stored digest."));
    return undefined;
  }
  return record.artifact;
}

export async function deleteArtifact(cacheKey: string): Promise<void> {
  const database = await openDatabase();
  const transaction = database.transaction(ARTIFACTS, "readwrite");
  transaction.objectStore(ARTIFACTS).delete(cacheKey);
  await transactionDone(transaction);
}

export async function pruneArtifacts(retain: number): Promise<void> {
  if (!Number.isSafeInteger(retain) || retain < 0) {
    throw new RangeError("Artifact retention count must be a non-negative safe integer.");
  }
  const database = await openDatabase();
  const transaction = database.transaction(ARTIFACTS, "readwrite");
  const store = transaction.objectStore(ARTIFACTS);
  const artifacts = await requestResult(store.getAll() as IDBRequest<PersistedArtifactRecord[]>);
  artifacts
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(retain)
    .forEach((artifact) => store.delete(artifact.cacheKey));
  await transactionDone(transaction);
}

export async function clearArtifactCache(): Promise<void> {
  const database = await openDatabase();
  const transaction = database.transaction(ARTIFACTS, "readwrite");
  transaction.objectStore(ARTIFACTS).clear();
  await transactionDone(transaction);
}

export async function storageEstimate(): Promise<{ usage: number; quota: number }> {
  const estimate = await navigator.storage.estimate();
  return { usage: estimate.usage ?? 0, quota: estimate.quota ?? 0 };
}

export async function requestPersistentStorage(): Promise<boolean> {
  return navigator.storage.persist();
}

function assertPersistedArtifactRecord(value: unknown, requestedCacheKey: string): PersistedArtifactRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Persisted artifact record must be an object.");
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (JSON.stringify(keys) !== JSON.stringify(["artifact", "cacheKey", "createdAt", "payloadSha256"])) {
    throw new Error("Persisted artifact record has an invalid shape.");
  }
  if (record.cacheKey !== requestedCacheKey) {
    throw new Error("Persisted artifact record cache key does not match its IndexedDB key.");
  }
  if (typeof record.payloadSha256 !== "string" || !SHA256_HEX.test(record.payloadSha256)) {
    throw new Error("Persisted artifact payload digest must be a lowercase SHA-256 hexadecimal string.");
  }

  const artifact = record.artifact as BuildArtifact;
  assertValidBuildArtifact(artifact);
  if (artifact.cacheKey !== record.cacheKey || artifact.createdAt !== record.createdAt) {
    throw new Error("Persisted artifact index fields do not match the artifact metadata.");
  }
  return record as unknown as PersistedArtifactRecord;
}

async function evictInvalidArtifact(cacheKey: string, reason: unknown): Promise<void> {
  console.warn(`Ignoring invalid cached artifact '${cacheKey}'.`, reason);
  try {
    await deleteArtifact(cacheKey);
  } catch (error) {
    console.warn(`Unable to evict invalid cached artifact '${cacheKey}'.`, error);
  }
}
