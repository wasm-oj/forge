import { describe, expect, it } from "vitest";
import { parseContainerSubmissionResult, readContainerSubmissionResult } from "../../worker/container-result";

const result = {
  state: "completed",
  verdict: "accepted",
  score: 100,
  fullyPassedCases: 1,
  deterministicCost: 10,
  peakMemoryBytes: 65_536,
  policySummary: {
    totalCases: 2,
    outputAcceptedCases: 1,
    policies: ["baseline", "efficient", "optimal"].map((id) => ({
      id,
      earnedCases: 0,
      costExceededCases: 1,
      memoryExceededCases: 1,
      logicalTimeExceededCases: 1,
    })),
  },
} as const;

describe("container result boundary", () => {
  it("accepts only the aggregate, hidden-safe terminal result", () => {
    expect(parseContainerSubmissionResult(result)).toEqual(result);
    expect(() => parseContainerSubmissionResult({ ...result, stdout: "hidden" })).toThrow("shape");
    expect(() => parseContainerSubmissionResult({ ...result, score: 101 })).toThrow("scoring contract");
    expect(() => parseContainerSubmissionResult({ ...result, fullyPassedCases: -1 })).toThrow("non-negative");
    expect(() => parseContainerSubmissionResult({
      ...result,
      policySummary: { ...result.policySummary, outputAcceptedCases: 2 },
    })).toThrow("disagree");
    expect(() => parseContainerSubmissionResult({
      ...result,
      policySummary: { ...result.policySummary, totalCases: 10_001 },
    })).toThrow("total cases");
    expect(() => parseContainerSubmissionResult({
      ...result,
      policySummary: {
        ...result.policySummary,
        policies: [...result.policySummary.policies].reverse(),
      },
    })).toThrow("order");
    expect(() => parseContainerSubmissionResult({
      ...result,
      policySummary: {
        ...result.policySummary,
        policies: result.policySummary.policies.map((policy, index) => (
          index === 0 ? { ...policy, earnedCases: 1, costExceededCases: 1 } : policy
        )),
      },
    })).toThrow("contradicts");
  });

  it("keeps judge errors and compile errors structurally explicit", () => {
    expect(() => parseContainerSubmissionResult({ ...result, verdict: "judge-error" })).toThrow("Completed state");
    expect(parseContainerSubmissionResult({
      state: "judge-error",
      verdict: "judge-error",
      score: 0,
      fullyPassedCases: 0,
      deterministicCost: result.deterministicCost,
      peakMemoryBytes: result.peakMemoryBytes,
    }).state).toBe("judge-error");
    expect(parseContainerSubmissionResult({ state: "compile-error", score: 0, fullyPassedCases: 0 })).toEqual({
      state: "compile-error",
      score: 0,
      fullyPassedCases: 0,
    });
  });

  it("bounds and parses the response before Workflow persistence", async () => {
    const response = new Response(JSON.stringify(result), { headers: { "content-type": "application/json" } });
    await expect(readContainerSubmissionResult(response)).resolves.toEqual(result);
    const oversized = new Response("x", { headers: { "content-length": String(64 * 1024 + 1) } });
    await expect(readContainerSubmissionResult(oversized)).rejects.toThrow("bounded response");
  });
});
