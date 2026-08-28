import { describe, expect, it } from "vitest";
import {
  ContestRuleEngine,
  decideContestAdmission,
  evaluateContestCheckpoint,
  expandContestRulesPreset,
  logicalContestSeconds,
  parseContestRules,
  parseContestRulesPreset,
  projectContestRules,
  rankContestResults,
  type ContestResultFact,
  type ContestStanding,
} from "./contest-rules";

const globalClock = {
  kind: "global",
  registrationOpensAt: "2026-01-01T00:00:00Z",
  registrationClosesAt: "2026-01-02T00:00:00Z",
  startsAt: "2026-01-02T00:00:00Z",
  durationSeconds: 600,
} as const;

function codeRules(problemSlugs = ["alpha", "beta"], scoring: Record<string, unknown> = { kind: "score", tieBreaks: ["deterministic-cost", "final-best-achieved-at"] }): Record<string, unknown> {
  return {
    clock: globalClock,
    officialTrack: { kind: "code", aiAssist: "allowed" },
    evidenceAt: "input-admitted",
    problems: problemSlugs.map((slug, index) => ({
      slug,
      batch: index + 1,
      releaseAfterSeconds: index * 180,
      submissionClosesAfterSeconds: 600,
      points: 100,
      attemptLimit: 3,
    })),
    scoring,
    checkpoints: [],
    leaderboard: { kind: "live" },
  };
}

function fact(overrides: Partial<ContestResultFact> & Pick<ContestResultFact, "entrantId" | "problemSlug">): ContestResultFact {
  return {
    verdict: "accepted",
    score: 100,
    fullyPassedCases: 4,
    deterministicCost: 100,
    peakMemoryBytes: 1_024,
    logicalSeconds: 60,
    eligible: true,
    ...overrides,
  };
}

describe("contest v2 canonical rules", () => {
  it("parses prompt-program profiles and rejects code-only generated-source evidence", () => {
    const rules = parseContestRules({
      ...codeRules(["alpha"]),
      officialTrack: {
        kind: "prompt-program",
        compiler: { configId: "compiler.production-v1", configDigest: "a".repeat(64) },
        limits: { promptBytes: 16_384, inputTokens: 8_000, outputTokens: 4_000, generatedSourceBytes: 1_048_576, timeoutSeconds: 120 },
        attemptPolicy: { consumeOn: "model-response-received", terminalInfrastructureFailure: "release-reservation" },
        disclosure: "best-after-end",
      },
      evidenceAt: "generated-source-ready",
      problems: [{
        slug: "alpha", batch: 1, releaseAfterSeconds: 0, submissionClosesAfterSeconds: 600,
        points: 100, attemptLimit: 3,
        output: { language: "rust", target: "wasip1", optimization: "release", entry: "src/main.rs" },
      }],
    });
    expect(rules.officialTrack.kind).toBe("prompt-program");
    expect(rules.problems[0]?.output).toEqual({ language: "rust", target: "wasip1", optimization: "release", entry: "src/main.rs" });
    expect(() => parseContestRules({ ...codeRules(["alpha"]), evidenceAt: "generated-source-ready" })).toThrow("requires the prompt-program track");
  });

  it("enforces duration, individual-ranking, exact-shape, and eight-problem batch invariants", () => {
    const nine = Array.from({ length: 9 }, (_, index) => `p-${index + 1}`);
    const nineRules = codeRules(nine);
    (nineRules.problems as Array<Record<string, unknown>>).forEach((problem) => { problem.batch = 1; problem.releaseAfterSeconds = 0; });
    expect(() => parseContestRules(nineRules)).toThrow("exceeds 8 problems");
    expect(() => parseContestRules({ ...codeRules(["alpha"]), unexpected: true })).toThrow("invalid shape");

    const individual = {
      ...codeRules(["alpha"]),
      clock: { kind: "individual", enrollmentOpensAt: "2026-01-01T00:00:00Z", enrollmentClosesAt: "2026-02-01T00:00:00Z", durationSeconds: 600 },
      checkpoints: [{
        id: "gate-1", atSeconds: 300, scope: { kind: "all-released" },
        threshold: { minimumSolved: 1, minimumScore: null }, ranking: { kind: "top-k", count: 10 }, settlement: "provisional",
      }],
    };
    expect(() => parseContestRules(individual)).toThrow("cannot rank entrants");
    expect(() => parseContestRules({
      ...individual,
      checkpoints: [],
      leaderboard: { kind: "freeze", atSeconds: 500 },
    })).toThrow("only valid for a global clock");
  });

  it("expands all authoring presets to canonical runtime rules", () => {
    const blitz = expandContestRulesPreset(parseContestRulesPreset({
      preset: "blitz-batches",
      clock: { ...globalClock, durationSeconds: 900 },
      problemSlugs: Array.from({ length: 12 }, (_, index) => `p-${index + 1}`),
      batchSize: 4,
      releaseIntervalSeconds: 180,
      pointsPerProblem: 25,
      attemptLimit: 3,
      minimumSolvedPerBatch: 2,
      aiAssist: "allowed",
      leaderboard: { kind: "live" },
    }));
    expect(blitz.problems.map((problem) => problem.releaseAfterSeconds)).toEqual([0, 0, 0, 0, 180, 180, 180, 180, 360, 360, 360, 360]);
    expect(blitz.checkpoints).toHaveLength(2);
    expect("preset" in blitz).toBe(false);

    const prompt = expandContestRulesPreset(parseContestRulesPreset({
      preset: "prompt-five-by-three",
      clock: globalClock,
      compiler: { configId: "test", configDigest: "b".repeat(64) },
      limits: { promptBytes: 16_384, inputTokens: 8_000, outputTokens: 4_000, generatedSourceBytes: 1_048_576, timeoutSeconds: 120 },
      disclosure: "best-after-end",
      leaderboard: { kind: "live" },
      problems: Array.from({ length: 5 }, (_, index) => ({
        slug: `p-${index + 1}`,
        output: { language: "c", target: "wasip1", optimization: "release", entry: "main.c" },
      })),
    }));
    expect(prompt.problems).toHaveLength(5);
    expect(prompt.problems.every((problem) => problem.attemptLimit === 3)).toBe(true);
  });
});

