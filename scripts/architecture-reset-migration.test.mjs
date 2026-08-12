import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import test from "node:test";
import {
  LEGACY_ERASURE_RECEIPT_SCHEMA,
  buildLegacyErasureReceiptStageSql,
  parseExactLegacyErasureReceipt,
} from "./architecture-reset-preflight.mjs";

const MIGRATION = "0017_architecture_reset.sql";
const NOW = "2026-08-12T00:00:00.000Z";
const uuid = (suffix) => `00000000-0000-4000-8000-${String(suffix).padStart(12, "0")}`;
const digest = (character) => character.repeat(64);
const gitSha = (character) => character.repeat(40);

function apply(database, filename) {
  database.exec(readFileSync(path.join(process.cwd(), "migrations/core", filename), "utf8"));
}

function legacyDatabase() {
  const database = new DatabaseSync(":memory:");
  const migrations = readdirSync(path.join(process.cwd(), "migrations/core"))
    .filter((filename) => filename.endsWith(".sql") && filename < MIGRATION)
    .sort();
  for (const migration of migrations) apply(database, migration);
  return database;
}

test("architecture reset consumes the immutable production release schema", () => {
  const database = legacyDatabase();
  const legacySchema = new Set(
    database.prepare("SELECT name FROM sqlite_schema WHERE type='table'").all().map((row) => String(row.name)),
  );
  assert.equal(legacySchema.has("forge_releases"), true);
  assert.equal(legacySchema.has("forge_active_releases"), true);
  assert.equal(legacySchema.has("wasm_oj_releases"), false);

  apply(database, MIGRATION);

  const migratedSchema = new Set(
    database.prepare("SELECT name FROM sqlite_schema WHERE type='table'").all().map((row) => String(row.name)),
  );
  assert.equal(migratedSchema.has("forge_releases"), false);
  assert.equal(migratedSchema.has("forge_active_releases"), false);
  assert.equal(migratedSchema.has("wasm_oj_releases"), true);
  assert.equal(migratedSchema.has("wasm_oj_active_releases"), true);
  assert.deepEqual(database.prepare("PRAGMA foreign_key_check").all(), []);
});

function columns(database, table) {
  return database.prepare(`PRAGMA table_info(${table})`).all().map((row) => String(row.name));
}

function indexShapes(database, table) {
  return database.prepare(`PRAGMA index_list(${table})`).all().map((index) => ({
    columns: database.prepare(`PRAGMA index_info(${index.name})`).all().map((row) => String(row.name)),
    origin: String(index.origin),
    partial: Number(index.partial),
    unique: Number(index.unique),
  })).sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
}

function seedPreservedIdentity(database) {
  database.prepare("INSERT INTO users (id, created_at, updated_at, status) VALUES (?, ?, ?, 'active')")
    .run(uuid(1), NOW, NOW);
  database.prepare("INSERT INTO github_identities (github_user_id, user_id, login, avatar_url, profile_url, updated_at) VALUES (10, ?, 'owner', 'https://example.test/avatar', 'https://example.test/owner', ?)")
    .run(uuid(1), NOW);
  database.prepare("INSERT INTO sessions (token_hash, user_id, csrf_hash, created_at, expires_at, last_seen_at) VALUES ('session-hash', ?, 'csrf-hash', ?, '2026-08-13T00:00:00.000Z', ?)")
    .run(uuid(1), NOW, NOW);
  database.prepare("INSERT INTO profiles (user_id, display_name, bio, visibility, updated_at) VALUES (?, 'Owner', '', 'public', ?)")
    .run(uuid(1), NOW);
  database.prepare("INSERT INTO user_roles (user_id, role, granted_at) VALUES (?, 'organizer', ?)")
    .run(uuid(1), NOW);
  database.prepare("INSERT INTO github_installations (installation_id, account_github_id, account_login, installed_by_user_id, status, permissions_json, repository_selection, created_at, updated_at) VALUES (1, 10, 'wasm-oj', ?, 'active', '{}', 'all', ?, ?)")
    .run(uuid(1), NOW, NOW);
  database.prepare("INSERT INTO github_repositories (github_repository_id, installation_id, owner_login, name, is_private, authorization_status, updated_at) VALUES (11, 1, 'wasm-oj', 'problems', 0, 'authorized', ?)")
    .run(NOW);
}

test("architecture reset guard aborts before destructive statements", () => {
  const database = legacyDatabase();
  database.prepare("INSERT INTO account_erasure_jobs (id, user_id, anonymous_user_id, status, requested_at, updated_at) VALUES ('erasure-active', 'owner', 'anonymous', 'revoking', ?, ?)")
    .run(NOW, NOW);

  assert.throws(() => apply(database, MIGRATION), /CHECK constraint failed/);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM collection_imports").get().count, 0);
  assert.equal(columns(database, "users").includes("erasure_epoch"), false);
  assert.equal(columns(database, "forge_releases").includes("manifest_r2_key"), true);
});

function exactLegacyReceipt(jobId, anonymousUserId) {
  return Buffer.from(`${JSON.stringify({
    schema: LEGACY_ERASURE_RECEIPT_SCHEMA,
    jobId,
    anonymousUserId,
    erasedAt: NOW,
    deletedSourceObjects: 1,
    affectedProblems: 2,
    affectedContests: 3,
  })}\n`, "utf8");
}

function seedHistoricErasureRecords(database) {
  const receipts = new Map([
    ["receipts/complete.json", exactLegacyReceipt("erasure-complete", "anonymous-complete")],
    ["receipts/history.json", exactLegacyReceipt("erasure-history", "anonymous-history")],
  ]);
  database.prepare("INSERT INTO account_erasure_jobs (id, user_id, anonymous_user_id, status, requested_at, updated_at, completed_at, deletion_receipt_r2_key, deletion_receipt_sha256) VALUES ('erasure-complete', 'removed-user', 'anonymous-complete', 'completed', ?, ?, ?, 'receipts/complete.json', ?)")
    .run(NOW, NOW, NOW, createHash("sha256").update(receipts.get("receipts/complete.json")).digest("hex"));
  database.prepare("INSERT INTO erased_user_tombstones (anonymous_user_id, original_user_sha256, erased_at, deletion_receipt_r2_key, deletion_receipt_sha256) VALUES ('anonymous-history', ?, ?, 'receipts/history.json', ?)")
    .run(digest("b"), NOW, createHash("sha256").update(receipts.get("receipts/history.json")).digest("hex"));
  return receipts;
}

