import { describe, expect, it } from "vitest";
import {
  DEFAULT_PROBLEM_COLLECTION_SOURCE,
  MemoryProblemCollectionCache,
  loadProblemCollection,
} from "./problem-catalog-loader";

const runIntegration = process.env.FORGE_RUN_PROBLEM_COLLECTION_INTEGRATION === "1";

describe.runIf(runIntegration)("published wasm-oj/problems collection", () => {
  it("loads the public index and verifies every published problem bundle", async () => {
    const collection = await loadProblemCollection(DEFAULT_PROBLEM_COLLECTION_SOURCE, {
      cache: new MemoryProblemCollectionCache(),
    });
    expect(collection.origin).toBe("network");
    expect(collection.index.problems).toHaveLength(45);
    expect(collection.index.revision).toBe("8a77d366553153ad10b6536ba0fc642d232c06761d073007626e89fe05fbc037");
    const problems = await Promise.all(collection.index.problems.map((entry) => collection.loadProblem(entry.id)));
    expect(problems.map((problem) => problem.number)).toEqual(Array.from({ length: 45 }, (_, index) => index + 1));
    expect(problems[0]).toMatchObject({ number: 1, id: "progressive-cost-budget", track: { en: "Foundations" } });
    expect(problems.at(-1)).toMatchObject({
      number: 45,
      id: "conformance-feature-coverage",
      judgeCases: expect.arrayContaining([expect.objectContaining({ id: "adversarial-blind-01" })]),
    });
  }, 30_000);
});
