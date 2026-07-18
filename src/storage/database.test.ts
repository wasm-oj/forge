import { forceCloseDatabase, IDBFactory, IDBVersionChangeEvent } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FORGE_CONTRACT_VERSION } from "../core/contract";
import { costProfileId } from "../core/cost-profile";
import { DEFAULT_DETERMINISM } from "../core/determinism";
import { sha256Hex } from "../core/hash";
import { DEFAULT_RESOURCE_POLICY } from "../core/resources";
import { toolchainPackageIdentities } from "../core/toolchains";
import type { Project, WasmArtifact } from "../core/types";

function openDatabase(
  factory: IDBFactory,
  name: string,
  version: number,
): Promise<IDBDatabase> {
  const request = factory.open(name, version);
  return new Promise((resolve, reject) => {
    request.addEventListener("success", () => resolve(request.result), { once: true });
    request.addEventListener("error", () => {
      reject(request.error ?? new Error("Test database open failed without an error."));
    }, { once: true });
    request.addEventListener("blocked", () => {
      reject(new Error(`Test database open '${name}' at version ${version} was blocked.`));
    }, { once: true });
  });
}

function deleteDatabase(factory: IDBFactory, name: string): Promise<void> {
  const request = factory.deleteDatabase(name);
  return new Promise((resolve, reject) => {
    request.addEventListener("success", () => resolve(), { once: true });
    request.addEventListener("error", () => {
      reject(request.error ?? new Error("Test database deletion failed without an error."));
    }, { once: true });
    request.addEventListener("blocked", () => {
      reject(new Error(`Test database deletion '${name}' was blocked.`));
    }, { once: true });
  });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.addEventListener("complete", () => resolve(), { once: true });
    transaction.addEventListener("abort", () => {
      reject(transaction.error ?? new Error("Test transaction aborted without an error."));
    }, { once: true });
    transaction.addEventListener("error", () => {
      reject(transaction.error ?? new Error("Test transaction failed without an error."));
    }, { once: true });
  });
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.addEventListener("success", () => resolve(request.result), { once: true });
    request.addEventListener("error", () => {
      reject(request.error ?? new Error("Test request failed without an error."));
    }, { once: true });
  });
}

async function putRawProject(database: IDBDatabase, value: unknown): Promise<void> {
  const transaction = database.transaction("projects", "readwrite");
  transaction.objectStore("projects").put(value);
  await transactionDone(transaction);
}

async function rawProject(database: IDBDatabase, id: string): Promise<unknown> {
  const transaction = database.transaction("projects", "readonly");
  const value = await requestResult(transaction.objectStore("projects").get(id));
  await transactionDone(transaction);
  return value;
}

async function putRawArtifact(database: IDBDatabase, value: unknown): Promise<void> {
  const transaction = database.transaction("artifacts", "readwrite");
  transaction.objectStore("artifacts").put(value);
  await transactionDone(transaction);
}

async function rawArtifact(database: IDBDatabase, cacheKey: string): Promise<unknown> {
  const transaction = database.transaction("artifacts", "readonly");
  const value = await requestResult(transaction.objectStore("artifacts").get(cacheKey));
  await transactionDone(transaction);
  return value;
}

function project(id: string, updatedAt: number): Project {
  return {
    id,
    name: id,
    files: [{ path: "src/main.js", language: "javascript", content: "console.log(42);\n" }],
    config: {
      language: "javascript",
      target: "wasip1",
      optimization: "release",
      entry: "src/main.js",
      args: [],
      stdin: "",
      env: {},
      determinism: { ...DEFAULT_DETERMINISM },
      resources: { ...DEFAULT_RESOURCE_POLICY },
    },
    activeFile: "src/main.js",
    updatedAt,
  };
}

function artifact(cacheKey: string, bytes = new Uint8Array([0, 97, 115, 109])): WasmArtifact {
  return {
    kind: "wasm",
    forgeContract: FORGE_CONTRACT_VERSION,
    id: `artifact-${cacheKey}`,
    projectId: "project",
    cacheKey,
    name: "project.wasm",
    language: "c",
    target: "wasip1",
    optimization: "release",
    createdAt: 1,
    durationMs: 1,
    size: bytes.byteLength,
    toolchains: toolchainPackageIdentities("c"),
    costProfile: costProfileId("c", "wasip1", "release"),
    bytes,
  };
}

