import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { describe, expect, it } from "vitest";
import type { WasmOjWorkerEnv } from "./env";
import { makeReadyBatchEffective, type RejudgeBatchRow } from "./rejudge";

class Statement {
  private bindings: SQLInputValue[] = [];
  constructor(private readonly database: DatabaseSync, private readonly sql: string) {}
  bind(...values: unknown[]) { this.bindings = values as SQLInputValue[]; return this; }
  async first<T>(): Promise<T | null> { return (this.database.prepare(this.sql).get(...this.bindings) as T | undefined) ?? null; }
  async run(): Promise<D1Result> {
    const result = this.database.prepare(this.sql).run(...this.bindings);
    return { success: true, meta: { changes: Number(result.changes) } } as D1Result;
  }
}

class SqliteD1 {
  constructor(private readonly database: DatabaseSync) {}
  prepare(sql: string): Statement { return new Statement(this.database, sql); }
  async batch(statements: readonly Statement[]): Promise<D1Result[]> {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const results: D1Result[] = [];
      for (const statement of statements) results.push(await statement.run());
      this.database.exec("COMMIT");
      return results;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }
}

const ORIGIN = "11111111-1111-4111-8111-111111111111";
const CHILD = "22222222-2222-4222-8222-222222222222";
const USER = "33333333-3333-4333-8333-333333333333";
const SOURCE = "44444444-4444-4444-8444-444444444444";
const PROBLEM = "55555555-5555-4555-8555-555555555555";
const CATALOG = "66666666-6666-4666-8666-666666666666";
const BATCH = "77777777-7777-4777-8777-777777777777";
const OLD_COMMIT = "a".repeat(40);
const ACTIVE_COMMIT = "b".repeat(40);
const OLD_JUDGE = "1".repeat(64);
const ACTIVE_JUDGE = "2".repeat(64);
const NOW = "2026-08-26T00:00:00.000Z";

