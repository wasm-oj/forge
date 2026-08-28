import type {
  ContestClock,
  ContestEvidenceAt,
  ContestLeaderboardRule,
  ContestOfficialTrack,
  ContestProblemAvailability,
  PromptProgramOutputProfile,
  ContestRulePhase,
  ContestScoring,
} from "../../../online-judge/contest-rules";

export type ContestRuntimeState = "scheduled" | "running" | "paused" | "ended";

export interface ContestEpochs {
  readonly timelineGeneration: number;
  readonly ruleEpoch: number;
}

export interface ContestEntrantProjection {
  readonly id: string;
  readonly state: "joined" | "active" | "eliminated" | "completed";
  readonly started: boolean;
  readonly eliminatedAtLogicalSeconds: number | null;
  readonly eliminatedAt: string | null;
  readonly eliminatedCheckpointId: string | null;
  readonly eliminationReason: string | null;
}

export interface ContestCheckpointProjection {
  readonly id: string;
  readonly atSeconds: number;
  readonly settlement: "provisional" | "pause-until-terminal";
  readonly state: "upcoming" | "pending" | "evaluating" | "provisional" | "final" | "invalid";
  readonly pendingWork: number;
  readonly decision: "advanced" | "eliminated" | null;
  readonly provisional: boolean;
}

export interface ContestProjection {
  readonly id: string;
  readonly slug: string;
  readonly title: string;
  readonly description: string;
  readonly accessMode: "public" | "invite";
  readonly status: "draft" | "published" | "archived";
  readonly organizer: boolean;
  readonly joined: boolean;
  readonly rulesCommit: string;
  readonly rulesDigest: string;
  readonly clock: ContestClock;
  readonly officialTrack: ContestOfficialTrack;
  readonly evidenceAt: ContestEvidenceAt;
  readonly scoring: ContestScoring;
  readonly leaderboard: ContestLeaderboardRule;
  readonly runtimeState: ContestRuntimeState;
  readonly scheduleShiftSeconds: number;
  readonly phase: ContestRulePhase;
  readonly logicalTimeSeconds: number | null;
  readonly nextBoundarySeconds: number | null;
  readonly paused: boolean;
  readonly pauseReason: string | null;
  readonly epochs: ContestEpochs;
  readonly entrant: ContestEntrantProjection | null;
  readonly checkpoints: readonly ContestCheckpointProjection[];
  readonly judgeProvisional: boolean;
  readonly promptCompilerAvailable: boolean;
  readonly aiAssistAvailable: boolean;
  readonly publicRepositoryTimingWarning: { readonly active: true; readonly message: string } | null;
  readonly pendingRulesCommit?: string | null;
  readonly problemCount?: number;
  readonly organizerProfile?: { readonly login: string; readonly displayName: string } | null;
  readonly createdAt: string;
}

interface ContestProblemProjectionBase {
  readonly ordinal: number;
  readonly batch: number;
  readonly availability: ContestProblemAvailability;
  readonly releaseAfterSeconds: number;
  readonly submissionClosesAfterSeconds: number;
  readonly points: number;
  readonly attemptLimit: number;
  readonly attemptsRemaining: number;
}

export interface LockedContestProblemProjection extends ContestProblemProjectionBase {
  readonly availability: "locked";
}

export interface RevealedContestProblemProjection extends ContestProblemProjectionBase {
  readonly availability: "open" | "closed";
  readonly problemId: string;
  readonly problemSlug: string;
  readonly problemNumber: number;
  readonly title: Readonly<Record<string, string>>;
  readonly contentCommit: string;
  readonly judgeDigest: string;
  readonly contentUrl: string;
  readonly output?: PromptProgramOutputProfile;
  readonly promptContextSha256?: string | null;
  readonly assistContextSha256?: string | null;
  readonly contestAdmission: {
    readonly timelineGeneration: number;
    readonly ruleEpoch: number;
    readonly problemEpoch: number;
  };
}

export type ContestProblemProjection = LockedContestProblemProjection | RevealedContestProblemProjection;

export interface ContestDetailResponse {
  readonly contest: ContestProjection;
  readonly problems: readonly ContestProblemProjection[];
}

export type ContestCatalogGroup = "upcoming" | "running" | "ended";

export function contestCatalogGroup(phase: ContestRulePhase): ContestCatalogGroup {
  if (phase === "ended") return "ended";
  if (phase === "running" || phase === "paused" || phase === "eliminated") return "running";
  return "upcoming";
}

export function contestEffectiveWallTime(timestamp: string, scheduleShiftSeconds: number): string {
  return new Date(Date.parse(timestamp) + scheduleShiftSeconds * 1_000).toISOString();
}

