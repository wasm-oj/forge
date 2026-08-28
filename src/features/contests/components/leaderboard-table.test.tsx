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
        problemResults: [{ problemId: "problem-1", score: 75, fullyPassedCases: 3 }],
      }]}
    />);
    expect(html).toContain("<details");
    expect(html).toContain("Problem 1");
    expect(html).toContain("75 points · 3 passed");
    expect(html).toContain("Not attempted");
  });

  it("renders ICPC solved and penalty standings at logical contest time", () => {
    const html = renderToStaticMarkup(<LeaderboardTable
      scoringKind="icpc"
      entries={[{
        rank: 2,
        participant: { id: "participant-2", kind: "anonymous", label: "Runner" },
        score: 200,
        solved: 2,
        penaltyMinutes: 47,
        fullyPassedCases: 4,
        deterministicCost: 80,
        peakMemoryBytes: 2_097_152,
        achievedAt: "1970-01-01T00:31:10.000Z",
        achievedAtLogicalSeconds: 1_870,
        provisional: true,
      }]}
    />);
    expect(html).toContain("<th>Solved</th><th>Penalty</th>");
    expect(html).toContain("47 min");
    expect(html).toContain("31:10");
    expect(html).toContain("Provisional");
    expect(html).not.toContain("1/1/1970");
  });

  it("renders progress before solved and score with elimination status", () => {
    const html = renderToStaticMarkup(<LeaderboardTable
      scoringKind="progress"
      checkpointCount={5}
      entries={[{
        rank: 3,
        participant: { id: "participant-3", kind: "anonymous", label: "Marathon runner" },
        score: 125,
        solved: 1,
        furthestCheckpoint: 3,
        fullyPassedCases: 5,
        deterministicCost: 90,
        peakMemoryBytes: 3_145_728,
        achievedAt: "2026-08-12T00:00:00.000Z",
        achievedAtLogicalSeconds: 3_725,
        eliminated: true,
      }]}
    />);
    expect(html).toContain("<th>Progress</th><th>Solved</th><th>Score</th>");
    expect(html).toContain("3 / 5");
    expect(html).toContain("1:02:05");
    expect(html).toContain("Eliminated");
    expect(html).toContain("leaderboard-row-eliminated");
  });
});
