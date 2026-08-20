import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import type { WasmOjWorkerEnv } from "./env";
import { approveCliOfficialSubmissionRisk, requireOfficialSubmissionRiskTurnstile } from "./formal-access";
import { sha256Hex } from "./crypto";

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
  async all<T>(): Promise<{ readonly results: T[] }> {
    return { results: this.database.prepare(this.sql).all(...this.bindings) as T[] };
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

  it("returns a same-origin browser verification URL only to bearer submissions", async () => {
    const { database, env } = fixture();
    const recent = new Date().toISOString();
    for (let index = 0; index < 5; index += 1) insertSubmission(database, `origin-${index}`, `origin-${index}`, recent);
    const requestKey = "a".repeat(64);
    await expect(requireOfficialSubmissionRiskTurnstile(
      new Request("https://wasm-oj.example/api/submissions", { headers: { authorization: `Bearer ${"b".repeat(43)}` } }),
      env,
      "user",
      requestKey,
    )).rejects.toMatchObject({
      status: 403,
      code: "turnstile-required",
      details: {
        requestKey,
        verificationUrl: `https://wasm-oj.example/auth/cli/turnstile?requestKey=${requestKey}`,
      },
    });
  });

  it("verifies Turnstile in the browser and writes an account-bound exact-request allowance", async () => {
    const { database, env } = fixture();
    database.exec(`CREATE TABLE users (id TEXT PRIMARY KEY, status TEXT NOT NULL) STRICT;
      CREATE TABLE github_identities (user_id TEXT PRIMARY KEY, login TEXT NOT NULL, avatar_url TEXT NOT NULL) STRICT;
      CREATE TABLE sessions (token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL, csrf_hash TEXT NOT NULL, expires_at TEXT NOT NULL) STRICT;
      CREATE TABLE user_roles (user_id TEXT NOT NULL, role TEXT NOT NULL) STRICT;`);
    database.prepare("INSERT INTO users (id, status) VALUES ('user', 'active')").run();
    database.prepare("INSERT INTO github_identities (user_id, login, avatar_url) VALUES ('user', 'ada', 'https://example.test/ada.png')").run();
    database.prepare("INSERT INTO sessions (token_hash, user_id, csrf_hash, expires_at) VALUES (?, 'user', ?, '2099-01-01T00:00:00.000Z')")
      .run(await sha256Hex("session-token"), await sha256Hex("csrf-token"));
    const requestKey = "c".repeat(64);
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response(JSON.stringify({ success: true, hostname: "wasm-oj.example", action: "official-submit" }), {
      headers: { "content-type": "application/json" },
    });
    try {
      const response = await approveCliOfficialSubmissionRisk(new Request("https://wasm-oj.example/api/auth/cli/turnstile/approve", {
        method: "POST",
        headers: {
          origin: "https://wasm-oj.example",
          cookie: "wasm_oj_session=session-token; wasm_oj_csrf=csrf-token",
          "x-wasm-oj-csrf": "csrf-token",
          "x-wasm-oj-turnstile-token": "turnstile-token",
          "content-type": "application/json",
        },
        body: JSON.stringify({ requestKey }),
      }), env);
      expect(await response.json()).toMatchObject({ requestKey, state: "approved" });
      expect(database.prepare("SELECT user_id, request_key FROM formal_risk_allowances").get()).toEqual({ user_id: "user", request_key: requestKey });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
