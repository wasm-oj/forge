import { describe, expect, it } from "vitest";
import { parseSubmissionListQuery, publicSubmissionProjection } from "../../worker/submissions";

describe("official submission projection", () => {
  it("exposes stable problem, judged commit, and judge digest without deployment internals", () => {
    const projection = publicSubmissionProjection({
      id: "submission-id", user_id: "private-user", problem_id: "problem-id", catalog_commit: "a".repeat(40), judge_digest: "b".repeat(64),
      contest_id: null, source_id: "source-id", source_state: "ready", language: "c", target: "wasip1", optimization: "release", entry_path: "main.c",
      state: "completed", verdict: "accepted", visibility: "private", score: 100, fully_passed_cases: 4, deterministic_cost: 42, peak_memory_bytes: 65_536,
      created_at: "2026-08-09T00:00:00.000Z", updated_at: "2026-08-09T00:01:00.000Z", completed_at: "2026-08-09T00:01:00.000Z",
    });
    expect(projection).toMatchObject({ problemId: "problem-id", catalogCommit: "a".repeat(40), judgeDigest: "b".repeat(64), score: 100 });
    expect(projection).not.toHaveProperty("user_id"); expect(projection).not.toHaveProperty("source_id"); expect(projection).not.toHaveProperty("runtimeBuildId");
  });

  it("parses strict keyset pagination cursors", () => {
    expect(parseSubmissionListQuery(new URL("https://wasm-oj.test/api/submissions?limit=25"))).toEqual({ limit: 25, cursor: null });
    expect(() => parseSubmissionListQuery(new URL("https://wasm-oj.test/api/submissions?limit=101"))).toThrow("integer from 1 to 100");
  });
});
