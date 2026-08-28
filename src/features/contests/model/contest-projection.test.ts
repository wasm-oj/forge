import { describe, expect, it } from "vitest";
import {
  contestBatchProgress,
  contestCatalogGroup,
  contestEffectiveWallTime,
  contestEnrollmentWindowOpen,
  formatLogicalDuration,
  nextContestBoundaryDelayMs,
  nextContestWallBoundaryDelayMs,
  projectedLogicalSeconds,
} from "./contest-projection";

const clock = {
  kind: "global" as const,
  registrationOpensAt: "2026-08-27T00:00:00Z",
  registrationClosesAt: "2026-08-27T00:30:00Z",
  startsAt: "2026-08-27T00:10:00Z",
  durationSeconds: 1_800,
};

describe("contest v2 UI projection", () => {
  it("advances only a running logical clock and schedules its next exact boundary", () => {
    const running = { clock, logicalTimeSeconds: 60, nextBoundarySeconds: 180, runtimeState: "running" as const };
    expect(projectedLogicalSeconds(running, 1_000, 31_000)).toBe(90);
    expect(nextContestBoundaryDelayMs(running, 1_000, 31_000)).toBe(90_000);
    expect(projectedLogicalSeconds({ ...running, runtimeState: "paused" }, 1_000, 31_000)).toBe(60);
    expect(nextContestBoundaryDelayMs({ ...running, runtimeState: "paused" }, 1_000, 31_000)).toBeUndefined();
  });

  it("groups all v2 participant phases without recreating a legacy phase model", () => {
    expect(contestCatalogGroup("registration")).toBe("upcoming");
    expect(contestCatalogGroup("awaiting-start")).toBe("upcoming");
    expect(contestCatalogGroup("paused")).toBe("running");
    expect(contestCatalogGroup("eliminated")).toBe("running");
    expect(contestCatalogGroup("ended")).toBe("ended");
  });

  it("summarizes batch availability without requiring locked problem identity", () => {
    const base = {
      releaseAfterSeconds: 0,
      submissionClosesAfterSeconds: 300,
      points: 100,
      attemptLimit: 3,
      attemptsRemaining: 3,
    };
    expect(contestBatchProgress([
      { ...base, ordinal: 1, batch: 1, availability: "locked" },
      { ...base, ordinal: 2, batch: 1, availability: "locked" },
      { ...base, ordinal: 3, batch: 2, availability: "open", problemId: "p", problemSlug: "p", problemNumber: 1, title: {}, contentCommit: "c", judgeDigest: "j", contentUrl: "/p", contestAdmission: { timelineGeneration: 1, ruleEpoch: 1, problemEpoch: 1 } },
    ])).toEqual([
      { batch: 1, total: 2, open: 0, closed: 0, locked: 2 },
      { batch: 2, total: 1, open: 1, closed: 0, locked: 0 },
    ]);
  });

  it("formats countdowns with stable tabular fields", () => {
    expect(formatLogicalDuration(0)).toBe("0:00");
    expect(formatLogicalDuration(125)).toBe("2:05");
    expect(formatLogicalDuration(3_725)).toBe("1:02:05");
  });

  it("uses the shifted wall schedule for enrollment and exact refresh", () => {
    const contest = { clock, scheduleShiftSeconds: 60, runtimeState: "scheduled" as const };
    expect(contestEffectiveWallTime(clock.startsAt, 60)).toBe("2026-08-27T00:11:00.000Z");
    expect(contestEnrollmentWindowOpen(contest, Date.parse("2026-08-27T00:00:30.000Z"))).toBe(false);
    expect(contestEnrollmentWindowOpen(contest, Date.parse("2026-08-27T00:01:00.000Z"))).toBe(true);
    expect(nextContestWallBoundaryDelayMs(contest, Date.parse("2026-08-27T00:00:30.000Z"))).toBe(30_000);
  });
});
