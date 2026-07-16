import type { BuildArtifact, Project } from "@/src/core/types";

const DATABASE_NAME = "localwasi-studio";
const DATABASE_VERSION = 1;
const PROJECTS = "projects";
const ARTIFACTS = "artifacts";

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
    transaction.addEventListener("error", () => reject(transaction.error), { once: true });
  });
}

let databasePromise: Promise<IDBDatabase> | undefined;

function openDatabase(): Promise<IDBDatabase> {
  databasePromise ??= new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
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
    request.addEventListener("success", () => resolve(request.result), { once: true });
    request.addEventListener("error", () => reject(request.error), { once: true });
    request.addEventListener("blocked", () => reject(new Error("LocalWASI storage upgrade is blocked by another open tab.")), { once: true });
  });
  return databasePromise;
}

export async function saveProject(project: Project): Promise<void> {
  const database = await openDatabase();
  const transaction = database.transaction(PROJECTS, "readwrite");
  transaction.objectStore(PROJECTS).put(project);
  await transactionDone(transaction);
}

export async function loadLatestProject(): Promise<Project | undefined> {
  const database = await openDatabase();
  const transaction = database.transaction(PROJECTS, "readonly");
  const projects = await requestResult(transaction.objectStore(PROJECTS).getAll() as IDBRequest<Project[]>);
  await transactionDone(transaction);
  return projects.sort((a, b) => b.updatedAt - a.updatedAt)[0];
}

export async function listProjects(): Promise<Project[]> {
  const database = await openDatabase();
  const transaction = database.transaction(PROJECTS, "readonly");
  const projects = await requestResult(transaction.objectStore(PROJECTS).getAll() as IDBRequest<Project[]>);
  await transactionDone(transaction);
  return projects.sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function saveArtifact(artifact: BuildArtifact): Promise<void> {
  const database = await openDatabase();
  const transaction = database.transaction(ARTIFACTS, "readwrite");
  transaction.objectStore(ARTIFACTS).put(artifact);
  await transactionDone(transaction);
  await pruneArtifacts(20);
}

export async function loadArtifact(cacheKey: string): Promise<BuildArtifact | undefined> {
  const database = await openDatabase();
  const transaction = database.transaction(ARTIFACTS, "readonly");
  const artifact = await requestResult(transaction.objectStore(ARTIFACTS).get(cacheKey) as IDBRequest<BuildArtifact | undefined>);
  await transactionDone(transaction);
  return artifact;
}

export async function pruneArtifacts(retain: number): Promise<void> {
  const database = await openDatabase();
  const transaction = database.transaction(ARTIFACTS, "readwrite");
  const store = transaction.objectStore(ARTIFACTS);
  const artifacts = await requestResult(store.getAll() as IDBRequest<BuildArtifact[]>);
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
