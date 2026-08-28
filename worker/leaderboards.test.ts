import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { describe, expect, it } from "vitest";
import type { ContestRules } from "../src/online-judge/contest-rules";
import { queryContestLeaderboard } from "./leaderboards";

class Statement {
  private bindings: SQLInputValue[] = [];

  constructor(private readonly database: DatabaseSync, private readonly sql: string) {}

  bind(...values: unknown[]): Statement {
    this.bindings = values as SQLInputValue[];
    return this;
  }

  async first<T>(): Promise<T | null> {
    return (this.database.prepare(this.sql).get(...this.bindings) as T | undefined) ?? null;
  }

  async all<T>(): Promise<D1Result<T>> {
    return {
      success: true,
      results: this.database.prepare(this.sql).all(...this.bindings) as T[],
      meta: {},
    } as D1Result<T>;
  }
}

const CONTEST_ID = "11111111-1111-4111-8111-111111111111";
const ENTRANT_ID = "22222222-2222-4222-8222-222222222222";
const USER_ID = "33333333-3333-4333-8333-333333333333";
const PROBLEM_ID = "44444444-4444-4444-8444-444444444444";
const SUBMISSION_ID = "55555555-5555-4555-8555-555555555555";
const RULES_COMMIT = "a".repeat(40);
const RULES_DIGEST = "b".repeat(64);

function rules(checkpointSeconds: readonly number[]): ContestRules {
  return {
    clock: {
      kind: "global",
      registrationOpensAt: "2026-08-25T00:00:00.000Z",
      registrationClosesAt: "2026-08-26T00:00:00.000Z",
      startsAt: "2026-08-26T00:00:00.000Z",
      durationSeconds: 1_000,
    },
    officialTrack: { kind: "code", aiAssist: "disabled" },
    evidenceAt: "input-admitted",
    problems: [{
      slug: "sum",
      batch: 1,
      releaseAfterSeconds: 0,
      submissionClosesAfterSeconds: 1_000,
      points: 100,
      attemptLimit: 3,
    }],
    scoring: { kind: "progress", tieBreaks: ["final-best-achieved-at"] },
    checkpoints: checkpointSeconds.map((atSeconds, index) => ({
      id: `gate-${index + 1}`,
      atSeconds,
      scope: { kind: "all-released" },
      threshold: { minimumSolved: 0, minimumScore: null },
      ranking: null,
      settlement: "provisional",
    })),
    leaderboard: { kind: "live" },
  };
}

