import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { LeaderboardTable } from "./leaderboard-table";

describe("contest leaderboard breakdown", () => {
  it("provides expandable per-problem results in addition to the wide table", () => {
    const html = renderToStaticMarkup(<LeaderboardTable
      showProblems
      problemColumns={[{ id: "problem-1", label: "1" }, { id: "problem-2", label: "2" }]}
      entries={[{
        rank: 1,
        participant: { id: "participant-1", kind: "anonymous", label: "Private participant" },
        score: 75,
        fullyPassedCases: 3,
        deterministicCost: 100,
        peakMemoryBytes: 1_048_576,
        achievedAt: "2026-08-12T00:00:00.000Z",
        problemResults: [{ problemVersionId: "problem-1", score: 75, fullyPassedCases: 3 }],
      }]}
    />);
    expect(html).toContain("<details");
    expect(html).toContain("Problem 1");
    expect(html).toContain("75 points · 3 passed");
    expect(html).toContain("Not attempted");
  });
});