function fixture(): { database: DatabaseSync; env: WasmOjWorkerEnv; batch: RejudgeBatchRow } {
  const database = new DatabaseSync(":memory:");
  database.exec(`
    CREATE TABLE users (id TEXT PRIMARY KEY, status TEXT NOT NULL, erasure_epoch INTEGER NOT NULL) STRICT;
    CREATE TABLE account_erasure_jobs (user_id TEXT PRIMARY KEY) STRICT;
    CREATE TABLE submission_sources (
      id TEXT PRIMARY KEY, owner_user_id TEXT NOT NULL, admission_erasure_epoch INTEGER NOT NULL,
      state TEXT NOT NULL
    ) STRICT;
    CREATE TABLE catalogs (id TEXT PRIMARY KEY, active_commit_sha TEXT) STRICT;
    CREATE TABLE problem_series (id TEXT PRIMARY KEY, catalog_id TEXT NOT NULL) STRICT;
    CREATE TABLE problem_revisions (
      problem_id TEXT NOT NULL, commit_sha TEXT NOT NULL, judge_digest TEXT NOT NULL,
      PRIMARY KEY (problem_id, commit_sha)
    ) STRICT;
    CREATE TABLE submissions (
      id TEXT PRIMARY KEY, origin_submission_id TEXT NOT NULL, user_id TEXT NOT NULL,
      problem_id TEXT NOT NULL, catalog_commit TEXT NOT NULL, judge_digest TEXT NOT NULL,
      contest_id TEXT, source_id TEXT NOT NULL, state TEXT NOT NULL
    ) STRICT;
    CREATE TABLE rejudge_batches (
      id TEXT PRIMARY KEY, state TEXT NOT NULL, expected_count INTEGER NOT NULL,
      purpose TEXT NOT NULL, contest_id TEXT, problem_id TEXT NOT NULL, to_commit TEXT NOT NULL,
      effective_at TEXT, updated_at TEXT NOT NULL
    ) STRICT;
    CREATE TABLE contest_problem_epochs (
      contest_id TEXT NOT NULL, problem_id TEXT NOT NULL, rollout_batch_id TEXT,
      state TEXT NOT NULL, judge_commit TEXT NOT NULL, judge_digest TEXT NOT NULL
    ) STRICT;
    CREATE TABLE contest_judge_rollout_origins (
      rejudge_batch_id TEXT NOT NULL, origin_submission_id TEXT NOT NULL,
      state TEXT NOT NULL
    ) STRICT;
    CREATE TABLE rejudge_jobs (
      rejudge_batch_id TEXT NOT NULL, origin_submission_id TEXT NOT NULL,
      new_submission_id TEXT NOT NULL, state TEXT NOT NULL
    ) STRICT;
    CREATE TABLE effective_rejudges (
      origin_submission_id TEXT PRIMARY KEY, effective_submission_id TEXT NOT NULL UNIQUE,
      rejudge_batch_id TEXT NOT NULL, became_effective_at TEXT NOT NULL
    ) STRICT;
    CREATE VIEW effective_submission_results AS
    SELECT origin.id AS origin_submission_id,
      coalesce(links.effective_submission_id, origin.id) AS effective_submission_id,
      effective.problem_id, effective.catalog_commit AS judged_commit,
      effective.judge_digest AS judged_digest, catalogs.active_commit_sha AS active_commit,
      active.judge_digest AS active_judge_digest,
      CASE WHEN active.judge_digest IS NULL OR active.judge_digest<>effective.judge_digest THEN 1 ELSE 0 END AS stale
    FROM submissions AS origin
    LEFT JOIN effective_rejudges AS links ON links.origin_submission_id=origin.id
    JOIN submissions AS effective ON effective.id=coalesce(links.effective_submission_id, origin.id)
    JOIN problem_series AS problems ON problems.id=effective.problem_id
    JOIN catalogs ON catalogs.id=problems.catalog_id
    LEFT JOIN problem_revisions AS active
      ON active.problem_id=effective.problem_id AND active.commit_sha=catalogs.active_commit_sha
    WHERE origin.origin_submission_id=origin.id;

    INSERT INTO users VALUES ('${USER}', 'active', 0);
    INSERT INTO submission_sources VALUES ('${SOURCE}', '${USER}', 0, 'ready');
    INSERT INTO catalogs VALUES ('${CATALOG}', '${ACTIVE_COMMIT}');
    INSERT INTO problem_series VALUES ('${PROBLEM}', '${CATALOG}');
    INSERT INTO problem_revisions VALUES ('${PROBLEM}', '${OLD_COMMIT}', '${OLD_JUDGE}');
    INSERT INTO problem_revisions VALUES ('${PROBLEM}', '${ACTIVE_COMMIT}', '${ACTIVE_JUDGE}');
    INSERT INTO submissions VALUES ('${ORIGIN}', '${ORIGIN}', '${USER}', '${PROBLEM}', '${OLD_COMMIT}', '${OLD_JUDGE}', NULL, '${SOURCE}', 'completed');
    INSERT INTO submissions VALUES ('${CHILD}', '${ORIGIN}', '${USER}', '${PROBLEM}', '${ACTIVE_COMMIT}', '${ACTIVE_JUDGE}', NULL, '${SOURCE}', 'completed');
    INSERT INTO rejudge_batches VALUES
      ('${BATCH}', 'ready', 1, 'manual', NULL, '${PROBLEM}', '${ACTIVE_COMMIT}', NULL, '${NOW}');
    INSERT INTO rejudge_jobs VALUES ('${BATCH}', '${ORIGIN}', '${CHILD}', 'ready');
  `);
  const batch: RejudgeBatchRow = {
    id: BATCH, problem_id: PROBLEM, from_commit: OLD_COMMIT, to_commit: ACTIVE_COMMIT,
    contest_id: null, requested_by: USER, purpose: "manual", state: "ready", expected_count: 1,
    completed_count: 1, ready_count: 1, failed_count: 0, failure_code: null,
    cancel_requested_at: null, created_at: NOW, updated_at: NOW, effective_at: null,
  };
  return { database, env: { DB: new SqliteD1(database) as unknown as D1Database } as WasmOjWorkerEnv, batch };
}

describe("commit-to-commit rejudge effectiveness", () => {
  it("keeps the origin immutable and clears stale only after the ready child becomes effective", async () => {
    const { database, env, batch } = fixture();
    expect(database.prepare("SELECT judged_commit, active_commit, stale FROM effective_submission_results WHERE origin_submission_id=?").get(ORIGIN))
      .toEqual({ judged_commit: OLD_COMMIT, active_commit: ACTIVE_COMMIT, stale: 1 });

    await expect(makeReadyBatchEffective(env, batch)).resolves.toBe(true);

    expect(database.prepare("SELECT effective_submission_id FROM effective_rejudges WHERE origin_submission_id=?").get(ORIGIN))
      .toEqual({ effective_submission_id: CHILD });
    expect(database.prepare("SELECT judged_commit, active_commit, stale FROM effective_submission_results WHERE origin_submission_id=?").get(ORIGIN))
      .toEqual({ judged_commit: ACTIVE_COMMIT, active_commit: ACTIVE_COMMIT, stale: 0 });
    expect(database.prepare("SELECT catalog_commit, judge_digest FROM submissions WHERE id=?").get(ORIGIN))
      .toEqual({ catalog_commit: OLD_COMMIT, judge_digest: OLD_JUDGE });
  });
});
