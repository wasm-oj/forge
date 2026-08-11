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
  constructor(private readonly database: DatabaseSync) {}

  prepare(sql: string): SqliteStatement {
    return new SqliteStatement(this.database, sql);
  }
}

function fixture(): { readonly database: DatabaseSync; readonly d1: D1Database } {
  const database = new DatabaseSync(":memory:");
  database.exec(`CREATE TABLE submissions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    managed_problem_version_id TEXT NOT NULL,
    contest_id TEXT,
    language TEXT NOT NULL,
    state TEXT NOT NULL,
    score REAL,
    fully_passed_cases INTEGER,
    deterministic_cost INTEGER,
    peak_memory_bytes INTEGER,
    completed_at TEXT,
    rejudge_batch_id TEXT,
    rejudge_of_submission_id TEXT
  ) STRICT`);
  return { database, d1: new SqliteD1(database) as unknown as D1Database };
}

function insert(database: DatabaseSync, input: {
  readonly id: string;
  readonly user: string;
  readonly problem: string;
  readonly language?: string;
  readonly score: number;
  readonly cases: number;
  readonly cost: number;
  readonly memory: number;
  readonly completedAt: string;
  readonly contest?: string;
  readonly batch?: string;
  readonly original?: string;
}): void {
  database.prepare(`INSERT INTO submissions
    (id, user_id, managed_problem_version_id, contest_id, language, state, score,
     fully_passed_cases, deterministic_cost, peak_memory_bytes, completed_at,
     rejudge_batch_id, rejudge_of_submission_id)
    VALUES (?, ?, ?, ?, ?, 'completed', ?, ?, ?, ?, ?, ?, ?)`)
    .run(input.id, input.user, input.problem, input.contest ?? null, input.language ?? "c", input.score,
      input.cases, input.cost, input.memory, input.completedAt,
      input.batch ?? null, input.original ?? null);
}

describe("D1 problem leaderboard", () => {
  it("selects each user's best direct or effective rejudge result", async () => {
    const { database, d1 } = fixture();
    insert(database, { id: "old-a", user: "a", problem: "old", score: 70, cases: 7, cost: 900, memory: 100, completedAt: "2026-01-01T00:00:00.000Z" });
    insert(database, { id: "direct-a", user: "a", problem: "new", score: 80, cases: 8, cost: 800, memory: 100, completedAt: "2026-02-01T00:00:00.000Z" });
    insert(database, { id: "child-a", user: "a", problem: "new", score: 90, cases: 9, cost: 700, memory: 100, completedAt: "2026-03-01T00:00:00.000Z", batch: "effective", original: "old-a" });
    insert(database, { id: "inactive-a", user: "a", problem: "new", score: 100, cases: 10, cost: 1, memory: 1, completedAt: "2026-04-01T00:00:00.000Z", batch: "inactive", original: "old-a" });
    insert(database, { id: "direct-b", user: "b", problem: "new", score: 90, cases: 9, cost: 800, memory: 100, completedAt: "2026-01-15T00:00:00.000Z" });
    insert(database, { id: "contest-only", user: "c", problem: "new", score: 100, cases: 10, cost: 1, memory: 1, completedAt: "2026-01-01T00:00:00.000Z", contest: "contest" });

    const rows = await queryProblemLeaderboard(d1, {
      effectiveProblemVersionId: "new",
      rejudgeBatchId: "effective",
      limit: 10,
    });

    expect(rows.map((row) => ({ user: row.userId, score: row.score, achievedAt: row.achievedAt }))).toEqual([
      { user: "a", score: 90, achievedAt: "2026-01-01T00:00:00.000Z" },
      { user: "b", score: 90, achievedAt: "2026-01-15T00:00:00.000Z" },
    ]);
  });

  it("recomputes each participant's best row within a language filter", async () => {
    const { database, d1 } = fixture();
    insert(database, { id: "a-c", user: "a", problem: "problem", language: "c", score: 80, cases: 8, cost: 500, memory: 100, completedAt: "2026-01-01T00:00:00.000Z" });
    insert(database, { id: "a-rust", user: "a", problem: "problem", language: "rust", score: 100, cases: 10, cost: 700, memory: 100, completedAt: "2026-01-02T00:00:00.000Z" });
    insert(database, { id: "b-c", user: "b", problem: "problem", language: "c", score: 90, cases: 9, cost: 600, memory: 100, completedAt: "2026-01-03T00:00:00.000Z" });

    const overall = await queryProblemLeaderboard(d1, {
      effectiveProblemVersionId: "problem",
      limit: 10,
    });
    expect(overall.map((row) => ({ user: row.userId, language: row.language, score: row.score }))).toEqual([
      { user: "a", language: "rust", score: 100 },
      { user: "b", language: "c", score: 90 },
    ]);

    const cOnly = await queryProblemLeaderboard(d1, {
      effectiveProblemVersionId: "problem",
      language: "c",
      limit: 10,
    });
    expect(cOnly.map((row) => ({ user: row.userId, language: row.language, score: row.score }))).toEqual([
      { user: "b", language: "c", score: 90 },
      { user: "a", language: "c", score: 80 },
    ]);
  });
});

