import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import test from "node:test";

import { contestV1CutoverInternals, runContestV1Cutover } from "./contest-v1-cutover.mjs";

const NOW = "2026-08-27T00:00:00.000Z";
const START = "2026-08-26T00:00:00.000Z";
const END = "2026-08-26T01:00:00.000Z";
const COMMIT = "a".repeat(40);
const CATALOG_ID = "11111111-1111-4111-8111-111111111111";
const ORGANIZER_ID = "22222222-2222-4222-8222-222222222222";
const ENTRANT_ID = "33333333-3333-4333-8333-333333333333";
const PUBLIC_SUBMITTER_ID = "44444444-4444-4444-8444-444444444444";
const CONTEST_ID = "55555555-5555-4555-8555-555555555555";
const PROBLEM_ID = "66666666-6666-4666-8666-666666666666";
const SOURCE_ID = "77777777-7777-4777-8777-777777777777";
const SUBMISSION_ID = "88888888-8888-4888-8888-888888888888";

function applyThrough(database, maximum) {
  for (const filename of readdirSync(path.join(process.cwd(), "migrations/core"))
    .filter((candidate) => candidate.endsWith(".sql") && candidate.slice(0, 4) <= maximum)
    .sort()) {
    database.exec(readFileSync(path.join(process.cwd(), "migrations/core", filename), "utf8"));
  }
}

function databaseFixture({ withSubmission = true, startsAt = START, endsAt = END } = {}) {
  const database = new DatabaseSync(":memory:");
  applyThrough(database, "0019");
  for (const userId of [ORGANIZER_ID, ENTRANT_ID, PUBLIC_SUBMITTER_ID]) {
    database.prepare("INSERT INTO users (id, created_at, updated_at, status) VALUES (?, ?, ?, 'active')")
      .run(userId, NOW, NOW);
  }
  database.prepare(`INSERT INTO github_installations
    (installation_id, account_github_id, account_login, installed_by_user_id,
     status, permissions_json, repository_selection, created_at, updated_at)
    VALUES (1, 42, 'wasm-oj', ?, 'active', '{}', 'all', ?, ?)`).run(ORGANIZER_ID, NOW, NOW);
  database.prepare(`INSERT INTO github_repositories
    (github_repository_id, installation_id, owner_login, name, is_private,
     authorization_status, updated_at)
    VALUES (42, 1, 'wasm-oj', 'problems', 0, 'authorized', ?)`).run(NOW);
  database.prepare(`INSERT INTO catalogs
    (id, organizer_user_id, github_repository_id, active_commit_sha, created_at, updated_at)
    VALUES (?, ?, 42, ?, ?, ?)`).run(CATALOG_ID, ORGANIZER_ID, COMMIT, NOW, NOW);
  database.prepare("INSERT INTO problem_series (id, catalog_id, slug, created_at) VALUES (?, ?, 'sum', ?)")
    .run(PROBLEM_ID, CATALOG_ID, NOW);
  database.prepare(`INSERT INTO problem_revisions (
      problem_id, commit_sha, ordinal, title_json, summary_json, practice_enabled,
      practice_bundle_path, practice_bundle_bytes, practice_bundle_sha256,
      contest_bundle_path, contest_bundle_bytes, contest_bundle_sha256,
      judge_package_path, judge_package_bytes, judge_digest, allowed_profiles_json, created_at
    ) VALUES (?, ?, 1, '{"en":"Sum","zh-TW":"加總"}', '{"en":"","zh-TW":""}', 1,
      'sum.practice.json', 1, ?, 'sum.contest.json', 1, ?, 'sum.wasmojjudge', 1, ?, '{}', ?)`)
    .run(PROBLEM_ID, COMMIT, "1".repeat(64), "2".repeat(64), "3".repeat(64), NOW);
  database.prepare(`INSERT INTO contest_series (id, catalog_id, slug, invite_code_hash, created_at)
    VALUES (?, ?, 'legacy', NULL, ?)`).run(CONTEST_ID, CATALOG_ID, NOW);
  database.prepare(`INSERT INTO contest_revisions
    (contest_id, commit_sha, status, title, description, access_mode,
     starts_at, ends_at, freeze_at, created_at)
    VALUES (?, ?, 'published', 'Legacy', '', 'public', ?, ?, ?, ?)`)
    .run(CONTEST_ID, COMMIT, startsAt, endsAt,
      new Date(Date.parse(startsAt) + 3_000_000).toISOString(),
      new Date(Date.parse(startsAt) - 86_400_000).toISOString());
  database.prepare(`INSERT INTO contest_revision_problems
    (contest_id, commit_sha, problem_id, ordinal) VALUES (?, ?, ?, 1)`)
    .run(CONTEST_ID, COMMIT, PROBLEM_ID);
  database.prepare("INSERT INTO contest_participants (contest_id, user_id, joined_at) VALUES (?, ?, ?)")
    .run(CONTEST_ID, ENTRANT_ID, new Date(Date.parse(startsAt) - 3_600_000).toISOString());
  if (withSubmission) {
    database.prepare(`INSERT INTO submission_sources
      (id, owner_user_id, admission_erasure_epoch, content_sha256, bytes, state, created_at, ready_at)
      VALUES (?, ?, 0, ?, 4, 'ready', ?, ?)`).run(SOURCE_ID, PUBLIC_SUBMITTER_ID, "4".repeat(64), NOW, NOW);
    database.prepare(`INSERT INTO submissions (
        id, origin_submission_id, origin_submitted_at, user_id, problem_id,
        catalog_commit, judge_digest, contest_id, source_id, language, target,
        optimization, entry_path, state, verdict, visibility, score,
        fully_passed_cases, deterministic_cost, peak_memory_bytes,
        policy_summary_json, effective_attempt, admitted_at, created_at, updated_at, completed_at
      ) VALUES (
        ?, ?, ?, ?, ?, ?, ?, ?, ?, 'c', 'wasip1', 'release', 'main.c',
        'completed', 'accepted', 'private', 100, 1, 10, 1024,
        '{}', 1, ?, ?, ?, ?
      )`)
      .run(
        SUBMISSION_ID, SUBMISSION_ID, new Date(Date.parse(startsAt) + 300_000).toISOString(),
        PUBLIC_SUBMITTER_ID, PROBLEM_ID, COMMIT, "3".repeat(64), CONTEST_ID, SOURCE_ID,
        new Date(Date.parse(startsAt) + 300_000).toISOString(),
        new Date(Date.parse(startsAt) + 300_000).toISOString(),
        new Date(Date.parse(startsAt) + 360_000).toISOString(),
        new Date(Date.parse(startsAt) + 360_000).toISOString(),
      );
  }
  database.exec(readFileSync(path.join(process.cwd(), "migrations/core/0020_contest_v2_runtime.sql"), "utf8"));
  return database;
}