describe("browser storage database lifecycle", () => {
  let factory: IDBFactory;

  beforeEach(() => {
    vi.resetModules();
    vi.doUnmock("../core/contract");
    factory = new IDBFactory();
    vi.stubGlobal("indexedDB", factory);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.doUnmock("../core/contract");
    vi.resetModules();
  });

  it("evicts a rejected open so storage can retry after the external failure is removed", async () => {
    const { FORGE_STORAGE } = await vi.importActual<typeof import("../core/contract")>("../core/contract");
    const incompatible = await openDatabase(
      factory,
      FORGE_STORAGE.database,
      FORGE_STORAGE.databaseVersion + 1,
    );
    incompatible.close();
    const storage = await import("./database");

    await expect(storage.listProjects()).rejects.toMatchObject({ name: "VersionError" });
    await deleteDatabase(factory, FORGE_STORAGE.database);
    await expect(storage.listProjects()).resolves.toEqual([]);
  });

  it("closes an eventual connection that succeeds after its blocked open already rejected", async () => {
    const actual = await vi.importActual<typeof import("../core/contract")>("../core/contract");
    const database = `${actual.FORGE_STORAGE.database}:blocked-open-test`;
    const blocker = await openDatabase(factory, database, 1);
    vi.doMock("../core/contract", () => ({
      ...actual,
      FORGE_STORAGE: {
        ...actual.FORGE_STORAGE,
        database,
        databaseVersion: 2,
      },
    }));
    const storage = await import("./database");

    await expect(storage.listProjects()).rejects.toThrow("blocked by another open tab");
    blocker.close();

    // The rejected version-2 request now completes. Its late connection must
    // close immediately, otherwise this version-3 upgrade reports `blocked`.
    const upgrade = await openDatabase(factory, database, 3);
    upgrade.close();
  });

  it("releases and forgets the cached connection on versionchange", async () => {
    const { FORGE_STORAGE } = await vi.importActual<typeof import("../core/contract")>("../core/contract");
    const storage = await import("./database");
    await expect(storage.listProjects()).resolves.toEqual([]);

    // A live cached Forge connection would block this upgrade. The
    // versionchange handler must close it and clear the memoized Promise.
    const upgrade = await openDatabase(
      factory,
      FORGE_STORAGE.database,
      FORGE_STORAGE.databaseVersion + 1,
    );
    upgrade.close();
    await deleteDatabase(factory, FORGE_STORAGE.database);

    await expect(storage.listProjects()).resolves.toEqual([]);
  });

  it("forgets an unexpectedly closed connection and opens a fresh one", async () => {
    const open = vi.spyOn(factory, "open");
    const storage = await import("./database");
    await expect(storage.listProjects()).resolves.toEqual([]);
    const firstRequest = open.mock.results[0]?.value;
    if (!firstRequest) throw new Error("Storage did not issue its initial IndexedDB open request.");

    forceCloseDatabase(firstRequest.result);

    await expect(storage.listProjects()).resolves.toEqual([]);
    expect(open).toHaveBeenCalledTimes(2);
    expect(open.mock.results[1]?.value.result).not.toBe(firstRequest.result);
  });

  it("does not let delayed events from an old connection evict its replacement", async () => {
    const open = vi.spyOn(factory, "open");
    const storage = await import("./database");
    await storage.listProjects();
    const first = open.mock.results[0]?.value.result;
    if (!first) throw new Error("Storage did not open its first IndexedDB connection.");

    first.dispatchEvent(new IDBVersionChangeEvent("versionchange"));
    await storage.listProjects();
    const second = open.mock.results[1]?.value.result;
    if (!second) throw new Error("Storage did not replace its version-changed connection.");
    forceCloseDatabase(first);
    await storage.listProjects();
    expect(open).toHaveBeenCalledTimes(2);

    forceCloseDatabase(second);
    await storage.listProjects();
    second.dispatchEvent(new IDBVersionChangeEvent("versionchange"));
    await storage.listProjects();
    expect(open).toHaveBeenCalledTimes(3);
  });

  it("rejects invalid retention counts before opening storage", async () => {
    const storage = await import("./database");
    await expect(storage.pruneArtifacts(-1)).rejects.toThrow("non-negative safe integer");
    await expect(storage.pruneArtifacts(0.5)).rejects.toThrow("non-negative safe integer");
  });

  it("verifies direct Wasm payload SHA-256 and evicts only a mutated artifact", async () => {
    const { FORGE_STORAGE } = await vi.importActual<typeof import("../core/contract")>("../core/contract");
    const storage = await import("./database");
    const clean = artifact("clean");
    const corrupted = artifact("corrupted", new Uint8Array([0, 97, 115, 109, 1]));
    await storage.saveArtifact(clean);
    await storage.saveArtifact(corrupted);
    const database = await openDatabase(factory, FORGE_STORAGE.database, FORGE_STORAGE.databaseVersion);
    const stored = await rawArtifact(database, corrupted.cacheKey) as {
      artifact: WasmArtifact;
      payloadSha256: string;
    };
    expect(stored.payloadSha256).toBe(await sha256Hex(corrupted.bytes));
    stored.artifact.bytes[4] = 2;
    await putRawArtifact(database, stored);
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    await expect(storage.loadArtifact(corrupted.cacheKey)).resolves.toBeUndefined();
    await expect(rawArtifact(database, corrupted.cacheKey)).resolves.toBeUndefined();
    await expect(storage.loadArtifact(clean.cacheKey)).resolves.toMatchObject({ cacheKey: clean.cacheKey });
    expect(warning).toHaveBeenCalledWith(
      expect.stringContaining(`'${corrupted.cacheKey}'`),
      expect.any(Error),
    );
    database.close();
  });

  it("deletes exactly the requested persisted artifact", async () => {
    const storage = await import("./database");
    await storage.saveArtifact(artifact("remove"));
    await storage.saveArtifact(artifact("retain"));

    await storage.deleteArtifact("remove");

    await expect(storage.loadArtifact("remove")).resolves.toBeUndefined();
    await expect(storage.loadArtifact("retain")).resolves.toMatchObject({ cacheKey: "retain" });
  });

  it("rejects an invalid project before opening IndexedDB", async () => {
    const open = vi.spyOn(factory, "open");
    const storage = await import("./database");
    await expect(storage.saveProject({ ...project("invalid", 1), name: " invalid " }))
      .rejects.toThrow("Project name must be a non-empty, trimmed string");
    expect(open).not.toHaveBeenCalled();
  });

  it("evicts an invalid newest record and returns the next valid draft", async () => {
    const { FORGE_STORAGE } = await vi.importActual<typeof import("../core/contract")>("../core/contract");
    const storage = await import("./database");
    await storage.saveProject(project("valid-older", 10));
    const database = await openDatabase(factory, FORGE_STORAGE.database, FORGE_STORAGE.databaseVersion);
    await putRawProject(database, {
      ...project("invalid-newest", 20),
      config: { ...project("invalid-newest", 20).config, target: "preview2" },
    });

    await expect(storage.loadLatestProject()).resolves.toMatchObject({ id: "valid-older" });
    await expect(rawProject(database, "invalid-newest")).resolves.toBeUndefined();
    database.close();
  });

  it("removes every malformed record while preserving and sorting valid drafts", async () => {
    const { FORGE_STORAGE } = await vi.importActual<typeof import("../core/contract")>("../core/contract");
    const storage = await import("./database");
    await storage.saveProject(project("valid-old", 10));
    await storage.saveProject(project("valid-new", 20));
    const database = await openDatabase(factory, FORGE_STORAGE.database, FORGE_STORAGE.databaseVersion);
    await putRawProject(database, { ...project("invalid-files", 30), files: [] });
    await putRawProject(database, { ...project("invalid-extra", 40), obsoleteVersion: 2 });

    await expect(storage.listProjects()).resolves.toMatchObject([
      { id: "valid-new" },
      { id: "valid-old" },
    ]);
    await expect(rawProject(database, "invalid-files")).resolves.toBeUndefined();
    await expect(rawProject(database, "invalid-extra")).resolves.toBeUndefined();
    database.close();
  });
});
