import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import type { WasmOjWorkerEnv } from "./env";
import { dispatchCatalogJobs, redeliverClaimedCatalogJob } from "./catalog-dispatcher";

class Statement {
  private values: SQLInputValue[] = [];
  constructor(private readonly database: DatabaseSync, private readonly sql: string) {}
  bind(...values: unknown[]) { this.values = values as SQLInputValue[]; return this; }
  async first<T>(): Promise<T | null> { return (this.database.prepare(this.sql).get(...this.values) as T | undefined) ?? null; }
  async run(): Promise<D1Result> { const result = this.database.prepare(this.sql).run(...this.values); return { success: true, meta: { changes: Number(result.changes) } } as D1Result; }
}

function fixture(create = vi.fn(async () => undefined)) {
  const database = new DatabaseSync(":memory:");
  database.exec(`CREATE TABLE catalogs (id TEXT PRIMARY KEY, organizer_user_id TEXT NOT NULL) STRICT;
    CREATE TABLE catalog_sync_jobs (id TEXT PRIMARY KEY, catalog_id TEXT NOT NULL, state TEXT NOT NULL, created_at TEXT NOT NULL, started_at TEXT, updated_at TEXT NOT NULL) STRICT;
    CREATE TABLE workflow_outbox (id TEXT PRIMARY KEY, catalog_sync_job_id TEXT, state TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, last_error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, settled_at TEXT) STRICT;`);
  const status = vi.fn(async () => ({ status: "unknown" }));
  return { database, create, env: { DB: { prepare: (sql: string) => new Statement(database, sql) }, CATALOG_WORKFLOW: { create, get: vi.fn(async () => ({ status })) } } as unknown as WasmOjWorkerEnv };
}

function queue(database: DatabaseSync, id: string, catalog: string, organizer: string, created: string) {
  database.prepare("INSERT OR IGNORE INTO catalogs VALUES (?, ?)").run(catalog, organizer);
  database.prepare("INSERT INTO catalog_sync_jobs (id,catalog_id,state,created_at,updated_at) VALUES (?,?,'queued',?,?)").run(id, catalog, created, created);
  database.prepare("INSERT INTO workflow_outbox (id,catalog_sync_job_id,state,created_at,updated_at) VALUES (?,?,'pending',?,?)").run(`outbox-${id}`, id, created, created);
}

describe("catalog sync dispatcher", () => {
  it("claims the oldest eligible job and creates one deterministic Workflow", async () => {
    const { database, env, create } = fixture();
    queue(database, "11111111-1111-4111-8111-111111111111", "cat-a", "alice", "2026-08-12T00:00:00.000Z");
    queue(database, "22222222-2222-4222-8222-222222222222", "cat-b", "bob", "2026-08-12T00:01:00.000Z");
    await expect(dispatchCatalogJobs(env, 1)).resolves.toBe(1);
    expect(create).toHaveBeenCalledWith({ id: "catalog-sync-11111111-1111-4111-8111-111111111111", params: { syncJobId: "11111111-1111-4111-8111-111111111111" } });
  });

  it("redelivers the same claimed sync identity", async () => {
    const create = vi.fn().mockRejectedValueOnce(new Error("lost acknowledgement")).mockResolvedValueOnce(undefined);
    const { database, env } = fixture(create);
    const id = "11111111-1111-4111-8111-111111111111";
    queue(database, id, "cat-a", "alice", "2026-08-12T00:00:00.000Z");
    await dispatchCatalogJobs(env, 1);
    await expect(redeliverClaimedCatalogJob(env, { syncJobId: id })).resolves.toBe(true);
    expect(create).toHaveBeenCalledTimes(2);
  });
});
