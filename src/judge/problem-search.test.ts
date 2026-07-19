import { describe, expect, it } from "vitest";
import type { JudgeProblemSummary } from "./problem-model";
import { matchesProblemSearch } from "./problem-search";

const problem: JudgeProblemSummary = {
  id: "progressive-cost-budget",
  number: 1,
  title: { "zh-TW": "漸進成本預算", en: "Progressive Cost Budget" },
  trackId: "foundations",
  track: { "zh-TW": "入門基礎", en: "Foundations" },
  difficulty: "easy",
  tags: ["prefix-sum", "resource-metering"],
  caseCount: 4,
};

describe("problem search", () => {
  it.each(["漸進", "Progressive", "foundations", "入門", "prefix-sum", "#1", "01"])(
    "matches localized titles, tracks, tags, and number: %s",
    (query) => expect(matchesProblemSearch(problem, query)).toBe(true),
  );

  it("requires every whitespace-delimited term to match", () => {
    expect(matchesProblemSearch(problem, "cost prefix")).toBe(true);
    expect(matchesProblemSearch(problem, "cost graph")).toBe(false);
  });

  it("normalizes case and full-width characters", () => {
    expect(matchesProblemSearch(problem, "ＰＲＯＧＲＥＳＳＩＶＥ")).toBe(true);
  });
});
