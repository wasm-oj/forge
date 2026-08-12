import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { markParetoFrontier, queryPerformanceEvolution, queryPerformanceFrontier } from "./performance";

type Binding = null | number | bigint | string | NodeJS.ArrayBufferView;

class SqliteStatement {
  private bindings: readonly Binding[] = [];
  constructor(private readonly database: DatabaseSync, private readonly sql: string) {}
  bind(...values: Binding[]): SqliteStatement { this.bindings = values; return this; }
  async all<T>(): Promise<{ readonly results: readonly T[] }> {
    return { results: this.database.prepare(this.sql).all(...this.bindings) as T[] };
  }
}

function fixture(): { readonly database: DatabaseSync; readonly d1: D1Database } {
  const database = new DatabaseSync(":memory:");
  database.exec(`CREATE TABLE submissions (
    id TEXT PRIMARY KEY,
    origin_submission_id TEXT NOT NULL,
    origin_submitted_at TEXT NOT NULL,
    user_id TEXT NOT NULL,
    problem_version_id TEXT NOT NULL,
    problem_series_id TEXT NOT NULL,
    contest_id TEXT,
    language TEXT NOT NULL,
    state TEXT NOT NULL,
    verdict TEXT,
    score REAL,
    fully_passed_cases INTEGER,
    deterministic_cost INTEGER,
    peak_memory_bytes INTEGER,
    policy_summary_json TEXT,
    created_at TEXT NOT NULL,
    completed_at TEXT
  ) STRICT;
  CREATE TABLE effective_submission_results (
    origin_submission_id TEXT PRIMARY KEY,
    effective_submission_id TEXT NOT NULL,
    effective_problem_version_id TEXT NOT NULL
  ) STRICT;
  CREATE TABLE contest_problems (
    contest_id TEXT NOT NULL,
    problem_series_id TEXT NOT NULL,
    problem_version_id TEXT NOT NULL,
    ordinal INTEGER NOT NULL,
    PRIMARY KEY (contest_id, problem_series_id)
  ) STRICT;`);
  const d1 = { prepare: (sql: string) => new SqliteStatement(database, sql) } as unknown as D1Database;
  return { database, d1 };
}

interface ResultInput {
  readonly id: string;
  readonly user: string;
  readonly version: string;
  readonly series: string;
  readonly score?: number;
  readonly cost?: number;
  readonly memory?: number;
  readonly completedAt: string;
  readonly language?: string;
  readonly contest?: string;
  readonly state?: "completed" | "compile-error";
  readonly resultId?: string;
  readonly resultVersion?: string;
  readonly policy?: string;
}

