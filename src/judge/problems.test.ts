import { describe, expect, it } from "vitest";
import { PROBLEM_LOCALES, PROBLEMS, broadestPolicy, sampleCases } from "./problems";

describe("problem catalog", () => {
  it("contains exactly 40 ordered, unique, localized, judgeable problems", () => {
    expect(PROBLEMS).toHaveLength(40);
    expect(new Set(PROBLEMS.map((problem) => problem.id)).size).toBe(40);
    expect(PROBLEMS.map((problem) => problem.number)).toEqual(Array.from({ length: 40 }, (_, index) => index + 1));
    for (const problem of PROBLEMS) {
      expect(Object.keys(problem.title).sort()).toEqual([...PROBLEM_LOCALES].sort());
      expect(Object.keys(problem.statement).sort()).toEqual([...PROBLEM_LOCALES].sort());
      expect(Object.keys(problem.editorial).sort()).toEqual([...PROBLEM_LOCALES].sort());
      expect(sampleCases(problem)).toHaveLength(3);
      expect(problem.judgeCases.length).toBeGreaterThanOrEqual(4);
      expect(problem.judgeCases[0]).toEqual({
        ...sampleCases(problem)[0],
      });
      expect(broadestPolicy(problem).limits.instructionBudget).toBeGreaterThan(0);
      expect(problem.scoring.policies.reduce((sum, policy) => sum + policy.points, 0)).toBe(100);
    }
  });
});
