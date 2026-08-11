import { describe, expect, it } from "vitest";
import {
  assertSubmissionTransition,
  compareLeaderboardEntries,
  parseOfficialSubmissionRequest,
  parseSequencedSubmissionEvent,
  parseSubmissionEventReplay,
  publicSubmissionEvent,
} from "./contracts";

const problemVersionId = "018f0d8a-7110-7cc8-9f08-15b28df8307b";

describe("online judge contracts", () => {
  it("accepts only source-based official submissions", () => {
    const request = parseOfficialSubmissionRequest({
      managedProblemVersionId: problemVersionId,
      language: "c",
      target: "wasip1",
      optimization: "release",
      entry: "main.c",
      sourceFiles: [{ path: "main.c", encoding: "utf8", content: "int main(void){return 0;}" }],
      idempotencyKey: "submission:018f0d8a-7110-7cc8",
    });
    expect(request.sourceFiles).toHaveLength(1);
    expect(() => parseOfficialSubmissionRequest({ ...request, artifact: "wasm" })).toThrow("invalid shape");
    expect(() => parseOfficialSubmissionRequest({ ...request, resources: { wallTimeLimitMs: 1 } })).toThrow("invalid shape");
  });

  it("enforces source limits and normalized paths", () => {
    const base = {
      managedProblemVersionId: problemVersionId,
      language: "c",
      target: "wasip1",
      optimization: "release",
      entry: "../main.c",
      sourceFiles: [{ path: "../main.c", encoding: "utf8", content: "x" }],
      idempotencyKey: "submission:018f0d8a-7110-7cc8",
    };
    expect(() => parseOfficialSubmissionRequest(base)).toThrow("normalized relative");
    expect(() => parseOfficialSubmissionRequest({
      ...base,
      entry: "main.c",
      sourceFiles: [{ path: "main.c", encoding: "utf8", content: "x".repeat(256 * 1024 + 1) }],
    })).toThrow("256 KiB");
  });

  it("rejects state skips and hidden event fields", () => {
    expect(() => assertSubmissionTransition("queued", "running")).toThrow("Invalid submission transition");
    expect(() => publicSubmissionEvent({
      kind: "case-progress",
      completedCases: 1,
      totalCases: 3,
      hiddenCaseId: "secret-1",
    })).toThrow("invalid shape");
    expect(publicSubmissionEvent({ kind: "case-progress", completedCases: 1, totalCases: 3 })).toEqual({
      kind: "case-progress",
      completedCases: 1,
      totalCases: 3,
    });
    for (const verdict of ["instruction-limit", "memory-limit", "output-limit", "filesystem-limit", "logical-time-limit", "wall-time-limit"]) {
      expect(publicSubmissionEvent({ kind: "verdict", verdict, score: 0, fullyPassedCases: 0 })).toEqual({
        kind: "verdict", verdict, score: 0, fullyPassedCases: 0,
      });
    }
    expect(() => publicSubmissionEvent({ kind: "verdict", verdict: "time-limit", score: 0, fullyPassedCases: 0 })).toThrow("verdict");
  });

  it("requires exact, canonical sequenced events and replay envelopes", () => {
    const event = {
      kind: "resource-summary",
      deterministicCost: 123,
      peakMemoryBytes: 456,
      sequence: 2,
      timestamp: "2026-08-09T01:02:03.000Z",
    };
    expect(parseSequencedSubmissionEvent(event)).toEqual(event);
    expect(parseSubmissionEventReplay({ events: [event], nextCursor: 2, state: "running" })).toEqual({
      events: [event],
      nextCursor: 2,
      state: "running",
    });
    expect(() => parseSequencedSubmissionEvent({ ...event, stdout: "hidden" })).toThrow("shape");
    expect(() => parseSequencedSubmissionEvent({ ...event, timestamp: "2026-08-09 01:02:03Z" })).toThrow("timestamp");
    expect(() => parseSubmissionEventReplay({ events: [{ ...event, sequence: 3 }, event], nextCursor: 3, state: "running" })).toThrow("ordered");
    expect(() => parseSubmissionEventReplay({ events: [event], nextCursor: 1, state: "running" })).toThrow("next cursor");
    expect(() => parseSubmissionEventReplay({ events: Array.from({ length: 101 }, () => event), nextCursor: 2, state: "running" })).toThrow("100 event");
  });

  it("orders leaderboard entries by the published deterministic rules", () => {
    const base = {
      userId: "b",
      score: 100,
      fullyPassedCases: 4,
      deterministicCost: 1_000,
      peakMemoryBytes: 65_536,
      achievedAt: "2026-01-01T00:00:00.000Z",
    };
    expect(compareLeaderboardEntries({ ...base, score: 90 }, base)).toBeGreaterThan(0);
    expect(compareLeaderboardEntries({ ...base, deterministicCost: 900 }, base)).toBeLessThan(0);
    expect(compareLeaderboardEntries({ ...base, userId: "a" }, base)).toBeLessThan(0);
  });
});
