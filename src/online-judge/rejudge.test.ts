import { describe, expect, it } from "vitest";
import {
  classifyRejudgeChildState,
  classifyRejudgeProgress,
  encodeContestRejudgeSelection,
  mergeEffectiveLeaderboardEntries,
  parseContestRejudgeSelection,
  parseCreateRejudgeRequest,
} from "./rejudge";

const oldProblemVersionId = "00000000-0000-4000-8000-000000000001";
const newProblemVersionId = "00000000-0000-4000-8000-000000000002";
const batchId = "00000000-0000-4000-8000-000000000003";

describe("immutable rejudge contract", () => {
  it("accepts only the exact source and successor request", () => {
    expect(parseCreateRejudgeRequest({
      oldProblemVersionId,
      newProblemVersionId,
      idempotencyKey: "rejudge-request-0001",
    })).toEqual({ oldProblemVersionId, newProblemVersionId, idempotencyKey: "rejudge-request-0001" });
    expect(() => parseCreateRejudgeRequest({
      oldProblemVersionId,
      newProblemVersionId,
      idempotencyKey: "rejudge-request-0001",
      source: "not accepted",
    })).toThrow("invalid shape");
    expect(() => parseCreateRejudgeRequest({
      oldProblemVersionId,
      newProblemVersionId: oldProblemVersionId,
      idempotencyKey: "rejudge-request-0001",
    })).toThrow("must be different");
  });

  it("treats only deterministic user outcomes as activation-ready", () => {
    expect(classifyRejudgeChildState("completed")).toBe("ready");
    expect(classifyRejudgeChildState("compile-error")).toBe("ready");
    expect(classifyRejudgeChildState("judge-error")).toBe("failed");
    expect(classifyRejudgeChildState("infrastructure-error")).toBe("failed");
    expect(classifyRejudgeChildState("cancelled")).toBe("failed");
  });

  it("fails closed until every enumerated source has a staged result", () => {
    expect(classifyRejudgeProgress({ expected: 3, materialized: 2, ready: 2, failed: 0 })).toBe("running");
    expect(classifyRejudgeProgress({ expected: 3, materialized: 3, ready: 2, failed: 0 })).toBe("running");
    expect(classifyRejudgeProgress({ expected: 3, materialized: 3, ready: 3, failed: 0 })).toBe("ready");
    expect(classifyRejudgeProgress({ expected: 3, materialized: 3, ready: 2, failed: 1 })).toBe("failed");
    expect(() => classifyRejudgeProgress({ expected: 2, materialized: 3, ready: 0, failed: 0 })).toThrow("inconsistent");
  });

  it("round-trips a bounded, identifier-only contest activation selection", () => {
    const selection = { batchId, stagedProblemVersionId: oldProblemVersionId };
    const encoded = encodeContestRejudgeSelection(new Map([[oldProblemVersionId, selection]]));
    expect([...parseContestRejudgeSelection(encoded)]).toEqual([[oldProblemVersionId, selection]]);
    expect(() => parseContestRejudgeSelection(JSON.stringify({ [oldProblemVersionId]: "not-a-uuid" }))).toThrow("invalid identifier");
  });

  it("atomically merges direct successor results with the activated generation", () => {
    const common = { fullyPassedCases: 10, deterministicCost: 100, peakMemoryBytes: 1024, achievedAt: "2026-01-01T00:00:00.000Z" };
    expect(mergeEffectiveLeaderboardEntries([
      { ...common, userId: "alice", submissionId: "direct-alice", score: 80 },
      { ...common, userId: "bob", submissionId: "direct-bob", score: 70 },
    ], [
      { ...common, userId: "alice", submissionId: "rejudge-alice", score: 100 },
      { ...common, userId: "carol", submissionId: "rejudge-carol", score: 90 },
    ], 2).map((entry) => entry.submissionId)).toEqual(["rejudge-alice", "rejudge-carol"]);
  });

});
