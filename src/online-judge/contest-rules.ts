import { isBuiltinLanguage, type BuiltinLanguage, type OptimizationLevel, type TargetAbi } from "../core/types";
import { SUBMISSION_SOURCE_LIMITS, SUBMISSION_VERDICTS, type SubmissionVerdict } from "./contracts";

/**
 * Pure contest policy boundary. Repository parsing materializes one canonical
 * rules value; runtime callers provide explicit clock, entrant, and result
 * snapshots so evaluation never reads storage or wall time implicitly.
 */

export const MAX_CONTEST_RELEASE_BATCH_SIZE = 8;
export const MAX_CONTEST_PROBLEMS = 100;
export const MAX_PROMPT_BYTES = 16 * 1024;

export type ContestEvidenceAt = "input-admitted" | "generated-source-ready" | "judge-terminal";

export interface GlobalContestClock {
  readonly kind: "global";
  readonly registrationOpensAt: string;
  readonly registrationClosesAt: string;
  readonly startsAt: string;
  readonly durationSeconds: number;
}

export interface IndividualContestClock {
  readonly kind: "individual";
  readonly enrollmentOpensAt: string;
  readonly enrollmentClosesAt: string;
  readonly durationSeconds: number;
}

export type ContestClock = GlobalContestClock | IndividualContestClock;

export interface CodeOfficialTrack {
  readonly kind: "code";
  readonly aiAssist: "allowed" | "disabled";
}

export interface PromptCompilerPin {
  readonly configId: string;
  readonly configDigest: string;
}

export interface PromptProgramLimits {
  readonly promptBytes: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly generatedSourceBytes: number;
  readonly timeoutSeconds: number;
}

export interface PromptAttemptPolicy {
  readonly consumeOn: "model-response-received";
  readonly terminalInfrastructureFailure: "release-reservation";
}

export interface PromptProgramOfficialTrack {
  readonly kind: "prompt-program";
  readonly compiler: PromptCompilerPin;
  readonly limits: PromptProgramLimits;
  readonly attemptPolicy: PromptAttemptPolicy;
  readonly disclosure: "private" | "best-after-end";
}

export type ContestOfficialTrack = CodeOfficialTrack | PromptProgramOfficialTrack;

export interface ContestProblemRuleBase {
  readonly slug: string;
  readonly batch: number;
  readonly releaseAfterSeconds: number;
  readonly submissionClosesAfterSeconds: number;
  readonly points: number;
  readonly attemptLimit: number;
}

export interface CodeContestProblemRule extends ContestProblemRuleBase {
  readonly output?: never;
}

export interface PromptProgramOutputProfile {
  readonly language: BuiltinLanguage;
  readonly target: TargetAbi;
  readonly optimization: OptimizationLevel;
  readonly entry: string;
}

export interface PromptProgramContestProblemRule extends ContestProblemRuleBase {
  readonly output: PromptProgramOutputProfile;
}

export type ContestProblemRule = CodeContestProblemRule | PromptProgramContestProblemRule;

export type ScoreTieBreak =
  | "fully-passed-cases"
  | "deterministic-cost"
  | "peak-memory"
  | "final-best-achieved-at";

export interface ScoreContestScoring {
  readonly kind: "score";
  readonly tieBreaks: readonly ScoreTieBreak[];
}

export type IcpcTieBreak = "last-solve-at" | "deterministic-cost" | "peak-memory";

export interface IcpcContestScoring {
  readonly kind: "icpc";
  readonly wrongAttemptPenaltyMinutes: number;
  readonly penalizedVerdicts: readonly SubmissionVerdict[];
  readonly tieBreaks: readonly IcpcTieBreak[];
}

export type ProgressTieBreak =
  | "fully-passed-cases"
  | "deterministic-cost"
  | "peak-memory"
  | "final-best-achieved-at";

export interface ProgressContestScoring {
  readonly kind: "progress";
  readonly tieBreaks: readonly ProgressTieBreak[];
}

export type ContestScoring = ScoreContestScoring | IcpcContestScoring | ProgressContestScoring;

export type ContestCheckpointScope =
  | { readonly kind: "all-released" }
  | { readonly kind: "batch"; readonly batch: number }
  | { readonly kind: "problems"; readonly slugs: readonly string[] };

export interface ContestCheckpointThreshold {
  readonly minimumSolved: number | null;
  readonly minimumScore: number | null;
}

export type ContestCheckpointRanking =
  | { readonly kind: "top-k"; readonly count: number }
  | { readonly kind: "top-percent"; readonly percent: number }
  | null;

export interface ContestCheckpointRule {
  readonly id: string;
  readonly atSeconds: number;
  readonly scope: ContestCheckpointScope;
  readonly threshold: ContestCheckpointThreshold;
  readonly ranking: ContestCheckpointRanking;
  readonly settlement: "provisional" | "pause-until-terminal";
}

export type ContestLeaderboardRule =
  | { readonly kind: "live" }
  | { readonly kind: "freeze"; readonly atSeconds: number }
  | { readonly kind: "hidden-until-end" };

interface ContestRulesBase {
  readonly clock: ContestClock;
  readonly evidenceAt: ContestEvidenceAt;
  readonly scoring: ContestScoring;
  readonly checkpoints: readonly ContestCheckpointRule[];
  readonly leaderboard: ContestLeaderboardRule;
}

export interface CodeContestRules extends ContestRulesBase {
  readonly officialTrack: CodeOfficialTrack;
  readonly problems: readonly CodeContestProblemRule[];
}

export interface PromptProgramContestRules extends ContestRulesBase {
  readonly officialTrack: PromptProgramOfficialTrack;
  readonly problems: readonly PromptProgramContestProblemRule[];
}

export type ContestRules = CodeContestRules | PromptProgramContestRules;

export interface ClassicScorePreset {
  readonly preset: "classic-score";
  readonly clock: ContestClock;
  readonly problemSlugs: readonly string[];
  readonly pointsPerProblem: number;
  readonly attemptLimit: number;
  readonly aiAssist: "allowed" | "disabled";
  readonly leaderboard: ContestLeaderboardRule;
}

export interface IcpcPreset {
  readonly preset: "icpc";
  readonly clock: ContestClock;
  readonly problemSlugs: readonly string[];
  readonly attemptLimit: number;
  readonly aiAssist: "allowed" | "disabled";
  readonly wrongAttemptPenaltyMinutes: number;
  readonly penalizedVerdicts: readonly SubmissionVerdict[];
  readonly leaderboard: ContestLeaderboardRule;
}

export interface BlitzBatchesPreset {
  readonly preset: "blitz-batches";
  readonly clock: ContestClock;
  readonly problemSlugs: readonly string[];
  readonly batchSize: number;
  readonly releaseIntervalSeconds: number;
  readonly pointsPerProblem: number;
  readonly attemptLimit: number;
  readonly minimumSolvedPerBatch: number;
  readonly aiAssist: "allowed" | "disabled";
  readonly leaderboard: ContestLeaderboardRule;
}

export interface PromptFiveByThreePreset {
  readonly preset: "prompt-five-by-three";
  readonly clock: ContestClock;
  readonly problems: readonly {
    readonly slug: string;
    readonly output: PromptProgramOutputProfile;
  }[];
  readonly compiler: PromptCompilerPin;
  readonly limits: PromptProgramLimits;
  readonly disclosure: "private" | "best-after-end";
  readonly leaderboard: ContestLeaderboardRule;
}

