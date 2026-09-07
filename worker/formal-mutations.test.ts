import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { AuthenticatedSession, WasmOjWorkerEnv } from "./env";
import { requireBrowserOrBearerMutationSession } from "./auth";
import { probeDeploymentContainer, updateFormalMutationControl } from "./admin";
import { createCatalog, createCatalogSync } from "./catalog";
import { sha256Hex } from "./crypto";
import {
  formalMutationStatus,
  requireFormalMutationsEnabled,
  setFormalMutationsEnabled,
} from "./formal-mutations";

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

  async all<T>(): Promise<{ readonly results: T[] }> {
    return { results: this.database.prepare(this.sql).all(...this.bindings) as T[] };
  }
}

class SqliteD1 {
  constructor(private readonly database: DatabaseSync) {}
  prepare(sql: string): SqliteStatement { return new SqliteStatement(this.database, sql); }
}

function fixture(
  environment: WasmOjWorkerEnv["ENVIRONMENT"],
): { readonly database: DatabaseSync; readonly env: WasmOjWorkerEnv } {
  const database = new DatabaseSync(":memory:");
  database.exec(readFileSync(path.join(process.cwd(), "migrations/core/0015_formal_mutation_control.sql"), "utf8"));
  database.exec(`CREATE TABLE cutover_blockers (blocker_kind TEXT, blocker_key TEXT);
    CREATE VIEW contest_v2_preflight_blockers AS SELECT * FROM cutover_blockers;`);
  return {
    database,
    env: {
      ENVIRONMENT: environment,
      DB: new SqliteD1(database) as unknown as D1Database,
    } as unknown as WasmOjWorkerEnv,
  };
}

const ORIGIN = "https://wasm-oj.test";
const BUILD_ID = "a".repeat(40);
const CATALOG_ID = "11111111-1111-4111-8111-111111111111";
const BEARER = "b".repeat(43);
const admin: AuthenticatedSession = {
  userId: "admin", login: "admin", avatarUrl: "", roles: ["admin"], expiresAt: "2099-01-01T00:00:00.000Z",
};

async function authenticatedFixture(roles: AuthenticatedSession["roles"] = ["admin"]) {
  const { database, env } = fixture("production");
  database.exec(`UPDATE formal_mutation_controls SET reason='repository-source-truth-cutover' WHERE environment='production';
    CREATE TABLE users (id TEXT PRIMARY KEY, status TEXT);
    CREATE TABLE github_identities (user_id TEXT, login TEXT, avatar_url TEXT);
    CREATE TABLE user_roles (user_id TEXT, role TEXT);
    CREATE TABLE sessions (token_hash TEXT, user_id TEXT, expires_at TEXT, csrf_hash TEXT);
    CREATE TABLE cli_access_tokens (token_hash TEXT, user_id TEXT, expires_at TEXT);
    CREATE TABLE catalogs (id TEXT, organizer_user_id TEXT, github_repository_id INTEGER, active_commit_sha TEXT, created_at TEXT, updated_at TEXT);
    INSERT INTO users VALUES ('admin', 'active');
    INSERT INTO github_identities VALUES ('admin', 'admin', '');`);
  for (const role of roles) database.prepare("INSERT INTO user_roles VALUES ('admin', ?)").run(role);
  database.prepare("INSERT INTO sessions VALUES (?, 'admin', ?, ?)")
    .run(await sha256Hex("session-token"), admin.expiresAt, await sha256Hex("csrf-token"));
  database.prepare("INSERT INTO cli_access_tokens VALUES (?, 'admin', ?)").run(await sha256Hex(BEARER), admin.expiresAt);
  const fetch = vi.fn(async () => new Response(JSON.stringify({
    schema: "wasm-oj-platform/container-identity/v3", buildId: BUILD_ID, contract: 2, protocol: "wasm-oj-container-v2",
  })));
  const getByName = vi.fn(() => ({ fetch }));
  return {
    database, fetch, getByName,
    env: { ...env, PUBLIC_ORIGIN: ORIGIN, WASM_OJ_BUILD_ID: BUILD_ID,
      CF_VERSION_METADATA: { tag: BUILD_ID, id: "worker-version" },
      SUBMISSION_CONTAINER: { getByName } } as unknown as WasmOjWorkerEnv,
  };
}