function stageHistoricErasureReceipts(database, receipts) {
  const rows = database.prepare(`SELECT
    record_kind, record_id, anonymous_user_id, erased_at, receipt_r2_key, receipt_sha256
  FROM (
    SELECT 'job' AS record_kind, id AS record_id, anonymous_user_id,
      requested_at AS erased_at, deletion_receipt_r2_key AS receipt_r2_key,
      deletion_receipt_sha256 AS receipt_sha256
    FROM account_erasure_jobs WHERE deletion_receipt_sha256 IS NOT NULL
    UNION ALL
    SELECT 'tombstone', anonymous_user_id, anonymous_user_id, erased_at,
      deletion_receipt_r2_key, deletion_receipt_sha256
    FROM erased_user_tombstones
  ) ORDER BY record_kind, record_id`).all();
  const records = rows.map((row) => parseExactLegacyErasureReceipt(row, receipts.get(row.receipt_r2_key)));
  database.exec(buildLegacyErasureReceiptStageSql(records));
  return records;
}

test("architecture reset refuses a quiescent database without verified erasure receipt staging", () => {
  const database = legacyDatabase();
  seedHistoricErasureRecords(database);
  assert.throws(() => apply(database, MIGRATION), /CHECK constraint failed/);
  assert.equal(columns(database, "users").includes("erasure_epoch"), false);
  assert.equal(columns(database, "account_erasure_jobs").includes("deletion_receipt_r2_key"), true);
});

function seedCatalog(database) {
  const ids = {
    collection: uuid(10),
    series: uuid(11),
    validationA: uuid(12),
    revisionA: uuid(13),
    publishA: uuid(14),
    publicationA: uuid(15),
    problemA: uuid(16),
    validationB: uuid(17),
    revisionB: uuid(18),
    publishB: uuid(19),
    publicationB: uuid(20),
    problemB: uuid(21),
    release: uuid(22),
    contestPublishA: uuid(23),
    contestPublicationA: uuid(24),
    contestProblemA: uuid(25),
    contestPublishB: uuid(26),
    contestPublicationB: uuid(27),
    contestProblemB: uuid(28),
  };
  database.prepare("INSERT INTO wasm_oj_releases (id, version, manifest_json, manifest_bytes, manifest_sha256, source_git_commit, created_at) VALUES (?, 'v2', '{}', 2, ?, ?, ?)")
    .run(ids.release, digest("9"), gitSha("9"), NOW);
  database.prepare("INSERT INTO problem_collections (id, organizer_user_id, github_repository_id, index_path, created_at, updated_at) VALUES (?, ?, 11, 'collection/index.json', ?, ?)")
    .run(ids.collection, uuid(1), NOW, NOW);
  database.prepare("INSERT INTO problem_series (id, collection_id, problem_slug, created_at) VALUES (?, ?, 'sum-two', ?)")
    .run(ids.series, ids.collection, NOW);

  const revisions = [
    {
      validation: ids.validationA,
      revision: ids.revisionA,
      publish: ids.publishA,
      publication: ids.publicationA,
      problem: ids.problemA,
      commit: gitSha("a"),
      revisionDigest: digest("1"),
      semantic: digest("a"),
      idempotency: "publish-a",
    },
    {
      validation: ids.validationB,
      revision: ids.revisionB,
      publish: ids.publishB,
      publication: ids.publicationB,
      problem: ids.problemB,
      commit: gitSha("b"),
      revisionDigest: digest("2"),
      semantic: digest("b"),
      idempotency: "publish-b",
    },
  ];

  for (const [index, item] of revisions.entries()) {
    database.prepare("INSERT INTO catalog_validation_jobs (id, collection_id, requested_ref, commit_sha, state, created_by, created_at, updated_at, started_at, finished_at) VALUES (?, ?, 'main', ?, 'valid', ?, ?, ?, ?, ?)")
      .run(item.validation, ids.collection, item.commit, uuid(1), NOW, NOW, NOW, NOW);
    database.prepare(`INSERT INTO collection_revisions (
      id, collection_id, validation_job_id, commit_sha, collection_revision_sha256,
      index_path, index_git_sha, index_bytes, index_sha256,
      managed_path, managed_git_sha, managed_bytes, managed_sha256,
      contract_version, validation_summary_json, validated_by, validated_at
    ) VALUES (?, ?, ?, ?, ?, 'collection/index.json', ?, 100, ?,
      'collection/managed.json', ?, 200, ?, 2, '{}', ?, ?)`)
      .run(
        item.revision, ids.collection, item.validation, item.commit, item.revisionDigest,
        gitSha(index === 0 ? "1" : "2"), digest(index === 0 ? "3" : "4"),
        gitSha(index === 0 ? "3" : "4"), digest(index === 0 ? "5" : "6"),
        uuid(1), NOW,
      );
    database.prepare("INSERT INTO judge_packages (sha256, bytes, state, staged_at, ready_at) VALUES (?, 12, 'ready', ?, ?)")
      .run(item.semantic, NOW, NOW);
    database.prepare(`INSERT INTO collection_revision_problems (
      collection_revision_id, problem_series_id, problem_number, title_json, difficulty,
      tags_json, practice_bundle_path, practice_bundle_git_sha, practice_bundle_bytes,
      practice_bundle_sha256, contest_public_path, contest_public_git_sha,
      contest_public_bytes, contest_public_sha256, judge_package_path,
      judge_package_git_sha, judge_package_bytes, judge_package_sha256,
      allowed_profiles_json, maximum_score
    ) VALUES (?, ?, 1, '{"en":"Sum Two"}', 'easy', '[]',
      'managed/practice.json', ?, 10, ?, 'managed/contest.json', ?, 11, ?,
      'managed/judge.wasmojjudge', ?, 12, ?,
      '{"c":{"optimization":"release","target":"wasip1"}}', 100)`)
      .run(
        item.revision, ids.series,
        gitSha("5"), digest("5"), gitSha("6"), digest("6"), gitSha("7"), item.semantic,
      );
    database.prepare("INSERT INTO catalog_publish_jobs (id, collection_revision_id, mode, state, requested_by, idempotency_key, request_digest, created_at, updated_at, started_at, finished_at) VALUES (?, ?, 'official-practice', 'published', ?, ?, ?, ?, ?, ?, ?)")
      .run(item.publish, item.revision, uuid(1), item.idempotency, digest(index === 0 ? "7" : "8"), NOW, NOW, NOW, NOW);
    database.prepare("INSERT INTO catalog_publications (id, publish_job_id, collection_revision_id, mode, published_by, published_at) VALUES (?, ?, ?, 'official-practice', ?, ?)")
      .run(item.publication, item.publish, item.revision, uuid(1), NOW);
    database.prepare(`INSERT INTO problem_versions (
      id, catalog_publication_id, problem_series_id,
      execution_semantic_sha256, created_at
    ) VALUES (?, ?, ?, ?, ?)`)
      .run(item.problem, item.publication, ids.series, item.semantic, NOW);

    const contestPublish = index === 0 ? ids.contestPublishA : ids.contestPublishB;
    const contestPublication = index === 0 ? ids.contestPublicationA : ids.contestPublicationB;
    const contestProblem = index === 0 ? ids.contestProblemA : ids.contestProblemB;
    database.prepare("INSERT INTO catalog_publish_jobs (id, collection_revision_id, mode, state, requested_by, idempotency_key, request_digest, created_at, updated_at, started_at, finished_at) VALUES (?, ?, 'contest', 'published', ?, ?, ?, ?, ?, ?, ?)")
      .run(contestPublish, item.revision, uuid(1), `${item.idempotency}-contest`, digest(index === 0 ? "c" : "d"), NOW, NOW, NOW, NOW);
    database.prepare("INSERT INTO catalog_publications (id, publish_job_id, collection_revision_id, mode, published_by, published_at) VALUES (?, ?, ?, 'contest', ?, ?)")
      .run(contestPublication, contestPublish, item.revision, uuid(1), NOW);
    database.prepare(`INSERT INTO problem_versions (
      id, catalog_publication_id, problem_series_id,
      execution_semantic_sha256, created_at
    ) VALUES (?, ?, ?, ?, ?)`)
      .run(contestProblem, contestPublication, ids.series, item.semantic, NOW);
  }
  database.prepare("INSERT INTO official_practice_heads (problem_series_id, problem_version_id, updated_at) VALUES (?, ?, ?)")
    .run(ids.series, ids.problemB, NOW);
  return ids;
}