export type ContestRulesPreset = ClassicScorePreset | IcpcPreset | BlitzBatchesPreset | PromptFiveByThreePreset;

export interface ContestLogicalClockSnapshot {
  readonly generation: number;
  readonly state: "running" | "paused";
  readonly logicalSeconds: number;
  readonly capturedAt: string;
}

export interface ContestEntrantRuleState {
  readonly joined: boolean;
  readonly started: boolean;
  readonly eliminatedAtSeconds: number | null;
  readonly completed?: boolean;
}

export type ContestProblemAvailability = "locked" | "open" | "closed";
export type ContestRulePhase = "registration" | "upcoming" | "awaiting-start" | "running" | "paused" | "ended" | "eliminated";

export interface ContestProblemRuleProjection {
  readonly slug: string;
  readonly availability: ContestProblemAvailability;
  readonly releaseAfterSeconds: number;
  readonly submissionClosesAfterSeconds: number;
  readonly attemptsRemaining: number;
}

export interface ContestRuleProjection {
  readonly generation: number;
  readonly phase: ContestRulePhase;
  readonly logicalSeconds: number | null;
  readonly nextBoundarySeconds: number | null;
  readonly problems: readonly ContestProblemRuleProjection[];
}

export interface ContestRuleProjectionInput {
  readonly rules: ContestRules;
  readonly observedAt: string;
  readonly clock: ContestLogicalClockSnapshot | null;
  readonly entrant: ContestEntrantRuleState | null;
  readonly attemptedByProblem: Readonly<Record<string, number>>;
  /** Wall-time displacement accumulated while the operational timeline was paused. */
  readonly scheduleShiftSeconds?: number;
  readonly contestEnded?: boolean;
}

export type ContestAdmissionDecision =
  | { readonly allowed: true; readonly problem: ContestProblemRule }
  | { readonly allowed: false; readonly reason: "unknown-problem" | "not-joined" | "not-started" | "paused" | "eliminated" | "problem-locked" | "problem-closed" | "attempt-limit" };

export interface ContestResultFact {
  readonly entrantId: string;
  readonly problemSlug: string;
  readonly verdict: SubmissionVerdict;
  readonly score: number;
  readonly fullyPassedCases: number;
  readonly deterministicCost: number;
  readonly peakMemoryBytes: number;
  readonly logicalSeconds: number;
  readonly eligible: boolean;
}

export interface ContestStanding {
  readonly entrantId: string;
  readonly rank: number;
  readonly solved: number;
  readonly score: number;
  readonly penaltyMinutes: number;
  readonly furthestCheckpoint: number;
  readonly fullyPassedCases: number;
  readonly deterministicCost: number;
  readonly peakMemoryBytes: number;
  readonly achievedAtSeconds: number;
}

export interface ContestCheckpointCandidate {
  readonly entrantId: string;
  readonly pending: boolean;
  readonly solved: number;
  readonly score: number;
}

export interface ContestCheckpointDecision {
  readonly entrantId: string;
  readonly advances: boolean;
  readonly provisional: boolean;
}