function mutationRequest(options: { readonly bearer?: boolean; readonly csrf?: boolean; readonly authenticated?: boolean; readonly origin?: string } = {}): Request {
  const headers = new Headers({ origin: options.origin ?? ORIGIN, "content-type": "application/json" });
  if (options.bearer) headers.set("authorization", `Bearer ${BEARER}`);
  else if (options.authenticated !== false) {
    headers.set("cookie", "wasm_oj_session=session-token; wasm_oj_csrf=csrf-token");
    if (options.csrf !== false) headers.set("x-wasm-oj-csrf", "csrf-token");
  }
  return new Request(`${ORIGIN}/api/admin/container-probe`, {
    method: "POST", headers, body: JSON.stringify({ reason: "repository-source-truth-production-smoke-passed" }),
  });
}

describe("D1 formal mutation control", () => {
  it("starts development open and production closed", async () => {
    await expect(formalMutationStatus(fixture("development").env)).resolves.toMatchObject({
      enabled: true,
      reason: "development-default-open",
    });
    await expect(formalMutationStatus(fixture("production").env)).resolves.toMatchObject({
      enabled: false,
      reason: "deployment-default-closed",
    });
  });

  it("pauses and resumes one environment without a lease or generation", async () => {
    const { database, env } = fixture("development");
    await expect(setFormalMutationsEnabled(env, false, "manual deployment pause")).resolves.toMatchObject({
      enabled: false,
      reason: "manual deployment pause",
    });
    await expect(requireFormalMutationsEnabled(env)).rejects.toMatchObject({
      status: 503,
      code: "formal-mutations-paused",
    });
    await expect(setFormalMutationsEnabled(env, true, "deployment smoke passed")).resolves.toMatchObject({
      enabled: true,
      reason: "deployment smoke passed",
    });
    await expect(requireFormalMutationsEnabled(env)).resolves.toBeUndefined();
    expect(database.prepare("SELECT formal_mutations_enabled FROM formal_mutation_controls WHERE environment='staging'").get()).toEqual({
      formal_mutations_enabled: 0,
    });
  });

  it("fails closed on missing control state and rejects ambiguous reasons", async () => {
    const { database, env } = fixture("production");
    database.prepare("DELETE FROM formal_mutation_controls WHERE environment='production'").run();
    await expect(formalMutationStatus(env)).rejects.toMatchObject({
      status: 503,
      code: "formal-mutation-control-unavailable",
    });
    await expect(setFormalMutationsEnabled(env, true, "ok")).rejects.toThrow("4–500");
  });

  it("allows only authenticated admins supplied by the two cutover admissions", async () => {
    const { database, env } = fixture("production");
    database.prepare(`UPDATE formal_mutation_controls
      SET reason='repository-source-truth-cutover'
      WHERE environment='production'`).run();
    await expect(requireFormalMutationsEnabled(env)).rejects.toMatchObject({ status: 503 });
    for (const roles of [[], ["organizer"]] as const) {
      await expect(requireFormalMutationsEnabled(env, { ...admin, roles })).rejects.toMatchObject({ status: 503 });
    }
    await expect(requireFormalMutationsEnabled(env, admin)).resolves.toBeUndefined();

    database.prepare(`UPDATE formal_mutation_controls
      SET reason='manual-incident-pause'
      WHERE environment='production'`).run();
    await expect(requireFormalMutationsEnabled(env, admin)).rejects.toMatchObject({ status: 503 });
    const staging = fixture("staging");
    staging.database.prepare("UPDATE formal_mutation_controls SET reason='repository-source-truth-cutover' WHERE environment='staging'").run();
    await expect(requireFormalMutationsEnabled(staging.env, admin)).rejects.toMatchObject({ status: 503 });
  });

  it("gates every reset-domain admission while leaving drain operations available", () => {
    const submissions = readFileSync(path.join(process.cwd(), "worker/submissions.ts"), "utf8");
    const product = readFileSync(path.join(process.cwd(), "worker/product.ts"), "utf8");
    const erasure = readFileSync(path.join(process.cwd(), "worker/account-erasure.ts"), "utf8");
    const catalog = readFileSync(path.join(process.cwd(), "worker/catalog.ts"), "utf8");
    const rejudge = readFileSync(path.join(process.cwd(), "worker/rejudge.ts"), "utf8");
    expect(submissions).toMatch(/createSubmission[\s\S]*requireFormalMutationsEnabled\(env, session\)[\s\S]*INSERT INTO submission_sources/);
    expect(submissions).toMatch(/updateSubmissionVisibility[\s\S]*requireFormalMutationsEnabled\(env\)[\s\S]*UPDATE submissions SET visibility/);
    expect(product).toMatch(/joinContest[\s\S]*requireFormalMutationsEnabled\(env\)[\s\S]*INSERT OR IGNORE INTO contest_entrants/);
    expect(erasure).toMatch(/eraseAccount[\s\S]*requireFormalMutationsEnabled\(env\)[\s\S]*INSERT INTO account_erasure_jobs/);
    expect(catalog).toMatch(/createCatalog[\s\S]*requireFormalMutationsEnabled\(env\)/);
    expect(catalog).toMatch(/createCatalogSync[\s\S]*requireFormalMutationsEnabled\(env, session\)/);
    expect(rejudge).toMatch(/createRejudgeBatch[\s\S]*requireFormalMutationsEnabled\(env\)/);
    const cancelStart = submissions.indexOf("export async function cancelSubmission");
    const cancelEnd = submissions.indexOf("export async function updateSubmissionVisibility", cancelStart);
    expect(submissions.slice(cancelStart, cancelEnd)).not.toContain("requireFormalMutationsEnabled");
  });

  it("checks cutover blockers in the resume UPDATE and opens only once blockers clear", async () => {
    const { database, env } = await authenticatedFixture();
    database.prepare("INSERT INTO cutover_blockers VALUES ('catalog-contests-v2-resync-required', ?)").run(CATALOG_ID);
    await expect(updateFormalMutationControl(mutationRequest(), env, true))
      .rejects.toMatchObject({ status: 409, code: "formal-mutation-resume-blocked" });
    await expect(formalMutationStatus(env)).resolves.toMatchObject({ enabled: false, reason: "repository-source-truth-cutover" });
    database.exec("DELETE FROM cutover_blockers");
    const response = await updateFormalMutationControl(mutationRequest(), env, true);
    expect(await response.json()).toMatchObject({ enabled: true, reason: "repository-source-truth-production-smoke-passed" });
  });

  it("rejects production resume outside the exact cutover pause and completion reason", async () => {
    const { database, env } = await authenticatedFixture();
    await expect(setFormalMutationsEnabled(env, true, "production smoke passed"))
      .rejects.toMatchObject({ status: 409, code: "formal-mutation-resume-blocked" });
    database.exec("UPDATE formal_mutation_controls SET reason='active-incident' WHERE environment='production'");
    await expect(updateFormalMutationControl(mutationRequest(), env, true))
      .rejects.toMatchObject({ status: 409, code: "formal-mutation-resume-blocked" });
    await expect(formalMutationStatus(env)).resolves.toMatchObject({ enabled: false, reason: "active-incident" });
  });

  it("does not overwrite a pause which changed while resume was being prepared", async () => {
    const { database, env } = await authenticatedFixture();
    const prepare = env.DB.prepare.bind(env.DB);
    vi.spyOn(env.DB, "prepare").mockImplementation((sql) => {
      if (sql.startsWith("UPDATE formal_mutation_controls")) {
        database.exec("UPDATE formal_mutation_controls SET reason='active-incident' WHERE environment='production'");
      }
      return prepare(sql);
    });
    await expect(updateFormalMutationControl(mutationRequest(), env, true))
      .rejects.toMatchObject({ status: 409, code: "formal-mutation-resume-blocked" });
    await expect(formalMutationStatus(env)).resolves.toMatchObject({ enabled: false, reason: "active-incident" });
  });
});