function insertResult(database: DatabaseSync, input: ResultInput): void {
  const state = input.state ?? "completed";
  const verdict = state === "completed" ? "accepted" : "compile-error";
  const insert = database.prepare(`INSERT INTO submissions
    (id, origin_submission_id, origin_submitted_at, user_id, problem_version_id, problem_series_id, contest_id,
     language, state, verdict, score, fully_passed_cases, deterministic_cost,
     peak_memory_bytes, policy_summary_json, created_at, completed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  insert.run(input.id, input.id, input.completedAt, input.user, input.version, input.series, input.contest ?? null,
    input.language ?? "rust", state, verdict, input.score ?? null,
    state === "completed" ? 1 : null, input.cost ?? null, input.memory ?? null,
    input.policy ?? null, input.completedAt, input.completedAt);
  const resultId = input.resultId ?? input.id;
  if (input.resultId) {
    insert.run(resultId, input.id, input.completedAt, input.user, input.resultVersion ?? input.version, input.series,
      input.contest ?? null, input.language ?? "rust", state, verdict, input.score ?? null,
      state === "completed" ? 1 : null, input.cost ?? null, input.memory ?? null,
      input.policy ?? null, input.completedAt, input.completedAt);
  }
  database.prepare("INSERT INTO effective_submission_results VALUES (?, ?, ?)")
    .run(input.id, resultId, input.resultVersion ?? input.version);
}

describe("performance frontier read model", () => {
  it("uses rejudged metrics, picks one best result per user, and marks three-dimensional Pareto points", async () => {
    const { database, d1 } = fixture();
    insertResult(database, { id: "a-old", resultId: "a-new", user: "a", version: "old", resultVersion: "new", series: "series", score: 100, cost: 50, memory: 50, completedAt: "2026-01-01T00:00:00.000Z" });
    insertResult(database, { id: "a-direct", user: "a", version: "new", series: "series", score: 90, cost: 10, memory: 10, completedAt: "2026-01-02T00:00:00.000Z" });
    insertResult(database, { id: "b", user: "b", version: "new", series: "series", score: 100, cost: 60, memory: 60, completedAt: "2026-01-03T00:00:00.000Z" });
    insertResult(database, { id: "c", user: "c", version: "new", series: "series", score: 90, cost: 5, memory: 5, completedAt: "2026-01-04T00:00:00.000Z" });

    const rows = await queryPerformanceFrontier(d1, { problemVersionId: "new" });
    expect(rows.map((row) => ({ user: row.userId, id: row.submissionId, pareto: row.isPareto }))).toEqual([
      { user: "a", id: "a-new", pareto: true },
      { user: "b", id: "b", pareto: false },
      { user: "c", id: "c", pareto: true },
    ]);
  });

  it("uses dominance dimensions before passed-case tie-breaking for one participant", async () => {
    const { database, d1 } = fixture();
    insertResult(database, { id: "resource-best", user: "a", version: "problem", series: "series", score: 100, cost: 10, memory: 10, completedAt: "2026-01-01T00:00:00.000Z" });
    insertResult(database, { id: "passed-best", user: "a", version: "problem", series: "series", score: 100, cost: 100, memory: 100, completedAt: "2026-01-02T00:00:00.000Z" });
    database.prepare("UPDATE submissions SET fully_passed_cases=2 WHERE id='passed-best'").run();

    const rows = await queryPerformanceFrontier(d1, { problemVersionId: "problem" });
    expect(rows).toMatchObject([{ submissionId: "resource-best", isPareto: true }]);
  });

  it("uses the contest-pinned identity and immutable origin submission cutoff during freeze", async () => {
    const { database, d1 } = fixture();
    database.prepare("INSERT INTO contest_problems VALUES ('contest', 'series', 'pinned', 1)").run();
    insertResult(database, { id: "before", resultId: "before-child", user: "a", version: "pinned", resultVersion: "later", series: "series", contest: "contest", score: 80, cost: 40, memory: 20, completedAt: "2026-01-01T00:00:00.000Z" });
    insertResult(database, { id: "after", user: "b", version: "pinned", series: "series", contest: "contest", score: 100, cost: 1, memory: 1, completedAt: "2026-02-01T00:00:00.000Z" });
    database.prepare("UPDATE submissions SET origin_submitted_at='2026-01-10T00:00:00.000Z' WHERE id IN ('before','before-child')").run();
    database.prepare("UPDATE submissions SET origin_submitted_at='2026-01-20T00:00:00.000Z' WHERE id='after'").run();

    const rows = await queryPerformanceFrontier(d1, {
      contestId: "contest",
      problemVersionId: "pinned",
      submittedAtOrBefore: "2026-01-15T00:00:00.000Z",
    });
    expect(rows).toMatchObject([{ userId: "a", submissionId: "before-child", score: 80, achievedAt: "2026-01-10T00:00:00.000Z" }]);
  });

  it("uses a dominance-compatible bounded sample before Pareto marking", async () => {
    const { database, d1 } = fixture();
    for (let index = 0; index < 100; index += 1) {
      insertResult(database, {
        id: `top-${String(index).padStart(3, "0")}`,
        user: `user-${String(index).padStart(3, "0")}`,
        version: "problem",
        series: "series",
        score: 100,
        cost: 100,
        memory: 100,
        completedAt: "2026-01-01T00:00:00.000Z",
      });
    }
    insertResult(database, {
      id: "outside-limit",
      user: "outside-limit",
      version: "problem",
      series: "series",
      score: 100,
      cost: 1,
      memory: 1,
      completedAt: "2026-01-02T00:00:00.000Z",
    });
    database.prepare("UPDATE submissions SET fully_passed_cases=0 WHERE id='outside-limit'").run();

    const rows = await queryPerformanceFrontier(d1, { problemVersionId: "problem" });
    expect(rows).toHaveLength(100);
    expect(rows[0]).toMatchObject({ submissionId: "outside-limit", isPareto: true });
    expect(rows.slice(1).every((row) => row.isPareto === false)).toBe(true);
  });
});

describe("personal performance evolution", () => {
  it("keeps error attempts and exposes current effective metrics without case data", async () => {
    const { database, d1 } = fixture();
    insertResult(database, { id: "compile", user: "a", version: "old", series: "series", state: "compile-error", completedAt: "2026-01-01T00:00:00.000Z" });
    insertResult(database, { id: "origin", resultId: "child", user: "a", version: "old", resultVersion: "new", series: "series", score: 100, cost: 10, memory: 20, policy: "{}", completedAt: "2026-01-02T00:00:00.000Z" });
    insertResult(database, { id: "other", user: "b", version: "new", series: "series", score: 100, cost: 1, memory: 1, completedAt: "2026-01-03T00:00:00.000Z" });

    const result = await queryPerformanceEvolution(d1, { userId: "a", problemSeriesId: "series" });
    expect(result.truncated).toBe(false);
    expect(result.entries).toMatchObject([
      { submissionId: "compile", attemptNumber: 1, state: "compile-error", score: null, policySummaryAvailable: false },
      { submissionId: "origin", attemptNumber: 2, state: "completed", score: 100, policySummaryAvailable: true },
    ]);
    expect(JSON.stringify(result.entries)).not.toContain("policy_summary_json");
  });

  it("does not backfill a failed effective child with stale origin metrics", async () => {
    const { database, d1 } = fixture();
    insertResult(database, {
      id: "origin",
      resultId: "failed-child",
      user: "a",
      version: "old",
      resultVersion: "new",
      series: "series",
      score: 100,
      cost: 10,
      memory: 20,
      policy: "{}",
      completedAt: "2026-01-02T00:00:00.000Z",
    });
    database.prepare(`UPDATE submissions
      SET state='compile-error', verdict='compile-error', score=0, fully_passed_cases=0,
        deterministic_cost=NULL, peak_memory_bytes=NULL, policy_summary_json=NULL
      WHERE id='failed-child'`).run();

    const result = await queryPerformanceEvolution(d1, { userId: "a", problemSeriesId: "series" });
    expect(result.entries).toMatchObject([{
      submissionId: "origin",
      state: "compile-error",
      score: null,
      fullyPassedCases: null,
      deterministicCost: null,
      peakMemoryBytes: null,
      policySummaryAvailable: false,
    }]);
  });

  it("returns the most recent 200 attempts in chronological order and reports truncation", async () => {
    const { database, d1 } = fixture();
    for (let index = 1; index <= 202; index += 1) {
      const id = `attempt-${String(index).padStart(3, "0")}`;
      const timestamp = new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString();
      insertResult(database, { id, user: "a", version: "problem", series: "series", score: index, cost: index, memory: index, completedAt: timestamp });
    }
    const result = await queryPerformanceEvolution(d1, { userId: "a", problemSeriesId: "series" });
    expect(result.truncated).toBe(true);
    expect(result.entries).toHaveLength(200);
    expect(result.entries[0]).toMatchObject({ submissionId: "attempt-003", attemptNumber: 3 });
    expect(result.entries.at(-1)).toMatchObject({ submissionId: "attempt-202", attemptNumber: 202 });
  });

  it("preserves full-history attempt numbers when filtering by language", async () => {
    const { database, d1 } = fixture();
    insertResult(database, { id: "rust-1", user: "a", version: "problem", series: "series", language: "rust", score: 1, cost: 1, memory: 1, completedAt: "2026-01-01T00:00:00.000Z" });
    insertResult(database, { id: "go-2", user: "a", version: "problem", series: "series", language: "go", score: 2, cost: 2, memory: 2, completedAt: "2026-01-02T00:00:00.000Z" });
    insertResult(database, { id: "rust-3", user: "a", version: "problem", series: "series", language: "rust", score: 3, cost: 3, memory: 3, completedAt: "2026-01-03T00:00:00.000Z" });

    const result = await queryPerformanceEvolution(d1, {
      userId: "a",
      problemSeriesId: "series",
      language: "rust",
    });
    expect(result.entries.map(({ submissionId, attemptNumber }) => ({ submissionId, attemptNumber }))).toEqual([
      { submissionId: "rust-1", attemptNumber: 1 },
      { submissionId: "rust-3", attemptNumber: 3 },
    ]);
  });
});

describe("Pareto equality", () => {
  it("keeps identical points on the frontier", () => {
    const row = { language: "c", score: 1, fully_passed_cases: 1, deterministic_cost: 0, peak_memory_bytes: 0, achieved_at: "2026-01-01T00:00:00.000Z" };
    expect(markParetoFrontier([
      { ...row, user_id: "a", submission_id: "a" },
      { ...row, user_id: "b", submission_id: "b" },
    ]).every((candidate) => candidate.isPareto)).toBe(true);
  });
});
