import { describe, expect, it } from "vitest";
import {
  FORMAL_RISK_COST_THRESHOLD,
  FORMAL_RISK_FAILURE_THRESHOLD,
  FORMAL_RISK_VELOCITY_THRESHOLD,
  formalRiskRequiresTurnstile,
} from "./formal-risk";

const ESTABLISHED = { priorSubmissionCount: 1, recentSubmissionCount: 1, recentFailureCount: 0, recentDeterministicCost: 0 };

describe("formal admission risk", () => {
  it("challenges first use, velocity, repeated failures, and accumulated cost", () => {
    expect(formalRiskRequiresTurnstile({ ...ESTABLISHED, priorSubmissionCount: 0 })).toBe(true);
    expect(formalRiskRequiresTurnstile({ ...ESTABLISHED, recentSubmissionCount: FORMAL_RISK_VELOCITY_THRESHOLD })).toBe(true);
    expect(formalRiskRequiresTurnstile({ ...ESTABLISHED, recentFailureCount: FORMAL_RISK_FAILURE_THRESHOLD })).toBe(true);
    expect(formalRiskRequiresTurnstile({ ...ESTABLISHED, recentDeterministicCost: FORMAL_RISK_COST_THRESHOLD })).toBe(true);
    expect(formalRiskRequiresTurnstile(ESTABLISHED)).toBe(false);
  });

  it("rejects malformed counters", () => {
    expect(() => formalRiskRequiresTurnstile({ ...ESTABLISHED, recentSubmissionCount: -1 })).toThrow("non-negative");
    expect(() => formalRiskRequiresTurnstile({ ...ESTABLISHED, recentFailureCount: Number.NaN })).toThrow("non-negative");
  });
});