const SHA256 = /^[0-9a-f]{64}$/;
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SOURCE_PATH = /^(?!\/)(?!.*(?:^|\/)\.{1,2}(?:\/|$))(?!.*\/\/)(?!.*\\)(?!.*\/$)[^\u0000-\u001f\u007f]+$/;
const MAX_DURATION_SECONDS = 366 * 24 * 60 * 60;
const MAX_RULE_INTEGER = 1_000_000_000;
const PENALIZED_ICPC_VERDICTS = new Set<SubmissionVerdict>([
  "wrong-answer",
  "runtime-error",
  "instruction-limit",
  "memory-limit",
  "output-limit",
  "filesystem-limit",
  "logical-time-limit",
  "wall-time-limit",
  "compile-error",
]);

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${label} must be an object.`);
  return value as Record<string, unknown>;
}

function exact(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new TypeError(`${label} has an invalid shape.`);
  }
}

function integer(value: unknown, label: string, minimum: number, maximum = MAX_RULE_INTEGER): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new TypeError(`${label} must be an integer between ${minimum} and ${maximum}.`);
  }
  return value as number;
}

function finiteNumber(value: unknown, label: string, minimum: number, maximum = MAX_RULE_INTEGER): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum || value > maximum) {
    throw new TypeError(`${label} must be a finite number between ${minimum} and ${maximum}.`);
  }
  return value;
}

function contestSlug(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length > 128 || !SLUG.test(value)) throw new TypeError(`${label} is invalid.`);
  return value;
}

function timestamp(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value) || Number.isNaN(Date.parse(value))) {
    throw new TypeError(`${label} must be an RFC 3339 UTC timestamp.`);
  }
  return value;
}

function parseClock(value: unknown, label: string): ContestClock {
  const input = record(value, label);
  if (input.kind === "global") {
    exact(input, ["durationSeconds", "kind", "registrationClosesAt", "registrationOpensAt", "startsAt"], label);
    const registrationOpensAt = timestamp(input.registrationOpensAt, `${label}.registrationOpensAt`);
    const registrationClosesAt = timestamp(input.registrationClosesAt, `${label}.registrationClosesAt`);
    const startsAt = timestamp(input.startsAt, `${label}.startsAt`);
    const durationSeconds = integer(input.durationSeconds, `${label}.durationSeconds`, 1, MAX_DURATION_SECONDS);
    const opensMs = Date.parse(registrationOpensAt);
    const closesMs = Date.parse(registrationClosesAt);
    const startsMs = Date.parse(startsAt);
    if (opensMs >= closesMs || opensMs > startsMs || closesMs > startsMs + durationSeconds * 1_000) {
      throw new TypeError(`${label} registration window must open no later than start and close before the contest ends.`);
    }
    return { kind: "global", registrationOpensAt, registrationClosesAt, startsAt, durationSeconds };
  }
  if (input.kind === "individual") {
    exact(input, ["durationSeconds", "enrollmentClosesAt", "enrollmentOpensAt", "kind"], label);
    const enrollmentOpensAt = timestamp(input.enrollmentOpensAt, `${label}.enrollmentOpensAt`);
    const enrollmentClosesAt = timestamp(input.enrollmentClosesAt, `${label}.enrollmentClosesAt`);
    if (Date.parse(enrollmentOpensAt) >= Date.parse(enrollmentClosesAt)) throw new TypeError(`${label} enrollment window is invalid.`);
    return {
      kind: "individual",
      enrollmentOpensAt,
      enrollmentClosesAt,
      durationSeconds: integer(input.durationSeconds, `${label}.durationSeconds`, 1, MAX_DURATION_SECONDS),
    };
  }
  throw new TypeError(`${label}.kind is invalid.`);
}

function parseCompilerPin(value: unknown, label: string): PromptCompilerPin {
  const input = record(value, label);
  exact(input, ["configDigest", "configId"], label);
  if (typeof input.configId !== "string" || !IDENTIFIER.test(input.configId)) throw new TypeError(`${label}.configId is invalid.`);
  if (typeof input.configDigest !== "string" || !SHA256.test(input.configDigest)) throw new TypeError(`${label}.configDigest must be a lowercase SHA-256 digest.`);
  return { configId: input.configId, configDigest: input.configDigest };
}

function parsePromptLimits(value: unknown, label: string): PromptProgramLimits {
  const input = record(value, label);
  exact(input, ["generatedSourceBytes", "inputTokens", "outputTokens", "promptBytes", "timeoutSeconds"], label);
  return {
    promptBytes: integer(input.promptBytes, `${label}.promptBytes`, 1, MAX_PROMPT_BYTES),
    inputTokens: integer(input.inputTokens, `${label}.inputTokens`, 1, 1_000_000),
    outputTokens: integer(input.outputTokens, `${label}.outputTokens`, 1, 1_000_000),
    generatedSourceBytes: integer(input.generatedSourceBytes, `${label}.generatedSourceBytes`, 1, SUBMISSION_SOURCE_LIMITS.totalBytes),
    timeoutSeconds: integer(input.timeoutSeconds, `${label}.timeoutSeconds`, 1, 3_600),
  };
}

function parseOfficialTrack(value: unknown, label: string): ContestOfficialTrack {
  const input = record(value, label);
  if (input.kind === "code") {
    exact(input, ["aiAssist", "kind"], label);
    if (input.aiAssist !== "allowed" && input.aiAssist !== "disabled") throw new TypeError(`${label}.aiAssist is invalid.`);
    return { kind: "code", aiAssist: input.aiAssist };
  }
  if (input.kind === "prompt-program") {
    exact(input, ["attemptPolicy", "compiler", "disclosure", "kind", "limits"], label);
    const attemptPolicy = record(input.attemptPolicy, `${label}.attemptPolicy`);
    exact(attemptPolicy, ["consumeOn", "terminalInfrastructureFailure"], `${label}.attemptPolicy`);
    if (attemptPolicy.consumeOn !== "model-response-received" || attemptPolicy.terminalInfrastructureFailure !== "release-reservation") {
      throw new TypeError(`${label}.attemptPolicy is unsupported.`);
    }
    if (input.disclosure !== "private" && input.disclosure !== "best-after-end") throw new TypeError(`${label}.disclosure is invalid.`);
    return {
      kind: "prompt-program",
      compiler: parseCompilerPin(input.compiler, `${label}.compiler`),
      limits: parsePromptLimits(input.limits, `${label}.limits`),
      attemptPolicy: { consumeOn: "model-response-received", terminalInfrastructureFailure: "release-reservation" },
      disclosure: input.disclosure,
    };
  }
  throw new TypeError(`${label}.kind is invalid.`);
}

function parseOutputProfile(value: unknown, label: string): PromptProgramOutputProfile {
  const input = record(value, label);
  exact(input, ["entry", "language", "optimization", "target"], label);
  if (typeof input.language !== "string" || !isBuiltinLanguage(input.language)) throw new TypeError(`${label}.language is unsupported.`);
  if (input.target !== "wasip1" && input.target !== "wasix") throw new TypeError(`${label}.target is unsupported.`);
  if (input.optimization !== "debug" && input.optimization !== "release") throw new TypeError(`${label}.optimization is unsupported.`);
  if (typeof input.entry !== "string" || input.entry.length > 512 || !SOURCE_PATH.test(input.entry)) throw new TypeError(`${label}.entry is invalid.`);
  return { language: input.language, target: input.target, optimization: input.optimization, entry: input.entry };
}

function parseProblems(value: unknown, track: ContestOfficialTrack, durationSeconds: number, label: string): ContestProblemRule[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_CONTEST_PROBLEMS) {
    throw new TypeError(`${label} must contain between 1 and ${MAX_CONTEST_PROBLEMS} problems.`);
  }
  const slugs = new Set<string>();
  const batchCounts = new Map<number, number>();
  const batchReleases = new Map<number, number>();
  return value.map((candidate, index): ContestProblemRule => {
    const problemLabel = `${label}[${index}]`;
    const input = record(candidate, problemLabel);
    exact(input, track.kind === "code"
      ? ["attemptLimit", "batch", "points", "releaseAfterSeconds", "slug", "submissionClosesAfterSeconds"]
      : ["attemptLimit", "batch", "output", "points", "releaseAfterSeconds", "slug", "submissionClosesAfterSeconds"], problemLabel);
    const slug = contestSlug(input.slug, `${problemLabel}.slug`);
    if (slugs.has(slug)) throw new TypeError(`${label} contains duplicate problem '${slug}'.`);
    slugs.add(slug);
    const batch = integer(input.batch, `${problemLabel}.batch`, 1, MAX_CONTEST_PROBLEMS);
    const releaseAfterSeconds = integer(input.releaseAfterSeconds, `${problemLabel}.releaseAfterSeconds`, 0, durationSeconds);
    const submissionClosesAfterSeconds = integer(input.submissionClosesAfterSeconds, `${problemLabel}.submissionClosesAfterSeconds`, 0, durationSeconds);
    if (submissionClosesAfterSeconds <= releaseAfterSeconds) throw new TypeError(`${problemLabel} submission window is empty.`);
    const batchCount = (batchCounts.get(batch) ?? 0) + 1;
    if (batchCount > MAX_CONTEST_RELEASE_BATCH_SIZE) throw new TypeError(`${label} batch ${batch} exceeds ${MAX_CONTEST_RELEASE_BATCH_SIZE} problems.`);
    batchCounts.set(batch, batchCount);
    const existingRelease = batchReleases.get(batch);
    if (existingRelease !== undefined && existingRelease !== releaseAfterSeconds) throw new TypeError(`${label} batch ${batch} has inconsistent release offsets.`);
    batchReleases.set(batch, releaseAfterSeconds);
    const base = {
      slug,
      batch,
      releaseAfterSeconds,
      submissionClosesAfterSeconds,
      points: finiteNumber(input.points, `${problemLabel}.points`, Number.EPSILON),
      attemptLimit: integer(input.attemptLimit, `${problemLabel}.attemptLimit`, 1, 1_000_000),
    };
    if (track.kind === "code") {
      return base;
    }
    return { ...base, output: parseOutputProfile(input.output, `${problemLabel}.output`) };
  });
}

function uniqueEnum<T extends string>(value: unknown, allowed: ReadonlySet<T>, label: string): T[] {
  if (!Array.isArray(value)) throw new TypeError(`${label} must be an array.`);
  const result = value.map((candidate, index) => {
    if (typeof candidate !== "string" || !allowed.has(candidate as T)) throw new TypeError(`${label}[${index}] is invalid.`);
    return candidate as T;
  });
  if (new Set(result).size !== result.length) throw new TypeError(`${label} contains a duplicate.`);
  return result;
}

const SCORE_TIE_BREAKS = new Set<ScoreTieBreak>(["fully-passed-cases", "deterministic-cost", "peak-memory", "final-best-achieved-at"]);
const ICPC_TIE_BREAKS = new Set<IcpcTieBreak>(["last-solve-at", "deterministic-cost", "peak-memory"]);
const PROGRESS_TIE_BREAKS = new Set<ProgressTieBreak>(["fully-passed-cases", "deterministic-cost", "peak-memory", "final-best-achieved-at"]);

function parseScoring(value: unknown, label: string): ContestScoring {
  const input = record(value, label);
  if (input.kind === "score") {
    exact(input, ["kind", "tieBreaks"], label);
    return { kind: "score", tieBreaks: uniqueEnum(input.tieBreaks, SCORE_TIE_BREAKS, `${label}.tieBreaks`) };
  }
  if (input.kind === "icpc") {
    exact(input, ["kind", "penalizedVerdicts", "tieBreaks", "wrongAttemptPenaltyMinutes"], label);
    const penalizedVerdicts = uniqueEnum(input.penalizedVerdicts, new Set(SUBMISSION_VERDICTS), `${label}.penalizedVerdicts`);
    if (penalizedVerdicts.some((verdict) => !PENALIZED_ICPC_VERDICTS.has(verdict))) {
      throw new TypeError(`${label}.penalizedVerdicts may contain only contestant-fault verdicts.`);
    }
    return {
      kind: "icpc",
      wrongAttemptPenaltyMinutes: integer(input.wrongAttemptPenaltyMinutes, `${label}.wrongAttemptPenaltyMinutes`, 0, 10_080),
      penalizedVerdicts,
      tieBreaks: uniqueEnum(input.tieBreaks, ICPC_TIE_BREAKS, `${label}.tieBreaks`),
    };
  }
  if (input.kind === "progress") {
    exact(input, ["kind", "tieBreaks"], label);
    return { kind: "progress", tieBreaks: uniqueEnum(input.tieBreaks, PROGRESS_TIE_BREAKS, `${label}.tieBreaks`) };
  }
  throw new TypeError(`${label}.kind is invalid.`);
}

function parseLeaderboard(value: unknown, clock: ContestClock, label: string): ContestLeaderboardRule {
  const input = record(value, label);
  if (input.kind === "live" || input.kind === "hidden-until-end") {
    exact(input, ["kind"], label);
    return { kind: input.kind };
  }
  if (input.kind === "freeze") {
    exact(input, ["atSeconds", "kind"], label);
    if (clock.kind !== "global") throw new TypeError(`${label} freeze is only valid for a global clock.`);
    const atSeconds = integer(input.atSeconds, `${label}.atSeconds`, 1, clock.durationSeconds - 1);
    return { kind: "freeze", atSeconds };
  }
  throw new TypeError(`${label}.kind is invalid.`);
}

function scopedProblems(scope: ContestCheckpointScope, atSeconds: number, problems: readonly ContestProblemRule[]): readonly ContestProblemRule[] {
  if (scope.kind === "all-released") return problems.filter((problem) => problem.releaseAfterSeconds <= atSeconds);
  if (scope.kind === "batch") return problems.filter((problem) => problem.batch === scope.batch);
  const requested = new Set(scope.slugs);
  return problems.filter((problem) => requested.has(problem.slug));
}

function parseCheckpoint(value: unknown, label: string): ContestCheckpointRule {
  const input = record(value, label);
  exact(input, ["atSeconds", "id", "ranking", "scope", "settlement", "threshold"], label);
  const scopeInput = record(input.scope, `${label}.scope`);
  let scope: ContestCheckpointScope;
  if (scopeInput.kind === "all-released") {
    exact(scopeInput, ["kind"], `${label}.scope`);
    scope = { kind: "all-released" };
  } else if (scopeInput.kind === "batch") {
    exact(scopeInput, ["batch", "kind"], `${label}.scope`);
    scope = { kind: "batch", batch: integer(scopeInput.batch, `${label}.scope.batch`, 1, MAX_CONTEST_PROBLEMS) };
  } else if (scopeInput.kind === "problems") {
    exact(scopeInput, ["kind", "slugs"], `${label}.scope`);
    if (!Array.isArray(scopeInput.slugs) || scopeInput.slugs.length < 1 || scopeInput.slugs.length > MAX_CONTEST_PROBLEMS) throw new TypeError(`${label}.scope.slugs is invalid.`);
    const slugs = scopeInput.slugs.map((slug, index) => contestSlug(slug, `${label}.scope.slugs[${index}]`));
    if (new Set(slugs).size !== slugs.length) throw new TypeError(`${label}.scope.slugs contains a duplicate.`);
    scope = { kind: "problems", slugs };
  } else throw new TypeError(`${label}.scope.kind is invalid.`);

  const thresholdInput = record(input.threshold, `${label}.threshold`);
  exact(thresholdInput, ["minimumScore", "minimumSolved"], `${label}.threshold`);
  const minimumSolved = thresholdInput.minimumSolved === null ? null : integer(thresholdInput.minimumSolved, `${label}.threshold.minimumSolved`, 0, MAX_CONTEST_PROBLEMS);
  const minimumScore = thresholdInput.minimumScore === null ? null : finiteNumber(thresholdInput.minimumScore, `${label}.threshold.minimumScore`, 0);
  if (minimumSolved === null && minimumScore === null) throw new TypeError(`${label}.threshold must declare at least one minimum.`);

  let ranking: ContestCheckpointRanking;
  if (input.ranking === null) ranking = null;
  else {
    const rankInput = record(input.ranking, `${label}.ranking`);
    if (rankInput.kind === "top-k") {
      exact(rankInput, ["count", "kind"], `${label}.ranking`);
      ranking = { kind: "top-k", count: integer(rankInput.count, `${label}.ranking.count`, 1, MAX_RULE_INTEGER) };
    } else if (rankInput.kind === "top-percent") {
      exact(rankInput, ["kind", "percent"], `${label}.ranking`);
      ranking = { kind: "top-percent", percent: finiteNumber(rankInput.percent, `${label}.ranking.percent`, Number.EPSILON, 100) };
    } else throw new TypeError(`${label}.ranking.kind is invalid.`);
  }
  if (input.settlement !== "provisional" && input.settlement !== "pause-until-terminal") throw new TypeError(`${label}.settlement is invalid.`);
  return {
    id: contestSlug(input.id, `${label}.id`),
    atSeconds: integer(input.atSeconds, `${label}.atSeconds`, 0, MAX_DURATION_SECONDS),
    scope,
    threshold: { minimumSolved, minimumScore },
    ranking,
    settlement: input.settlement,
  };
}

function parsePresetProblemSlugs(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_CONTEST_PROBLEMS) {
    throw new TypeError(`${label} must contain between 1 and ${MAX_CONTEST_PROBLEMS} problem slugs.`);
  }
  const slugs = value.map((candidate, index) => contestSlug(candidate, `${label}[${index}]`));
  if (new Set(slugs).size !== slugs.length) throw new TypeError(`${label} contains a duplicate.`);
  return slugs;
}

function parseAiAssist(value: unknown, label: string): "allowed" | "disabled" {
  if (value !== "allowed" && value !== "disabled") throw new TypeError(`${label} is invalid.`);
  return value;
}

function parsePresetLeaderboard(value: unknown, clockValue: unknown, label: string): ContestLeaderboardRule {
  return parseLeaderboard(value, parseClock(clockValue, `${label} clock`), label);
}

export function parseContestRules(value: unknown, label = "contest rules"): ContestRules {
  const input = record(value, label);
  exact(input, ["checkpoints", "clock", "evidenceAt", "leaderboard", "officialTrack", "problems", "scoring"], label);
  const clock = parseClock(input.clock, `${label}.clock`);
  const officialTrack = parseOfficialTrack(input.officialTrack, `${label}.officialTrack`);
  if (input.evidenceAt !== "input-admitted" && input.evidenceAt !== "generated-source-ready" && input.evidenceAt !== "judge-terminal") {
    throw new TypeError(`${label}.evidenceAt is invalid.`);
  }
  if (input.evidenceAt === "generated-source-ready" && officialTrack.kind !== "prompt-program") {
    throw new TypeError(`${label}.evidenceAt generated-source-ready requires the prompt-program track.`);
  }
  const evidenceAt: ContestEvidenceAt = input.evidenceAt;
  const problems = parseProblems(input.problems, officialTrack, clock.durationSeconds, `${label}.problems`);
  const scoring = parseScoring(input.scoring, `${label}.scoring`);
  if (!Array.isArray(input.checkpoints) || input.checkpoints.length > 100) throw new TypeError(`${label}.checkpoints is invalid.`);
  const checkpoints = input.checkpoints.map((checkpoint, index) => parseCheckpoint(checkpoint, `${label}.checkpoints[${index}]`));
  if (scoring.kind === "progress" && checkpoints.length < 1) throw new TypeError(`${label}.scoring progress requires at least one checkpoint.`);
  const checkpointIds = new Set<string>();
  let priorCheckpointAt = -1;
  for (const checkpoint of checkpoints) {
    if (checkpointIds.has(checkpoint.id)) throw new TypeError(`${label}.checkpoints contains duplicate id '${checkpoint.id}'.`);
    checkpointIds.add(checkpoint.id);
    if (checkpoint.atSeconds <= priorCheckpointAt || checkpoint.atSeconds > clock.durationSeconds) {
      throw new TypeError(`${label}.checkpoints must have strictly increasing offsets within the contest duration.`);
    }
    priorCheckpointAt = checkpoint.atSeconds;
    if (clock.kind === "individual" && (checkpoint.ranking !== null || checkpoint.settlement !== "provisional")) {
      throw new TypeError(`${label}.checkpoints for an individual clock must be provisional and cannot rank entrants.`);
    }
    const scoped = scopedProblems(checkpoint.scope, checkpoint.atSeconds, problems);
    if (scoped.length < 1 || scoped.some((problem) => problem.releaseAfterSeconds > checkpoint.atSeconds)) {
      throw new TypeError(`${label}.checkpoint '${checkpoint.id}' scope must contain released problems.`);
    }
    if (checkpoint.scope.kind === "problems" && scoped.length !== checkpoint.scope.slugs.length) {
      throw new TypeError(`${label}.checkpoint '${checkpoint.id}' references an unknown problem.`);
    }
    if (checkpoint.threshold.minimumSolved !== null && checkpoint.threshold.minimumSolved > scoped.length) {
      throw new TypeError(`${label}.checkpoint '${checkpoint.id}' minimumSolved exceeds its scope.`);
    }
    const maximumScore = scoped.reduce((total, problem) => total + problem.points, 0);
    if (checkpoint.threshold.minimumScore !== null && checkpoint.threshold.minimumScore > maximumScore) {
      throw new TypeError(`${label}.checkpoint '${checkpoint.id}' minimumScore exceeds its scope.`);
    }
  }
  const leaderboard = parseLeaderboard(input.leaderboard, clock, `${label}.leaderboard`);
  const base = { clock, evidenceAt, scoring, checkpoints, leaderboard };
  return officialTrack.kind === "code"
    ? { ...base, officialTrack, problems: problems as CodeContestProblemRule[] }
    : { ...base, officialTrack, problems: problems as PromptProgramContestProblemRule[] };
}

export function parseContestRulesPreset(value: unknown, label = "contest rules preset"): ContestRulesPreset {
  const input = record(value, label);
  const preset = input.preset;
  if (preset === "classic-score") {
    exact(input, ["aiAssist", "attemptLimit", "clock", "leaderboard", "pointsPerProblem", "preset", "problemSlugs"], label);
    return {
      preset,
      clock: parseClock(input.clock, `${label}.clock`),
      problemSlugs: parsePresetProblemSlugs(input.problemSlugs, `${label}.problemSlugs`),
      pointsPerProblem: finiteNumber(input.pointsPerProblem, `${label}.pointsPerProblem`, Number.EPSILON),
      attemptLimit: integer(input.attemptLimit, `${label}.attemptLimit`, 1, 1_000_000),
      aiAssist: parseAiAssist(input.aiAssist, `${label}.aiAssist`),
      leaderboard: parsePresetLeaderboard(input.leaderboard, input.clock, `${label}.leaderboard`),
    };
  }
  if (preset === "icpc") {
    exact(input, ["aiAssist", "attemptLimit", "clock", "leaderboard", "penalizedVerdicts", "preset", "problemSlugs", "wrongAttemptPenaltyMinutes"], label);
    const penalizedVerdicts = uniqueEnum(input.penalizedVerdicts, new Set(SUBMISSION_VERDICTS), `${label}.penalizedVerdicts`);
    if (penalizedVerdicts.some((verdict) => !PENALIZED_ICPC_VERDICTS.has(verdict))) throw new TypeError(`${label}.penalizedVerdicts is invalid.`);
    return {
      preset,
      clock: parseClock(input.clock, `${label}.clock`),
      problemSlugs: parsePresetProblemSlugs(input.problemSlugs, `${label}.problemSlugs`),
      attemptLimit: integer(input.attemptLimit, `${label}.attemptLimit`, 1, 1_000_000),
      aiAssist: parseAiAssist(input.aiAssist, `${label}.aiAssist`),
      wrongAttemptPenaltyMinutes: integer(input.wrongAttemptPenaltyMinutes, `${label}.wrongAttemptPenaltyMinutes`, 0, 10_080),
      penalizedVerdicts,
      leaderboard: parsePresetLeaderboard(input.leaderboard, input.clock, `${label}.leaderboard`),
    };
  }
  if (preset === "blitz-batches") {
    exact(input, ["aiAssist", "attemptLimit", "batchSize", "clock", "leaderboard", "minimumSolvedPerBatch", "pointsPerProblem", "preset", "problemSlugs", "releaseIntervalSeconds"], label);
    const problemSlugs = parsePresetProblemSlugs(input.problemSlugs, `${label}.problemSlugs`);
    const batchSize = integer(input.batchSize, `${label}.batchSize`, 1, MAX_CONTEST_RELEASE_BATCH_SIZE);
    return {
      preset,
      clock: parseClock(input.clock, `${label}.clock`),
      problemSlugs,
      batchSize,
      releaseIntervalSeconds: integer(input.releaseIntervalSeconds, `${label}.releaseIntervalSeconds`, 1, MAX_DURATION_SECONDS),
      pointsPerProblem: finiteNumber(input.pointsPerProblem, `${label}.pointsPerProblem`, Number.EPSILON),
      attemptLimit: integer(input.attemptLimit, `${label}.attemptLimit`, 1, 1_000_000),
      minimumSolvedPerBatch: integer(input.minimumSolvedPerBatch, `${label}.minimumSolvedPerBatch`, 0, Math.min(batchSize, problemSlugs.length)),
      aiAssist: parseAiAssist(input.aiAssist, `${label}.aiAssist`),
      leaderboard: parsePresetLeaderboard(input.leaderboard, input.clock, `${label}.leaderboard`),
    };
  }
  if (preset === "prompt-five-by-three") {
    exact(input, ["clock", "compiler", "disclosure", "leaderboard", "limits", "preset", "problems"], label);
    if (!Array.isArray(input.problems) || input.problems.length !== 5) throw new TypeError(`${label}.problems must contain exactly five problems.`);
    const problems = input.problems.map((candidate, index) => {
      const problem = record(candidate, `${label}.problems[${index}]`);
      exact(problem, ["output", "slug"], `${label}.problems[${index}]`);
      return { slug: contestSlug(problem.slug, `${label}.problems[${index}].slug`), output: parseOutputProfile(problem.output, `${label}.problems[${index}].output`) };
    });
    if (new Set(problems.map((problem) => problem.slug)).size !== problems.length) throw new TypeError(`${label}.problems contains a duplicate.`);
    if (input.disclosure !== "private" && input.disclosure !== "best-after-end") throw new TypeError(`${label}.disclosure is invalid.`);
    return {
      preset,
      clock: parseClock(input.clock, `${label}.clock`),
      problems,
      compiler: parseCompilerPin(input.compiler, `${label}.compiler`),
      limits: parsePromptLimits(input.limits, `${label}.limits`),
      disclosure: input.disclosure,
      leaderboard: parsePresetLeaderboard(input.leaderboard, input.clock, `${label}.leaderboard`),
    };
  }
  throw new TypeError(`${label}.preset is invalid.`);
}

export function expandContestRulesPreset(preset: ContestRulesPreset): ContestRules {
  const close = preset.clock.durationSeconds;
  if (preset.preset === "classic-score") {
    return parseContestRules({
      clock: preset.clock,
      officialTrack: { kind: "code", aiAssist: preset.aiAssist },
      evidenceAt: "input-admitted",
      problems: preset.problemSlugs.map((slug) => ({ slug, batch: 1, releaseAfterSeconds: 0, submissionClosesAfterSeconds: close, points: preset.pointsPerProblem, attemptLimit: preset.attemptLimit })),
      scoring: { kind: "score", tieBreaks: ["fully-passed-cases", "deterministic-cost", "peak-memory", "final-best-achieved-at"] },
      checkpoints: [],
      leaderboard: preset.leaderboard,
    });
  }
  if (preset.preset === "icpc") {
    return parseContestRules({
      clock: preset.clock,
      officialTrack: { kind: "code", aiAssist: preset.aiAssist },
      evidenceAt: "judge-terminal",
      problems: preset.problemSlugs.map((slug) => ({ slug, batch: 1, releaseAfterSeconds: 0, submissionClosesAfterSeconds: close, points: 100, attemptLimit: preset.attemptLimit })),
      scoring: { kind: "icpc", wrongAttemptPenaltyMinutes: preset.wrongAttemptPenaltyMinutes, penalizedVerdicts: preset.penalizedVerdicts, tieBreaks: [] },
      checkpoints: [],
      leaderboard: preset.leaderboard,
    });
  }
  if (preset.preset === "blitz-batches") {
    const batchCount = Math.ceil(preset.problemSlugs.length / preset.batchSize);
    const checkpoints = Array.from({ length: Math.max(0, batchCount - 1) }, (_, index) => ({
      id: `batch-${index + 1}`,
      atSeconds: (index + 1) * preset.releaseIntervalSeconds,
      scope: { kind: "batch" as const, batch: index + 1 },
      threshold: { minimumSolved: preset.minimumSolvedPerBatch, minimumScore: null },
      ranking: null,
      settlement: "provisional" as const,
    }));
    return parseContestRules({
      clock: preset.clock,
      officialTrack: { kind: "code", aiAssist: preset.aiAssist },
      evidenceAt: "judge-terminal",
      problems: preset.problemSlugs.map((slug, index) => ({
        slug,
        batch: Math.floor(index / preset.batchSize) + 1,
        releaseAfterSeconds: Math.floor(index / preset.batchSize) * preset.releaseIntervalSeconds,
        submissionClosesAfterSeconds: close,
        points: preset.pointsPerProblem,
        attemptLimit: preset.attemptLimit,
      })),
      scoring: { kind: "progress", tieBreaks: ["fully-passed-cases", "deterministic-cost", "final-best-achieved-at"] },
      checkpoints,
      leaderboard: preset.leaderboard,
    });
  }
  return parseContestRules({
    clock: preset.clock,
    officialTrack: {
      kind: "prompt-program",
      compiler: preset.compiler,
      limits: preset.limits,
      attemptPolicy: { consumeOn: "model-response-received", terminalInfrastructureFailure: "release-reservation" },
      disclosure: preset.disclosure,
    },
    evidenceAt: "generated-source-ready",
    problems: preset.problems.map((problem) => ({ ...problem, batch: 1, releaseAfterSeconds: 0, submissionClosesAfterSeconds: close, points: 100, attemptLimit: 3 })),
    scoring: { kind: "score", tieBreaks: ["deterministic-cost", "final-best-achieved-at"] },
    checkpoints: [],
    leaderboard: preset.leaderboard,
  });
}

export function logicalContestSeconds(snapshot: ContestLogicalClockSnapshot, now: string, durationSeconds: number): number {
  integer(snapshot.generation, "contest clock generation", 1);
  const duration = integer(durationSeconds, "contest durationSeconds", 1, MAX_DURATION_SECONDS);
  const capturedAt = timestamp(snapshot.capturedAt, "contest clock capturedAt");
  const nowTimestamp = timestamp(now, "contest clock now");
  if (snapshot.state !== "running" && snapshot.state !== "paused") throw new TypeError("contest clock state is invalid.");
  if (typeof snapshot.logicalSeconds !== "number" || !Number.isFinite(snapshot.logicalSeconds)) throw new TypeError("contest clock logicalSeconds is invalid.");
  const projected = snapshot.state === "paused"
    ? snapshot.logicalSeconds
    : snapshot.logicalSeconds + (Date.parse(nowTimestamp) - Date.parse(capturedAt)) / 1_000;
  return Math.min(duration, Math.max(0, projected));
}

export function projectContestRules(input: ContestRuleProjectionInput): ContestRuleProjection {
  const { rules, clock, entrant } = input;
  const observedAt = timestamp(input.observedAt, "contest projection observedAt");
  const scheduleShiftSeconds = integer(input.scheduleShiftSeconds ?? 0, "contest projection scheduleShiftSeconds", 0);
  const observedMs = Date.parse(observedAt) - scheduleShiftSeconds * 1_000;
  if (clock !== null && (!Number.isSafeInteger(clock.generation) || clock.generation < 1)) throw new TypeError("contest clock generation is invalid.");
  let phase: ContestRulePhase;
  let logicalSeconds: number | null = clock === null ? null : logicalContestSeconds(clock, observedAt, rules.clock.durationSeconds);
  if (input.contestEnded === true || entrant?.completed === true) phase = "ended";
  else if (entrant === null || !entrant.joined) {
    const opensAt = rules.clock.kind === "global" ? rules.clock.registrationOpensAt : rules.clock.enrollmentOpensAt;
    const closesAt = rules.clock.kind === "global" ? rules.clock.registrationClosesAt : rules.clock.enrollmentClosesAt;
    if (observedMs >= Date.parse(opensAt) && observedMs < Date.parse(closesAt)) phase = "registration";
    else if (rules.clock.kind === "global" && observedMs >= Date.parse(rules.clock.startsAt) + rules.clock.durationSeconds * 1_000) phase = "ended";
    else phase = "upcoming";
  }
  else if (entrant.eliminatedAtSeconds !== null) {
    phase = "eliminated";
    logicalSeconds ??= entrant.eliminatedAtSeconds;
  } else if (clock?.state === "paused") phase = "paused";
  else if (rules.clock.kind === "individual" && !entrant.started) phase = "awaiting-start";
  else if (clock === null) phase = "upcoming";
  else if (logicalSeconds !== null && logicalSeconds >= rules.clock.durationSeconds) phase = "ended";
  else phase = "running";

  const attempted = (slug: string): number => {
    const count = input.attemptedByProblem[slug] ?? 0;
    if (!Number.isSafeInteger(count) || count < 0) throw new TypeError(`attempt count for '${slug}' is invalid.`);
    return count;
  };
  const problems = rules.problems.map((problem): ContestProblemRuleProjection => {
    let availability: ContestProblemAvailability;
    if (entrant === null || !entrant.joined || logicalSeconds === null || logicalSeconds < problem.releaseAfterSeconds) availability = "locked";
    else if (phase === "eliminated" || logicalSeconds >= problem.submissionClosesAfterSeconds || phase === "ended") availability = "closed";
    else availability = "open";
    return {
      slug: problem.slug,
      availability,
      releaseAfterSeconds: problem.releaseAfterSeconds,
      submissionClosesAfterSeconds: problem.submissionClosesAfterSeconds,
      attemptsRemaining: Math.max(0, problem.attemptLimit - attempted(problem.slug)),
    };
  });
  let nextBoundarySeconds: number | null = null;
  if (logicalSeconds !== null && phase !== "ended" && phase !== "eliminated") {
    const candidates = [
      rules.clock.durationSeconds,
      ...rules.problems.flatMap((problem) => [problem.releaseAfterSeconds, problem.submissionClosesAfterSeconds]),
      ...rules.checkpoints.map((checkpoint) => checkpoint.atSeconds),
      ...(rules.leaderboard.kind === "freeze" ? [rules.leaderboard.atSeconds] : []),
    ].filter((boundary) => boundary > logicalSeconds);
    nextBoundarySeconds = candidates.length === 0 ? null : Math.min(...candidates);
  }
  return { generation: clock?.generation ?? 0, phase, logicalSeconds, nextBoundarySeconds, problems };
}

export function decideContestAdmission(input: ContestRuleProjectionInput, problemSlug: string): ContestAdmissionDecision {
  const problem = input.rules.problems.find((candidate) => candidate.slug === problemSlug);
  if (!problem) return { allowed: false, reason: "unknown-problem" };
  if (input.entrant === null || !input.entrant.joined) return { allowed: false, reason: "not-joined" };
  if (input.rules.clock.kind === "individual" && !input.entrant.started) return { allowed: false, reason: "not-started" };
  if (input.clock?.state === "paused") return { allowed: false, reason: "paused" };
  if (input.entrant.eliminatedAtSeconds !== null) return { allowed: false, reason: "eliminated" };
  const projection = projectContestRules(input);
  const projectedProblem = projection.problems.find((candidate) => candidate.slug === problemSlug)!;
  if (projectedProblem.availability === "locked") return { allowed: false, reason: "problem-locked" };
  if (projectedProblem.availability === "closed") return { allowed: false, reason: "problem-closed" };
  if (projectedProblem.attemptsRemaining < 1) return { allowed: false, reason: "attempt-limit" };
  return { allowed: true, problem };
}

function compareNumber(left: number, right: number, direction: "asc" | "desc"): number {
  return direction === "asc" ? left - right : right - left;
}

function compareFactMetric(left: ContestResultFact, right: ContestResultFact, tieBreak: ScoreTieBreak | ProgressTieBreak): number {
  switch (tieBreak) {
    case "fully-passed-cases": return compareNumber(left.fullyPassedCases, right.fullyPassedCases, "desc");
    case "deterministic-cost": return compareNumber(left.deterministicCost, right.deterministicCost, "asc");
    case "peak-memory": return compareNumber(left.peakMemoryBytes, right.peakMemoryBytes, "asc");
    case "final-best-achieved-at": return compareNumber(left.logicalSeconds, right.logicalSeconds, "asc");
  }
}

function bestScoreFact(facts: readonly ContestResultFact[], tieBreaks: readonly (ScoreTieBreak | ProgressTieBreak)[]): ContestResultFact | null {
  let selected: ContestResultFact | null = null;
  for (const fact of facts) {
    if (!fact.eligible) continue;
    if (selected === null) { selected = fact; continue; }
    let comparison = compareNumber(fact.score, selected.score, "desc");
    for (const tieBreak of tieBreaks) {
      if (comparison !== 0) break;
      comparison = compareFactMetric(fact, selected, tieBreak);
    }
    if (comparison < 0 || (comparison === 0 && fact.logicalSeconds < selected.logicalSeconds)) selected = fact;
  }
  return selected;
}

function validateResultFacts(rules: ContestRules, entrantIds: readonly string[], results: readonly ContestResultFact[]): void {
  if (new Set(entrantIds).size !== entrantIds.length || entrantIds.some((entrantId) => !entrantId)) throw new TypeError("entrantIds must be unique non-empty strings.");
  const entrants = new Set(entrantIds);
  const problems = new Set(rules.problems.map((problem) => problem.slug));
  for (const result of results) {
    if (!entrants.has(result.entrantId)) throw new TypeError(`result references unknown entrant '${result.entrantId}'.`);
    if (!problems.has(result.problemSlug)) throw new TypeError(`result references unknown problem '${result.problemSlug}'.`);
    if (!SUBMISSION_VERDICTS.includes(result.verdict)) throw new TypeError("result verdict is invalid.");
    finiteNumber(result.score, "result score", 0, 100);
    integer(result.fullyPassedCases, "result fullyPassedCases", 0);
    integer(result.deterministicCost, "result deterministicCost", 0);
    integer(result.peakMemoryBytes, "result peakMemoryBytes", 0);
    finiteNumber(result.logicalSeconds, "result logicalSeconds", 0, rules.clock.durationSeconds);
    if (typeof result.eligible !== "boolean") throw new TypeError("result eligible must be boolean.");
  }
}

function standingMetric(standing: ContestStanding, tieBreak: ScoreTieBreak | ProgressTieBreak | IcpcTieBreak): number {
  switch (tieBreak) {
    case "fully-passed-cases": return standing.fullyPassedCases;
    case "deterministic-cost": return standing.deterministicCost;
    case "peak-memory": return standing.peakMemoryBytes;
    case "final-best-achieved-at":
    case "last-solve-at": return standing.achievedAtSeconds;
  }
}

function compareStandingMetric(left: ContestStanding, right: ContestStanding, tieBreak: ScoreTieBreak | ProgressTieBreak | IcpcTieBreak): number {
  const direction = tieBreak === "fully-passed-cases" ? "desc" : "asc";
  return compareNumber(standingMetric(left, tieBreak), standingMetric(right, tieBreak), direction);
}

function compareCompetitiveStandings(scoring: ContestScoring, left: ContestStanding, right: ContestStanding): number {
  if (scoring.kind === "icpc") {
    let comparison = compareNumber(left.solved, right.solved, "desc") || compareNumber(left.penaltyMinutes, right.penaltyMinutes, "asc");
    for (const tieBreak of scoring.tieBreaks) {
      if (comparison !== 0) break;
      comparison = compareStandingMetric(left, right, tieBreak);
    }
    return comparison;
  }
  let comparison = scoring.kind === "progress"
    ? compareNumber(left.furthestCheckpoint, right.furthestCheckpoint, "desc")
      || compareNumber(left.solved, right.solved, "desc")
      || compareNumber(left.score, right.score, "desc")
    : compareNumber(left.score, right.score, "desc");
  for (const tieBreak of scoring.tieBreaks) {
    if (comparison !== 0) break;
    comparison = compareStandingMetric(left, right, tieBreak);
  }
  return comparison;
}

export function rankContestResults(
  rules: ContestRules,
  entrantIds: readonly string[],
  results: readonly ContestResultFact[],
  passedCheckpointCounts?: Readonly<Record<string, number>>,
): readonly ContestStanding[] {
  validateResultFacts(rules, entrantIds, results);
  const factsByEntrant = new Map<string, ContestResultFact[]>();
  for (const entrantId of entrantIds) factsByEntrant.set(entrantId, []);
  for (const result of results) factsByEntrant.get(result.entrantId)!.push(result);
  const unranked = entrantIds.map((entrantId): ContestStanding => {
    const entrantFacts = factsByEntrant.get(entrantId)!;
    let solved = 0;
    let score = 0;
    let penaltyMinutes = 0;
    let fullyPassedCases = 0;
    let deterministicCost = 0;
    let peakMemoryBytes = 0;
    let achievedAtSeconds = 0;
    if (rules.scoring.kind === "icpc") {
      const penalized = new Set(rules.scoring.penalizedVerdicts);
      for (const problem of rules.problems) {
        const chronological = entrantFacts
          .filter((fact) => fact.problemSlug === problem.slug && fact.eligible)
          .sort((left, right) => left.logicalSeconds - right.logicalSeconds);
        let wrongAttempts = 0;
        for (const fact of chronological) {
          if (fact.score === 100) {
            solved += 1;
            score += problem.points;
            penaltyMinutes += Math.floor(fact.logicalSeconds / 60) + wrongAttempts * rules.scoring.wrongAttemptPenaltyMinutes;
            fullyPassedCases += fact.fullyPassedCases;
            deterministicCost += fact.deterministicCost;
            peakMemoryBytes = Math.max(peakMemoryBytes, fact.peakMemoryBytes);
            achievedAtSeconds = Math.max(achievedAtSeconds, fact.logicalSeconds);
            break;
          }
          if (penalized.has(fact.verdict)) wrongAttempts += 1;
        }
      }
    } else {
      const tieBreaks = rules.scoring.tieBreaks;
      for (const problem of rules.problems) {
        const selected = bestScoreFact(entrantFacts.filter((fact) => fact.problemSlug === problem.slug), tieBreaks);
        if (!selected) continue;
        score += problem.points * selected.score / 100;
        if (selected.score === 100) solved += 1;
        fullyPassedCases += selected.fullyPassedCases;
        deterministicCost += selected.deterministicCost;
        peakMemoryBytes = Math.max(peakMemoryBytes, selected.peakMemoryBytes);
        achievedAtSeconds = Math.max(achievedAtSeconds, selected.logicalSeconds);
      }
    }
    const furthestCheckpoint = passedCheckpointCounts?.[entrantId] ?? 0;
    integer(furthestCheckpoint, `passed checkpoint count for '${entrantId}'`, 0, rules.checkpoints.length);
    return {
      entrantId,
      rank: 0,
      solved,
      score,
      penaltyMinutes,
      furthestCheckpoint,
      fullyPassedCases,
      deterministicCost,
      peakMemoryBytes,
      achievedAtSeconds,
    };
  });
  unranked.sort((left, right) => compareCompetitiveStandings(rules.scoring, left, right) || left.entrantId.localeCompare(right.entrantId));
  let rank = 1;
  return unranked.map((standing, index): ContestStanding => {
    if (index > 0 && compareCompetitiveStandings(rules.scoring, unranked[index - 1]!, standing) !== 0) rank = index + 1;
    return { ...standing, rank };
  });
}

export function evaluateContestCheckpoint(
  rules: ContestRules,
  checkpoint: ContestCheckpointRule,
  standings: readonly ContestStanding[],
  candidates: readonly ContestCheckpointCandidate[],
): readonly ContestCheckpointDecision[] {
  if (rules.clock.kind === "individual" && checkpoint.ranking !== null) throw new TypeError("individual checkpoints cannot rank entrants.");
  if (checkpoint.settlement === "pause-until-terminal" && candidates.some((candidate) => candidate.pending)) {
    throw new TypeError("pause-until-terminal checkpoint cannot settle while bounded work is pending.");
  }
  const standingByEntrant = new Map(standings.map((standing) => [standing.entrantId, standing]));
  if (standingByEntrant.size !== standings.length) throw new TypeError("checkpoint standings contain a duplicate entrant.");
  const candidateIds = new Set<string>();
  for (const candidate of candidates) {
    if (!candidate.entrantId || candidateIds.has(candidate.entrantId)) throw new TypeError("checkpoint candidates must have unique entrant ids.");
    candidateIds.add(candidate.entrantId);
    if (!standingByEntrant.has(candidate.entrantId)) throw new TypeError(`checkpoint candidate '${candidate.entrantId}' has no standing.`);
    integer(candidate.solved, `checkpoint candidate '${candidate.entrantId}' solved`, 0, MAX_CONTEST_PROBLEMS);
    finiteNumber(candidate.score, `checkpoint candidate '${candidate.entrantId}' score`, 0);
    if (typeof candidate.pending !== "boolean") throw new TypeError("checkpoint candidate pending must be boolean.");
  }
  const seats = checkpoint.ranking === null
    ? candidates.length
    : checkpoint.ranking.kind === "top-k"
      ? Math.min(candidates.length, checkpoint.ranking.count)
      : Math.ceil(candidates.length * checkpoint.ranking.percent / 100);
  return candidates.map((candidate): ContestCheckpointDecision => {
    const thresholdPassed = (checkpoint.threshold.minimumSolved === null || candidate.solved >= checkpoint.threshold.minimumSolved)
      && (checkpoint.threshold.minimumScore === null || candidate.score >= checkpoint.threshold.minimumScore);
    const rankingPassed = checkpoint.ranking === null || standingByEntrant.get(candidate.entrantId)!.rank <= seats;
    const provisional = checkpoint.settlement === "provisional" && candidate.pending;
    return { entrantId: candidate.entrantId, advances: provisional || (thresholdPassed && rankingPassed), provisional };
  });
}

export const ContestRuleEngine = Object.freeze({
  project: projectContestRules,
  admission: decideContestAdmission,
  rank: rankContestResults,
  checkpoint: evaluateContestCheckpoint,
});
