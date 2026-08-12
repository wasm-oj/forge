import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { queryContestLeaderboard, queryProblemLeaderboard } from "./leaderboards";

type Binding = null | number | bigint | string | NodeJS.ArrayBufferView;

class SqliteStatement {
  private bindings: readonly Binding[] = [];

  constructor(private readonly database: DatabaseSync, private readonly sql: string) {}

  bind(...values: Binding[]): SqliteStatement {
    this.bindings = values;
    return this;
  }

  async all<T>(): Promise<{ readonly results: readonly T[] }> {
    return { results: this.database.prepare(this.sql).all(...this.bindings) as T[] };
  }
}

class SqliteD1 {
  readonly preparedSql: string[] = [];

  constructor(private readonly database: DatabaseSync) {}

  prepare(sql: string): SqliteStatement {
    this.preparedSql.push(sql);
    return new SqliteStatement(this.database, sql);
  }
}

function fixture(): {
  readonly database: DatabaseSync;
  readonly d1: D1Database;
  readonly preparedSql: readonly string[];
} {
  const database = new DatabaseSync(":memory:");
  database.exec(`CREATE TABLE submissions (
    id TEXT PRIMARY KEY,
    origin_submission_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    problem_version_id TEXT NOT NULL,
    problem_series_id TEXT NOT NULL,
    origin_submitted_at TEXT NOT NULL,
    contest_id TEXT,
    language TEXT NOT NULL,
    state TEXT NOT NULL,
    score REAL,
    fully_passed_cases INTEGER,
    deterministic_cost INTEGER,
    peak_memory_bytes INTEGER,
    completed_at TEXT
  ) STRICT;
  CREATE TABLE effective_submission_results (
    origin_submission_id TEXT PRIMARY KEY,
    effective_submission_id TEXT NOT NULL,
    effective_problem_version_id TEXT NOT NULL,
    effective_rejudge_batch_id TEXT,
    became_effective_at TEXT
  ) STRICT;
  CREATE TABLE contest_problems (
    contest_id TEXT NOT NULL,
    problem_series_id TEXT NOT NULL,
    problem_version_id TEXT NOT NULL,
    ordinal INTEGER NOT NULL,
    PRIMARY KEY (contest_id, problem_series_id)
  ) STRICT;`);
  const client = new SqliteD1(database);
  return { database, d1: client as unknown as D1Database, preparedSql: client.preparedSql };
}

interface ResultInput {
  readonly originId: string;
  readonly resultId?: string;
  readonly user: string;
  readonly originVersion: string;
  readonly resultVersion?: string;
  readonly series: string;
  readonly language?: string;
  readonly score: number;
  readonly cases: number;
  readonly cost: number;
  readonly memory: number;
  readonly completedAt: string;
  readonly submittedAt?: string;
  readonly resultCompletedAt?: string;
  readonly contest?: string;
}

function insertEffectiveResult(database: DatabaseSync, input: ResultInput): void {
  const resultId = input.resultId ?? input.originId;
  database.prepare(`INSERT INTO submissions
    (id, origin_submission_id, user_id, problem_version_id, problem_series_id, origin_submitted_at, contest_id,
     language, state, score, fully_passed_cases, deterministic_cost, peak_memory_bytes, completed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'completed', ?, ?, ?, ?, ?)`).run(
    input.originId, input.originId, input.user, input.originVersion, input.series,
    input.submittedAt ?? input.completedAt, input.contest ?? null,
    input.language ?? "c", input.resultId ? 0 : input.score,
    input.resultId ? 0 : input.cases, input.resultId ? 0 : input.cost,
    input.resultId ? 0 : input.memory, input.completedAt,
  );
  if (input.resultId) {
    database.prepare(`INSERT INTO submissions
      (id, origin_submission_id, user_id, problem_version_id, problem_series_id, origin_submitted_at, contest_id,
       language, state, score, fully_passed_cases, deterministic_cost, peak_memory_bytes, completed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'completed', ?, ?, ?, ?, ?)`).run(
      resultId, input.originId, input.user, input.resultVersion ?? input.originVersion,
      input.series, input.submittedAt ?? input.completedAt, input.contest ?? null,
      input.language ?? "c", input.score, input.cases,
      input.cost, input.memory, input.resultCompletedAt ?? input.completedAt,
    );
  }
  database.prepare(`INSERT INTO effective_submission_results
    (origin_submission_id, effective_submission_id, effective_problem_version_id)
    VALUES (?, ?, ?)`).run(input.originId, resultId, input.resultVersion ?? input.originVersion);
}

