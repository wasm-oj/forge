import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { hmacSha256Hex, sha256Hex } from "./crypto";
import type { ForgeWorkerEnv } from "./env";
import { MAX_GITHUB_INSTALLATION_REPOSITORY_CHANGES } from "./github";
import {
  activateGithubInstallationClaim,
  bindGithubInstallationClaim,
  cleanupExpiredGithubInstallationClaims,
  deleteGithubInstallationClaimsForUser,
  finalizeGithubInstallationClaim,
  recordGithubInstallationCreatedProof,
} from "./github-installation-claims";
import { completeGithubAppInstall, githubWebhook } from "./organizer";
import { apiErrorResponse } from "./http";

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

  async run(): Promise<{ readonly meta: { readonly changes: number } }> {
    return this.execute();
  }

  execute(): { readonly meta: { readonly changes: number } } {
    const changes = this.database.prepare(this.sql).run(...this.bindings).changes;
    return { meta: { changes: Number(changes) } };
  }
}

class SqliteD1 {
  constructor(private readonly database: DatabaseSync) {}

  prepare(sql: string): SqliteStatement {
    return new SqliteStatement(this.database, sql);
  }

  async batch(statements: readonly SqliteStatement[]): Promise<readonly { readonly meta: { readonly changes: number } }[]> {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const results = statements.map((statement) => statement.execute());
      this.database.exec("COMMIT");
      return results;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }
}

const USER_A = "00000000-0000-4000-8000-000000000001";
const USER_B = "00000000-0000-4000-8000-000000000002";
const GITHUB_A = 101;
const GITHUB_B = 202;
const INSTALLATION = 7001;
const OTHER_INSTALLATION = 7002;
const ACCOUNT = 9001;
const NOW = "2026-08-09T00:00:00.000Z";
const EXPIRES = "2026-08-09T00:15:00.000Z";
const STATE_EXPIRES = "2026-08-09T00:10:00.000Z";
const STATE_A = "a".repeat(64);
const STATE_B = "b".repeat(64);
const STATE_A_SECOND = "c".repeat(64);

function migratedDatabase(): DatabaseSync {
  const database = new DatabaseSync(":memory:");
  const directory = join(process.cwd(), "migrations/core");
  for (const filename of readdirSync(directory).filter((item) => item.endsWith(".sql")).sort()) {
    database.exec(readFileSync(join(directory, filename), "utf8"));
  }
  return database;
}

function fixture(): { readonly database: DatabaseSync; readonly d1: D1Database } {
  const database = migratedDatabase();
  const user = database.prepare("INSERT INTO users (id, created_at, updated_at, status) VALUES (?, ?, ?, 'active')");
  user.run(USER_A, NOW, NOW);
  user.run(USER_B, NOW, NOW);
  const identity = database.prepare("INSERT INTO github_identities (github_user_id, user_id, login, avatar_url, profile_url, updated_at) VALUES (?, ?, ?, ?, ?, ?)");
  identity.run(GITHUB_A, USER_A, "organizer-a", "https://example.test/a.png", "https://github.com/organizer-a", NOW);
  identity.run(GITHUB_B, USER_B, "organizer-b", "https://example.test/b.png", "https://github.com/organizer-b", NOW);
  return { database, d1: new SqliteD1(database) as unknown as D1Database };
}

function insertState(database: DatabaseSync, stateHash: string, userId: string, expiresAt = STATE_EXPIRES): void {
  database.prepare("INSERT INTO github_installation_states (state_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)")
    .run(stateHash, userId, NOW, expiresAt);
}

async function insertProof(
  database: DatabaseSync,
  d1: D1Database,
  installationId: number,
  installerGithubUserId: number,
  deliveryId: string,
): Promise<void> {
  database.prepare("INSERT INTO github_webhook_deliveries (delivery_id, event_name, body_sha256, received_at, updated_at, outcome) VALUES (?, 'installation', ?, ?, ?, 'processing')")
    .run(deliveryId, "f".repeat(64), NOW, NOW);
  await recordGithubInstallationCreatedProof(d1, {
    installationId,
    installerGithubUserId,
    accountGithubId: ACCOUNT,
    deliveryId,
    receivedAt: NOW,
    expiresAt: EXPIRES,
  });
}

