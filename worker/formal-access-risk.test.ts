import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import type { WasmOjWorkerEnv } from "./env";
import { requireOfficialSubmissionRiskTurnstile } from "./formal-access";

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
  async run(): Promise<{ readonly meta: { readonly changes: number } }> {
    return { meta: { changes: Number(this.database.prepare(this.sql).run(...this.bindings).changes) } };
  }
}

function fixture(): { readonly database: DatabaseSync; readonly env: WasmOjWorkerEnv } {
  const database = new DatabaseSync(":memory:");
  database.exec(`CREATE TABLE submissions (
      id TEXT PRIMARY KEY, origin_submission_id TEXT NOT NULL, user_id TEXT NOT NULL,
      state TEXT NOT NULL, deterministic_cost INTEGER, created_at TEXT NOT NULL,
      completed_at TEXT
    ) STRICT;
    CREATE TABLE formal_risk_allowances (
      user_id TEXT NOT NULL, request_key TEXT NOT NULL, expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL, PRIMARY KEY (user_id, request_key)
    ) STRICT;`);
  return {
    database,
    env: {
      DB: { prepare: (sql: string) => new SqliteStatement(database, sql) } as unknown as D1Database,
      ENVIRONMENT: "production",
      PUBLIC_ORIGIN: "https://wasm-oj.example",
      TURNSTILE_SECRET_KEY: "test-secret",
    } as WasmOjWorkerEnv,
  };
}

function insertSubmission(
  database: DatabaseSync,
  id: string,
  originId: string,
  createdAt: string,
): void {
  database.prepare(`INSERT INTO submissions
      (id, origin_submission_id, user_id, state, deterministic_cost, created_at, completed_at)
    VALUES (?, ?, 'user', 'completed', 1, ?, ?)`)
    .run(id, originId, createdAt, createdAt);
}

describe("Official Submit risk identity", () => {
  it("excludes rejudge children from velocity and failure signals", async () => {
    const { database, env } = fixture();
    insertSubmission(database, "origin", "origin", "2020-01-01T00:00:00.000Z");
    const recent = new Date().toISOString();
    for (let index = 0; index < 10; index += 1) {
      insertSubmission(database, `child-${index}`, "origin", recent);
    }

    await expect(requireOfficialSubmissionRiskTurnstile(
      new Request("https://wasm-oj.example/api/submissions"),
      env,
      "user",
      "request-key",
    )).resolves.toBeUndefined();
  });

  it("continues to count original submissions", async () => {
    const { database, env } = fixture();
    const recent = new Date().toISOString();
    for (let index = 0; index < 5; index += 1) {
      insertSubmission(database, `origin-${index}`, `origin-${index}`, recent);
    }

    await expect(requireOfficialSubmissionRiskTurnstile(
      new Request("https://wasm-oj.example/api/submissions"),
      env,
      "user",
      "request-key",
    )).rejects.toMatchObject({ code: "turnstile-required" });
  });
});
