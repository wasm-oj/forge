import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import type { ForgeWorkerEnv } from "./env";
import {
  CANONICAL_OBJECT_GC_GRACE_MS,
  claimPredecessorCanonicalManifest,
  claimPredecessorObject,
  releaseImportObjectClaims,
} from "./canonical-object-claims";

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

const USER_ID = "00000000-0000-4000-8000-000000000001";
const OLD_RELEASE_ID = "00000000-0000-4000-8000-000000000002";
const ACTIVE_RELEASE_ID = "00000000-0000-4000-8000-000000000003";
const PREDECESSOR_ID = "00000000-0000-4000-8000-000000000004";
const ACTIVE_GITHUB_ID = "00000000-0000-4000-8000-000000000005";
const SUCCESSOR_ID = "00000000-0000-4000-8000-000000000006";
const SNAPSHOT_ID = "00000000-0000-4000-8000-000000000007";
const COMMIT = "c".repeat(40);
const MANIFEST_DIGEST = "a".repeat(64);
const OBJECT_DIGEST = "b".repeat(64);
const MANIFEST_KEY = `snapshots/objects/${MANIFEST_DIGEST}`;
const OBJECT_KEY = `snapshots/objects/${OBJECT_DIGEST}`;

function migratedDatabase(): DatabaseSync {
  const database = new DatabaseSync(":memory:");
  const migrationDirectory = join(process.cwd(), "migrations/core");
  for (const filename of readdirSync(migrationDirectory).filter((item) => item.endsWith(".sql")).sort()) {
    database.exec(readFileSync(join(migrationDirectory, filename), "utf8"));
  }
  return database;
}

