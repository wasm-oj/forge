import { describe, expect, it } from "vitest";
import { formalSubmissionOutcome } from "../container/submission-result.mjs";

describe("formal Container submission outcome", () => {
  const scoring = { points: 75, cases: [{ outputAccepted: true }, { outputAccepted: false }] };

  it("keeps ordinary contestant verdicts eligible for completed projections", () => {
    expect(formalSubmissionOutcome("wrong-answer", scoring)).toEqual({ state: "completed", score: 75, fullyPassedCases: 1 });
    for (const verdict of ["instruction-limit", "memory-limit", "output-limit", "filesystem-limit", "logical-time-limit", "wall-time-limit"] as const) {
      expect(formalSubmissionOutcome(verdict, scoring)).toEqual({ state: "completed", score: 75, fullyPassedCases: 1 });
    }
  });

  it("turns checker or interactor failure into a non-projectable judge error", () => {
    expect(formalSubmissionOutcome("judge-error", scoring)).toEqual({ state: "judge-error", score: 0, fullyPassedCases: 0 });
  });
});
