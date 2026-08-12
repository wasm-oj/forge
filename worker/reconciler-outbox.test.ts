import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import type { WasmOjWorkerEnv } from "./env";
import { reconcilePendingOutbox } from "./reconciler";

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
  async all<T>(): Promise<{ readonly results: readonly T[] }> {
    return { results: this.database.prepare(this.sql).all(...this.bindings) as T[] };
  }
  async run(): Promise<D1Result> {
    const result = this.database.prepare(this.sql).run(...this.bindings);
    return { success: true, meta: { changes: Number(result.changes) } } as D1Result;
  }
}

class SqliteD1 {
  constructor(private readonly database: DatabaseSync) {}
  prepare(sql: string): SqliteStatement {
    return new SqliteStatement(this.database, sql);
  }
  async batch(statements: readonly SqliteStatement[]): Promise<readonly D1Result[]> {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const results = [];
      for (const statement of statements) results.push(await statement.run());
      this.database.exec("COMMIT");
      return results;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }
}

function fixture(
  status: () => Promise<{ readonly status: string }>,
  get = vi.fn(async () => ({ status })),
) {
  const database = new DatabaseSync(":memory:");
  database.exec(`CREATE TABLE submissions (
      id TEXT PRIMARY KEY, state TEXT NOT NULL, verdict TEXT, score REAL,
      fully_passed_cases INTEGER, updated_at TEXT NOT NULL, completed_at TEXT
    ) STRICT;
    CREATE TABLE submission_attempts (
      submission_id TEXT NOT NULL, state TEXT NOT NULL, finished_at TEXT, failure_code TEXT
    ) STRICT;
    CREATE TABLE submission_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT, submission_id TEXT NOT NULL,
      event_key TEXT NOT NULL, payload_json TEXT NOT NULL, created_at TEXT NOT NULL,
      UNIQUE (submission_id, event_key)
    ) STRICT;
    CREATE TABLE workflow_outbox (
      id TEXT PRIMARY KEY, catalog_validation_job_id TEXT, catalog_publish_job_id TEXT,
      submission_id TEXT, state TEXT NOT NULL, attempts INTEGER NOT NULL,
      last_error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, settled_at TEXT
    ) STRICT;`);
  database.prepare("INSERT INTO submissions VALUES ('submission', 'preparing', NULL, NULL, NULL, ?, NULL)")
    .run("2026-08-12T00:00:00.000Z");
  database.prepare("INSERT INTO submission_attempts VALUES ('submission', 'created', NULL, NULL)").run();
  database.prepare(`INSERT INTO workflow_outbox
      VALUES ('outbox', NULL, NULL, 'submission', 'pending', 20, NULL, ?, ?, NULL)`)
    .run("2026-08-12T00:00:00.000Z", "2026-08-12T00:00:00.000Z");
  return {
    database,
    env: {
      DB: new SqliteD1(database) as unknown as D1Database,
      SUBMISSION_WORKFLOW: { get },
    } as unknown as WasmOjWorkerEnv,
  };
}

describe("workflow outbox lost-ack reconciliation", () => {
  it("settles an exhausted row when its deterministic Workflow already exists", async () => {
    const { database, env } = fixture(async () => ({ status: "running" }));
    await expect(reconcilePendingOutbox(env)).resolves.toBe(1);
    expect(database.prepare("SELECT state, attempts, settled_at IS NOT NULL AS settled FROM workflow_outbox").get())
      .toEqual({ state: "delivered", attempts: 20, settled: 1 });
    expect(database.prepare("SELECT state FROM submissions").get()).toEqual({ state: "preparing" });
  });

  it("does not consume or exhaust attempts when status lookup fails", async () => {
    const { database, env } = fixture(async () => { throw new Error("status unavailable"); });
    await expect(reconcilePendingOutbox(env)).resolves.toBe(0);
    expect(database.prepare("SELECT state, attempts, last_error FROM workflow_outbox").get())
      .toEqual({ state: "pending", attempts: 20, last_error: "status unavailable" });
    expect(database.prepare("SELECT state FROM submissions").get()).toEqual({ state: "preparing" });
  });

  it("fails the target only after status explicitly reports unknown", async () => {
    const { database, env } = fixture(async () => ({ status: "unknown" }));
    await expect(reconcilePendingOutbox(env)).resolves.toBe(1);
    expect(database.prepare("SELECT state, attempts, last_error, settled_at IS NOT NULL AS settled FROM workflow_outbox").get())
      .toEqual({ state: "failed", attempts: 20, last_error: "workflow-delivery-exhausted", settled: 1 });
    expect(database.prepare("SELECT state, verdict FROM submissions").get())
      .toEqual({ state: "infrastructure-error", verdict: "judge-error" });
  });

  it("treats get instance.not_found as explicit unknown before exhausting attempts", async () => {
    const get = vi.fn(async () => { throw new Error("(instance.not_found) Instance not found"); });
    const { database, env } = fixture(async () => ({ status: "running" }), get);
    await expect(reconcilePendingOutbox(env)).resolves.toBe(1);
    expect(database.prepare("SELECT state, attempts, last_error FROM workflow_outbox").get())
      .toEqual({ state: "failed", attempts: 20, last_error: "workflow-delivery-exhausted" });
    expect(database.prepare("SELECT state, verdict FROM submissions").get())
      .toEqual({ state: "infrastructure-error", verdict: "judge-error" });
  });
});
