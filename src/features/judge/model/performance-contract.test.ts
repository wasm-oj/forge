import { describe, expect, it } from "vitest";
import {
  parseProblemPerformanceResponse,
  parseSubmissionPolicySummaryResponse,
  problemPerformanceApiPath,
  submissionPolicySummaryApiPath,
} from "./performance-contract";

const PROBLEM_ID = "11111111-1111-4111-8111-111111111111";
const CONTEST_ID = "22222222-2222-4222-8222-222222222222";
const SUBMISSION_A = "33333333-3333-4333-8333-333333333333";
const SUBMISSION_B = "44444444-4444-4444-8444-444444444444";

function performanceResponse() {
  return {
    context: {
      problemVersionId: PROBLEM_ID,
      contestId: CONTEST_ID,
      frozen: true,
      availableLanguages: ["rust", "python"],
      selectedLanguage: null,
      myEvolutionTruncated: true,
    },
    frontier: [{
      submissionId: SUBMISSION_A,
      participant: { id: "participant-0123456789abcdef01234567", kind: "anonymous", label: "Private participant 234567" },
      language: "rust",
      score: 100,
      fullyPassedCases: 12,
      deterministicCost: 12_345,
      peakMemoryBytes: 1_048_576,
      achievedAt: "2026-08-12T00:00:00.000Z",
      isPareto: true,
    }],
    myEvolution: [{
      submissionId: SUBMISSION_B,
      attemptNumber: 37,
      language: "python",
      state: "compile-error",
      verdict: "compile-error",
      score: null,
      fullyPassedCases: null,
      deterministicCost: null,
      peakMemoryBytes: null,
      createdAt: "2026-08-12T01:00:00.000Z",
      completedAt: "2026-08-12T01:01:00.000Z",
      policySummaryAvailable: false,
    }],
  };
}

function policySummary() {
  return {
    submissionId: SUBMISSION_A,
    policySummary: {
      totalCases: 10,
      outputAcceptedCases: 8,
      policies: [
        { id: "baseline", earnedCases: 8, costExceededCases: 0, memoryExceededCases: 0, logicalTimeExceededCases: 0 },
        { id: "efficient", earnedCases: 6, costExceededCases: 2, memoryExceededCases: 1, logicalTimeExceededCases: 1 },
        { id: "optimal", earnedCases: 4, costExceededCases: 4, memoryExceededCases: 3, logicalTimeExceededCases: 2 },
      ],
    },
  };
}

describe("performance API contracts", () => {
  it("parses the one exact contest response shape including a truncated full-history sequence", () => {
    const response = performanceResponse();
    response.myEvolution[0]!.attemptNumber = 10_001;
    const parsed = parseProblemPerformanceResponse(response, {
      problemVersionId: PROBLEM_ID,
      contestId: CONTEST_ID,
      language: "all",
    });

    expect(parsed.context).toMatchObject({ frozen: true, selectedLanguage: null, myEvolutionTruncated: true });
    expect(parsed.frontier[0]).toMatchObject({ language: "rust", isPareto: true });
    expect(parsed.myEvolution?.[0]).toMatchObject({ attemptNumber: 10_001, state: "compile-error" });
  });

  it("fails closed on extra keys, stale context, removed states, and bounded inventories", () => {
    const extra = performanceResponse() as ReturnType<typeof performanceResponse> & { compatibility?: boolean };
    extra.compatibility = true;
    expect(() => parseProblemPerformanceResponse(extra, { problemVersionId: PROBLEM_ID, contestId: CONTEST_ID, language: "all" }))
      .toThrow(/invalid shape/i);

    const stale = performanceResponse();
    stale.context.problemVersionId = "55555555-5555-4555-8555-555555555555";
    expect(() => parseProblemPerformanceResponse(stale, { problemVersionId: PROBLEM_ID, contestId: CONTEST_ID, language: "all" }))
      .toThrow(/does not match/i);

    const removedState = performanceResponse();
    removedState.myEvolution[0]!.state = "waiting-capacity";
    expect(() => parseProblemPerformanceResponse(removedState, { problemVersionId: PROBLEM_ID, contestId: CONTEST_ID, language: "all" }))
      .toThrow(/state is invalid/i);

    const fakeErrorCoordinates = performanceResponse();
    Object.assign(fakeErrorCoordinates.myEvolution[0]!, {
      score: 0,
      deterministicCost: 1,
      peakMemoryBytes: 1,
    });
    expect(() => parseProblemPerformanceResponse(fakeErrorCoordinates, { problemVersionId: PROBLEM_ID, contestId: CONTEST_ID, language: "all" }))
      .toThrow(/before completion/i);

    const tooMany = performanceResponse();
    tooMany.frontier = Array.from({ length: 101 }, (_, index) => ({
      ...tooMany.frontier[0]!,
      submissionId: `00000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`,
    }));
    expect(() => parseProblemPerformanceResponse(tooMany, { problemVersionId: PROBLEM_ID, contestId: CONTEST_ID, language: "all" }))
      .toThrow(/frontier is invalid/i);
  });

  it("requires canonical policy order and accepted-output resource invariants", () => {
    expect(parseSubmissionPolicySummaryResponse(policySummary(), SUBMISSION_A).policySummary.policies.map((item) => item.id))
      .toEqual(["baseline", "efficient", "optimal"]);

    const wrongOrder = policySummary();
    wrongOrder.policySummary.policies[0]!.id = "optimal";
    expect(() => parseSubmissionPolicySummaryResponse(wrongOrder, SUBMISSION_A)).toThrow(/canonical order/i);

    const impossible = policySummary();
    impossible.policySummary.policies[1]!.costExceededCases = 3;
    expect(() => parseSubmissionPolicySummaryResponse(impossible, SUBMISSION_A)).toThrow(/inconsistent/i);

    const empty = policySummary();
    empty.policySummary.totalCases = 0;
    empty.policySummary.outputAcceptedCases = 0;
    empty.policySummary.policies = empty.policySummary.policies.map((level) => ({
      ...level,
      earnedCases: 0,
      costExceededCases: 0,
      memoryExceededCases: 0,
      logicalTimeExceededCases: 0,
    }));
    expect(() => parseSubmissionPolicySummaryResponse(empty, SUBMISSION_A)).toThrow(/must be positive/i);
  });

  it("builds exact, encoded API paths without a latest or compatibility parameter", () => {
    expect(problemPerformanceApiPath("problem/id", "all"))
      .toBe("/api/problems/problem%2Fid/performance");
    expect(problemPerformanceApiPath("problem/id", "rust", "contest/id"))
      .toBe("/api/problems/problem%2Fid/performance?language=rust&contestId=contest%2Fid");
    expect(submissionPolicySummaryApiPath("submission/id"))
      .toBe("/api/submissions/submission%2Fid/policy-summary");
  });
});