describe("ContestRuleEngine projections", () => {
  const rules = parseContestRules(codeRules());
  const entrant = { joined: true, started: true, eliminatedAtSeconds: null };

  it("advances and freezes explicit logical clocks at exact schedule boundaries", () => {
    expect(logicalContestSeconds({ generation: 1, state: "running", logicalSeconds: 0, capturedAt: "2026-01-02T00:00:00Z" }, "2026-01-02T00:03:00Z", 600)).toBe(180);
    expect(logicalContestSeconds({ generation: 1, state: "paused", logicalSeconds: 179, capturedAt: "2026-01-02T00:02:59Z" }, "2026-01-02T00:10:00Z", 600)).toBe(179);

    const projection = projectContestRules({
      rules,
      observedAt: "2026-01-02T00:03:00Z",
      clock: { generation: 2, state: "running", logicalSeconds: 0, capturedAt: "2026-01-02T00:00:00Z" },
      entrant,
      attemptedByProblem: { alpha: 3 },
    });
    expect(projection.phase).toBe("running");
    expect(projection.problems.map((problem) => problem.availability)).toEqual(["open", "open"]);
    expect(projection.problems[0]?.attemptsRemaining).toBe(0);
    expect(projection.nextBoundarySeconds).toBe(600);
  });

  it("locks content until join and shares admission decisions with projection", () => {
    const unjoined = projectContestRules({
      rules,
      observedAt: "2026-01-01T12:00:00Z",
      clock: null,
      entrant: null,
      attemptedByProblem: {},
    });
    expect(unjoined.phase).toBe("registration");
    expect(unjoined.problems.every((problem) => problem.availability === "locked")).toBe(true);

    const input = {
      rules,
      observedAt: "2026-01-02T00:03:00Z",
      clock: { generation: 1, state: "running" as const, logicalSeconds: 180, capturedAt: "2026-01-02T00:03:00Z" },
      entrant,
      attemptedByProblem: { beta: 3 },
    };
    expect(decideContestAdmission(input, "alpha").allowed).toBe(true);
    expect(decideContestAdmission(input, "beta")).toEqual({ allowed: false, reason: "attempt-limit" });
    expect(ContestRuleEngine.admission(input, "missing")).toEqual({ allowed: false, reason: "unknown-problem" });
  });
});

