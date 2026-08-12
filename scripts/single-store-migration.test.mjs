import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import test from "node:test";

function apply(database, filename) {
  database.exec(readFileSync(path.join(process.cwd(), "migrations/core", filename), "utf8"));
}

function coreMigrations() {
  return readdirSync(path.join(process.cwd(), "migrations/core"))
    .filter((filename) => filename.endsWith(".sql"))
    .sort();
}

function columns(database, table) {
  return database.prepare(`PRAGMA table_info(${table})`).all().map((row) => String(row.name));
}

test("single-store migration preserves product resources and resets derived judging state", () => {
  const database = new DatabaseSync(":memory:");
  const migrations = coreMigrations();
  for (const migration of migrations.filter((filename) => filename < "0016_single_store.sql")) apply(database, migration);

  const now = "2026-08-11T00:00:00.000Z";
  database.prepare("INSERT INTO users (id, created_at, updated_at, status) VALUES ('user-1', ?, ?, 'active')").run(now, now);
  database.prepare("INSERT INTO github_installations (installation_id, account_github_id, account_login, installed_by_user_id, status, permissions_json, repository_selection, created_at, updated_at) VALUES (1, 1, 'wasm-oj', 'user-1', 'active', '{}', 'all', ?, ?)").run(now, now);
  database.prepare("INSERT INTO github_repositories (github_repository_id, installation_id, owner_login, name, is_private, authorization_status, updated_at) VALUES (1, 1, 'wasm-oj', 'official-problems', 0, 'authorized', ?)").run(now);
  database.prepare("INSERT INTO forge_releases (id, version, manifest_r2_key, manifest_mirror_r2_key, manifest_sha256, source_git_commit, status, created_at) VALUES ('release-1', 'v1', 'releases/v1', 'releases/v1', ?, ?, 'active', ?)")
    .run("a".repeat(64), "b".repeat(40), now);
  database.exec(`
    DROP TABLE forge_active_releases;
    CREATE TABLE forge_release_qualifications (
      id TEXT PRIMARY KEY,
      forge_release_id TEXT NOT NULL REFERENCES forge_releases(id),
      environment TEXT NOT NULL,
      manifest_sha256 TEXT NOT NULL,
      worker_bundle_sha256 TEXT NOT NULL,
      worker_version_id TEXT NOT NULL,
      container_image_digest TEXT NOT NULL,
      container_identity_sha256 TEXT NOT NULL,
      container_instance_type TEXT NOT NULL,
      evidence_r2_key TEXT NOT NULL,
      evidence_sha256 TEXT NOT NULL,
      qualified_by TEXT NOT NULL,
      qualified_at TEXT NOT NULL,
      UNIQUE (id, forge_release_id)
    ) STRICT;
    INSERT INTO forge_release_qualifications VALUES (
      'qualification-1', 'release-1', 'production', '${"a".repeat(64)}', '${"a".repeat(64)}',
      'worker-1', 'sha256:${"a".repeat(64)}', '${"a".repeat(64)}', 'standard-2',
      'evidence/1', '${"a".repeat(64)}', 'owner', '${now}'
    );
    CREATE TABLE forge_active_releases (
      environment TEXT PRIMARY KEY,
      forge_release_id TEXT NOT NULL UNIQUE REFERENCES forge_releases(id),
      qualification_id TEXT NOT NULL,
      activated_by TEXT NOT NULL,
      activated_at TEXT NOT NULL,
      FOREIGN KEY (qualification_id, forge_release_id)
        REFERENCES forge_release_qualifications(id, forge_release_id)
    ) STRICT;
    INSERT INTO forge_active_releases VALUES ('production', 'release-1', 'qualification-1', 'owner', '${now}');
    CREATE TABLE release_drain_checks (id TEXT PRIMARY KEY) STRICT;
    CREATE TABLE release_smoke_checks (id TEXT PRIMARY KEY) STRICT;
    CREATE TABLE forge_release_package_active_roots (id TEXT PRIMARY KEY) STRICT;
    CREATE TABLE forge_release_package_mutation_leases (id TEXT PRIMARY KEY) STRICT;
  `);
  database.prepare("INSERT INTO collection_imports (id, organizer_user_id, github_repository_id, requested_ref, commit_sha, index_path, forge_release_id, status, created_at, updated_at, canonical_source_r2_key, canonical_source_mirror_r2_key, canonical_source_sha256) VALUES ('import-1', 'user-1', 1, 'main', ?, 'collection/index.json', 'release-1', 'valid', ?, ?, 'snapshots/objects/' || ?, 'snapshots/objects/' || ?, ?)")
    .run("c".repeat(40), now, now, "d".repeat(64), "d".repeat(64), "d".repeat(64));
  database.prepare("INSERT INTO collection_imports (id, organizer_user_id, github_repository_id, requested_ref, commit_sha, index_path, forge_release_id, status, created_at, updated_at, canonical_source_r2_key, canonical_source_mirror_r2_key, canonical_source_sha256, source_kind, predecessor_import_id) VALUES ('successor-1', 'user-1', 1, 'main', ?, 'collection/index.json', 'release-1', 'queued', ?, ?, 'snapshots/objects/' || ?, 'snapshots/objects/' || ?, ?, 'canonical-successor', 'import-1')")
    .run("c".repeat(40), now, now, "d".repeat(64), "d".repeat(64), "d".repeat(64));
  database.prepare("INSERT INTO managed_snapshots (id, import_id, mode, collection_revision, judge_projection_digest, status, published_at, published_by, created_at) VALUES ('snapshot-1', 'import-1', 'official-practice', 'v1', ?, 'published', ?, 'user-1', ?)")
    .run("e".repeat(64), now, now);
  database.prepare("INSERT INTO managed_problem_versions (id, snapshot_id, problem_slug, problem_number, title_json, bundle_digest, public_projection_r2_key, judge_projection_r2_key, created_at) VALUES ('problem-1', 'snapshot-1', 'hello', 1, '{}', ?, 'public/1', 'judge/1', ?)")
    .run("f".repeat(64), now);
  for (const [id, status] of [["contest-running", "running"], ["contest-ended", "ended"]]) {
    database.prepare("INSERT INTO contests (id, organizer_user_id, title, access_mode, starts_at, ends_at, status, created_at, updated_at) VALUES (?, 'user-1', ?, 'public', '2026-08-10T00:00:00.000Z', '2026-08-12T00:00:00.000Z', ?, ?, ?)")
      .run(id, id, status, now, now);
  }
  database.prepare("INSERT INTO contest_problems (contest_id, managed_problem_version_id, ordinal) VALUES ('contest-running', 'problem-1', 1)").run();
  database.prepare("INSERT INTO contest_participants (contest_id, user_id, joined_at) VALUES ('contest-running', 'user-1', ?)").run(now);
  database.prepare("INSERT INTO core_outbox (id, kind, aggregate_id, payload_json, created_at) VALUES ('keep', 'cleanup-import-archive', 'import-1', '{}', ?), ('drop', 'start-validation-workflow', 'successor-1', '{}', ?)")
    .run(now, now);

  apply(database, "0016_single_store.sql");

  const tables = new Set(database.prepare("SELECT name FROM sqlite_schema WHERE type='table'").all().map((row) => row.name));
  for (const table of ["submissions", "submission_events", "submission_attempts", "rejudge_jobs", "outbox"]) {
    assert.equal(tables.has(table), true, `missing ${table}`);
  }
  for (const table of ["verified_solves", "rejudge_verified_solves", "formal_submission_admissions", "core_outbox"]) {
    assert.equal(tables.has(table), false, `retained ${table}`);
  }
  assert.equal(columns(database, "forge_releases").includes("manifest_mirror_r2_key"), false);
  assert.deepEqual(columns(database, "forge_active_releases"), ["environment", "forge_release_id", "activated_by", "activated_at"]);
  for (const retiredTable of [
    "forge_release_qualifications",
    "release_drain_checks",
    "release_smoke_checks",
    "forge_release_package_active_roots",
    "forge_release_package_mutation_leases",
  ]) {
    assert.equal(tables.has(retiredTable), false, `${retiredTable} must be removed`);
  }
  assert.equal(columns(database, "collection_imports").includes("canonical_source_mirror_r2_key"), false);
  assert.equal(columns(database, "collection_imports").includes("source_kind"), false);
  assert.equal(columns(database, "collection_imports").includes("predecessor_import_id"), false);
  assert.equal(columns(database, "collection_imports").includes("retry_of_import_id"), true);
  assert.equal(columns(database, "organizer_applications").includes("review_note"), true);
  assert.equal(columns(database, "submissions").includes("verdict"), true);
  const collectionIndexes = new Set(database.prepare("SELECT name FROM sqlite_schema WHERE type='index' AND tbl_name='collection_imports'").all().map((row) => row.name));
  assert.equal(collectionIndexes.has("collection_imports_one_root_source"), true);
  assert.equal(collectionIndexes.has("collection_imports_one_retry"), true);
  assert.equal(database.prepare("SELECT count(*) AS total FROM collection_imports WHERE id='successor-1'").get().total, 0);
  assert.deepEqual(database.prepare("SELECT id, status FROM contests ORDER BY id").all().map((row) => ({ ...row })), [
    { id: "contest-ended", status: "published" },
    { id: "contest-running", status: "published" },
  ]);
  assert.deepEqual(database.prepare("SELECT id, kind FROM outbox").all().map((row) => ({ ...row })), [
    { id: "keep", kind: "cleanup-import-archive" },
  ]);
  assert.deepEqual(database.prepare("SELECT contest_id, managed_problem_version_id FROM contest_problems").all().map((row) => ({ ...row })), [
    { contest_id: "contest-running", managed_problem_version_id: "problem-1" },
  ]);

  assert.throws(() => database.prepare("INSERT INTO collection_imports (id, organizer_user_id, github_repository_id, requested_ref, commit_sha, index_path, forge_release_id, status, created_at, updated_at) VALUES ('duplicate-root', 'user-1', 1, 'main', ?, 'collection/index.json', 'release-1', 'queued', ?, ?)")
    .run("c".repeat(40), now, now));
  database.prepare("INSERT INTO collection_imports (id, organizer_user_id, github_repository_id, requested_ref, commit_sha, index_path, forge_release_id, retry_of_import_id, status, created_at, updated_at) VALUES ('retry-1', 'user-1', 1, 'main', ?, 'collection/index.json', 'release-1', 'import-1', 'queued', ?, ?)")
    .run("c".repeat(40), now, now);
  assert.throws(() => database.prepare("INSERT INTO collection_imports (id, organizer_user_id, github_repository_id, requested_ref, commit_sha, index_path, forge_release_id, retry_of_import_id, status, created_at, updated_at) VALUES ('retry-2', 'user-1', 1, 'main', ?, 'collection/index.json', 'release-1', 'import-1', 'queued', ?, ?)")
    .run("c".repeat(40), now, now));

  database.prepare("INSERT INTO submissions (id, user_id, managed_problem_version_id, language, target, optimization, entry_path, source_r2_key, source_digest, forge_release_id, forge_manifest_sha256, state, admitted_at, created_at, updated_at) VALUES ('submission-1', 'erased-owner', 'problem-1', 'c', 'wasip1', 'release', 'main.c', 'sources/submission-1', ?, 'release-1', ?, 'admitting', ?, ?, ?)")
    .run("1".repeat(64), "a".repeat(64), now, now, now);
  database.prepare("UPDATE submissions SET state='completed', verdict='accepted' WHERE id='submission-1'").run();
  assert.deepEqual({ ...database.prepare("SELECT state, verdict FROM submissions WHERE id='submission-1'").get() }, { state: "completed", verdict: "accepted" });
  assert.throws(() => database.prepare("UPDATE submissions SET verdict='unrecognized' WHERE id='submission-1'").run());
  assert.throws(() => database.prepare("INSERT INTO submissions (id, user_id, managed_problem_version_id, language, target, optimization, entry_path, forge_release_id, forge_manifest_sha256, state, admitted_at, created_at, updated_at) VALUES ('missing-source', 'user-1', 'problem-1', 'c', 'wasip1', 'release', 'main.c', 'release-1', ?, 'admitting', ?, ?, ?)")
    .run("a".repeat(64), now, now, now));
  assert.deepEqual(database.prepare("PRAGMA foreign_key_check").all(), []);
});
