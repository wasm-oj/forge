import { describe, expect, it } from "vitest";
import { parseContestRules } from "../src/online-judge/contest-rules";
import {
  selectPromptGalleryCandidates,
  type PromptGallerySelectionCandidate,
} from "./prompt-gallery";

const rules = parseContestRules({
  clock: {
    kind: "global",
    registrationOpensAt: "2026-01-01T00:00:00Z",
    registrationClosesAt: "2026-01-02T00:00:00Z",
    startsAt: "2026-01-02T00:00:00Z",
    durationSeconds: 3600,
  },
  officialTrack: {
    kind: "prompt-program",
    compiler: { configId: "fixture", configDigest: "a".repeat(64) },
    limits: {
      promptBytes: 16_384,
      inputTokens: 4096,
      outputTokens: 4096,
      generatedSourceBytes: 1_048_576,
      timeoutSeconds: 120,
    },
    attemptPolicy: {
      consumeOn: "model-response-received",
      terminalInfrastructureFailure: "release-reservation",
    },
    disclosure: "best-after-end",
  },
  evidenceAt: "generated-source-ready",
  problems: ["sum", "sort"].map((slug, index) => ({
    slug,
    batch: 1,
    releaseAfterSeconds: 0,
    submissionClosesAfterSeconds: 3600,
    points: index === 0 ? 100 : 200,
    attemptLimit: 3,
    output: { language: "c", target: "wasip1", optimization: "release", entry: "main.c" },
  })),
  scoring: { kind: "score", tieBreaks: ["deterministic-cost", "final-best-achieved-at"] },
  checkpoints: [],
  leaderboard: { kind: "live" },
});

function candidate(
  entrant: string,
  problem: "sum" | "sort",
  attempt: string,
  score: number,
  cost: number,
  logicalSeconds: number,
): PromptGallerySelectionCandidate {
  return {
    entrant_id: entrant,
    account_user_id: `${entrant}-account`,
    problem_id: `${problem}-id`,
    problem_slug: problem,
    verdict: score === 100 ? "accepted" : "wrong-answer",
    score,
    fully_passed_cases: score,
    deterministic_cost: cost,
    peak_memory_bytes: 1024,
    logical_seconds: logicalSeconds,
    submission_id: `${attempt}-effective`,
    origin_submission_id: `${attempt}-origin`,
    attempt_id: attempt,
    prompt_text: `prompt ${attempt}`,
    source_id: `${attempt}-source`,
    source_sha256: "b".repeat(64),
  };
}

describe("Prompt Program best-after-end gallery selection", () => {
  it("publishes one final-leaderboard-selected prompt and source per entrant and problem", () => {
    const selected = selectPromptGalleryCandidates(rules, [
      candidate("entrant-b", "sum", "b-sum", 100, 20, 200),
      candidate("entrant-a", "sum", "a-sum-early", 100, 30, 100),
      candidate("entrant-a", "sum", "a-sum-cheap", 100, 10, 300),
      candidate("entrant-a", "sort", "a-sort", 70, 4, 400),
      candidate("entrant-b", "sort", "b-sort-low", 60, 1, 50),
      candidate("entrant-b", "sort", "b-sort-best", 80, 9, 500),
    ]);
    expect(selected.map((row) => row.attempt_id)).toEqual([
      "a-sort",
      "a-sum-cheap",
      "b-sort-best",
      "b-sum",
    ]);
  });
});
