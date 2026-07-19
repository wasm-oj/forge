import { describe, expect, it } from "vitest";
import { PROBLEMS } from "./problems";

describe("generated problem fixtures", () => {
  it("embeds every declared test as non-empty deterministic UTF-8 text", () => {
    const caseIds = new Set<string>();
    for (const problem of PROBLEMS) {
      for (const testCase of problem.judgeCases) {
        expect(testCase.input.length, `${problem.id}/${testCase.id} input`).toBeGreaterThan(0);
        expect(testCase.output.length, `${problem.id}/${testCase.id} output`).toBeGreaterThan(0);
        expect(testCase.input.includes("\r"), `${problem.id}/${testCase.id} input`).toBe(false);
        expect(testCase.output.includes("\r"), `${problem.id}/${testCase.id} output`).toBe(false);
        expect(caseIds.has(`${problem.id}:${testCase.id}`)).toBe(false);
        caseIds.add(`${problem.id}:${testCase.id}`);
      }
    }
  });
});