function metadata(installationId = INSTALLATION) {
  return {
    installationId,
    accountGithubId: ACCOUNT,
    accountLogin: "managed-account",
    permissionsJson: JSON.stringify({ contents: "read", metadata: "read" }),
    repositorySelection: "selected" as const,
  };
}

describe("GitHub installation ownership claims", () => {
  it("removes installer identity on account erasure and expires unclaimed proof material", async () => {
    const { database, d1 } = fixture();
    insertState(database, STATE_A, USER_A);
    await insertProof(database, d1, INSTALLATION, GITHUB_A, "delivery-erasure");
    await bindGithubInstallationClaim(d1, { stateHash: STATE_A, userId: USER_A, installationId: INSTALLATION, now: NOW });
    await finalizeGithubInstallationClaim(d1, { stateHash: STATE_A, userId: USER_A, metadata: metadata(INSTALLATION), now: NOW });
    expect(await deleteGithubInstallationClaimsForUser(d1, USER_A)).toBe(1);
    expect(database.prepare("SELECT COUNT(*) AS count FROM github_installation_claim_proofs WHERE installer_github_user_id=?").get(GITHUB_A)).toEqual({ count: 0 });

    database.prepare("INSERT INTO github_installation_states (state_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)")
      .run(STATE_B, USER_B, NOW, "2026-08-09T00:01:00.000Z");
    database.prepare("INSERT INTO github_webhook_deliveries (delivery_id, event_name, body_sha256, received_at, updated_at, outcome) VALUES ('delivery-expired', 'installation', ?, ?, ?, 'accepted')")
      .run("e".repeat(64), NOW, NOW);
    database.prepare("INSERT INTO github_installation_claim_proofs (installation_id, installer_github_user_id, account_github_id, delivery_id, received_at, expires_at) VALUES (?, ?, ?, 'delivery-expired', ?, ?)")
      .run(OTHER_INSTALLATION, GITHUB_B, ACCOUNT + 1, NOW, "2026-08-09T00:01:00.000Z");
    await expect(cleanupExpiredGithubInstallationClaims(d1, new Date("2026-08-09T00:02:00.000Z"))).resolves.toEqual({ proofs: 1, states: 1 });
    expect(database.prepare("SELECT COUNT(*) AS count FROM github_webhook_deliveries WHERE delivery_id='delivery-expired'").get()).toEqual({ count: 1 });
  });

  it("creates installer proof only from a correctly signed installation.created webhook", async () => {
    const { database, d1 } = fixture();
    insertState(database, STATE_A, USER_A, "2099-01-01T00:00:00.000Z");
    const secret = "webhook-secret";
    const body = JSON.stringify({
      action: "created",
      installation: { id: INSTALLATION, app_id: 12_345, account: { id: ACCOUNT, login: "managed-account" } },
      sender: { id: GITHUB_A, login: "organizer-a" },
    });
    const signedRequest = async (signature: string) => new Request("https://forge.example.test/api/github/webhook", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-github-delivery": "delivery-signed-created",
        "x-github-event": "installation",
        "x-hub-signature-256": `sha256=${signature}`,
      },
      body,
    });
    const env = { DB: d1, GITHUB_APP_ID: "12345", GITHUB_WEBHOOK_SECRET: secret } as ForgeWorkerEnv;

    await expect(githubWebhook(await signedRequest("0".repeat(64)), env)).rejects.toMatchObject({
      code: "github-webhook-signature",
    });
    expect(database.prepare("SELECT COUNT(*) AS count FROM github_installation_claim_proofs").get()).toEqual({ count: 0 });

    const response = await githubWebhook(await signedRequest(await hmacSha256Hex(secret, new TextEncoder().encode(body))), env);
    expect(response.status).toBe(200);
    expect(database.prepare("SELECT installer_github_user_id, account_github_id, delivery_id FROM github_installation_claim_proofs WHERE installation_id=?").get(INSTALLATION)).toEqual({
      installer_github_user_id: GITHUB_A,
      account_github_id: ACCOUNT,
      delivery_id: "delivery-signed-created",
    });
    await expect(githubWebhook(await signedRequest(await hmacSha256Hex(secret, new TextEncoder().encode(body))), env).then((replay) => replay.json()))
      .resolves.toEqual({ accepted: true, replayed: true });
  });

  it("bounds installation repository changes before the first D1 operation", async () => {
    const secret = "webhook-secret";
    let databaseOperations = 0;
    const forbiddenD1 = {
      prepare(): never {
        databaseOperations += 1;
        throw new Error("D1 boundary reached");
      },
    } as unknown as D1Database;
    const deliver = async (deliveryId: string, added: unknown, removed: unknown) => {
      const body = JSON.stringify({
        action: "added",
        installation: { id: INSTALLATION },
        repositories_added: added,
        repositories_removed: removed,
      });
      const bytes = new TextEncoder().encode(body);
      return githubWebhook(new Request("https://forge.example.test/api/github/webhook", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-github-delivery": deliveryId,
          "x-github-event": "installation_repositories",
          "x-hub-signature-256": `sha256=${await hmacSha256Hex(secret, bytes)}`,
        },
        body,
      }), { DB: forbiddenD1, GITHUB_WEBHOOK_SECRET: secret } as ForgeWorkerEnv);
    };
    const boundary = Array.from({ length: MAX_GITHUB_INSTALLATION_REPOSITORY_CHANGES }, (_, id) => ({ id: id + 1 }));

    await expect(deliver("delivery-repositories-boundary", boundary, [])).rejects.toThrow("D1 boundary reached");
    expect(databaseOperations).toBe(1);

    databaseOperations = 0;
    const overLimitError = await deliver("delivery-repositories-over-limit", [...boundary, { id: boundary.length + 1 }], []).catch((error: unknown) => error);
    expect(databaseOperations).toBe(0);
    const overLimitResponse = apiErrorResponse(overLimitError);
    expect(overLimitResponse.status).toBe(413);
    await expect(overLimitResponse.json()).resolves.toEqual({
      error: {
        code: "github-webhook-too-many-repositories",
        message: "GitHub webhook exceeds the installation repository change limit.",
      },
    });

    const invalidShapeError = await deliver("delivery-repositories-invalid", [], null).catch((error: unknown) => error);
    expect(databaseOperations).toBe(0);
    const invalidShapeResponse = apiErrorResponse(invalidShapeError);
    expect(invalidShapeResponse.status).toBe(400);
    await expect(invalidShapeResponse.json()).resolves.toEqual({
      error: {
        code: "github-installation-repositories-invalid",
        message: "GitHub installation repository changes must be arrays.",
      },
    });
  });

  it("suspends a claimed installation when a signed permission-change event grants write access", async () => {
    const { database, d1 } = fixture();
    database.prepare(
      `INSERT INTO github_installations
         (installation_id, account_github_id, account_login, installed_by_user_id, status,
          permissions_json, repository_selection, created_at, updated_at)
       VALUES (?, ?, 'managed-account', ?, 'active', ?, 'selected', ?, ?)`,
    ).run(INSTALLATION, ACCOUNT, USER_A, '{"contents":"read","metadata":"read"}', NOW, NOW);
    const secret = "webhook-secret";
    const deliver = async (deliveryId: string, permissions: Record<string, string>, repositorySelection: string) => {
      const body = JSON.stringify({
        action: "new_permissions_accepted",
        installation: {
          id: INSTALLATION,
          app_id: 12_345,
          account: { id: ACCOUNT, login: "managed-account" },
          permissions,
          repository_selection: repositorySelection,
        },
        sender: { id: GITHUB_A, login: "organizer-a" },
      });
      return githubWebhook(new Request("https://forge.example.test/api/github/webhook", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-github-delivery": deliveryId,
          "x-github-event": "installation",
          "x-hub-signature-256": `sha256=${await hmacSha256Hex(secret, new TextEncoder().encode(body))}`,
        },
        body,
      }), { DB: d1, GITHUB_APP_ID: "12345", GITHUB_WEBHOOK_SECRET: secret } as ForgeWorkerEnv);
    };

    expect((await deliver("delivery-permission-write", { contents: "write", metadata: "read" }, "selected")).status).toBe(200);
    expect(database.prepare("SELECT status, permissions_json FROM github_installations WHERE installation_id=?").get(INSTALLATION)).toEqual({
      status: "suspended",
      permissions_json: '{"contents":"read","metadata":"read"}',
    });

    expect((await deliver("delivery-permission-safe", { metadata: "read", contents: "read" }, "selected")).status).toBe(200);
    expect(database.prepare("SELECT status, permissions_json FROM github_installations WHERE installation_id=?").get(INSTALLATION)).toEqual({
      status: "suspended",
      permissions_json: '{"contents":"read","metadata":"read"}',
    });
  });

  it("does not recreate erased GitHub identity from a delayed signed installation.created webhook", async () => {
    const { database, d1 } = fixture();
    insertState(database, STATE_A, USER_A, "2099-01-01T00:00:00.000Z");
    await insertProof(database, d1, INSTALLATION, GITHUB_A, "delivery-before-erasure");

    database.exec("BEGIN IMMEDIATE");
    try {
      database.prepare("INSERT INTO account_erasure_jobs (id, user_id, anonymous_user_id, status, requested_at, updated_at) VALUES ('erasure-1', ?, 'erased-user-a', 'revoking', ?, ?)")
        .run(USER_A, NOW, NOW);
      database.prepare("UPDATE users SET status='suspended', updated_at=? WHERE id=?").run(NOW, USER_A);
      database.prepare("DELETE FROM github_installation_claim_proofs WHERE installer_github_user_id=?").run(GITHUB_A);
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }

    const secret = "webhook-secret";
    const body = JSON.stringify({
      action: "created",
      installation: { id: INSTALLATION, app_id: 12_345, account: { id: ACCOUNT, login: "managed-account" } },
      sender: { id: GITHUB_A, login: "organizer-a" },
    });
    const signature = await hmacSha256Hex(secret, new TextEncoder().encode(body));
    const response = await githubWebhook(new Request("https://forge.example.test/api/github/webhook", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-github-delivery": "delivery-after-erasure",
        "x-github-event": "installation",
        "x-hub-signature-256": `sha256=${signature}`,
      },
      body,
    }), { DB: d1, GITHUB_APP_ID: "12345", GITHUB_WEBHOOK_SECRET: secret } as ForgeWorkerEnv);

    expect(response.status).toBe(200);
    expect(database.prepare("SELECT COUNT(*) AS count FROM github_installation_claim_proofs WHERE installer_github_user_id=?").get(GITHUB_A)).toEqual({ count: 0 });
    expect(database.prepare("SELECT event_name, outcome FROM github_webhook_deliveries WHERE delivery_id='delivery-after-erasure'").get()).toEqual({
      event_name: "installation",
      outcome: "accepted",
    });
  });

  it("reclaims an exact failed delivery without accepting a delivery-ID byte collision", async () => {
    const { database, d1 } = fixture();
    const secret = "webhook-secret";
    const deliveryId = "delivery-retry";
    const body = JSON.stringify({
      action: "created",
      installation: { id: OTHER_INSTALLATION, app_id: 12_345, account: { id: ACCOUNT + 1, login: "second-account" } },
      sender: { id: GITHUB_A, login: "organizer-a" },
    });
    const bytes = new TextEncoder().encode(body);
    database.prepare("INSERT INTO github_webhook_deliveries (delivery_id, event_name, body_sha256, received_at, updated_at, attempts, outcome) VALUES (?, 'installation', ?, ?, ?, 1, 'failed')")
      .run(deliveryId, await sha256Hex(bytes), NOW, NOW);
    const request = async (value: string) => new Request("https://forge.example.test/api/github/webhook", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-github-delivery": deliveryId,
        "x-github-event": "installation",
        "x-hub-signature-256": `sha256=${await hmacSha256Hex(secret, new TextEncoder().encode(value))}`,
      },
      body: value,
    });
    const env = { DB: d1, GITHUB_APP_ID: "12345", GITHUB_WEBHOOK_SECRET: secret } as ForgeWorkerEnv;
    expect((await githubWebhook(await request(body), env)).status).toBe(200);
    expect(database.prepare("SELECT attempts, outcome FROM github_webhook_deliveries WHERE delivery_id=?").get(deliveryId)).toEqual({ attempts: 2, outcome: "accepted" });
    await expect(githubWebhook(await request(`${body} `), env)).rejects.toMatchObject({ code: "github-webhook-delivery-conflict" });
  });

  it("rejects callback installation_id substitution before any GitHub request", async () => {
    const { database, d1 } = fixture();
    const sessionToken = "session-secret";
    const rawState = "installation-state-secret";
    const stateHash = await sha256Hex(rawState);
    database.prepare("INSERT INTO user_roles (user_id, role, granted_at) VALUES (?, 'organizer', ?)").run(USER_A, NOW);
    database.prepare("INSERT INTO sessions (token_hash, user_id, csrf_hash, created_at, expires_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(await sha256Hex(sessionToken), USER_A, await sha256Hex("csrf"), NOW, "2099-01-01T00:00:00.000Z", NOW);
    database.prepare("INSERT INTO github_installation_states (state_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)")
      .run(stateHash, USER_A, NOW, "2099-01-01T00:00:00.000Z");
    const env = {
      DB: d1,
      ENVIRONMENT: "development",
      STAGING_ALLOWED_GITHUB_USER_IDS: "",
    } as ForgeWorkerEnv;
    const callback = (installationId: number) => new Request(
      `https://forge.example.test/api/organizer/github/callback?state=${encodeURIComponent(rawState)}&installation_id=${installationId}&setup_action=install`,
      { headers: { cookie: `forge_session=${sessionToken}; forge_install_state=${rawState}` } },
    );

    await expect(completeGithubAppInstall(callback(OTHER_INSTALLATION), env)).rejects.toMatchObject({
      code: "github-installation-proof-pending",
    });
    await expect(completeGithubAppInstall(callback(INSTALLATION), env)).rejects.toMatchObject({
      code: "github-installation-state-bound",
    });
    expect(database.prepare("SELECT installation_id FROM github_installation_states WHERE state_hash=?").get(stateHash)).toEqual({
      installation_id: OTHER_INSTALLATION,
    });
  });

  it("binds the callback state to its first exact installation and rejects substituted IDs or installers", async () => {
    const { database, d1 } = fixture();
    insertState(database, STATE_A, USER_A);
    insertState(database, STATE_B, USER_B);
    await insertProof(database, d1, INSTALLATION, GITHUB_A, "delivery-owner-a");

    await expect(bindGithubInstallationClaim(d1, {
      stateHash: STATE_A,
      userId: USER_A,
      installationId: OTHER_INSTALLATION,
      now: NOW,
    })).rejects.toMatchObject({ code: "github-installation-proof-pending" });
    await expect(bindGithubInstallationClaim(d1, {
      stateHash: STATE_A,
      userId: USER_A,
      installationId: INSTALLATION,
      now: NOW,
    })).rejects.toMatchObject({ code: "github-installation-state-bound" });

    await expect(bindGithubInstallationClaim(d1, {
      stateHash: STATE_B,
      userId: USER_B,
      installationId: INSTALLATION,
      now: NOW,
    })).rejects.toMatchObject({ code: "github-installation-installer-mismatch" });
    expect(database.prepare("SELECT installation_id FROM github_installation_states WHERE state_hash=?").get(STATE_A)).toEqual({ installation_id: OTHER_INSTALLATION });
    expect(database.prepare("SELECT COUNT(*) AS count FROM github_installations").get()).toEqual({ count: 0 });
  });

  it("never transfers an existing installation owner, including through the final transactional write", async () => {
    const { database, d1 } = fixture();
    insertState(database, STATE_B, USER_B);
    await insertProof(database, d1, INSTALLATION, GITHUB_B, "delivery-owner-b");
    database.prepare(
      "INSERT INTO github_installations (installation_id, account_github_id, account_login, installed_by_user_id, status, permissions_json, repository_selection, created_at, updated_at) VALUES (?, ?, 'victim-account', ?, 'active', '{}', 'selected', ?, ?)",
    ).run(INSTALLATION, ACCOUNT, USER_A, NOW, NOW);

    await expect(bindGithubInstallationClaim(d1, {
      stateHash: STATE_B,
      userId: USER_B,
      installationId: INSTALLATION,
      now: NOW,
    })).rejects.toMatchObject({ code: "github-installation-owned" });
    await expect(finalizeGithubInstallationClaim(d1, {
      stateHash: STATE_B,
      userId: USER_B,
      metadata: metadata(),
      now: NOW,
    })).rejects.toMatchObject({ code: "github-installation-owned" });

    expect(database.prepare("SELECT installed_by_user_id, account_login, status FROM github_installations WHERE installation_id=?").get(INSTALLATION)).toEqual({
      installed_by_user_id: USER_A,
      account_login: "victim-account",
      status: "active",
    });
    expect(database.prepare("SELECT claimed_at FROM github_installation_claim_proofs WHERE installation_id=?").get(INSTALLATION)).toEqual({ claimed_at: null });
    expect(() => database.prepare("UPDATE github_installations SET installed_by_user_id=? WHERE installation_id=?").run(USER_B, INSTALLATION))
      .toThrow("github installation owner cannot be transferred or reclaimed");
  });

  it("serializes concurrent states so exactly one consumes the signed proof", async () => {
    const { database, d1 } = fixture();
    insertState(database, STATE_A, USER_A);
    insertState(database, STATE_A_SECOND, USER_A);
    await insertProof(database, d1, INSTALLATION, GITHUB_A, "delivery-concurrent");
    await bindGithubInstallationClaim(d1, { stateHash: STATE_A, userId: USER_A, installationId: INSTALLATION, now: NOW });
    await bindGithubInstallationClaim(d1, { stateHash: STATE_A_SECOND, userId: USER_A, installationId: INSTALLATION, now: NOW });

    const attempts = await Promise.allSettled([
      finalizeGithubInstallationClaim(d1, { stateHash: STATE_A, userId: USER_A, metadata: metadata(), now: NOW }),
      finalizeGithubInstallationClaim(d1, { stateHash: STATE_A_SECOND, userId: USER_A, metadata: metadata(), now: NOW }),
    ]);
    expect(attempts.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(attempts.filter((result) => result.status === "rejected")).toHaveLength(1);

    const proof = database.prepare("SELECT state_hash, claimed_by_user_id, claimed_at, activated_at FROM github_installation_claim_proofs WHERE installation_id=?").get(INSTALLATION);
    expect(proof).toMatchObject({ claimed_by_user_id: USER_A, claimed_at: NOW, activated_at: null });
    expect([STATE_A, STATE_A_SECOND]).toContain((proof as { state_hash: string }).state_hash);
    expect(database.prepare("SELECT COUNT(*) AS count FROM github_installation_states WHERE consumed_at IS NOT NULL").get()).toEqual({ count: 1 });
    expect(database.prepare("SELECT installed_by_user_id, status FROM github_installations WHERE installation_id=?").get(INSTALLATION)).toEqual({
      installed_by_user_id: USER_A,
      status: "suspended",
    });

    const winningState = (proof as { state_hash: string }).state_hash;
    await activateGithubInstallationClaim(d1, { stateHash: winningState, userId: USER_A, installationId: INSTALLATION, now: NOW });
    expect(database.prepare("SELECT installed_by_user_id, status FROM github_installations WHERE installation_id=?").get(INSTALLATION)).toEqual({
      installed_by_user_id: USER_A,
      status: "active",
    });
  });
});
