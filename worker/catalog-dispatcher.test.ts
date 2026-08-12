import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import { dispatchCatalogJobs, redeliverClaimedCatalogJob } from "./catalog-dispatcher";
import type { WasmOjWorkerEnv } from "./env";

type Binding = null | number | bigint | string | NodeJS.ArrayBufferView;

class SqliteStatement {
  private bindings: readonly Binding[] = [];
  constructor(private readonly database: DatabaseSync, private readonly sql: string) {}
  bind(...values: Binding[]): SqliteStatement {
    this.bindings = values;
    return this;
  }
  async first<T>(): Promise<T | null> {
    return (this.database.prepare(this.sql).get(...this.bindings) as T | undefined) ?? null;
  }
  async run(): Promise<D1Result> {
    const result = this.database.prepare(this.sql).run(...this.bindings);
    return { meta: { changes: Number(result.changes) }, success: true } as D1Result;
  }
}

function fixture(
  create = vi.fn(async () => undefined),
  status = vi.fn(async () => ({ status: "unknown" })),
) {
  const database = new DatabaseSync(":memory:");
  database.exec(`CREATE TABLE problem_collections (
      id TEXT PRIMARY KEY, organizer_user_id TEXT NOT NULL
    ) STRICT;
    CREATE TABLE collection_revisions (
      id TEXT PRIMARY KEY, collection_id TEXT NOT NULL
    ) STRICT;
    CREATE TABLE catalog_validation_jobs (
      id TEXT PRIMARY KEY, collection_id TEXT NOT NULL, state TEXT NOT NULL,
      created_at TEXT NOT NULL, started_at TEXT, updated_at TEXT NOT NULL
    ) STRICT;
    CREATE TABLE catalog_publish_jobs (
      id TEXT PRIMARY KEY, collection_revision_id TEXT NOT NULL, state TEXT NOT NULL,
      created_at TEXT NOT NULL, started_at TEXT, updated_at TEXT NOT NULL
    ) STRICT;
    CREATE TABLE workflow_outbox (
      id TEXT PRIMARY KEY, state TEXT NOT NULL,
      catalog_validation_job_id TEXT, catalog_publish_job_id TEXT,
      attempts INTEGER NOT NULL DEFAULT 0, last_error TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL, settled_at TEXT
    ) STRICT;`);
  return {
    database,
    create,
    env: {
      DB: { prepare: (sql: string) => new SqliteStatement(database, sql) } as unknown as D1Database,
      CATALOG_WORKFLOW: { create, get: vi.fn(async () => ({ status })) },
    } as unknown as WasmOjWorkerEnv,
  };
}

function collection(database: DatabaseSync, id: string, organizer: string): void {
  database.prepare("INSERT INTO problem_collections VALUES (?, ?)").run(id, organizer);
}

function validation(
  database: DatabaseSync,
  input: { readonly id: string; readonly collection: string; readonly state: string; readonly created: string },
): void {
  database.prepare(`INSERT INTO catalog_validation_jobs
    (id, collection_id, state, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`)
    .run(input.id, input.collection, input.state, input.created, input.created);
  if (input.state === "queued" || input.state === "running") {
    database.prepare(`INSERT INTO workflow_outbox
      (id, state, catalog_validation_job_id, created_at, updated_at)
      VALUES (?, 'pending', ?, ?, ?)`)
      .run(`outbox-${input.id}`, input.id, input.created, input.created);
  }
}

