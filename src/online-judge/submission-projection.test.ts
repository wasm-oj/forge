import { describe, expect, it } from "vitest";
import { publicSubmissionProjection } from "../../worker/submissions";

describe("official submission projection", () => {
  it("does not expose storage, user, or source integrity internals", () => {
    const projection = publicSubmissionProjection({
      id: "submission-id",
      user_id: "private-user-id",
      managed_problem_version_id: "problem-version-id",
      contest_id: null,
      language: "c",
      target: "wasip1",
      optimization: "release",
      entry_path: "main.c",
      source_r2_key: "sources/private-key",
      source_digest: "a".repeat(64),
      state: "completed",
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
      managedProblemVersionId: "problem-version-id",
      contestId: null,
      language: "c",
      target: "wasip1",
      optimization: "release",
      entry: "main.c",
      state: "completed",
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
    expect(projection).not.toHaveProperty("source_r2_key");
    expect(projection).not.toHaveProperty("source_digest");
  });
});
