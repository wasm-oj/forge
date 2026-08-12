import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import {
  parseSubmissionListQuery,
  publicSubmissionProjection,
  submissionMayBecomePublic,
  SUBMISSION_PRODUCT_SELECT_SQL,
} from "../../worker/submissions";

describe("official submission projection", () => {
  it("does not expose storage, user, or source integrity internals", () => {
    const projection = publicSubmissionProjection({
      id: "submission-id",
      user_id: "private-user-id",
      problem_version_id: "problem-version-id",
      problem_mode: "official-practice",
      contest_id: null,
      source_id: "source-id",
      source_state: "ready",
      language: "c",
      target: "wasip1",
      optimization: "release",
      entry_path: "main.c",
      wasm_oj_release_id: "release-id",
      wasm_oj_manifest_sha256: "b".repeat(64),
      state: "completed",
      verdict: "accepted",
      visibility: "private",
      score: 100,
      fully_passed_cases: 4,
      deterministic_cost: 42,
      peak_memory_bytes: 65_536,
      created_at: "2026-08-09T00:00:00.000Z",
      updated_at: "2026-08-09T00:01:00.000Z",
      completed_at: "2026-08-09T00:01:00.000Z",
    });

    expect(projection).toEqual({
      id: "submission-id",
      problemVersionId: "problem-version-id",
      contestId: null,
      language: "c",
      target: "wasip1",
      optimization: "release",
      entry: "main.c",
      state: "completed",
      verdict: "accepted",
      visibility: "private",
      score: 100,
      fullyPassedCases: 4,
      deterministicCost: 42,
      peakMemoryBytes: 65_536,
      createdAt: "2026-08-09T00:00:00.000Z",
      updatedAt: "2026-08-09T00:01:00.000Z",
      completedAt: "2026-08-09T00:01:00.000Z",
    });
    expect(projection).not.toHaveProperty("user_id");
    expect(projection).not.toHaveProperty("source_id");
    expect(projection).not.toHaveProperty("source_state");
    expect(projection).not.toHaveProperty("wasm_oj_release_id");
    expect(projection).not.toHaveProperty("wasm_oj_manifest_sha256");
  });

  it("projects the latest effective result while preserving the origin identity", () => {
    const database = new DatabaseSync(":memory:");
    database.exec(`CREATE TABLE submissions (
      id TEXT PRIMARY KEY, origin_submission_id TEXT NOT NULL, user_id TEXT NOT NULL,
      problem_version_id TEXT NOT NULL, contest_id TEXT,
      source_id TEXT NOT NULL, language TEXT NOT NULL, target TEXT NOT NULL,
      optimization TEXT NOT NULL, entry_path TEXT, wasm_oj_release_id TEXT NOT NULL,
      wasm_oj_manifest_sha256 TEXT NOT NULL, state TEXT NOT NULL, verdict TEXT,
      visibility TEXT NOT NULL, score REAL, fully_passed_cases INTEGER,
      deterministic_cost INTEGER, peak_memory_bytes INTEGER, created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL, completed_at TEXT
    ) STRICT;
    CREATE TABLE submission_sources (id TEXT PRIMARY KEY, state TEXT NOT NULL) STRICT;
    CREATE TABLE effective_submission_results (
      origin_submission_id TEXT PRIMARY KEY, effective_submission_id TEXT NOT NULL,
      effective_problem_version_id TEXT NOT NULL
    ) STRICT;
    CREATE TABLE problem_version_details (
      id TEXT PRIMARY KEY, mode TEXT NOT NULL, problem_slug TEXT NOT NULL, title_json TEXT NOT NULL
    ) STRICT;
    CREATE TABLE contests (id TEXT PRIMARY KEY, title TEXT NOT NULL) STRICT;`);
    const origin = "0198dbd3-5c00-7000-8000-000000000011";
    const child = "0198dbd3-5c00-7000-8000-000000000012";
    const source = "0198dbd3-5c00-7000-8000-000000000013";
    database.prepare("INSERT INTO submission_sources VALUES (?, 'ready')").run(source);
    database.prepare("INSERT INTO problem_version_details VALUES ('version-a', 'official-practice', 'sum', '{\"en\":\"A\"}')").run();
    database.prepare("INSERT INTO problem_version_details VALUES ('version-c', 'official-practice', 'sum', '{\"en\":\"C\"}')").run();
    const insert = database.prepare(`INSERT INTO submissions VALUES (
      ?, ?, 'user', ?, NULL, ?, 'c', 'wasip1', 'release',
      'main.c', 'release', ?, ?, ?, 'private', ?, ?, ?, ?, ?, ?, ?
    )`);
    insert.run(origin, origin, "version-a", source, "a".repeat(64), "completed", "accepted", 100, 4, 40, 4096,
      "2026-08-12T00:00:00.000Z", "2026-08-12T00:01:00.000Z", "2026-08-12T00:01:00.000Z");
    insert.run(child, origin, "version-c", source, "a".repeat(64), "completed", "wrong-answer", 25, 1, 80, 8192,
      "2026-08-12T00:02:00.000Z", "2026-08-12T00:03:00.000Z", "2026-08-12T00:03:00.000Z");
    database.prepare("INSERT INTO effective_submission_results VALUES (?, ?, 'version-c')").run(origin, child);

    const row = database.prepare(`${SUBMISSION_PRODUCT_SELECT_SQL}
      WHERE origin.id=? AND origin.origin_submission_id=origin.id`).get(origin) as Record<string, unknown>;
    expect(row).toMatchObject({
      id: origin,
      problem_version_id: "version-c",
      state: "completed",
      verdict: "wrong-answer",
      score: 25,
      deterministic_cost: 80,
      created_at: "2026-08-12T00:00:00.000Z",
      updated_at: "2026-08-12T00:03:00.000Z",
      problem_slug: "sum",
      title_json: '{"en":"C"}',
    });
    expect(submissionMayBecomePublic(row as { state: string })).toBe(true);

    database.prepare("UPDATE submissions SET state='compile-error', verdict='compile-error' WHERE id=?").run(child);
    const failedEffective = database.prepare(`${SUBMISSION_PRODUCT_SELECT_SQL}
      WHERE origin.id=? AND origin.origin_submission_id=origin.id`).get(origin) as Record<string, unknown>;
    expect(submissionMayBecomePublic(failedEffective as { state: string })).toBe(false);

    const contestOrigin = "0198dbd3-5c00-7000-8000-000000000021";
    const contestChild = "0198dbd3-5c00-7000-8000-000000000022";
    const contestId = "0198dbd3-5c00-7000-8000-000000000023";
    database.prepare("INSERT INTO problem_version_details VALUES ('contest-a', 'contest', 'frozen', '{\"en\":\"Frozen A\"}')").run();
    database.prepare("INSERT INTO problem_version_details VALUES ('contest-c', 'contest', 'changed', '{\"en\":\"Changed C\"}')").run();
    database.prepare("INSERT INTO contests VALUES (?, 'Ended contest')").run(contestId);
    const insertContest = database.prepare(`INSERT INTO submissions VALUES (
      ?, ?, 'user', ?, ?, ?, 'c', 'wasip1', 'release', 'main.c',
      'release', ?, 'completed', ?, 'private', ?, 1, 10, 1024, ?, ?, ?
    )`);
    insertContest.run(contestOrigin, contestOrigin, "contest-a", contestId, source, "b".repeat(64), "accepted", 100,
      "2026-08-12T01:00:00.000Z", "2026-08-12T01:01:00.000Z", "2026-08-12T01:01:00.000Z");
    insertContest.run(contestChild, contestOrigin, "contest-c", contestId, source, "b".repeat(64), "wrong-answer", 10,
      "2026-08-12T01:02:00.000Z", "2026-08-12T01:03:00.000Z", "2026-08-12T01:03:00.000Z");
    database.prepare("INSERT INTO effective_submission_results VALUES (?, ?, 'contest-c')").run(contestOrigin, contestChild);
    const contestProjection = database.prepare(`${SUBMISSION_PRODUCT_SELECT_SQL}
      WHERE origin.id=? AND origin.origin_submission_id=origin.id`).get(contestOrigin) as Record<string, unknown>;
    expect(contestProjection).toMatchObject({
      id: contestOrigin,
      problem_version_id: "contest-a",
      problem_slug: "frozen",
      verdict: "wrong-answer",
      score: 10,
      contest_record_id: contestId,
    });

    database.prepare("DELETE FROM effective_submission_results WHERE origin_submission_id=?").run(origin);
    database.prepare("UPDATE submissions SET state='running', verdict=NULL, score=NULL, completed_at=NULL WHERE id=?").run(origin);
    const active = database.prepare(`${SUBMISSION_PRODUCT_SELECT_SQL}
      WHERE origin.id=? AND origin.origin_submission_id=origin.id`).get(origin) as Record<string, unknown>;
    expect(active).toMatchObject({ id: origin, problem_version_id: "version-a", state: "running", verdict: null });
  });

  it("parses strict keyset pagination cursors", () => {
    expect(parseSubmissionListQuery(new URL("https://wasm-oj.test/api/submissions?limit=25"))).toEqual({
      limit: 25,
      cursor: null,
    });
    expect(parseSubmissionListQuery(new URL("https://wasm-oj.test/api/submissions?limit=25&before=2026-08-12T00%3A00%3A00.000Z&beforeId=0198dbd3-5c00-7000-8000-000000000011"))).toEqual({
      limit: 25,
      cursor: {
        before: "2026-08-12T00:00:00.000Z",
        beforeId: "0198dbd3-5c00-7000-8000-000000000011",
      },
    });
    expect(() => parseSubmissionListQuery(new URL("https://wasm-oj.test/api/submissions?before=bad&beforeId=0198dbd3-5c00-7000-8000-000000000011")))
      .toThrow("Submission cursor is invalid");
    expect(() => parseSubmissionListQuery(new URL("https://wasm-oj.test/api/submissions?limit=101")))
      .toThrow("Submission limit must be an integer from 1 to 100");
  });
});