describe("catalog FIFO dispatcher", () => {
  it("skips an organizer at its active cap and claims the oldest eligible job", async () => {
    const { database, env, create } = fixture();
    collection(database, "collection-a", "alice");
    collection(database, "collection-b", "bob");
    validation(database, { id: "alice-active", collection: "collection-a", state: "running", created: "2026-08-12T00:00:00.000Z" });
    validation(database, { id: "alice-oldest", collection: "collection-a", state: "queued", created: "2026-08-12T00:01:00.000Z" });
    validation(database, { id: "bob-next", collection: "collection-b", state: "queued", created: "2026-08-12T00:02:00.000Z" });

    await expect(dispatchCatalogJobs(env, 1)).resolves.toBe(1);
    expect(database.prepare("SELECT state FROM catalog_validation_jobs WHERE id='alice-oldest'").get()).toEqual({ state: "queued" });
    expect(database.prepare("SELECT state FROM catalog_validation_jobs WHERE id='bob-next'").get()).toEqual({ state: "running" });
    expect(create).toHaveBeenCalledWith({
      id: "catalog-validation-bob-next",
      params: { kind: "validation", jobId: "bob-next" },
    });
  });

  it("does not create a Workflow before one of the five global slots is available", async () => {
    const { database, env, create } = fixture();
    for (let index = 0; index < 6; index += 1) {
      collection(database, `collection-${index}`, `organizer-${index}`);
      validation(database, {
        id: `job-${index}`,
        collection: `collection-${index}`,
        state: index < 5 ? "running" : "queued",
        created: `2026-08-12T00:0${index}:00.000Z`,
      });
    }
    await expect(dispatchCatalogJobs(env)).resolves.toBe(0);
    expect(create).not.toHaveBeenCalled();
    expect(database.prepare("SELECT state FROM catalog_validation_jobs WHERE id='job-5'").get()).toEqual({ state: "queued" });
  });

  it("redelivers a claimed job with the same deterministic Workflow identity after create failure", async () => {
    const create = vi.fn()
      .mockRejectedValueOnce(new Error("injected lost acknowledgement"))
      .mockResolvedValueOnce(undefined);
    const { database, env } = fixture(create);
    collection(database, "collection-a", "alice");
    validation(database, { id: "job-a", collection: "collection-a", state: "queued", created: "2026-08-12T00:00:00.000Z" });

    await expect(dispatchCatalogJobs(env, 1)).resolves.toBe(1);
    expect(database.prepare("SELECT state FROM catalog_validation_jobs WHERE id='job-a'").get()).toEqual({ state: "running" });
    expect(database.prepare("SELECT state, attempts FROM workflow_outbox WHERE catalog_validation_job_id='job-a'").get())
      .toEqual({ state: "pending", attempts: 1 });

    await expect(redeliverClaimedCatalogJob(env, { kind: "validation", jobId: "job-a" })).resolves.toBe(true);
    expect(create.mock.calls.map(([request]) => request.id)).toEqual([
      "catalog-validation-job-a",
      "catalog-validation-job-a",
    ]);
    expect(database.prepare("SELECT state, attempts FROM workflow_outbox WHERE catalog_validation_job_id='job-a'").get())
      .toEqual({ state: "delivered", attempts: 2 });
  });

  it("settles a lost create acknowledgement after observing the deterministic Workflow", async () => {
    const create = vi.fn().mockRejectedValueOnce(new Error("injected lost acknowledgement"));
    const status = vi.fn()
      .mockResolvedValueOnce({ status: "unknown" })
      .mockResolvedValueOnce({ status: "running" });
    const { database, env } = fixture(create, status);
    collection(database, "collection-a", "alice");
    validation(database, { id: "job-a", collection: "collection-a", state: "queued", created: "2026-08-12T00:00:00.000Z" });

    await expect(dispatchCatalogJobs(env, 1)).resolves.toBe(1);
    expect(create).toHaveBeenCalledTimes(1);
    expect(database.prepare(`SELECT state, attempts, settled_at IS NOT NULL AS settled
      FROM workflow_outbox WHERE catalog_validation_job_id='job-a'`).get()).toEqual({
      state: "delivered",
      attempts: 1,
      settled: 1,
    });
  });

  it("does not consume a delivery attempt when Workflow status cannot be observed", async () => {
    const create = vi.fn(async () => undefined);
    const status = vi.fn().mockRejectedValueOnce(new Error("injected status outage"));
    const { database, env } = fixture(create, status);
    collection(database, "collection-a", "alice");
    validation(database, { id: "job-a", collection: "collection-a", state: "queued", created: "2026-08-12T00:00:00.000Z" });

    await expect(dispatchCatalogJobs(env, 1)).resolves.toBe(1);
    expect(create).not.toHaveBeenCalled();
    expect(database.prepare(`SELECT state, attempts, last_error
      FROM workflow_outbox WHERE catalog_validation_job_id='job-a'`).get()).toEqual({
      state: "pending",
      attempts: 0,
      last_error: "injected status outage",
    });
  });

  it("settles an already-existing Workflow without consuming a create attempt", async () => {
    const create = vi.fn(async () => undefined);
    const status = vi.fn().mockResolvedValue({ status: "running" });
    const { database, env } = fixture(create, status);
    collection(database, "collection-a", "alice");
    validation(database, { id: "job-a", collection: "collection-a", state: "queued", created: "2026-08-12T00:00:00.000Z" });

    await expect(dispatchCatalogJobs(env, 1)).resolves.toBe(1);
    expect(create).not.toHaveBeenCalled();
    expect(database.prepare(`SELECT state, attempts FROM workflow_outbox
      WHERE catalog_validation_job_id='job-a'`).get()).toEqual({
      state: "delivered",
      attempts: 0,
    });
  });
});