function fixture(): { readonly database: DatabaseSync; readonly env: ForgeWorkerEnv } {
  const database = migratedDatabase();
  database.prepare("INSERT INTO users (id, created_at, updated_at, status) VALUES (?, ?, ?, 'active')")
    .run(USER_ID, "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z");
  database.prepare("INSERT INTO github_installations (installation_id, account_github_id, account_login, installed_by_user_id, status, permissions_json, repository_selection, created_at, updated_at) VALUES (1, 10, 'owner', ?, 'active', '{}', 'selected', ?, ?)")
    .run(USER_ID, "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z");
  database.exec("INSERT INTO github_repositories (github_repository_id, installation_id, owner_login, name, is_private, authorization_status, updated_at) VALUES (20, 1, 'owner', 'repo', 0, 'authorized', '2026-01-01T00:00:00.000Z')");
  const release = database.prepare("INSERT INTO forge_releases (id, version, manifest_r2_key, manifest_mirror_r2_key, manifest_sha256, source_git_commit, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
  release.run(OLD_RELEASE_ID, "old", "releases/old.json", "releases/old.json", "d".repeat(64), "e".repeat(40), "retired", "2026-01-01T00:00:00.000Z");
  release.run(ACTIVE_RELEASE_ID, "active", "releases/active.json", "releases/active.json", "f".repeat(64), "1".repeat(40), "active", "2026-01-02T00:00:00.000Z");
  const importStatement = database.prepare("INSERT INTO collection_imports (id, organizer_user_id, github_repository_id, requested_ref, commit_sha, index_path, forge_release_id, canonical_source_r2_key, canonical_source_mirror_r2_key, canonical_source_sha256, archive_disposition, source_kind, predecessor_import_id, status, created_at, updated_at) VALUES (?, ?, 20, 'main', ?, 'collection/index.json', ?, ?, ?, ?, 'deleted', ?, ?, ?, ?, ?)");
  importStatement.run(PREDECESSOR_ID, USER_ID, COMMIT, OLD_RELEASE_ID, MANIFEST_KEY, MANIFEST_KEY, MANIFEST_DIGEST, "github-archive", null, "valid", "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z");
  // A normal active-release import of the same commit must not block the
  // separately linked canonical successor.
  importStatement.run(ACTIVE_GITHUB_ID, USER_ID, COMMIT, ACTIVE_RELEASE_ID, null, null, null, "github-archive", null, "queued", "2026-01-02T00:00:00.000Z", "2026-01-02T00:00:00.000Z");
  importStatement.run(SUCCESSOR_ID, USER_ID, COMMIT, ACTIVE_RELEASE_ID, MANIFEST_KEY, MANIFEST_KEY, MANIFEST_DIGEST, "canonical-successor", PREDECESSOR_ID, "validating", "2026-01-02T00:00:00.000Z", "2026-01-02T00:00:00.000Z");
  database.prepare("INSERT INTO managed_snapshots (id, import_id, mode, collection_revision, judge_projection_digest, status, published_at, published_by, created_at) VALUES (?, ?, 'official-practice', ?, ?, 'published', ?, ?, ?)")
    .run(SNAPSHOT_ID, PREDECESSOR_ID, "2".repeat(64), "3".repeat(64), "2026-01-01T00:00:00.000Z", USER_ID, "2026-01-01T00:00:00.000Z");
  const claim = database.prepare("INSERT INTO collection_import_objects (import_id, object_key, object_sha256, object_bytes, claimed_at) VALUES (?, ?, ?, ?, ?)");
  claim.run(PREDECESSOR_ID, MANIFEST_KEY, MANIFEST_DIGEST, 200, "2026-01-01T00:00:00.000Z");
  claim.run(PREDECESSOR_ID, OBJECT_KEY, OBJECT_DIGEST, 300, "2026-01-01T00:00:00.000Z");
  database.prepare("INSERT INTO canonical_object_gc (object_key, object_sha256, object_bytes, not_before, created_at) VALUES (?, ?, 200, ?, ?)")
    .run(MANIFEST_KEY, MANIFEST_DIGEST, "2026-01-03T00:00:00.000Z", "2026-01-01T00:00:00.000Z");
  return {
    database,
    env: { CORE_DB: new SqliteD1(database) as unknown as D1Database } as ForgeWorkerEnv,
  };
}

describe("canonical successor object claims", () => {
  it("authorizes the exact published root before R2 and cancels pending GC", async () => {
    const { database, env } = fixture();
    await expect(claimPredecessorCanonicalManifest(env, SUCCESSOR_ID, PREDECESSOR_ID, OBJECT_KEY, OBJECT_DIGEST))
      .rejects.toThrow("not retained by the published predecessor");
    await expect(claimPredecessorCanonicalManifest(env, SUCCESSOR_ID, PREDECESSOR_ID, MANIFEST_KEY, MANIFEST_DIGEST))
      .resolves.toEqual({ key: MANIFEST_KEY, digest: MANIFEST_DIGEST, bytes: 200 });
    expect(database.prepare("SELECT COUNT(*) AS count FROM canonical_object_gc WHERE object_key=?").get(MANIFEST_KEY)).toEqual({ count: 0 });
    expect(database.prepare("SELECT object_bytes FROM collection_import_objects WHERE import_id=? AND object_key=?").get(SUCCESSOR_ID, MANIFEST_KEY)).toEqual({ object_bytes: 200 });
  });

  it("binds declared object length and releases the exact inventory through a 24-hour tombstone", async () => {
    const { database, env } = fixture();
    await expect(claimPredecessorObject(env, SUCCESSOR_ID, PREDECESSOR_ID, OBJECT_KEY, OBJECT_DIGEST, 301))
      .rejects.toThrow("not retained by the published predecessor");
    await expect(claimPredecessorObject(env, SUCCESSOR_ID, PREDECESSOR_ID, OBJECT_KEY, OBJECT_DIGEST, 300))
      .resolves.toEqual({ key: OBJECT_KEY, digest: OBJECT_DIGEST, bytes: 300 });
    database.prepare("UPDATE collection_imports SET status='invalid' WHERE id=?").run(SUCCESSOR_ID);
    const now = new Date("2026-01-04T00:00:00.000Z");
    await expect(releaseImportObjectClaims(env, SUCCESSOR_ID, now)).resolves.toBe(1);
    expect(database.prepare("SELECT COUNT(*) AS count FROM collection_import_objects WHERE import_id=?").get(SUCCESSOR_ID)).toEqual({ count: 0 });
    expect(database.prepare("SELECT not_before, state FROM canonical_object_gc WHERE object_key=?").get(OBJECT_KEY)).toEqual({
      not_before: new Date(now.getTime() + CANONICAL_OBJECT_GC_GRACE_MS).toISOString(),
      state: "pending",
    });
  });
});
