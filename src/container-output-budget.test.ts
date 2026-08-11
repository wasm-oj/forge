import { describe, expect, it } from "vitest";
import { OutputBudget, OutputBudgetExceededError } from "../container/output-budget.mjs";

describe("Container aggregate output budget", () => {
  it("shares one exact boundary across sequential compile and judge phases", () => {
    const budget = new OutputBudget(10);
    budget.consume(3);
    budget.consume(7);
    expect(budget.used).toBe(10);
    expect(budget.remaining).toBe(0);
    expect(() => budget.consume(1)).toThrow(OutputBudgetExceededError);
  });

  it("rejects invalid counters without changing the budget", () => {
    const budget = new OutputBudget(10);
    expect(() => budget.consume(-1)).toThrow(TypeError);
    expect(() => budget.consume(Number.MAX_SAFE_INTEGER)).toThrow(OutputBudgetExceededError);
    expect(budget.used).toBe(0);
    expect(budget.remaining).toBe(10);
  });
});