function fixture(checkpointSeconds: readonly number[]): {
  readonly database: DatabaseSync;
  readonly d1: D1Database;
} {
  const database = new DatabaseSync(":memory:");
  database.exec(`
    CREATE TABLE contest_runtimes (
      contest_id TEXT PRIMARY KEY,
      active_rules_commit TEXT NOT NULL,
      active_rules_sha256 TEXT NOT NULL,
      timeline_generation INTEGER NOT NULL,
      rules_epoch INTEGER NOT NULL
    );
    CREATE TABLE contest_rule_revisions (
      contest_id TEXT NOT NULL,
      rules_commit TEXT NOT NULL,
      rules_sha256 TEXT NOT NULL,
      rules_json TEXT NOT NULL,
      global_starts_at TEXT
    );
    CREATE TABLE contest_problem_epochs (
      contest_id TEXT NOT NULL,
      problem_id TEXT NOT NULL,
      judge_epoch INTEGER NOT NULL,
      state TEXT NOT NULL,
      rollout_batch_id TEXT
    );
    CREATE TABLE rejudge_batches (id TEXT PRIMARY KEY, state TEXT NOT NULL, purpose TEXT NOT NULL);
    CREATE TABLE contest_entrants (
      id TEXT PRIMARY KEY,
      contest_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      account_user_id TEXT,
      state TEXT NOT NULL,
      state_timeline_generation INTEGER NOT NULL
    );
    CREATE TABLE contest_submission_records (
      submission_id TEXT PRIMARY KEY,
      contest_id TEXT NOT NULL,
      entrant_id TEXT NOT NULL,
      evidence_logical_seconds INTEGER,
      eligibility TEXT NOT NULL,
      judge_epoch INTEGER NOT NULL,
      prompt_attempt_id TEXT
    );
    CREATE TABLE submissions (
      id TEXT PRIMARY KEY,
      origin_submission_id TEXT NOT NULL,
      problem_id TEXT NOT NULL,
      state TEXT NOT NULL,
      verdict TEXT,
      score REAL,
      fully_passed_cases INTEGER,
      deterministic_cost INTEGER,
      peak_memory_bytes INTEGER
    );
    CREATE TABLE effective_submission_results (
      origin_submission_id TEXT PRIMARY KEY,
      effective_submission_id TEXT NOT NULL
    );
    CREATE TABLE problem_series (id TEXT PRIMARY KEY, slug TEXT NOT NULL);
    CREATE TABLE contest_rule_problems (
      contest_id TEXT NOT NULL,
      rules_commit TEXT NOT NULL,
      problem_id TEXT NOT NULL,
      ordinal INTEGER NOT NULL
    );
    CREATE TABLE contest_judge_rollout_prompt_attempts (
      prompt_attempt_id TEXT NOT NULL,
      target_judge_epoch INTEGER NOT NULL,
      state TEXT NOT NULL
    );
    CREATE TABLE contest_checkpoint_runs (
      id TEXT PRIMARY KEY,
      contest_id TEXT NOT NULL,
      timeline_generation INTEGER NOT NULL,
      rules_epoch INTEGER NOT NULL,
      logical_seconds INTEGER NOT NULL,
      state TEXT NOT NULL
    );
    CREATE TABLE contest_checkpoint_decisions (
      checkpoint_run_id TEXT NOT NULL,
      entrant_id TEXT NOT NULL,
      decision TEXT NOT NULL,
      provisional INTEGER NOT NULL
    );
  `);
  database.prepare("INSERT INTO contest_runtimes VALUES (?, ?, ?, 1, 1)")
    .run(CONTEST_ID, RULES_COMMIT, RULES_DIGEST);
  database.prepare("INSERT INTO contest_rule_revisions VALUES (?, ?, ?, ?, ?)")
    .run(
      CONTEST_ID,
      RULES_COMMIT,
      RULES_DIGEST,
      JSON.stringify(rules(checkpointSeconds)),
      "2026-08-26T00:00:00.000Z",
    );
  database.prepare("INSERT INTO contest_entrants VALUES (?, ?, 'account', ?, 'active', 1)")
    .run(ENTRANT_ID, CONTEST_ID, USER_ID);
  database.prepare("INSERT INTO problem_series VALUES (?, 'sum')").run(PROBLEM_ID);
  database.prepare("INSERT INTO contest_rule_problems VALUES (?, ?, ?, 1)")
    .run(CONTEST_ID, RULES_COMMIT, PROBLEM_ID);
  database.prepare(`INSERT INTO submissions VALUES
    (?, ?, ?, 'completed', 'accepted', 100, 1, 10, 1024)`)
    .run(SUBMISSION_ID, SUBMISSION_ID, PROBLEM_ID);
  database.prepare("INSERT INTO effective_submission_results VALUES (?, ?)")
    .run(SUBMISSION_ID, SUBMISSION_ID);
  database.prepare(`INSERT INTO contest_submission_records VALUES
    (?, ?, ?, 50, 'eligible', 1, NULL)`)
    .run(SUBMISSION_ID, CONTEST_ID, ENTRANT_ID);
  return { database, d1: new (class {
    prepare(sql: string): Statement { return new Statement(database, sql); }
  })() as unknown as D1Database };
}

function addCheckpoint(
  database: DatabaseSync,
  input: {
    readonly index: number;
    readonly logicalSeconds: number;
    readonly runState: "provisional" | "final";
    readonly decisionProvisional: 0 | 1;
  },
): void {
  const runId = `66666666-6666-4666-8666-${String(input.index).padStart(12, "0")}`;
  database.prepare("INSERT INTO contest_checkpoint_runs VALUES (?, ?, 1, 1, ?, ?)")
    .run(runId, CONTEST_ID, input.logicalSeconds, input.runState);
  database.prepare("INSERT INTO contest_checkpoint_decisions VALUES (?, ?, 'advanced', ?)")
    .run(runId, ENTRANT_ID, input.decisionProvisional);
}

describe("contest progress leaderboard checkpoint projection", () => {
  it("freezes checkpoint progress at the checkpoint run's logical boundary", async () => {
    const value = fixture([100, 500]);
    addCheckpoint(value.database, { index: 1, logicalSeconds: 100, runState: "final", decisionProvisional: 0 });
    addCheckpoint(value.database, { index: 2, logicalSeconds: 500, runState: "final", decisionProvisional: 0 });

    const entries = await queryContestLeaderboard(value.d1, {
      contestId: CONTEST_ID,
      evidenceLogicalAtOrBefore: 300,
      limit: 10,
    });

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ furthestCheckpoint: 1, provisional: false });
  });

  it("does not count a provisional decision and marks the public standing provisional", async () => {
    const value = fixture([100]);
    addCheckpoint(value.database, {
      index: 1,
      logicalSeconds: 100,
      runState: "provisional",
      decisionProvisional: 1,
    });

    const entries = await queryContestLeaderboard(value.d1, { contestId: CONTEST_ID, limit: 10 });

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ furthestCheckpoint: 0, provisional: true });
  });

  it("marks settled entrant decisions provisional while their checkpoint run is unsettled", async () => {
    const value = fixture([100]);
    addCheckpoint(value.database, {
      index: 1,
      logicalSeconds: 100,
      runState: "provisional",
      decisionProvisional: 0,
    });

    const entries = await queryContestLeaderboard(value.d1, { contestId: CONTEST_ID, limit: 10 });

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ furthestCheckpoint: 1, provisional: true });
  });
});
