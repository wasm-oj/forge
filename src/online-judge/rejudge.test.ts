import { describe, expect, it } from "vitest";
import {
  classifyRejudgeChildState,
  classifyRejudgeProgress,
  parseCreateRejudgeRequest,
} from "./rejudge";

const problemId = "00000000-0000-4000-8000-000000000001";
const contestId = "00000000-0000-4000-8000-000000000002";
const fromCommit = "a".repeat(40);
const toCommit = "b".repeat(40);

describe("repository-commit rejudge contract", () => {
  it("accepts only the exact source and successor request", () => {
    expect(parseCreateRejudgeRequest({
      problemId,
      fromCommit,
      toCommit,
      contestId,
      idempotencyKey: "rejudge-request-0001",
    })).toEqual({ problemId, fromCommit, toCommit, contestId, idempotencyKey: "rejudge-request-0001" });
    expect(() => parseCreateRejudgeRequest({
      problemId,
      fromCommit,
      toCommit,
      idempotencyKey: "rejudge-request-0001",
      source: "not accepted",
    })).toThrow("invalid shape");
    expect(() => parseCreateRejudgeRequest({
      problemId,
      fromCommit,
      toCommit: fromCommit,
      idempotencyKey: "rejudge-request-0001",
    })).toThrow("must be different");
  });

  it("treats only deterministic user outcomes as effective-result ready", () => {
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
});