function adapter(database) {
  return {
    async query(sql) { return database.prepare(sql).all().map((row) => ({ ...row })); },
    async execute(statements) {
      database.exec("BEGIN IMMEDIATE");
      try {
        for (const statement of statements) database.exec(statement);
        database.exec("COMMIT");
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
    },
  };
}

test("contest v1 cutover materializes an idempotent classic-code timeline and preserves sources", async () => {
  const database = databaseFixture();
  const first = await runContestV1Cutover(adapter(database), { now: NOW });
  assert.deepEqual(first, { state: "completed", translatedContests: 1, replayed: false });
  assert.deepEqual({ ...database.prepare(`SELECT official_track, evidence_at, scoring_kind,
      leaderboard_kind, leaderboard_freeze_after_seconds, duration_seconds
    FROM contest_rule_revisions`).get() }, {
    official_track: "code",
    evidence_at: "judge-terminal",
    scoring_kind: "score",
    leaderboard_kind: "freeze",
    leaderboard_freeze_after_seconds: 3000,
    duration_seconds: 3600,
  });
  const rules = JSON.parse(database.prepare("SELECT rules_json FROM contest_rule_revisions").get().rules_json);
  assert.equal(rules.problems[0].points, 100);
  assert.equal(rules.problems[0].attemptLimit, 1_000_000);
  assert.deepEqual(rules.scoring.tieBreaks, [
    "fully-passed-cases", "deterministic-cost", "peak-memory", "final-best-achieved-at",
  ]);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM contest_entrants").get().count, 2);
  assert.deepEqual({ ...database.prepare(`SELECT evidence_at, admitted_logical_seconds,
      evidence_logical_seconds, eligibility FROM contest_submission_records`).get() }, {
    evidence_at: "judge-terminal",
    admitted_logical_seconds: 300,
    evidence_logical_seconds: 360,
    eligibility: "eligible",
  });
  assert.deepEqual({ ...database.prepare("SELECT state, logical_anchor_seconds FROM contest_runtimes").get() }, {
    state: "ended",
    logical_anchor_seconds: 3600,
  });
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM submission_sources WHERE id=?").get(SOURCE_ID).count, 1);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM submissions WHERE id=?").get(SUBMISSION_ID).count, 1);
  assert.equal(database.prepare("SELECT state FROM catalog_contest_v2_resync_requirements").get().state, "pending");
  assert.deepEqual(database.prepare("SELECT blocker_kind FROM contest_v2_preflight_blockers ORDER BY blocker_kind").all()
    .map((row) => ({ ...row })), [
    { blocker_kind: "catalog-contests-v2-resync-required" },
  ]);

  const replay = await runContestV1Cutover(adapter(database), { now: NOW });
  assert.deepEqual(replay, { state: "completed", translatedContests: 1, replayed: true });
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM contest_rule_revisions").get().count, 1);
  assert.deepEqual(database.prepare("PRAGMA foreign_key_check").all(), []);
});

