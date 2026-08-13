import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";
import {
  approveCliLogin,
  authenticatedSession,
  exchangeCliLoginToken,
  getCliLoginFlow,
  logout,
  requireBrowserMutationSession,
  requireBrowserOrBearerMutationSession,
  startCliLogin,
} from "./auth";
import { base64Url, sha256Hex } from "./crypto";
import type { WasmOjWorkerEnv } from "./env";

const ORIGIN = "https://wasm-oj.test";
const USER_ID = "11111111-1111-4111-8111-111111111111";
const SESSION_TOKEN = "browser-session-token";
const CSRF_TOKEN = "browser-csrf-token";
const VERIFIER = "test-verifier-which-is-long-enough-for-pkce-1234";

class TestD1Statement {
  #values: (string | number | bigint | null | Uint8Array)[] = [];

  constructor(readonly statement: StatementSync) {}

  bind(...values: unknown[]) {
    this.#values = values as (string | number | bigint | null | Uint8Array)[];
    return this;
  }

  async first<T>(): Promise<T | null> {
    return (this.statement.get(...this.#values) as T | undefined) ?? null;
  }

  async all<T>(): Promise<{ results: T[] }> {
    return { results: this.statement.all(...this.#values) as T[] };
  }

  async run(): Promise<D1Result> {
    return this.runSync();
  }

  runSync(): D1Result {
    const result = this.statement.run(...this.#values);
    return { success: true, meta: { changes: Number(result.changes) }, results: [] } as unknown as D1Result;
  }
}

class TestD1 {
  readonly sqlite = new DatabaseSync(":memory:");

  prepare(sql: string): TestD1Statement {
    return new TestD1Statement(this.sqlite.prepare(sql));
  }

  async batch(statements: readonly TestD1Statement[]): Promise<D1Result[]> {
    this.sqlite.exec("BEGIN IMMEDIATE");
    try {
      const results = statements.map((statement) => statement.runSync());
      this.sqlite.exec("COMMIT");
      return results;
    } catch (error) {
      this.sqlite.exec("ROLLBACK");
      throw error;
    }
  }
}

async function challenge(verifier: string): Promise<string> {
  return base64Url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
}

function jsonRequest(path: string, body: unknown, headers?: HeadersInit): Request {
  return new Request(`${ORIGIN}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

function browserHeaders(): HeadersInit {
  return {
    origin: ORIGIN,
    cookie: `wasm_oj_session=${SESSION_TOKEN}; wasm_oj_csrf=${CSRF_TOKEN}`,
    "x-wasm-oj-csrf": CSRF_TOKEN,
  };
}

describe("CLI browser-assisted authentication", () => {
  let database: TestD1;
  let env: WasmOjWorkerEnv;

  beforeEach(async () => {
    database = new TestD1();
    database.sqlite.exec(readFileSync(join(process.cwd(), "migrations/core/0001_initial.sql"), "utf8"));
    database.sqlite.exec(readFileSync(join(process.cwd(), "migrations/core/0018_cli_auth.sql"), "utf8"));
    const now = new Date().toISOString();
    database.sqlite.prepare("INSERT INTO users (id, created_at, updated_at, status) VALUES (?, ?, ?, 'active')").run(USER_ID, now, now);
    database.sqlite.prepare("INSERT INTO github_identities (github_user_id, user_id, login, avatar_url, profile_url, updated_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(42, USER_ID, "ada", "https://example.test/ada.png", "https://github.com/ada", now);
    database.sqlite.prepare("INSERT INTO user_roles (user_id, role, granted_at) VALUES (?, 'organizer', ?)").run(USER_ID, now);
    database.sqlite.prepare("INSERT INTO sessions (token_hash, user_id, csrf_hash, created_at, expires_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(await sha256Hex(SESSION_TOKEN), USER_ID, await sha256Hex(CSRF_TOKEN), now, "2099-01-01T00:00:00.000Z", now);
    env = { DB: database as unknown as D1Database, PUBLIC_ORIGIN: ORIGIN } as WasmOjWorkerEnv;
  });

  it("creates only a bounded S256 flow with an exact request shape", async () => {
    const response = await startCliLogin(jsonRequest("/api/auth/cli/start", {
      codeChallenge: await challenge(VERIFIER),
      deviceName: "Ada's laptop",
    }), env);
    expect(response.status).toBe(201);
    const body = await response.json() as Record<string, unknown>;
    expect(body).toMatchObject({
      verificationUrl: `${ORIGIN}/auth/cli?flow=${body.flowId}`,
      pollIntervalSeconds: 2,
    });
    const stored = database.sqlite.prepare("SELECT code_challenge, device_name, approved_user_id, exchanged_at FROM cli_login_flows WHERE id = ?")
      .get(body.flowId as string) as Record<string, unknown>;
    expect(stored).toEqual({ code_challenge: await challenge(VERIFIER), device_name: "Ada's laptop", approved_user_id: null, exchanged_at: null });

    await expect(startCliLogin(jsonRequest("/api/auth/cli/start", {
      codeChallenge: await challenge(VERIFIER), deviceName: "Ada's laptop", ignored: true,
    }), env)).rejects.toMatchObject({ status: 400, code: "invalid-request" });
    await expect(startCliLogin(jsonRequest("/api/auth/cli/start", {
      codeChallenge: await challenge(VERIFIER), deviceName: "Ada\u200b laptop",
    }), env)).rejects.toMatchObject({ status: 400, code: "invalid-device-name" });
  });

  it("requires browser CSRF approval, exposes pending state, and issues one hashed token", async () => {
    const started = await startCliLogin(jsonRequest("/api/auth/cli/start", {
      codeChallenge: await challenge(VERIFIER), deviceName: "Terminal on MacBook",
    }), env);
    const { flowId } = await started.json() as { flowId: string };

    const pending = exchangeCliLoginToken(jsonRequest("/api/auth/cli/token", { flowId, codeVerifier: VERIFIER }), env);
    await expect(pending).rejects.toMatchObject({ status: 428, code: "cli-login-pending" });

    const flowResponse = await getCliLoginFlow(new Request(`${ORIGIN}/api/auth/cli/flows/${flowId}`, {
      headers: { cookie: `wasm_oj_session=${SESSION_TOKEN}` },
    }), env, flowId);
    expect(await flowResponse.json()).toMatchObject({ deviceName: "Terminal on MacBook", state: "pending", approvedByCurrentUser: false });

    await expect(approveCliLogin(jsonRequest(`/api/auth/cli/flows/${flowId}/approve`, {}, {
      cookie: `wasm_oj_session=${SESSION_TOKEN}; wasm_oj_csrf=${CSRF_TOKEN}`,
      "x-wasm-oj-csrf": CSRF_TOKEN,
      origin: "https://attacker.test",
    }), env, flowId)).rejects.toMatchObject({ status: 403, code: "origin-rejected" });

    const approval = await approveCliLogin(jsonRequest(`/api/auth/cli/flows/${flowId}/approve`, {}, browserHeaders()), env, flowId);
    expect(await approval.json()).toMatchObject({ flowId, state: "approved" });

    const exchanges = await Promise.allSettled([
      exchangeCliLoginToken(jsonRequest("/api/auth/cli/token", { flowId, codeVerifier: VERIFIER }), env),
      exchangeCliLoginToken(jsonRequest("/api/auth/cli/token", { flowId, codeVerifier: VERIFIER }), env),
    ]);
    const fulfilled = exchanges.filter((result): result is PromiseFulfilledResult<Response> => result.status === "fulfilled");
    const rejected = exchanges.filter((result): result is PromiseRejectedResult => result.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.reason).toMatchObject({ status: 409 });
    const tokenBody = await fulfilled[0]!.value.json() as { accessToken: string; tokenType: string };
    expect(tokenBody.tokenType).toBe("Bearer");
    expect(database.sqlite.prepare("SELECT COUNT(*) AS count FROM cli_access_tokens").get()).toEqual({ count: 1 });
    const stored = database.sqlite.prepare("SELECT token_hash FROM cli_access_tokens").get() as { token_hash: string };
    expect(stored.token_hash).toBe(await sha256Hex(tokenBody.accessToken));
    expect(stored.token_hash).not.toContain(tokenBody.accessToken);

    const session = await authenticatedSession(new Request(`${ORIGIN}/api/auth/session`, {
      headers: { authorization: `Bearer ${tokenBody.accessToken}` },
    }), env);
    expect(session).toMatchObject({ userId: USER_ID, login: "ada", roles: ["organizer"] });

    await expect(requireBrowserMutationSession(new Request(`${ORIGIN}/api/admin/formal-mutations/resume`, {
      method: "POST",
      headers: { authorization: `Bearer ${tokenBody.accessToken}`, origin: ORIGIN },
    }), env)).rejects.toMatchObject({ status: 401, code: "browser-authentication-required" });

    const logoutResponse = await logout(jsonRequest("/api/auth/logout", {}, { authorization: `Bearer ${tokenBody.accessToken}` }), env);
    expect(await logoutResponse.json()).toEqual({ ok: true });
    expect(await authenticatedSession(new Request(`${ORIGIN}/api/auth/session`, {
      headers: { authorization: `Bearer ${tokenBody.accessToken}` },
    }), env)).toBeUndefined();
  });

  it("never falls back to a valid browser cookie when Authorization is malformed", async () => {
    const mixed = new Request(`${ORIGIN}/api/auth/session`, {
      headers: {
        authorization: "Bearer invalid",
        cookie: `wasm_oj_session=${SESSION_TOKEN}; wasm_oj_csrf=${CSRF_TOKEN}`,
        origin: ORIGIN,
        "x-wasm-oj-csrf": CSRF_TOKEN,
      },
    });
    expect(await authenticatedSession(mixed, env)).toBeUndefined();
    await expect(requireBrowserOrBearerMutationSession(mixed, env)).rejects.toMatchObject({ status: 401, code: "authentication-required" });
  });
});
