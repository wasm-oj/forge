import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { sha256Hex } from "./crypto";
import type { WasmOjWorkerEnv } from "./env";
import { appendAuthorizedSubmissionEvent } from "./submission-events";
import type { HydratedSubmissionWorkflow } from "./submission-workflow-context";
import { createRetryAttempt } from "./submission-retry";

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

  async run(): Promise<{ readonly success: true; readonly meta: { readonly changes: number } }> {
    const result = this.database.prepare(this.sql).run(...this.bindings);
    return { success: true, meta: { changes: Number(result.changes) } };
  }
}

class SqliteD1 {
  constructor(private readonly database: DatabaseSync) {}

  prepare(sql: string): SqliteStatement {
    return new SqliteStatement(this.database, sql);
  }

  async batch(statements: readonly SqliteStatement[]): Promise<readonly {
    readonly success: true;
    readonly meta: { readonly changes: number };
  }[]> {
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

const SUBMISSION_ID = "00000000-0000-4000-8000-000000000001";
const TOKEN = "retry-attempt-token";

function fixture(state: "preparing" | "compiling" | "running" | "finalizing") {
  const database = new DatabaseSync(":memory:");
  database.exec(`CREATE TABLE submissions (
      id TEXT PRIMARY KEY, state TEXT NOT NULL, updated_at TEXT NOT NULL
    ) STRICT;
    CREATE TABLE submission_attempts (
      submission_id TEXT NOT NULL, attempt INTEGER NOT NULL, token_hash TEXT NOT NULL,
      state TEXT NOT NULL, started_at TEXT, finished_at TEXT, failure_code TEXT,
      PRIMARY KEY (submission_id, attempt)
    ) STRICT;
    CREATE TABLE submission_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT, submission_id TEXT NOT NULL,
      event_key TEXT NOT NULL, payload_json TEXT NOT NULL, created_at TEXT NOT NULL,
      UNIQUE (submission_id, event_key)
    ) STRICT;`);
  database.prepare("INSERT INTO submissions VALUES (?, ?, '2026-08-12T00:00:00.000Z')")
    .run(SUBMISSION_ID, state);
  database.prepare("INSERT INTO submission_attempts VALUES (?, 1, 'first-token', 'running', '2026-08-12T00:00:00.000Z', NULL, NULL)")
    .run(SUBMISSION_ID);
  const env = { DB: new SqliteD1(database) as unknown as D1Database } as WasmOjWorkerEnv;
  const submission = { submissionId: SUBMISSION_ID } as HydratedSubmissionWorkflow;
  return { database, env, submission };
}

describe("submission Workflow infrastructure retry", () => {
  for (const state of ["preparing", "compiling", "running", "finalizing"] as const) {
    it(`atomically resets ${state} to preparing before attempt 2 callbacks`, async () => {
      const { database, env, submission } = fixture(state);
      await createRetryAttempt(env, submission, 1, 2, TOKEN);

      expect(database.prepare("SELECT state FROM submissions WHERE id=?").get(SUBMISSION_ID))
        .toEqual({ state: "preparing" });
      expect(database.prepare("SELECT attempt, state, failure_code FROM submission_attempts ORDER BY attempt").all())
        .toEqual([
          { attempt: 1, state: "failed", failure_code: "container-failure" },
          { attempt: 2, state: "created", failure_code: null },
        ]);

      const tokenHash = await sha256Hex(TOKEN);
      await expect(appendAuthorizedSubmissionEvent(env, {
        submissionId: SUBMISSION_ID,
        attempt: 2,
        attemptTokenHash: tokenHash,
        eventKey: "container:2:preparing",
        event: { kind: "state", state: "preparing" },
      })).resolves.toMatchObject({ duplicate: false });

      await expect(createRetryAttempt(env, submission, 1, 2, TOKEN)).resolves.toBeUndefined();
      expect(database.prepare("SELECT COUNT(*) AS count FROM submission_events").get())
        .toEqual({ count: 2 });
    });
  }
});
