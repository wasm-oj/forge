import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import type { ForgeWorkerEnv } from "./env";
import {
  hydrateValidationWorkflowContext,
  validationWorkflowStepMarker,
} from "./validation-workflow-context";
import {
  archiveCleanupOutboxJson,
  deliverValidationWorkflowOutbox,
  parseArchiveCleanupOutboxJson,
  parseValidationWorkflowOutboxJson,
  validationWorkflowOutboxJson,
} from "./validation-workflow-outbox";

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
    return this.execute();
  }

  execute(): { readonly meta: { readonly changes: number } } {
    return { meta: { changes: Number(this.database.prepare(this.sql).run(...this.bindings).changes) } };
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

const USER_ID = "00000000-0000-4000-8000-000000000001";
const IMPORT_ID = "00000000-0000-4000-8000-000000000002";
const RELEASE_ID = "00000000-0000-4000-8000-000000000006";
const OTHER_IMPORT_ID = "00000000-0000-4000-8000-000000000004";
const MANIFEST = "a".repeat(64);
const IDENTITY = "b".repeat(64);
const COMMIT = "c".repeat(40);
const CANONICAL_DIGEST = "d".repeat(64);
const CANONICAL_KEY = `snapshots/objects/${CANONICAL_DIGEST}`;
const NOW = "2026-08-09T00:00:00.000Z";

function migratedDatabase(): DatabaseSync {
  const database = new DatabaseSync(":memory:");
  const migrationDirectory = join(process.cwd(), "migrations/core");
  for (const filename of readdirSync(migrationDirectory).filter((item) => item.endsWith(".sql")).sort()) {
    database.exec(readFileSync(join(migrationDirectory, filename), "utf8"));
  }
  return database;
}

function parameters(importId = IMPORT_ID) {
  return {
    importId,
    expectedReleaseId: RELEASE_ID,
    expectedManifestSha256: MANIFEST,
    expectedContainerIdentitySha256: IDENTITY,
  } as const;
}

function fixture(): { readonly database: DatabaseSync; readonly env: ForgeWorkerEnv } {
  const database = migratedDatabase();
  database.prepare("INSERT INTO users (id, created_at, updated_at, status) VALUES (?, ?, ?, 'active')").run(USER_ID, NOW, NOW);
  database.prepare("INSERT INTO github_installations (installation_id, account_github_id, account_login, installed_by_user_id, status, permissions_json, repository_selection, created_at, updated_at) VALUES (101, 201, 'private-owner', ?, 'active', '{\"contents\":\"read\"}', 'selected', ?, ?)")
    .run(USER_ID, NOW, NOW);
  database.prepare("INSERT INTO github_repositories (github_repository_id, installation_id, owner_login, name, is_private, authorization_status, updated_at) VALUES (301, 101, 'private-owner', 'private-fixture', 1, 'authorized', ?)")
    .run(NOW);
  database.prepare("INSERT INTO forge_releases (id, version, manifest_r2_key, manifest_sha256, source_git_commit, status, created_at) VALUES (?, 'active', 'releases/active.json', ?, ?, 'active', ?)")
    .run(RELEASE_ID, MANIFEST, "1".repeat(40), NOW);
  database.prepare("INSERT INTO collection_imports (id, organizer_user_id, github_repository_id, requested_ref, commit_sha, index_path, forge_release_id, archive_disposition, status, created_at, updated_at) VALUES (?, ?, 301, 'main', ?, 'collection/index.json', ?, 'pending', 'queued', ?, ?)")
    .run(IMPORT_ID, USER_ID, COMMIT, RELEASE_ID, NOW, NOW);
  return {
    database,
    env: { DB: new SqliteD1(database) as unknown as D1Database } as ForgeWorkerEnv,
  };
}

function withFailedCreate(env: ForgeWorkerEnv, status: string): ForgeWorkerEnv {
  return {
    ...env,
    VALIDATION_WORKFLOW: {
      async create() { throw new Error("create response lost"); },
      async get() {
        return { async status() { return { status }; } };
      },
    },
  } as unknown as ForgeWorkerEnv;
}

describe("Validation Workflow durable privacy boundary", () => {
  it("serializes only the exact opaque reference and rejects legacy private context", () => {
    const payload = validationWorkflowOutboxJson(parameters());
    expect(JSON.parse(payload)).toEqual(parameters());
    expect(Object.keys(JSON.parse(payload) as object).sort()).toEqual([
      "expectedContainerIdentitySha256",
      "expectedManifestSha256",
      "expectedReleaseId",
      "importId",
    ]);
    expect(payload).not.toContain("private-owner");
    expect(payload).not.toContain("private-fixture");
    expect(payload).not.toContain("installationId");
    expect(payload).not.toContain("organizerUserId");
    expect(payload).not.toContain("archiveR2Key");
    expect(() => parseValidationWorkflowOutboxJson(JSON.stringify({ ...parameters(), owner: "private-owner" }), IMPORT_ID)).toThrow("invalid shape");
    expect(() => parseValidationWorkflowOutboxJson(payload, OTHER_IMPORT_ID)).toThrow("aggregate identity");
  });

  it("hydrates private GitHub context only from DB and emits a redacted step marker", async () => {
    const { env } = fixture();
    const context = await hydrateValidationWorkflowContext(env, parameters(), ["queued"]);
    expect(context.source).toMatchObject({
      kind: "github-archive",
      installationId: 101,
      expectedOwner: "private-owner",
      expectedRepository: "private-fixture",
    });
    expect(validationWorkflowStepMarker(context)).toEqual({ sourceKind: "github-archive" });
    expect(JSON.stringify(validationWorkflowStepMarker(context))).not.toMatch(/private-owner|private-fixture|expectedOwner|expectedRepository|installationId|archiveR2Key/);
  });

  it("rejects hydration after GitHub access is removed", async () => {
    const { database, env } = fixture();
    database.exec("UPDATE github_installations SET status='removed', installed_by_user_id=NULL; UPDATE github_repositories SET authorization_status='removed'");
    await expect(hydrateValidationWorkflowContext(env, parameters(), ["queued"]))
      .rejects.toThrow("repository or archive fence");
  });

  it("replays a lost Workflow create acknowledgement without widening the payload", async () => {
    const created: unknown[] = [];
    const env = {
      VALIDATION_WORKFLOW: {
        async create(input: unknown) {
          created.push(input);
          throw new Error("response lost after durable create");
        },
        async get() {
          return { async status() { return { status: "running" }; } };
        },
      },
    } as unknown as ForgeWorkerEnv;
    const payload = validationWorkflowOutboxJson(parameters());
    await expect(deliverValidationWorkflowOutbox(env, IMPORT_ID, payload)).resolves.toEqual(parameters());
    expect(created).toEqual([{ id: IMPORT_ID, params: parameters() }]);
  });

  it("does not treat an unknown Workflow as a successful lost-ack replay", async () => {
    const env = {
      VALIDATION_WORKFLOW: {
        async create() { throw new Error("create failed before durable commit"); },
        async get() {
          return { async status() { return { status: "unknown" }; } };
        },
      },
    } as unknown as ForgeWorkerEnv;
    await expect(deliverValidationWorkflowOutbox(env, IMPORT_ID, validationWorkflowOutboxJson(parameters())))
      .rejects.toThrow("create failed before durable commit");
  });

  it("observes a completed lost-ack create but rejects every unsupported status", async () => {
    const payload = validationWorkflowOutboxJson(parameters());
    const minimal = {} as ForgeWorkerEnv;
    await expect(deliverValidationWorkflowOutbox(withFailedCreate(minimal, "complete"), IMPORT_ID, payload))
      .resolves.toEqual(parameters());
    await expect(deliverValidationWorkflowOutbox(withFailedCreate(minimal, "mystery"), IMPORT_ID, payload))
      .rejects.toThrow("unsupported status");
  });

  it("terminalizes an import when the observed Workflow failed before touching it", async () => {
    const { database, env } = fixture();
    await expect(deliverValidationWorkflowOutbox(
      withFailedCreate(env, "errored"),
      IMPORT_ID,
      validationWorkflowOutboxJson(parameters()),
    )).resolves.toEqual(parameters());
    expect(database.prepare("SELECT status, error_code, archive_r2_key, archive_disposition FROM collection_imports WHERE id=?").get(IMPORT_ID)).toEqual({
      status: "infrastructure-error",
      error_code: "validation-workflow-errored",
      archive_r2_key: null,
      archive_disposition: "deleted",
    });
  });

  it("quarantines a reserved archive and releases output claims before settling a terminal Workflow", async () => {
    const { database, env } = fixture();
    const archiveKey = `imports/${IMPORT_ID}/${COMMIT}.tar.gz`;
    database.prepare("UPDATE collection_imports SET status='downloading', archive_r2_key=? WHERE id=?").run(archiveKey, IMPORT_ID);
    await deliverValidationWorkflowOutbox(withFailedCreate(env, "terminated"), IMPORT_ID, validationWorkflowOutboxJson(parameters()));
    const github = database.prepare("SELECT status, error_code, archive_r2_key, archive_disposition, archive_delete_after FROM collection_imports WHERE id=?").get(IMPORT_ID) as Record<string, unknown>;
    expect(github).toMatchObject({
      status: "infrastructure-error",
      error_code: "validation-workflow-terminated",
      archive_r2_key: archiveKey,
      archive_disposition: "quarantined",
    });
    expect(Number.isFinite(Date.parse(github.archive_delete_after as string))).toBe(true);

    database.prepare("UPDATE collection_imports SET status='validating' WHERE id=?").run(IMPORT_ID);
    database.prepare("INSERT INTO collection_import_objects (import_id, object_key, object_sha256, object_bytes, claimed_at) VALUES (?, ?, ?, 100, ?)")
      .run(IMPORT_ID, CANONICAL_KEY, CANONICAL_DIGEST, NOW);
    expect(database.prepare("SELECT COUNT(*) AS count FROM collection_import_objects WHERE import_id=?").get(IMPORT_ID)).toEqual({ count: 1 });
    await deliverValidationWorkflowOutbox(withFailedCreate(env, "errored"), IMPORT_ID, validationWorkflowOutboxJson(parameters()));
    expect(database.prepare("SELECT COUNT(*) AS count FROM collection_import_objects WHERE import_id=?").get(IMPORT_ID)).toEqual({ count: 0 });
    expect(database.prepare("SELECT COUNT(*) AS count FROM canonical_object_gc WHERE object_key=?").get(CANONICAL_KEY)).toEqual({ count: 1 });
  });

  it("settles an already-terminal replay only after repairing its opaque archive cleanup outbox", async () => {
    const { database, env } = fixture();
    const archiveKey = `imports/${IMPORT_ID}/${COMMIT}.tar.gz`;
    database.prepare("UPDATE collection_imports SET status='invalid', error_code='validation-failed', archive_r2_key=?, archive_disposition='pending' WHERE id=?")
      .run(archiveKey, IMPORT_ID);
    const failed = withFailedCreate(env, "errored");
    const payload = validationWorkflowOutboxJson(parameters());
    await deliverValidationWorkflowOutbox(failed, IMPORT_ID, payload);
    await deliverValidationWorkflowOutbox(failed, IMPORT_ID, payload);
    expect(database.prepare("SELECT status, error_code, archive_r2_key, archive_disposition FROM collection_imports WHERE id=?").get(IMPORT_ID)).toEqual({
      status: "invalid",
      error_code: "validation-failed",
      archive_r2_key: archiveKey,
      archive_disposition: "pending",
    });
    expect(database.prepare("SELECT COUNT(*) AS count FROM outbox WHERE kind='cleanup-import-archive' AND aggregate_id=? AND delivered_at IS NULL").get(IMPORT_ID)).toEqual({ count: 1 });
    const cleanup = database.prepare("SELECT payload_json FROM outbox WHERE kind='cleanup-import-archive' AND aggregate_id=?").get(IMPORT_ID) as { readonly payload_json: string };
    expect(cleanup.payload_json).toBe(archiveCleanupOutboxJson(IMPORT_ID));
    expect(cleanup.payload_json).not.toContain("archiveR2Key");
  });

  it("keeps archive object keys out of cleanup outbox payloads", () => {
    const payload = archiveCleanupOutboxJson(IMPORT_ID);
    expect(payload).toBe(JSON.stringify({ importId: IMPORT_ID }));
    expect(parseArchiveCleanupOutboxJson(payload, IMPORT_ID)).toEqual({ importId: IMPORT_ID });
    expect(() => parseArchiveCleanupOutboxJson(JSON.stringify({ importId: IMPORT_ID, archiveR2Key: `imports/${IMPORT_ID}/${COMMIT}.tar.gz` }), IMPORT_ID))
      .toThrow("invalid");
  });
});