export function contestPrimaryWallTime(contest: Pick<ContestProjection, "clock" | "scheduleShiftSeconds">): string {
  const timestamp = contest.clock.kind === "global" ? contest.clock.startsAt : contest.clock.enrollmentClosesAt;
  return contestEffectiveWallTime(timestamp, contest.scheduleShiftSeconds);
}

export function contestEnrollmentWindowOpen(
  contest: Pick<ContestProjection, "clock" | "scheduleShiftSeconds" | "runtimeState">,
  nowMs: number,
): boolean {
  if (contest.runtimeState === "paused" || contest.runtimeState === "ended") return false;
  const opensAt = contest.clock.kind === "global" ? contest.clock.registrationOpensAt : contest.clock.enrollmentOpensAt;
  const closesAt = contest.clock.kind === "global" ? contest.clock.registrationClosesAt : contest.clock.enrollmentClosesAt;
  const shiftMs = contest.scheduleShiftSeconds * 1_000;
  return nowMs >= Date.parse(opensAt) + shiftMs && nowMs < Date.parse(closesAt) + shiftMs;
}

export function nextContestWallBoundaryDelayMs(
  contest: Pick<ContestProjection, "clock" | "scheduleShiftSeconds" | "runtimeState">,
  nowMs: number,
): number | undefined {
  if (contest.runtimeState === "paused" || contest.runtimeState === "ended") return undefined;
  const timestamps = contest.clock.kind === "global"
    ? [
      contest.clock.registrationOpensAt,
      contest.clock.registrationClosesAt,
      contest.clock.startsAt,
      new Date(Date.parse(contest.clock.startsAt) + contest.clock.durationSeconds * 1_000).toISOString(),
    ]
    : [contest.clock.enrollmentOpensAt, contest.clock.enrollmentClosesAt];
  const shiftMs = contest.scheduleShiftSeconds * 1_000;
  const future = timestamps.map((timestamp) => Date.parse(timestamp) + shiftMs - nowMs).filter((delay) => delay > 0);
  return future.length === 0 ? undefined : Math.ceil(Math.min(...future));
}

export function projectedLogicalSeconds(
  contest: Pick<ContestProjection, "clock" | "logicalTimeSeconds" | "runtimeState">,
  fetchedAtMs: number,
  nowMs: number,
): number | null {
  if (contest.logicalTimeSeconds === null) return null;
  if (contest.runtimeState !== "running") return contest.logicalTimeSeconds;
  const elapsedSeconds = Math.max(0, (nowMs - fetchedAtMs) / 1_000);
  return Math.min(contest.clock.durationSeconds, contest.logicalTimeSeconds + elapsedSeconds);
}

export function nextContestBoundaryDelayMs(
  contest: Pick<ContestProjection, "clock" | "logicalTimeSeconds" | "nextBoundarySeconds" | "runtimeState">,
  fetchedAtMs: number,
  nowMs: number,
): number | undefined {
  if (contest.runtimeState !== "running" || contest.nextBoundarySeconds === null) return undefined;
  const logical = projectedLogicalSeconds(contest, fetchedAtMs, nowMs);
  if (logical === null) return undefined;
  return Math.max(0, Math.ceil((contest.nextBoundarySeconds - logical) * 1_000));
}

export function isRevealedContestProblem(
  problem: ContestProblemProjection,
): problem is RevealedContestProblemProjection {
  return problem.availability !== "locked";
}

export function formatLogicalDuration(totalSeconds: number): string {
  const seconds = Math.max(0, Math.ceil(totalSeconds));
  const hours = Math.floor(seconds / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  const remainder = seconds % 60;
  if (hours > 0) return `${hours}:${String(minutes).padStart(2, "0")}:${String(remainder).padStart(2, "0")}`;
  return `${minutes}:${String(remainder).padStart(2, "0")}`;
}

export function contestBatchProgress(problems: readonly ContestProblemProjection[]): readonly {
  readonly batch: number;
  readonly total: number;
  readonly open: number;
  readonly closed: number;
  readonly locked: number;
}[] {
  const batches = new Map<number, { total: number; open: number; closed: number; locked: number }>();
  for (const problem of problems) {
    const value = batches.get(problem.batch) ?? { total: 0, open: 0, closed: 0, locked: 0 };
    value.total += 1;
    value[problem.availability] += 1;
    batches.set(problem.batch, value);
  }
  return [...batches.entries()]
    .sort(([left], [right]) => left - right)
    .map(([batch, value]) => ({ batch, ...value }));
}