describe("D1 problem leaderboard", () => {
  it("ranks only canonical effective results and preserves the origin timestamp", async () => {
    const { database, d1 } = fixture();
    insertEffectiveResult(database, {
      originId: "old-a", resultId: "child-a", user: "a", originVersion: "old",
      resultVersion: "new", series: "series", score: 90, cases: 9, cost: 700,
      memory: 100, completedAt: "2026-01-01T00:00:00.000Z",
      resultCompletedAt: "2026-03-01T00:00:00.000Z",
    });
    insertEffectiveResult(database, {
      originId: "direct-a", user: "a", originVersion: "new", series: "series",
      score: 80, cases: 8, cost: 800, memory: 100,
      completedAt: "2026-02-01T00:00:00.000Z",
    });
    insertEffectiveResult(database, {
      originId: "direct-b", user: "b", originVersion: "new", series: "series",
      score: 90, cases: 9, cost: 800, memory: 100,
      completedAt: "2026-01-15T00:00:00.000Z",
    });
    insertEffectiveResult(database, {
      originId: "contest-only", user: "c", originVersion: "new", series: "series",
      score: 100, cases: 10, cost: 1, memory: 1,
      completedAt: "2026-01-01T00:00:00.000Z", contest: "contest",
    });

    const rows = await queryProblemLeaderboard(d1, { problemVersionId: "new", limit: 10 });

    expect(rows.map((row) => ({ user: row.userId, score: row.score, achievedAt: row.achievedAt }))).toEqual([
      { user: "a", score: 90, achievedAt: "2026-01-01T00:00:00.000Z" },
      { user: "b", score: 90, achievedAt: "2026-01-15T00:00:00.000Z" },
    ]);
  });

  it("recomputes each participant's best row within a language filter", async () => {
    const { database, d1 } = fixture();
    insertEffectiveResult(database, { originId: "a-c", user: "a", originVersion: "problem", series: "series", language: "c", score: 80, cases: 8, cost: 500, memory: 100, completedAt: "2026-01-01T00:00:00.000Z" });
    insertEffectiveResult(database, { originId: "a-rust", user: "a", originVersion: "problem", series: "series", language: "rust", score: 100, cases: 10, cost: 700, memory: 100, completedAt: "2026-01-02T00:00:00.000Z" });
    insertEffectiveResult(database, { originId: "b-c", user: "b", originVersion: "problem", series: "series", language: "c", score: 90, cases: 9, cost: 600, memory: 100, completedAt: "2026-01-03T00:00:00.000Z" });

    const overall = await queryProblemLeaderboard(d1, { problemVersionId: "problem", limit: 10 });
    expect(overall.map((row) => ({ user: row.userId, language: row.language, score: row.score }))).toEqual([
      { user: "a", language: "rust", score: 100 },
      { user: "b", language: "c", score: 90 },
    ]);

    const cOnly = await queryProblemLeaderboard(d1, { problemVersionId: "problem", language: "c", limit: 10 });
    expect(cOnly.map((row) => ({ user: row.userId, language: row.language, score: row.score }))).toEqual([
      { user: "b", language: "c", score: 90 },
      { user: "a", language: "c", score: 80 },
    ]);
  });
});

describe("D1 contest leaderboard", () => {
  it("uses the effective view, immutable contest versions, and origin submission time for freeze", async () => {
    const { database, d1 } = fixture();
    database.prepare("INSERT INTO contest_problems VALUES (?, ?, ?, ?)").run("contest", "series-p1", "bound-p1", 1);
    database.prepare("INSERT INTO contest_problems VALUES (?, ?, ?, ?)").run("contest", "series-p2", "p2", 2);
    insertEffectiveResult(database, {
      originId: "old-a", resultId: "child-a", user: "a", originVersion: "bound-p1",
      resultVersion: "rejudged-p1", series: "series-p1", contest: "contest",
      score: 100, cases: 10, cost: 500, memory: 100,
      submittedAt: "2026-01-01T00:00:00.000Z",
      completedAt: "2026-02-01T00:00:00.000Z", resultCompletedAt: "2026-03-01T00:00:00.000Z",
    });
    insertEffectiveResult(database, { originId: "p2-a", user: "a", originVersion: "p2", series: "series-p2", contest: "contest", score: 50, cases: 5, cost: 400, memory: 50, completedAt: "2026-01-02T00:00:00.000Z" });
    insertEffectiveResult(database, { originId: "p1-b", user: "b", originVersion: "bound-p1", series: "series-p1", contest: "contest", score: 100, cases: 10, cost: 100, memory: 50, submittedAt: "2026-01-20T00:00:00.000Z", completedAt: "2026-02-01T00:00:00.000Z" });

    const frozen = await queryContestLeaderboard(d1, {
      contestId: "contest",
      submittedAtOrBefore: "2026-01-15T00:00:00.000Z",
      limit: 10,
    });
    expect(frozen).toMatchObject([{
      userId: "a",
      score: 150,
      fullyPassedCases: 15,
      deterministicCost: 900,
      peakMemoryBytes: 100,
      achievedAt: "2026-02-01T00:00:00.000Z",
      attemptedProblems: 2,
      problemResults: [
        { problemVersionId: "bound-p1", score: 100, fullyPassedCases: 10 },
        { problemVersionId: "p2", score: 50, fullyPassedCases: 5 },
      ],
    }]);

    const organizer = await queryContestLeaderboard(d1, { contestId: "contest", limit: 10 });
    expect(organizer.map((row) => row.userId)).toEqual(["a", "b"]);
    expect(organizer[1]).toMatchObject({ score: 100, deterministicCost: 100 });
  });

  it("reads a full 100-problem contest directly from its authority table", async () => {
    const { database, d1, preparedSql } = fixture();
    const insert = database.prepare("INSERT INTO contest_problems VALUES (?, ?, ?, ?)");
    for (let index = 0; index < 100; index += 1) {
      insert.run("contest", `series-${index}`, `problem-${index}`, index + 1);
    }
    await expect(queryContestLeaderboard(d1, { contestId: "contest", limit: 100 }))
      .resolves.toEqual([]);
    expect(preparedSql).toHaveLength(1);
    expect(preparedSql[0]).toContain("JOIN contest_problems AS contest_problem");
    expect(preparedSql[0]).not.toContain("json_each");
  });
});
