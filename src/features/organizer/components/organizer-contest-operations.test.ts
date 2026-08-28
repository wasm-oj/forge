import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { OrganizerContestOperations, rewindConfirmationPhrase } from "./organizer-contest-operations";
import type { ContestProjection } from "../../contests/model/contest-projection";

function contest(state: "running" | "paused"): ContestProjection {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    slug: "blitz",
    title: "Blitz",
    description: "",
    accessMode: "public",
    status: "published",
    organizer: true,
    joined: false,
    rulesCommit: "a".repeat(40),
    rulesDigest: "b".repeat(64),
    clock: { kind: "global", registrationOpensAt: "2026-08-27T00:00:00Z", registrationClosesAt: "2026-08-27T00:10:00Z", startsAt: "2026-08-27T00:10:00Z", durationSeconds: 1_800 },
    officialTrack: { kind: "code", aiAssist: "allowed" },
    evidenceAt: "judge-terminal",
    scoring: { kind: "score", tieBreaks: ["final-best-achieved-at"] },
    leaderboard: { kind: "live" },
    runtimeState: state,
    scheduleShiftSeconds: 0,
    phase: state,
    logicalTimeSeconds: 360,
    nextBoundarySeconds: 540,
    paused: state === "paused",
    pauseReason: state === "paused" ? "Judge rollout" : null,
    epochs: { timelineGeneration: 3, ruleEpoch: 4 },
    entrant: null,
    checkpoints: [],
    judgeProvisional: false,
    promptCompilerAvailable: false,
    aiAssistAvailable: false,
    publicRepositoryTimingWarning: null,
    pendingRulesCommit: null,
    createdAt: "2026-08-27T00:00:00.000Z",
  };
}

describe("Organizer contest operations", () => {
  it("requires an explicit generation-specific rewind phrase", () => {
    expect(rewindConfirmationPhrase(3)).toBe("REWIND TIMELINE 3");
    expect(() => rewindConfirmationPhrase(0)).toThrow("positive integer");
  });

  it("renders pause for a running contest and resume plus rewind warnings only while paused", () => {
    const running = renderToStaticMarkup(createElement(OrganizerContestOperations, { contest: contest("running"), participants: [], onRefresh: vi.fn() }));
    expect(running).toContain("Pause contest");
    expect(running).not.toContain("Create new timeline generation");

    const paused = renderToStaticMarkup(createElement(OrganizerContestOperations, { contest: contest("paused"), participants: [], onRefresh: vi.fn() }));
    expect(paused).toContain("Resume contest");
    expect(paused).toContain("REWIND TIMELINE 3");
    expect(paused).toContain("Data is retained as invalid history");
  });
});
