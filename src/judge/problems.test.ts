import { describe, expect, it } from "vitest";
import { PROBLEMS } from "./problems";

describe("problem catalog", () => {
  it("contains exactly 20 ordered, unique, judgeable problems", () => {
    expect(PROBLEMS).toHaveLength(20);
    expect(new Set(PROBLEMS.map((problem) => problem.id)).size).toBe(20);
    expect(PROBLEMS.map((problem) => problem.number)).toEqual(Array.from({ length: 20 }, (_, index) => index + 1));
    for (const problem of PROBLEMS) {
      expect(problem.examples.length).toBeGreaterThan(0);
      expect(problem.judgeCases.length).toBeGreaterThanOrEqual(4);
      expect(problem.judgeCases[0]).toEqual({
        input: problem.examples[0].input,
        output: problem.examples[0].output,
      });
      expect(problem.timeLimitMs).toBeGreaterThan(0);
    }
  });
});