describe("ContestRuleEngine scoring and checkpoints", () => {
  it("weights best score results and applies declared competitive tie-breaks", () => {
    const rules = parseContestRules(codeRules());
    const standings = rankContestResults(rules, ["alice", "bob"], [
      fact({ entrantId: "alice", problemSlug: "alpha", deterministicCost: 90 }),
      fact({ entrantId: "alice", problemSlug: "beta", score: 50, deterministicCost: 80, logicalSeconds: 200 }),
      fact({ entrantId: "bob", problemSlug: "alpha", deterministicCost: 100 }),
      fact({ entrantId: "bob", problemSlug: "beta", score: 50, deterministicCost: 80, logicalSeconds: 190 }),
    ]);
    expect(standings.map(({ entrantId, rank, score }) => ({ entrantId, rank, score }))).toEqual([
      { entrantId: "alice", rank: 1, score: 150 },
      { entrantId: "bob", rank: 2, score: 150 },
    ]);
    expect(standings[0]?.peakMemoryBytes).toBe(1_024);
  });

  it("implements ICPC penalty and Progress checkpoint-first ordering", () => {
    const icpc = parseContestRules(codeRules(["alpha"], {
      kind: "icpc", wrongAttemptPenaltyMinutes: 20, penalizedVerdicts: ["wrong-answer"], tieBreaks: [],
    }));
    const standings = rankContestResults(icpc, ["alice", "bob"], [
      fact({ entrantId: "alice", problemSlug: "alpha", verdict: "wrong-answer", score: 0, logicalSeconds: 60 }),
      fact({ entrantId: "alice", problemSlug: "alpha", logicalSeconds: 120 }),
      fact({ entrantId: "bob", problemSlug: "alpha", logicalSeconds: 300 }),
    ]);
    expect(standings.map(({ entrantId, penaltyMinutes }) => ({ entrantId, penaltyMinutes }))).toEqual([
      { entrantId: "bob", penaltyMinutes: 5 },
      { entrantId: "alice", penaltyMinutes: 22 },
    ]);

    const progress = parseContestRules({
      ...codeRules(["alpha"], { kind: "progress", tieBreaks: [] }),
      checkpoints: [100, 200].map((atSeconds, index) => ({
        id: `gate-${index + 1}`, atSeconds, scope: { kind: "all-released" },
        threshold: { minimumSolved: 0, minimumScore: null }, ranking: null, settlement: "provisional",
      })),
    });
    expect(rankContestResults(progress, ["alice", "bob"], [
      fact({ entrantId: "alice", problemSlug: "alpha" }),
      fact({ entrantId: "bob", problemSlug: "alpha", score: 20 }),
    ], { alice: 1, bob: 2 }).map((standing) => standing.entrantId)).toEqual(["bob", "alice"]);
  });

  it("uses ceil population seats, admits complete-key ties, and provisionally advances pending work", () => {
    const rules = parseContestRules({
      ...codeRules(["alpha"]),
      checkpoints: [{
        id: "gate-1", atSeconds: 300, scope: { kind: "all-released" },
        threshold: { minimumSolved: 1, minimumScore: null }, ranking: { kind: "top-percent", percent: 50 }, settlement: "provisional",
      }],
    });
    const base: Omit<ContestStanding, "entrantId" | "rank"> = {
      solved: 1, score: 100, penaltyMinutes: 0, furthestCheckpoint: 0,
      fullyPassedCases: 1, deterministicCost: 1, peakMemoryBytes: 1, achievedAtSeconds: 1,
    };
    const decisions = evaluateContestCheckpoint(rules, rules.checkpoints[0]!, [
      { ...base, entrantId: "alice", rank: 1 },
      { ...base, entrantId: "bob", rank: 2 },
      { ...base, entrantId: "carol", rank: 2 },
      { ...base, entrantId: "dave", rank: 4 },
      { ...base, entrantId: "eve", rank: 5 },
    ], [
      { entrantId: "alice", pending: false, solved: 1, score: 100 },
      { entrantId: "bob", pending: false, solved: 1, score: 100 },
      { entrantId: "carol", pending: false, solved: 1, score: 100 },
      { entrantId: "dave", pending: true, solved: 0, score: 0 },
      { entrantId: "eve", pending: false, solved: 0, score: 0 },
    ]);
    expect(decisions).toEqual([
      { entrantId: "alice", advances: true, provisional: false },
      { entrantId: "bob", advances: true, provisional: false },
      { entrantId: "carol", advances: true, provisional: false },
      { entrantId: "dave", advances: true, provisional: true },
      { entrantId: "eve", advances: false, provisional: false },
    ]);
  });
});
