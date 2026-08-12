import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import { dispatchSubmissionJobs } from "./dispatcher";
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

describe("submission Workflow delivery", () => {
  it("creates the deterministic Workflow when Cloudflare reports instance.not_found", async () => {
    const database = new DatabaseSync(":memory:");
    database.exec(`CREATE TABLE submissions (
        id TEXT PRIMARY KEY, user_id TEXT NOT NULL, state TEXT NOT NULL,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        wasm_oj_release_id TEXT NOT NULL, wasm_oj_manifest_sha256 TEXT NOT NULL
      ) STRICT;
      CREATE TABLE submission_attempts (
        submission_id TEXT NOT NULL, attempt INTEGER NOT NULL,
        PRIMARY KEY (submission_id, attempt)
      ) STRICT;
      CREATE TABLE submission_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT, submission_id TEXT NOT NULL,
        event_key TEXT NOT NULL, payload_json TEXT NOT NULL, created_at TEXT NOT NULL,
        UNIQUE (submission_id, event_key)
      ) STRICT;
      CREATE TABLE workflow_outbox (
        id TEXT PRIMARY KEY, submission_id TEXT, state TEXT NOT NULL,
        attempts INTEGER NOT NULL, last_error TEXT, created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL, settled_at TEXT
      ) STRICT;
      CREATE TABLE rejudge_jobs (new_submission_id TEXT PRIMARY KEY) STRICT;
      INSERT INTO submissions VALUES (
        'submission', 'user', 'queued', '2026-08-12T00:00:00.000Z',
        '2026-08-12T00:00:00.000Z', 'release', '${"f".repeat(64)}'
      );
      INSERT INTO submission_attempts VALUES ('submission', 1);
      INSERT INTO workflow_outbox VALUES (
        'outbox', 'submission', 'pending', 0, NULL,
        '2026-08-12T00:00:00.000Z', '2026-08-12T00:00:00.000Z', NULL
      );`);
    const create = vi.fn(async () => undefined);
    const status = vi.fn().mockRejectedValueOnce(new Error("(instance.not_found) Instance not found"));
    const env = {
      DB: new SqliteD1(database) as unknown as D1Database,
      SUBMISSION_WORKFLOW: { create, get: vi.fn(async () => ({ status })) },
    } as unknown as WasmOjWorkerEnv;

    await expect(dispatchSubmissionJobs(env, 1)).resolves.toBe(1);
    expect(create).toHaveBeenCalledWith({
      id: "submission",
      params: {
        submissionId: "submission",
        attempt: 1,
        expectedReleaseId: "release",
        expectedManifestSha256: "f".repeat(64),
      },
    });
    expect(database.prepare(`SELECT state FROM submissions WHERE id='submission'`).get())
      .toEqual({ state: "preparing" });
    expect(database.prepare(`SELECT state, attempts, last_error, settled_at IS NOT NULL AS settled
      FROM workflow_outbox WHERE id='outbox'`).get()).toEqual({
      state: "delivered",
      attempts: 1,
      last_error: null,
      settled: 1,
    });
  });
});