test("contest v1 cutover gates a scheduled contest until its active catalog resyncs as v2", async () => {
  const futureStart = "2026-09-01T00:00:00.000Z";
  const database = databaseFixture({
    withSubmission: false,
    startsAt: futureStart,
    endsAt: "2026-09-01T01:00:00.000Z",
  });
  await runContestV1Cutover(adapter(database), { now: NOW });
  assert.throws(
    () => database.prepare("UPDATE contest_runtimes SET state='running', wall_anchor_at=? WHERE contest_id=?")
      .run(futureStart, CONTEST_ID),
    /requires contests\/v2 resync/u,
  );
  database.prepare(`UPDATE catalog_contest_v2_resync_requirements
    SET state='ready', resynced_commit=?, resynced_at=? WHERE catalog_id=?`)
    .run("b".repeat(40), NOW, CATALOG_ID);
  database.prepare("UPDATE contest_runtimes SET state='running', wall_anchor_at=? WHERE contest_id=?")
    .run(futureStart, CONTEST_ID);
  assert.equal(database.prepare("SELECT state FROM contest_runtimes").get().state, "running");
});

test("contest v1 cutover fails closed before hashing an unrepresentable logical duration", async () => {
  const database = databaseFixture({
    withSubmission: false,
    endsAt: "2026-08-26T01:00:00.500Z",
  });
  await assert.rejects(
    runContestV1Cutover(adapter(database), { now: NOW }),
    /not representable as whole logical seconds/u,
  );
  assert.deepEqual({ ...database.prepare("SELECT state, failure_code FROM contest_v2_cutover_state").get() }, {
    state: "failed",
    failure_code: "legacy-contest-unrepresentable",
  });
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM contest_rule_revisions").get().count, 0);
});

test("classic translation splits simultaneous legacy release into batches of at most eight", () => {
  const problems = Array.from({ length: 17 }, (_, index) => ({ slug: `p-${index + 1}` }));
  const rules = contestV1CutoverInternals.classicRules({
    starts_at: START,
    ends_at: END,
    freeze_at: null,
    created_at: "2026-08-25T00:00:00.000Z",
  }, problems);
  assert.deepEqual(rules.problems.map((problem) => problem.batch), [
    1, 1, 1, 1, 1, 1, 1, 1,
    2, 2, 2, 2, 2, 2, 2, 2,
    3,
  ]);
  assert.equal(rules.problems.every((problem) => problem.releaseAfterSeconds === 0), true);
});

test("deterministic entrant ids are stable, scoped, and valid UUIDv8 values", () => {
  const first = contestV1CutoverInternals.deterministicEntrantId(CONTEST_ID, ENTRANT_ID);
  assert.equal(first, contestV1CutoverInternals.deterministicEntrantId(CONTEST_ID, ENTRANT_ID));
  assert.notEqual(first, contestV1CutoverInternals.deterministicEntrantId(CONTEST_ID, PUBLIC_SUBMITTER_ID));
  assert.match(first, /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-a[0-9a-f]{3}-[0-9a-f]{12}$/u);
  assert.equal(createHash("sha256").update("unchanged source evidence").digest("hex").length, 64);
});