function insertSource(database, id, state = "ready") {
  database.prepare(`INSERT INTO submission_sources (
    id, owner_user_id, admission_erasure_epoch, content_sha256, bytes, state,
    created_at, ready_at
  ) VALUES (?, ?, 0, ?, 20, ?, ?, ?)`)
    .run(id, uuid(1), digest("d"), state, NOW, state === "ready" ? NOW : null);
}

function policySummaryJson(totalCases = 1, outputAcceptedCases = 1) {
  return JSON.stringify({
    totalCases,
    outputAcceptedCases,
    policies: ["baseline", "efficient", "optimal"].map((id) => ({
      id,
      earnedCases: outputAcceptedCases,
      costExceededCases: 0,
      memoryExceededCases: 0,
      logicalTimeExceededCases: 0,
    })),
  });
}

function insertSubmission(database, {
  id,
  origin = id,
  problem,
  series,
  semantic,
  source,
  release,
  state = "completed",
  verdict = "accepted",
  score = state === "completed" ? 100 : 0,
  policySummary = state === "completed" ? policySummaryJson() : null,
}) {
  database.prepare(`INSERT INTO submissions (
    id, origin_submission_id, origin_submitted_at, user_id, problem_version_id,
    problem_series_id, execution_semantic_sha256, source_id,
    language, target, optimization, entry_path, wasm_oj_release_id,
    wasm_oj_manifest_sha256, state, verdict, score, policy_summary_json, admitted_at, created_at,
    updated_at, completed_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'c', 'wasip1',
    'release', 'main.c', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(
      id, origin, NOW, uuid(1), problem, series, semantic, source, release,
      digest("9"), state, verdict, score,
      policySummary,
      NOW, NOW, NOW, NOW,
    );
}

test("architecture reset preserves authority state and enforces the v2 consistency model", () => {
  const database = legacyDatabase();
  seedPreservedIdentity(database);
  const exactReceipts = seedHistoricErasureRecords(database);
  const stagedReceipts = stageHistoricErasureReceipts(database, exactReceipts);
  apply(database, MIGRATION);

  assert.deepEqual(database.prepare("PRAGMA foreign_key_check").all(), []);
  assert.equal(database.prepare("SELECT display_name FROM profiles WHERE user_id=?").get(uuid(1)).display_name, "Owner");
  assert.equal(database.prepare("SELECT role FROM user_roles WHERE user_id=?").get(uuid(1)).role, "organizer");
  assert.equal(database.prepare("SELECT login FROM github_identities WHERE user_id=?").get(uuid(1)).login, "owner");
  assert.equal(database.prepare("SELECT token_hash FROM sessions WHERE user_id=?").get(uuid(1)).token_hash, "session-hash");
  assert.equal(database.prepare("SELECT name FROM github_repositories WHERE github_repository_id=11").get().name, "problems");
  assert.equal(database.prepare("SELECT erasure_epoch FROM users WHERE id=?").get(uuid(1)).erasure_epoch, 0);
  const migratedReceipt = database.prepare("SELECT receipt_json, receipt_sha256 FROM erased_user_tombstones WHERE anonymous_user_id='anonymous-history'").get();
  assert.equal(migratedReceipt.receipt_json, exactReceipts.get("receipts/history.json").toString("utf8"));
  assert.equal(JSON.parse(migratedReceipt.receipt_json).schema, LEGACY_ERASURE_RECEIPT_SCHEMA);
  assert.equal(
    createHash("sha256").update(Buffer.from(migratedReceipt.receipt_json, "utf8")).digest("hex"),
    migratedReceipt.receipt_sha256,
  );
  assert.equal(migratedReceipt.receipt_sha256, stagedReceipts.find((record) => record.record_kind === "tombstone").receipt_sha256);
  assert.equal(
    database.prepare("SELECT receipt_json FROM account_erasure_jobs WHERE id='erasure-complete'").get().receipt_json,
    exactReceipts.get("receipts/complete.json").toString("utf8"),
  );
  assert.equal(columns(database, "account_erasure_jobs").includes("deletion_receipt_r2_key"), false);
  assert.equal(columns(database, "erased_user_tombstones").includes("deletion_receipt_r2_key"), false);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM sqlite_schema WHERE name='architecture_reset_erasure_receipts'").get().count, 0);
  assert.deepEqual(columns(database, "wasm_oj_releases"), [
    "id", "version", "manifest_json", "manifest_bytes", "manifest_sha256",
    "source_git_commit", "created_at", "revoked_at",
  ]);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM wasm_oj_active_releases").get().count, 0);
  assert.equal(database.prepare("SELECT SUM(formal_mutations_enabled) AS enabled FROM formal_mutation_controls").get().enabled, 0);

  const expectedTables = [
    "problem_collections", "catalog_validation_jobs", "collection_revisions",
    "problem_series", "collection_revision_problems", "catalog_publish_jobs",
    "judge_packages", "catalog_publications", "problem_versions",
    "official_practice_heads", "submission_sources", "submissions",
    "submission_attempts", "submission_events", "rejudge_batches", "rejudge_jobs",
    "problem_version_lineages", "workflow_outbox", "maintenance_cursors",
  ];
  const schemaObjects = new Set(database.prepare("SELECT name FROM sqlite_schema").all().map((row) => row.name));
  for (const table of expectedTables) assert.equal(schemaObjects.has(table), true, `missing ${table}`);
  for (const removed of [
    "collection_imports", "managed_snapshots", "managed_problem_versions",
    "outbox", "effective_rejudges", "rejudge_results", "maintenance_tasks",
  ]) {
    assert.equal(schemaObjects.has(removed), false, `retained ${removed}`);
  }
  assert.equal(schemaObjects.has("effective_submission_results"), true);
  assert.equal(schemaObjects.has("problem_version_details"), true);
  assert.deepEqual(columns(database, "catalog_publications"), [
    "id", "publish_job_id", "collection_revision_id", "mode", "published_by", "published_at",
  ]);
  assert.deepEqual(columns(database, "problem_versions"), [
    "id", "catalog_publication_id", "problem_series_id", "execution_semantic_sha256", "created_at",
  ]);
  assert.deepEqual(columns(database, "official_practice_heads"), [
    "problem_series_id", "problem_version_id", "updated_at",
  ]);
  assert.equal(columns(database, "submissions").includes("policy_summary_json"), true);
  assert.deepEqual(indexShapes(database, "catalog_publications"), [
    { columns: ["id"], origin: "pk", partial: 0, unique: 1 },
    { columns: ["publish_job_id"], origin: "u", partial: 0, unique: 1 },
  ]);
  assert.deepEqual(indexShapes(database, "problem_versions"), [
    { columns: ["catalog_publication_id", "problem_series_id"], origin: "u", partial: 0, unique: 1 },
    { columns: ["execution_semantic_sha256"], origin: "c", partial: 0, unique: 0 },
    { columns: ["id", "problem_series_id"], origin: "u", partial: 0, unique: 1 },
    { columns: ["id"], origin: "pk", partial: 0, unique: 1 },
  ]);
  assert.deepEqual(indexShapes(database, "official_practice_heads"), [
    { columns: ["problem_series_id"], origin: "pk", partial: 0, unique: 1 },
    { columns: ["problem_version_id"], origin: "u", partial: 0, unique: 1 },
  ]);
  for (const table of [
    "catalog_validation_jobs",
    "collection_revisions",
    "problem_series",
    "catalog_publish_jobs",
    "rejudge_jobs",
  ]) {
    assert.equal(indexShapes(database, table).some((index) => (
      index.origin === "u" && index.columns[0] === "id" && index.columns.length > 1
    )), false, `redundant id composite index on ${table}`);
  }

  const ids = seedCatalog(database);
  const cancelledValidation = uuid(90);
  database.prepare(`INSERT INTO catalog_validation_jobs (
    id, collection_id, requested_ref, commit_sha, state, created_by,
    error_code, created_at, updated_at, started_at, finished_at
  ) VALUES (?, ?, 'cancelled-race', ?, 'infrastructure-error', ?,
    'account-erasure', ?, ?, ?, ?)`)
    .run(cancelledValidation, ids.collection, gitSha("c"), uuid(1), NOW, NOW, NOW, NOW);
  assert.throws(
    () => database.prepare(`INSERT INTO collection_revisions (
      id, collection_id, validation_job_id, commit_sha,
      collection_revision_sha256, index_path, index_git_sha, index_bytes,
      index_sha256, managed_path, managed_git_sha, managed_bytes,
      managed_sha256, contract_version, validation_summary_json,
      validated_by, validated_at
    ) SELECT ?, collection_id, ?, ?, ?, index_path, index_git_sha,
      index_bytes, index_sha256, managed_path, managed_git_sha, managed_bytes,
      managed_sha256, contract_version, validation_summary_json,
      validated_by, validated_at FROM collection_revisions WHERE id=?`)
      .run(uuid(91), cancelledValidation, gitSha("c"), digest("f"), ids.revisionA),
    /requires its exact valid validation job/,
  );

  const cancelledPublish = uuid(92);
  const stagingPackage = digest("f");
  database.prepare(`INSERT INTO catalog_publish_jobs (
    id, collection_revision_id, mode, state, requested_by, idempotency_key,
    request_digest, error_code, created_at, updated_at, started_at, finished_at
  ) VALUES (?, ?, 'official-practice', 'failed', ?, 'cancelled-race', ?,
    'account-erasure', ?, ?, ?, ?)`)
    .run(cancelledPublish, ids.revisionA, uuid(1), digest("0"), NOW, NOW, NOW, NOW);
  database.prepare("INSERT INTO judge_packages (sha256, bytes, state, staged_at) VALUES (?, 12, 'staging', ?)")
    .run(stagingPackage, NOW);
  database.exec("BEGIN IMMEDIATE");
  database.prepare("UPDATE judge_packages SET state='ready', ready_at=? WHERE sha256=? AND state='staging'")
    .run(NOW, stagingPackage);
  assert.throws(
    () => database.prepare(`INSERT INTO catalog_publications (
      id, publish_job_id, collection_revision_id, mode,
      published_by, published_at
    ) VALUES (?, ?, ?, 'official-practice', ?, ?)`)
      .run(uuid(93), cancelledPublish, ids.revisionA, uuid(1), NOW),
    /requires its exact published job/,
  );
  database.exec("ROLLBACK");
  assert.deepEqual({ ...database.prepare("SELECT state, ready_at FROM judge_packages WHERE sha256=?").get(stagingPackage) }, {
    state: "staging",
    ready_at: null,
  });
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM catalog_publications WHERE publish_job_id=?").get(cancelledPublish).count, 0);

  assert.throws(
    () => database.prepare("UPDATE collection_revisions SET managed_bytes=201 WHERE id=?").run(ids.revisionA),
    /collection revisions are immutable/,
  );
  assert.throws(
    () => database.prepare("UPDATE catalog_publish_jobs SET request_digest=? WHERE id=?").run(digest("0"), ids.publishA),
    /catalog publish job identity is immutable/,
  );
  assert.throws(
    () => database.prepare(`UPDATE collection_revision_problems
      SET contest_public_bytes=12 WHERE collection_revision_id=? AND problem_series_id=?`)
      .run(ids.revisionA, ids.series),
    /collection revision problems are immutable/,
  );
  assert.throws(
    () => database.prepare(`DELETE FROM collection_revision_problems
      WHERE collection_revision_id=? AND problem_series_id=?`)
      .run(ids.revisionA, ids.series),
    /collection revision problems are immutable/,
  );
  assert.throws(
    () => database.prepare("UPDATE judge_packages SET ready_at=? WHERE sha256=?")
      .run("2026-08-12T00:00:01.000Z", digest("a")),
    /ready judge packages are immutable/,
  );
  assert.throws(
    () => database.prepare("DELETE FROM judge_packages WHERE sha256=?").run(digest("a")),
    /only a deletion-fenced staging judge package may be deleted/,
  );
  assert.throws(
    () => database.prepare("UPDATE catalog_publications SET collection_revision_id=? WHERE id=?")
      .run(ids.revisionB, ids.publicationA),
    /catalog publication identity is immutable/,
  );
  assert.throws(
    () => database.prepare("DELETE FROM catalog_publications WHERE id=?").run(ids.publicationA),
    /catalog publications are immutable/,
  );
  assert.throws(
    () => database.prepare("UPDATE problem_versions SET execution_semantic_sha256=? WHERE id=?")
      .run(digest("b"), ids.problemA),
    /problem versions are immutable/,
  );
  assert.throws(
    () => database.prepare("DELETE FROM problem_versions WHERE id=?").run(ids.problemA),
    /problem versions are immutable/,
  );

  const contest = uuid(29);
  database.prepare(`INSERT INTO contests (
    id, organizer_user_id, catalog_publication_id, title, description, access_mode,
    starts_at, ends_at, status, created_at, updated_at
  ) VALUES (?, ?, ?, 'Architecture v2', '', 'public', ?, '2026-08-13T00:00:00.000Z',
    'draft', ?, ?)`)
    .run(contest, uuid(1), ids.contestPublicationA, NOW, NOW, NOW);
  database.prepare(`INSERT INTO contest_problems (
    contest_id, problem_series_id, problem_version_id, ordinal
  ) VALUES (?, ?, ?, 1)`)
    .run(contest, ids.series, ids.contestProblemA);

  // A same-semantic successor in contest mode is an effective zero-job
  // rejudge, not an official-practice publication lineage.
  const contestNoOpPublish = uuid(105);
  const contestNoOpPublication = uuid(106);
  const contestNoOpProblem = uuid(107);
  const contestNoOpBatch = uuid(108);
  database.prepare(`INSERT INTO catalog_publish_jobs (
    id, collection_revision_id, mode, state, requested_by, idempotency_key,
    request_digest, created_at, updated_at, started_at, finished_at
  ) VALUES (?, ?, 'contest', 'published', ?, 'contest-noop-publish', ?, ?, ?, ?, ?)`)
    .run(contestNoOpPublish, ids.revisionA, uuid(1), digest("1"), NOW, NOW, NOW, NOW);
  database.prepare(`INSERT INTO catalog_publications (
    id, publish_job_id, collection_revision_id, mode, published_by, published_at
  ) VALUES (?, ?, ?, 'contest', ?, ?)`)
    .run(contestNoOpPublication, contestNoOpPublish, ids.revisionA, uuid(1), NOW);
  database.prepare(`INSERT INTO problem_versions (
    id, catalog_publication_id, problem_series_id,
    execution_semantic_sha256, created_at
  ) VALUES (?, ?, ?, ?, ?)`)
    .run(contestNoOpProblem, contestNoOpPublication, ids.series, digest("a"), NOW);
  database.prepare(`INSERT INTO rejudge_batches (
    id, old_problem_version_id, new_problem_version_id, problem_series_id,
    requested_by, state, expected_count, idempotency_key, request_digest,
    wasm_oj_release_id, wasm_oj_manifest_sha256, created_at, updated_at, effective_at
  ) VALUES (?, ?, ?, ?, ?, 'effective', 0, 'contest-noop-batch', ?, ?, ?, ?, ?, ?)`)
    .run(
      contestNoOpBatch, ids.contestProblemA, contestNoOpProblem, ids.series,
      uuid(1), digest("2"), ids.release, digest("9"), NOW, NOW, NOW,
    );
  database.prepare(`INSERT INTO problem_version_lineages (
    problem_series_id, predecessor_problem_version_id,
    successor_problem_version_id, reason, rejudge_batch_id, created_at
  ) VALUES (?, ?, ?, 'rejudge', ?, ?)`)
    .run(ids.series, ids.contestProblemA, contestNoOpProblem, contestNoOpBatch, NOW);
  assert.deepEqual({ ...database.prepare(`SELECT reason, rejudge_batch_id
    FROM problem_version_lineages WHERE predecessor_problem_version_id=?`).get(ids.contestProblemA) }, {
    reason: "rejudge",
    rejudge_batch_id: contestNoOpBatch,
  });

  const incompatibleContest = uuid(103);
  database.prepare(`INSERT INTO contests (
    id, organizer_user_id, catalog_publication_id, title, description, access_mode,
    starts_at, ends_at, status, created_at, updated_at
  ) VALUES (?, ?, ?, 'Architecture v2 B', '', 'public', ?, '2026-08-13T00:00:00.000Z',
    'draft', ?, ?)`)
    .run(incompatibleContest, uuid(1), ids.contestPublicationB, NOW, NOW, NOW);
  assert.throws(
    () => database.prepare(`UPDATE contest_problems
      SET contest_id=?
      WHERE contest_id=? AND problem_series_id=?`)
      .run(incompatibleContest, contest, ids.series),
    /one published contest publication/,
  );
  assert.throws(
    () => database.prepare(`UPDATE contest_problems
      SET problem_version_id=?
      WHERE contest_id=? AND problem_series_id=?`)
      .run(ids.contestProblemB, contest, ids.series),
    /one published contest publication/,
  );
  database.prepare(`INSERT INTO wasm_oj_active_releases (
    environment, wasm_oj_release_id, activated_by, activated_at
  ) VALUES ('production', ?, ?, ?)`).run(ids.release, uuid(1), NOW);
  assert.throws(
    () => database.prepare("UPDATE wasm_oj_active_releases SET environment='staging' WHERE environment='production'").run(),
    /active release environment is immutable/,
  );
  assert.throws(
    () => database.prepare("INSERT INTO problem_version_lineages (problem_series_id, predecessor_problem_version_id, successor_problem_version_id, reason, rejudge_batch_id, created_at) VALUES (?, ?, ?, 'publication', NULL, ?)")
      .run(ids.series, ids.problemA, ids.contestProblemA, NOW),
    /share one series and mode/,
  );

  const source = uuid(30);
  const otherSource = uuid(31);
  insertSource(database, source);
  insertSource(database, otherSource);
  const origin = uuid(32);
  const child = uuid(33);
  insertSubmission(database, {
    id: origin,
    problem: ids.problemA,
    series: ids.series,
    semantic: digest("a"),
    source,
    release: ids.release,
  });
  assert.throws(() => insertSubmission(database, {
    id: uuid(34),
    origin,
    problem: ids.problemB,
    series: ids.series,
    semantic: digest("b"),
    source: otherSource,
    release: ids.release,
  }), /canonical origin/);
  insertSubmission(database, {
    id: child,
    origin,
    problem: ids.problemB,
    series: ids.series,
    semantic: digest("b"),
    source,
    release: ids.release,
    verdict: "wrong-answer",
  });
  assert.throws(
    () => database.prepare("UPDATE submissions SET policy_summary_json=? WHERE id=?")
      .run(policySummaryJson(2, 1), child),
    /terminal submission results are immutable/,
  );
  assert.throws(
    () => insertSubmission(database, {
      id: uuid(104),
      problem: ids.problemA,
      series: ids.series,
      semantic: digest("a"),
      source,
      release: ids.release,
      policySummary: JSON.stringify({ padding: "x".repeat(2048) }),
    }),
    /CHECK constraint failed/,
  );

  // A direct Workflow judge-error is terminal failure provenance and can never
  // be represented as a ready, effective contestant result.
  const failedChild = uuid(100);
  const failedBatch = uuid(101);
  const failedJob = uuid(102);
  assert.throws(
    () => insertSubmission(database, {
      id: failedChild,
      origin,
      problem: ids.problemB,
      series: ids.series,
      semantic: digest("b"),
      source,
      release: ids.release,
      state: "judge-error",
      verdict: "judge-error",
      policySummary: policySummaryJson(),
    }),
    /CHECK constraint failed/,
  );
  insertSubmission(database, {
    id: failedChild,
    origin,
    problem: ids.problemB,
    series: ids.series,
    semantic: digest("b"),
    source,
    release: ids.release,
    state: "judge-error",
    verdict: "judge-error",
  });
  database.prepare(`INSERT INTO rejudge_batches (
    id, old_problem_version_id, new_problem_version_id, problem_series_id,
    requested_by, state, expected_count, idempotency_key, request_digest, wasm_oj_release_id,
    wasm_oj_manifest_sha256, created_at, updated_at
  ) VALUES (?, ?, ?, ?, ?, 'ready', 1, 'batch-judge-error', ?, ?, ?, ?, ?)`)
    .run(failedBatch, ids.problemA, ids.problemB, ids.series, uuid(1), digest("6"), ids.release, digest("9"), NOW, NOW);
  assert.throws(
    () => database.prepare(`INSERT INTO rejudge_jobs (
      id, rejudge_batch_id, problem_series_id, origin_submission_id,
      old_submission_id, new_submission_id, old_problem_version_id,
      new_problem_version_id, source_id, user_id, state, result_state,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ready', 'judge-error', ?, ?)`)
      .run(
        failedJob, failedBatch, ids.series, origin, origin, failedChild,
        ids.problemA, ids.problemB, source, uuid(1), NOW, NOW,
      ),
    /CHECK constraint failed/,
  );
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM problem_version_lineages WHERE rejudge_batch_id=?").get(failedBatch).count, 0);
  database.prepare("UPDATE rejudge_batches SET state='failed', failure_code='judge-error', updated_at=? WHERE id=?")
    .run(NOW, failedBatch);

  const batch = uuid(35);
  const job = uuid(36);
  database.prepare(`INSERT INTO rejudge_batches (
    id, old_problem_version_id, new_problem_version_id, problem_series_id,
    requested_by, state, expected_count, idempotency_key, request_digest, wasm_oj_release_id,
    wasm_oj_manifest_sha256, created_at, updated_at, effective_at
  ) VALUES (?, ?, ?, ?, ?, 'ready', 1, 'batch-a', ?, ?, ?, ?, ?, NULL)`)
    .run(batch, ids.problemA, ids.problemB, ids.series, uuid(1), digest("8"), ids.release, digest("9"), NOW, NOW);
  assert.throws(
    () => database.prepare(`INSERT INTO rejudge_batches (
      id, old_problem_version_id, new_problem_version_id, problem_series_id,
      requested_by, state, expected_count, idempotency_key, request_digest,
      wasm_oj_release_id, wasm_oj_manifest_sha256, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, 'queued', 0, 'overlapping-generation', ?, ?, ?, ?, ?)`).run(
      uuid(100), ids.problemB, ids.problemA, ids.series, uuid(1), digest("0"),
      ids.release, digest("9"), NOW, NOW,
    ),
    /UNIQUE constraint failed: rejudge_batches\.problem_series_id/,
  );
  database.prepare(`INSERT INTO rejudge_jobs (
    id, rejudge_batch_id, problem_series_id, origin_submission_id,
    old_submission_id, new_submission_id, old_problem_version_id,
    new_problem_version_id, source_id, user_id, state, result_state,
    created_at, updated_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ready', 'completed', ?, ?)`)
    .run(job, batch, ids.series, origin, origin, child, ids.problemA, ids.problemB, source, uuid(1), NOW, NOW);
  database.exec("BEGIN IMMEDIATE");
  database.prepare("UPDATE rejudge_batches SET state='effective', effective_at=?, updated_at=? WHERE id=? AND state='ready'")
    .run(NOW, NOW, batch);
  database.prepare("INSERT INTO problem_version_lineages (problem_series_id, predecessor_problem_version_id, successor_problem_version_id, reason, rejudge_batch_id, created_at) VALUES (?, ?, ?, 'rejudge', ?, ?)")
    .run(ids.series, ids.problemA, ids.problemB, batch, NOW);
  database.exec("COMMIT");
  assert.deepEqual({ ...database.prepare("SELECT origin_submission_id, effective_submission_id, effective_problem_version_id FROM effective_submission_results WHERE origin_submission_id=?").get(origin) }, {
    origin_submission_id: origin,
    effective_submission_id: child,
    effective_problem_version_id: ids.problemB,
  });

  // A same-semantic publication after an effective rejudge advances the
  // management version without discarding the latest computed child result.
  const publishC = uuid(37);
  const publicationC = uuid(38);
  const problemC = uuid(39);
  database.prepare("INSERT INTO catalog_publish_jobs (id, collection_revision_id, mode, state, requested_by, idempotency_key, request_digest, created_at, updated_at, started_at, finished_at) VALUES (?, ?, 'official-practice', 'published', ?, 'publish-c', ?, ?, ?, ?, ?)")
    .run(publishC, ids.revisionB, uuid(1), digest("e"), NOW, NOW, NOW, NOW);
  database.prepare("INSERT INTO catalog_publications (id, publish_job_id, collection_revision_id, mode, published_by, published_at) VALUES (?, ?, ?, 'official-practice', ?, ?)")
    .run(publicationC, publishC, ids.revisionB, uuid(1), NOW);
  database.prepare(`INSERT INTO problem_versions (
    id, catalog_publication_id, problem_series_id,
    execution_semantic_sha256, created_at
  ) VALUES (?, ?, ?, ?, ?)`)
    .run(problemC, publicationC, ids.series, digest("b"), NOW);
  database.prepare("INSERT INTO problem_version_lineages (problem_series_id, predecessor_problem_version_id, successor_problem_version_id, reason, rejudge_batch_id, created_at) VALUES (?, ?, ?, 'publication', NULL, ?)")
    .run(ids.series, ids.problemB, problemC, NOW);
  assert.deepEqual({ ...database.prepare("SELECT effective_submission_id, effective_problem_version_id FROM effective_submission_results WHERE origin_submission_id=?").get(origin) }, {
    effective_submission_id: child,
    effective_problem_version_id: problemC,
  });

  // A second changed rejudge must select the deepest effective child even
  // when both activations share the same millisecond timestamp.
  const publishD = uuid(94);
  const publicationD = uuid(95);
  const problemD = uuid(96);
  const childD = uuid(97);
  const batchD = uuid(98);
  const jobD = uuid(99);
  database.prepare("INSERT INTO catalog_publish_jobs (id, collection_revision_id, mode, state, requested_by, idempotency_key, request_digest, created_at, updated_at, started_at, finished_at) VALUES (?, ?, 'official-practice', 'published', ?, 'publish-d', ?, ?, ?, ?, ?)")
    .run(publishD, ids.revisionA, uuid(1), digest("3"), NOW, NOW, NOW, NOW);
  database.prepare("INSERT INTO catalog_publications (id, publish_job_id, collection_revision_id, mode, published_by, published_at) VALUES (?, ?, ?, 'official-practice', ?, ?)")
    .run(publicationD, publishD, ids.revisionA, uuid(1), NOW);
  database.prepare(`INSERT INTO problem_versions (
    id, catalog_publication_id, problem_series_id,
    execution_semantic_sha256, created_at
  ) VALUES (?, ?, ?, ?, ?)`)
    .run(problemD, publicationD, ids.series, digest("a"), NOW);
  insertSubmission(database, {
    id: childD,
    origin,
    problem: problemD,
    series: ids.series,
    semantic: digest("a"),
    source,
    release: ids.release,
  });
  database.prepare(`INSERT INTO rejudge_batches (
    id, old_problem_version_id, new_problem_version_id, problem_series_id,
    requested_by, state, expected_count, idempotency_key, request_digest, wasm_oj_release_id,
    wasm_oj_manifest_sha256, created_at, updated_at, effective_at
  ) VALUES (?, ?, ?, ?, ?, 'ready', 1, 'batch-d', ?, ?, ?, ?, ?, NULL)`)
    .run(batchD, problemC, problemD, ids.series, uuid(1), digest("4"), ids.release, digest("9"), NOW, NOW);
  database.prepare(`INSERT INTO rejudge_jobs (
    id, rejudge_batch_id, problem_series_id, origin_submission_id,
    old_submission_id, new_submission_id, old_problem_version_id,
    new_problem_version_id, source_id, user_id, state, result_state,
    created_at, updated_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ready', 'completed', ?, ?)`)
    .run(jobD, batchD, ids.series, origin, child, childD, problemC, problemD, source, uuid(1), NOW, NOW);
  database.exec("BEGIN IMMEDIATE");
  database.prepare("UPDATE rejudge_batches SET state='effective', effective_at=?, updated_at=? WHERE id=? AND state='ready'")
    .run(NOW, NOW, batchD);
  database.prepare("INSERT INTO problem_version_lineages (problem_series_id, predecessor_problem_version_id, successor_problem_version_id, reason, rejudge_batch_id, created_at) VALUES (?, ?, ?, 'rejudge', ?, ?)")
    .run(ids.series, problemC, problemD, batchD, NOW);
  database.exec("COMMIT");
  assert.deepEqual({ ...database.prepare("SELECT effective_submission_id, effective_problem_version_id FROM effective_submission_results WHERE origin_submission_id=?").get(origin) }, {
    effective_submission_id: childD,
    effective_problem_version_id: problemD,
  });
  assert.throws(
    () => database.prepare("UPDATE submissions SET source_id=? WHERE id=?").run(otherSource, child),
    /submission identity is immutable/,
  );
  const rejudgeJobForeignKeys = database.prepare("PRAGMA foreign_key_list(rejudge_jobs)").all();
  const predecessorForeignKeyId = rejudgeJobForeignKeys.find((row) => (
    row.table === "submissions" && row.from === "old_submission_id"
  )).id;
  assert.deepEqual(
    rejudgeJobForeignKeys
      .filter((row) => row.id === predecessorForeignKeyId)
      .map((row) => row.from),
    ["old_submission_id", "problem_series_id", "source_id", "user_id"],
  );

  const staleSource = uuid(40);
  const erasingSource = uuid(41);
  insertSource(database, staleSource, "reserved");
  insertSource(database, erasingSource, "reserved");
  database.prepare("UPDATE users SET status='suspended', erasure_epoch=erasure_epoch+1, updated_at=? WHERE id=?")
    .run(NOW, uuid(1));
  assert.throws(
    () => database.prepare("UPDATE submission_sources SET state='ready', ready_at=? WHERE id=?").run(NOW, staleSource),
    /submission source transition is invalid/,
  );
  database.exec("BEGIN");
  database.prepare(`UPDATE submission_sources
    SET state='erasing', content_sha256=NULL, bytes=NULL,
      erasure_requested_at=?, erasure_next_attempt_at=?
    WHERE id=?`)
    .run(NOW, NOW, erasingSource);
  database.exec("COMMIT");
  assert.deepEqual({ ...database.prepare(`SELECT state, erasure_attempts,
    erasure_next_attempt_at FROM submission_sources WHERE id=?`).get(erasingSource) }, {
    state: "erasing",
    erasure_attempts: 0,
    erasure_next_attempt_at: NOW,
  });
  database.prepare(`UPDATE submission_sources
    SET erasure_attempts=erasure_attempts+1, erasure_next_attempt_at=?
    WHERE id=?`).run("2026-08-12T00:05:00.000Z", erasingSource);
  database.prepare(`UPDATE submission_sources
    SET erasure_last_error='r2 unavailable', erasure_next_attempt_at=?
    WHERE id=?`).run("2026-08-12T00:10:00.000Z", erasingSource);
  assert.equal(database.prepare("SELECT erasure_attempts FROM submission_sources WHERE id=?").get(erasingSource).erasure_attempts, 1);

  const anonymousUser = uuid(50);
  database.prepare("INSERT INTO users (id, created_at, updated_at, status) VALUES (?, ?, ?, 'suspended')")
    .run(anonymousUser, NOW, NOW);
  database.prepare("INSERT INTO account_erasure_jobs (id, user_id, anonymous_user_id, status, requested_at, updated_at) VALUES ('erasure-v2', ?, ?, 'anonymizing', ?, ?)")
    .run(uuid(1), anonymousUser, NOW, NOW);
  database.prepare("UPDATE catalog_validation_jobs SET created_by=? WHERE created_by=?")
    .run(anonymousUser, uuid(1));
  database.prepare("UPDATE collection_revisions SET validated_by=? WHERE validated_by=?")
    .run(anonymousUser, uuid(1));
  database.prepare("UPDATE catalog_publish_jobs SET requested_by=? WHERE requested_by=?")
    .run(anonymousUser, uuid(1));
  database.prepare("UPDATE catalog_publications SET published_by=? WHERE published_by=?")
    .run(anonymousUser, uuid(1));
  database.prepare("UPDATE rejudge_batches SET requested_by=? WHERE requested_by=?")
    .run(anonymousUser, uuid(1));
  database.prepare("UPDATE submissions SET user_id=? WHERE user_id=?")
    .run(anonymousUser, uuid(1));
  assert.equal(database.prepare("SELECT user_id FROM rejudge_jobs WHERE id=?").get(job).user_id, anonymousUser);
  assert.deepEqual(database.prepare("PRAGMA foreign_key_check").all(), []);
});
