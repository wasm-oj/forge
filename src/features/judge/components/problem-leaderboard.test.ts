import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { ProblemLeaderboardView, problemLeaderboardApiPath } from "./problem-leaderboard";

describe("problem leaderboard", () => {
  it("builds an all-language or validated language-filter URL", () => {
    expect(problemLeaderboardApiPath("problem/id", "all"))
      .toBe("/api/problems/problem%2Fid/leaderboard?limit=100");
    expect(problemLeaderboardApiPath("problem/id", "rust"))
      .toBe("/api/problems/problem%2Fid/leaderboard?limit=100&language=rust");
  });

  it("shows the winning submission language and deterministic rank", () => {
    const html = renderToStaticMarkup(createElement(ProblemLeaderboardView, {
      locale: "zh-TW",
      language: "all",
      loading: false,
      onLanguageChange: vi.fn(),
      response: {
        availableLanguages: ["c", "rust"],
        selectedLanguage: null,
        entries: [{
          rank: 1,
          language: "rust",
          participant: { id: "private-a", kind: "anonymous", label: "Private participant a" },
          score: 100,
          fullyPassedCases: 4,
          deterministicCost: 1234,
          peakMemoryBytes: 131072,
          achievedAt: "2026-08-12T00:00:00.000Z",
        }],
      },
    }));

    expect(html).toContain("題目排名");
    expect(html).toContain("所有語言");
    expect(html).toContain("Language");
    expect(html).toContain("Rust");
    expect(html).toContain("1,234");
  });
});