describe("D1 contest leaderboard", () => {
  it("uses effective problem versions and the original completion time for freeze", async () => {
    const { database, d1 } = fixture();
    insert(database, { id: "old-a", user: "a", problem: "old-p1", contest: "contest", score: 80, cases: 8, cost: 800, memory: 100, completedAt: "2026-01-01T00:00:00.000Z" });
    insert(database, { id: "child-a", user: "a", problem: "new-p1", contest: "contest", score: 100, cases: 10, cost: 500, memory: 100, completedAt: "2026-03-01T00:00:00.000Z", batch: "effective", original: "old-a" });
    insert(database, { id: "p2-a", user: "a", problem: "p2", contest: "contest", score: 50, cases: 5, cost: 400, memory: 50, completedAt: "2026-01-02T00:00:00.000Z" });
    insert(database, { id: "p1-b", user: "b", problem: "new-p1", contest: "contest", score: 100, cases: 10, cost: 100, memory: 50, completedAt: "2026-02-01T00:00:00.000Z" });
    insert(database, { id: "inactive-b", user: "b", problem: "new-p1", contest: "contest", score: 100, cases: 10, cost: 1, memory: 1, completedAt: "2026-01-01T00:00:00.000Z", batch: "inactive", original: "p1-b" });

    const problems = [
      { originalProblemVersionId: "old-p1", effectiveProblemVersionId: "new-p1", rejudgeBatchId: "effective" },
      { originalProblemVersionId: "p2", effectiveProblemVersionId: "p2" },
    ] as const;
    const frozen = await queryContestLeaderboard(d1, {
      contestId: "contest",
      problems,
      completedAtOrBefore: "2026-01-15T00:00:00.000Z",
      limit: 10,
    });
    expect(frozen).toMatchObject([{
      userId: "a",
      score: 150,
      fullyPassedCases: 15,
      deterministicCost: 900,
      peakMemoryBytes: 100,
      achievedAt: "2026-01-02T00:00:00.000Z",
      attemptedProblems: 2,
      problemResults: [
        { problemVersionId: "old-p1", score: 100, fullyPassedCases: 10 },
        { problemVersionId: "p2", score: 50, fullyPassedCases: 5 },
      ],
    }]);

    const organizer = await queryContestLeaderboard(d1, { contestId: "contest", problems, limit: 10 });
    expect(organizer.map((row) => row.userId)).toEqual(["a", "b"]);
    expect(organizer[1]).toMatchObject({ score: 100, deterministicCost: 100 });
  });

  it("accepts the full 100-problem contest through one JSON selection binding", async () => {
    const { d1 } = fixture();
    const problems = Array.from({ length: 100 }, (_, index) => ({
      originalProblemVersionId: `problem-${index}`,
      effectiveProblemVersionId: `problem-${index}`,
    }));
    await expect(queryContestLeaderboard(d1, {
      contestId: "contest",
      problems,
      limit: 100,
    })).resolves.toEqual([]);
  });
});