describe("existing authentication for maintenance operations", () => {
  it("uses current roles for both browser and bearer cutover admissions", async () => {
    const { database, env } = await authenticatedFixture();
    for (const bearer of [false, true]) {
      const session = await requireBrowserOrBearerMutationSession(mutationRequest({ bearer }), env);
      await expect(requireFormalMutationsEnabled(env, session)).resolves.toBeUndefined();
    }
    database.exec("DELETE FROM user_roles");
    for (const bearer of [false, true]) {
      const session = await requireBrowserOrBearerMutationSession(mutationRequest({ bearer }), env);
      await expect(requireFormalMutationsEnabled(env, session)).rejects.toMatchObject({ status: 503 });
    }
    database.exec("UPDATE users SET status='erased'");
    await expect(requireBrowserOrBearerMutationSession(mutationRequest(), env)).rejects.toMatchObject({ status: 401 });
    await expect(requireBrowserOrBearerMutationSession(mutationRequest({ bearer: true }), env)).rejects.toMatchObject({ status: 401 });
  });

  it("keeps catalog creation paused and preserves catalog ownership for admin sync", async () => {
    const { database, env } = await authenticatedFixture();
    database.prepare("INSERT INTO catalogs VALUES (?, 'other-owner', 123, NULL, '', '')").run(CATALOG_ID);
    await expect(createCatalog(mutationRequest(), env)).rejects.toMatchObject({ status: 503, code: "formal-mutations-paused" });
    await expect(createCatalogSync(mutationRequest(), env, CATALOG_ID)).rejects.toMatchObject({ status: 404, code: "catalog-not-found" });
    database.exec("UPDATE user_roles SET role='organizer'");
    await expect(createCatalogSync(mutationRequest(), env, CATALOG_ID)).rejects.toMatchObject({ status: 503, code: "formal-mutations-paused" });
  });

  it.each([
    { roles: [], options: {}, code: "admin-required" },
    { roles: ["organizer"], options: {}, code: "admin-required" },
    { roles: ["admin"], options: { authenticated: false }, code: "authentication-required" },
    { roles: ["admin"], options: { csrf: false }, code: "csrf-rejected" },
    { roles: ["admin"], options: { origin: "https://other.test" }, code: "origin-rejected" },
    { roles: ["admin"], options: { bearer: true }, code: "browser-authentication-required" },
  ] as const)("rejects unauthorized container probe: $code $roles", async ({ roles, options, code }) => {
    const { env, getByName, fetch } = await authenticatedFixture(roles);
    await expect(probeDeploymentContainer(mutationRequest(options), env)).rejects.toMatchObject({ code });
    expect(getByName).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("probes the exact container only for a current browser admin with CSRF", async () => {
    const { env, database, getByName, fetch } = await authenticatedFixture();
    const response = await probeDeploymentContainer(mutationRequest(), env);
    expect(await response.json()).toEqual({ ready: true, buildId: BUILD_ID, contract: 2,
      protocol: "wasm-oj-container-v2", workerVersionId: "worker-version" });
    expect(getByName).toHaveBeenCalledWith(`deployment-smoke-${BUILD_ID}`);
    expect(fetch).toHaveBeenCalledWith("https://judge.container/identity");
    getByName.mockClear();
    database.exec("DELETE FROM user_roles");
    await expect(probeDeploymentContainer(mutationRequest(), env)).rejects.toMatchObject({ code: "admin-required" });
    expect(getByName).not.toHaveBeenCalled();
  });

  it("rejects inconsistent Worker metadata before probing and mismatched container builds afterward", async () => {
    const { env, getByName, fetch } = await authenticatedFixture();
    await expect(probeDeploymentContainer(mutationRequest(), { ...env,
      CF_VERSION_METADATA: { ...env.CF_VERSION_METADATA, tag: "b".repeat(40) },
    })).rejects.toMatchObject({ status: 503, code: "worker-build-mismatch" });
    expect(getByName).not.toHaveBeenCalled();
    fetch.mockResolvedValueOnce(new Response(JSON.stringify({ schema: "wasm-oj-platform/container-identity/v3",
      buildId: "b".repeat(40), contract: 2, protocol: "wasm-oj-container-v2" })));
    await expect(probeDeploymentContainer(mutationRequest(), env)).rejects.toMatchObject({ status: 503, code: "container-build-mismatch" });
  });
});
