import type {
  ContestEntrantRuleState,
  ContestLogicalClockSnapshot,
  ContestRuleProjection,
  ContestRules,
} from "../src/online-judge/contest-rules";
import {
  ContestRuleEngine,
  logicalContestSeconds,
  parseContestRules,
} from "../src/online-judge/contest-rules";
import { requireBrowserMutationSession, requireBrowserOrBearerMutationSession } from "./auth";
import type { AuthenticatedSession, WasmOjWorkerEnv } from "./env";
import { requireFormalMutationsEnabled } from "./formal-mutations";
import { requireOrganizer } from "./github";
import { ApiError, jsonResponse, readJsonBody } from "./http";
import {
  reconcileContestCheckpointsForContest,
  reconcilePausedContestCheckpoints,
} from "./contest-checkpoints";

/**
 * D1-backed operational boundary for one canonical contest rules snapshot.
 * Handlers call this service instead of calculating contest time, reveal, or
 * eligibility independently.
 */

export interface ContestRuntimeEpochs {
  readonly timelineGeneration: number;
  readonly ruleEpoch: number;
}

export interface ContestProblemRuntimeEpoch extends ContestRuntimeEpochs {
  readonly problemId: string;
  readonly problemSlug: string;
  readonly problemEpoch: number;
  readonly contentEpoch: number;
  readonly contentCommit: string;
  readonly judgeEpoch: number;
  readonly judgeDigest: string;
}

export interface ContestRuntimeSnapshot {
  readonly contestId: string;
  readonly rulesCommit: string;
  readonly rulesDigest: string;
  readonly rules: ContestRules;
  readonly state: "scheduled" | "running" | "paused" | "ended";
  readonly pausedFromState: "scheduled" | "running" | null;
  readonly scheduleShiftSeconds: number;
  readonly pauseReason: string | null;
  readonly clock: ContestLogicalClockSnapshot | null;
  readonly epochs: ContestRuntimeEpochs;
  readonly entrant: (ContestEntrantRuleState & {
    readonly entrantId: string;
    readonly state: "joined" | "active" | "eliminated" | "completed";
  }) | null;
  readonly problems: readonly ContestProblemRuntimeEpoch[];
  readonly projection: ContestRuleProjection;
  readonly publicRepositoryTimingWarning: boolean;
}

export interface ContestAdmissionFence {
  readonly contestId: string;
  readonly entrantId: string;
  readonly problemId: string;
  readonly timelineGeneration: number;
  readonly ruleEpoch: number;
  readonly problemEpoch: number;
  readonly contentCommit: string;
  readonly logicalSeconds: number;
}

export interface ContestRewindRequest {
  readonly targetLogicalSeconds: number;
  readonly reason: string;
}

export interface ContestRuleActivationRequest {
  readonly rulesCommit: string;
  readonly rulesDigest: string;
  readonly mode: "monotonic-recalculate" | "rewind";
  readonly rewindTargetLogicalSeconds?: number;
}

interface RuntimeRow {
  readonly contest_id: string;
  readonly organizer_user_id: string;
  readonly is_private: number;
  readonly status: "draft" | "published" | "archived";
  readonly access_mode: "public" | "invite";
  readonly rules_commit: string;
  readonly rules_sha256: string;
  readonly rules_json: string;
  readonly clock_kind: "global" | "individual";
  readonly registration_opens_at: string;
  readonly registration_closes_at: string;
  readonly global_starts_at: string | null;
  readonly duration_seconds: number;
  readonly state: "scheduled" | "running" | "paused" | "ended";
  readonly paused_from_state: "scheduled" | "running" | null;
  readonly schedule_shift_seconds: number;
  readonly wall_anchor_at: string | null;
  readonly logical_anchor_seconds: number;
  readonly pause_reason: string | null;
  readonly paused_at: string | null;
  readonly first_started_at: string | null;
  readonly rules_epoch: number;
  readonly timeline_generation: number;
  readonly entrant_id: string | null;
  readonly entrant_state: "joined" | "active" | "eliminated" | "completed" | null;
  readonly entrant_started_at: string | null;
  readonly individual_wall_anchor_at: string | null;
  readonly individual_logical_anchor_seconds: number | null;
  readonly eliminated_logical_seconds: number | null;
  readonly entrant_state_generation: number | null;
}

interface ProblemEpochRow {
  readonly problem_id: string;
  readonly problem_slug: string;
  readonly problem_epoch: number;
  readonly content_epoch: number;
  readonly content_commit: string;
  readonly judge_epoch: number;
  readonly judge_digest: string;
}

interface PendingRulesRow {
  readonly active_rules_commit: string;
  readonly active_rules_sha256: string;
  readonly active_activation_sha256: string;
  readonly active_rules_json: string;
  readonly pending_rules_commit: string | null;
  readonly pending_rules_sha256: string | null;
  readonly pending_activation_sha256: string | null;
  readonly pending_rules_json: string | null;
}

function exactRecord(value: unknown, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ApiError(400, "payload-invalid", "Payload must be an object.");
  const record = value as Record<string, unknown>;
  const allowed = new Set([...required, ...optional]);
  if (required.some((key) => !Object.hasOwn(record, key)) || Object.keys(record).some((key) => !allowed.has(key))) {
    throw new ApiError(400, "payload-invalid", "Payload has an invalid shape.");
  }
  return record;
}

function logicalAt(anchorSeconds: number, anchorAt: string | null, now: Date, durationSeconds: number): number {
  if (anchorAt === null) return Math.min(durationSeconds, anchorSeconds);
  return logicalContestSeconds({
    generation: 1,
    state: "running",
    logicalSeconds: anchorSeconds,
    capturedAt: anchorAt,
  }, now.toISOString(), durationSeconds);
}

async function materializeGlobalRuntime(env: WasmOjWorkerEnv, contestId: string, now: Date): Promise<void> {
  const timestamp = now.toISOString();
  await env.DB.batch([
    env.DB.prepare(`UPDATE contest_runtimes
      SET state='running',
          wall_anchor_at=strftime('%Y-%m-%dT%H:%M:%fZ', revisions.global_starts_at,
            '+' || contest_runtimes.schedule_shift_seconds || ' seconds'),
          logical_anchor_seconds=0,
          first_started_at=COALESCE(first_started_at,
            strftime('%Y-%m-%dT%H:%M:%fZ', revisions.global_starts_at,
              '+' || contest_runtimes.schedule_shift_seconds || ' seconds')),
          updated_at=?
      FROM contest_rule_revisions AS revisions
      WHERE contest_runtimes.contest_id=?
        AND revisions.contest_id=contest_runtimes.contest_id
        AND revisions.rules_commit=contest_runtimes.active_rules_commit
        AND revisions.clock_kind='global'
        AND ROUND((julianday(?) - julianday(revisions.global_starts_at))*86400000)
          >= contest_runtimes.schedule_shift_seconds*1000
        AND contest_runtimes.state='scheduled'`)
      .bind(timestamp, contestId, timestamp),
    env.DB.prepare(`INSERT INTO contest_timeline_events
      (contest_id, event_key, event_type, from_generation, to_generation,
       logical_seconds, target_logical_seconds, actor_user_id, payload_json, created_at)
      SELECT runtime.contest_id, 'start:' || runtime.timeline_generation || ':global',
        'start', runtime.timeline_generation, runtime.timeline_generation,
        0, NULL, catalogs.organizer_user_id, json_object('clockKind', 'global'),
        runtime.wall_anchor_at
      FROM contest_runtimes AS runtime
      JOIN contest_series AS series ON series.id=runtime.contest_id
      JOIN catalogs ON catalogs.id=series.catalog_id
      WHERE runtime.contest_id=? AND runtime.state='running'
        AND runtime.wall_anchor_at IS NOT NULL AND runtime.logical_anchor_seconds=0
      ON CONFLICT(contest_id, event_key) DO NOTHING`)
      .bind(contestId),
    env.DB.prepare(`UPDATE contest_entrants
      SET state='active', started_at=COALESCE(started_at, runtime.wall_anchor_at),
          start_timeline_generation=COALESCE(start_timeline_generation, runtime.timeline_generation),
          state_timeline_generation=runtime.timeline_generation, updated_at=?
      FROM contest_runtimes AS runtime
      JOIN contest_rule_revisions AS revisions
        ON revisions.contest_id=runtime.contest_id
       AND revisions.rules_commit=runtime.active_rules_commit
      WHERE contest_entrants.contest_id=? AND contest_entrants.contest_id=runtime.contest_id
        AND runtime.state='running' AND revisions.clock_kind='global'
        AND contest_entrants.state='joined'`)
      .bind(timestamp, contestId),
    env.DB.prepare(`UPDATE contest_runtimes
      SET state='ended', wall_anchor_at=NULL,
          logical_anchor_seconds=revisions.duration_seconds,
          ended_at=strftime('%Y-%m-%dT%H:%M:%fZ', contest_runtimes.wall_anchor_at,
            '+' || (revisions.duration_seconds-contest_runtimes.logical_anchor_seconds) || ' seconds'),
          updated_at=?
      FROM contest_rule_revisions AS revisions
      WHERE contest_runtimes.contest_id=?
        AND revisions.contest_id=contest_runtimes.contest_id
        AND revisions.rules_commit=contest_runtimes.active_rules_commit
        AND revisions.clock_kind='global'
        AND ROUND((julianday(?) - julianday(contest_runtimes.wall_anchor_at))*86400000)
          >= (revisions.duration_seconds-contest_runtimes.logical_anchor_seconds)*1000
        AND contest_runtimes.state='running'`)
      .bind(timestamp, contestId, timestamp),
    env.DB.prepare(`INSERT INTO contest_timeline_events
      (contest_id, event_key, event_type, from_generation, to_generation,
       logical_seconds, target_logical_seconds, actor_user_id, payload_json, created_at)
      SELECT runtime.contest_id, 'end:' || runtime.timeline_generation,
        'end', runtime.timeline_generation, runtime.timeline_generation,
        runtime.logical_anchor_seconds, NULL, catalogs.organizer_user_id,
        json_object('clockKind', revisions.clock_kind), runtime.ended_at
      FROM contest_runtimes AS runtime
      JOIN contest_series AS series ON series.id=runtime.contest_id
      JOIN catalogs ON catalogs.id=series.catalog_id
      JOIN contest_rule_revisions AS revisions
        ON revisions.contest_id=runtime.contest_id
       AND revisions.rules_commit=runtime.active_rules_commit
      WHERE runtime.contest_id=? AND runtime.state='ended'
      ON CONFLICT(contest_id, event_key) DO NOTHING`)
      .bind(contestId),
    env.DB.prepare(`UPDATE contest_entrants
      SET state='completed', updated_at=?
      WHERE contest_id=? AND state='active'
        AND EXISTS (SELECT 1 FROM contest_runtimes
          WHERE contest_id=? AND state='ended'
            AND timeline_generation=contest_entrants.state_timeline_generation)`)
      .bind(timestamp, contestId, contestId),
  ]);
}

async function materializeIndividualRuntime(env: WasmOjWorkerEnv, contestId: string, now: Date): Promise<void> {
  const timestamp = now.toISOString();
  await env.DB.batch([
    env.DB.prepare(`UPDATE contest_entrants
      SET state='completed', individual_logical_anchor_seconds=revisions.duration_seconds,
          individual_wall_anchor_at=NULL, updated_at=?
      FROM contest_runtimes AS runtime
      JOIN contest_rule_revisions AS revisions
        ON revisions.contest_id=runtime.contest_id
       AND revisions.rules_commit=runtime.active_rules_commit
      WHERE contest_entrants.contest_id=?
        AND contest_entrants.contest_id=runtime.contest_id
        AND contest_entrants.state='active' AND runtime.state='running'
        AND revisions.clock_kind='individual'
        AND contest_entrants.individual_wall_anchor_at IS NOT NULL
        AND contest_entrants.individual_logical_anchor_seconds
          + CAST(MAX(0, ROUND((julianday(?)
            - julianday(contest_entrants.individual_wall_anchor_at))*86400000))/1000 AS INTEGER)
          >= revisions.duration_seconds`)
      .bind(timestamp, contestId, timestamp),
    env.DB.prepare(`UPDATE contest_entrants
      SET state='completed', updated_at=?
      WHERE contest_id=? AND state='joined'
        AND EXISTS (SELECT 1 FROM contest_runtimes AS runtime
          JOIN contest_rule_revisions AS revisions
            ON revisions.contest_id=runtime.contest_id
           AND revisions.rules_commit=runtime.active_rules_commit
          WHERE runtime.contest_id=contest_entrants.contest_id
            AND runtime.state<>'paused' AND revisions.clock_kind='individual'
            AND ROUND((julianday(?) - julianday(revisions.registration_closes_at))*86400000)
              >= runtime.schedule_shift_seconds*1000)`)
      .bind(timestamp, contestId, timestamp),
    env.DB.prepare(`UPDATE contest_runtimes
      SET state='ended', wall_anchor_at=NULL, paused_from_state=NULL, ended_at=?, updated_at=?
      WHERE contest_id=? AND state IN ('scheduled','running')
        AND EXISTS (SELECT 1 FROM contest_rule_revisions AS revisions
          WHERE revisions.contest_id=contest_runtimes.contest_id
            AND revisions.rules_commit=contest_runtimes.active_rules_commit
            AND revisions.clock_kind='individual'
            AND ROUND((julianday(?) - julianday(revisions.registration_closes_at))*86400000)
              >= contest_runtimes.schedule_shift_seconds*1000)
        AND NOT EXISTS (SELECT 1 FROM contest_entrants
          WHERE contest_id=contest_runtimes.contest_id AND state IN ('joined','active'))`)
      .bind(timestamp, timestamp, contestId, timestamp),
    env.DB.prepare(`INSERT INTO contest_timeline_events
      (contest_id, event_key, event_type, from_generation, to_generation,
       logical_seconds, target_logical_seconds, actor_user_id, payload_json, created_at)
      SELECT runtime.contest_id, 'end:' || runtime.timeline_generation,
        'end', runtime.timeline_generation, runtime.timeline_generation,
        revisions.duration_seconds, NULL, catalogs.organizer_user_id,
        json_object('clockKind', 'individual'), runtime.ended_at
      FROM contest_runtimes AS runtime
      JOIN contest_series AS series ON series.id=runtime.contest_id
      JOIN catalogs ON catalogs.id=series.catalog_id
      JOIN contest_rule_revisions AS revisions
        ON revisions.contest_id=runtime.contest_id
       AND revisions.rules_commit=runtime.active_rules_commit
      WHERE runtime.contest_id=? AND runtime.state='ended'
        AND revisions.clock_kind='individual'
      ON CONFLICT(contest_id, event_key) DO NOTHING`)
      .bind(contestId),
  ]);
}

export async function materializeContestRuntime(env: WasmOjWorkerEnv, contestId: string, now = new Date()): Promise<void> {
  await materializeGlobalRuntime(env, contestId, now);
  await materializeIndividualRuntime(env, contestId, now);
}

async function runtimeRow(
  env: WasmOjWorkerEnv,
  contestId: string,
  session: AuthenticatedSession | null,
): Promise<RuntimeRow> {
  const row = await env.DB.prepare(`SELECT series.id AS contest_id, catalogs.organizer_user_id,
      repositories.is_private, revisions.status, revisions.access_mode,
      revisions.rules_commit, revisions.rules_sha256, revisions.rules_json,
      revisions.clock_kind, revisions.registration_opens_at, revisions.registration_closes_at,
      revisions.global_starts_at, revisions.duration_seconds,
      runtime.state, runtime.paused_from_state, runtime.schedule_shift_seconds,
      runtime.wall_anchor_at, runtime.logical_anchor_seconds,
      runtime.pause_reason, runtime.paused_at, runtime.first_started_at,
      runtime.rules_epoch, runtime.timeline_generation,
      entrants.id AS entrant_id, entrants.state AS entrant_state,
      entrants.started_at AS entrant_started_at,
      entrants.individual_wall_anchor_at, entrants.individual_logical_anchor_seconds,
      entrants.eliminated_logical_seconds,
      entrants.state_timeline_generation AS entrant_state_generation
    FROM contest_series AS series
    JOIN catalogs ON catalogs.id=series.catalog_id
    JOIN github_repositories AS repositories
      ON repositories.github_repository_id=catalogs.github_repository_id
    JOIN contest_runtimes AS runtime ON runtime.contest_id=series.id
    JOIN contest_rule_revisions AS revisions
      ON revisions.contest_id=runtime.contest_id
     AND revisions.rules_commit=runtime.active_rules_commit
     AND revisions.rules_sha256=runtime.active_rules_sha256
    LEFT JOIN contest_entrants AS entrants
      ON entrants.contest_id=series.id AND entrants.kind='account' AND entrants.account_user_id=?
    WHERE series.id=?`)
    .bind(session?.userId ?? "", contestId).first<RuntimeRow>();
  if (!row) throw new ApiError(404, "contest-not-found", "Contest was not found.");
  const organizer = row.organizer_user_id === session?.userId;
  if ((!organizer && row.status !== "published")
    || (!organizer && row.access_mode === "invite" && row.entrant_id === null)) {
    throw new ApiError(404, "contest-not-found", "Contest was not found.");
  }
  return row;
}

async function ownedOperationalRuntime(
  env: WasmOjWorkerEnv,
  contestId: string,
  session: AuthenticatedSession,
): Promise<RuntimeRow> {
  await materializeContestRuntime(env, contestId, new Date());
  const row = await runtimeRow(env, contestId, session);
  if (row.organizer_user_id !== session.userId && !session.roles.includes("admin")) {
    throw new ApiError(404, "contest-not-found", "Organizer-owned contest was not found.");
  }
  return row;
}

async function pendingRulesRow(env: WasmOjWorkerEnv, contestId: string): Promise<PendingRulesRow> {
  const row = await env.DB.prepare(`SELECT runtime.active_rules_commit,
      runtime.active_rules_sha256, runtime.active_activation_sha256,
      active.rules_json AS active_rules_json,
      runtime.pending_rules_commit, runtime.pending_rules_sha256,
      runtime.pending_activation_sha256, pending.rules_json AS pending_rules_json
    FROM contest_runtimes AS runtime
    JOIN contest_rule_revisions AS active
      ON active.contest_id=runtime.contest_id
     AND active.rules_commit=runtime.active_rules_commit
     AND active.rules_sha256=runtime.active_rules_sha256
    LEFT JOIN contest_rule_revisions AS pending
      ON pending.contest_id=runtime.contest_id
     AND pending.rules_commit=runtime.pending_rules_commit
     AND pending.rules_sha256=runtime.pending_rules_sha256
    WHERE runtime.contest_id=?`)
    .bind(contestId).first<PendingRulesRow>();
  if (!row) throw new ApiError(404, "contest-not-found", "Contest was not found.");
  return row;
}

function immutableRuleChanges(active: ContestRules, pending: ContestRules): readonly string[] {
  const changes: string[] = [];
  if (active.clock.kind !== pending.clock.kind) changes.push("clock.kind");
  if (active.officialTrack.kind !== pending.officialTrack.kind) changes.push("officialTrack.kind");
  if (active.evidenceAt !== pending.evidenceAt) changes.push("evidenceAt");
  const activeDisclosure = active.officialTrack.kind === "prompt-program" ? active.officialTrack.disclosure : null;
  const pendingDisclosure = pending.officialTrack.kind === "prompt-program" ? pending.officialTrack.disclosure : null;
  if (activeDisclosure !== pendingDisclosure) changes.push("officialTrack.disclosure");
  return changes;
}

function rewindZeroRuleChanges(active: ContestRules, pending: ContestRules): readonly string[] {
  const changes: string[] = [];
  if (active.officialTrack.kind === "prompt-program" && pending.officialTrack.kind === "prompt-program") {
    if (active.officialTrack.compiler.configId !== pending.officialTrack.compiler.configId
      || active.officialTrack.compiler.configDigest !== pending.officialTrack.compiler.configDigest) {
      changes.push("officialTrack.compiler");
    }
    const activeOutputs = active.problems.map((problem) => [problem.slug, problem.output]);
    const pendingOutputs = pending.problems.map((problem) => [problem.slug, problem.output]);
    if (JSON.stringify(activeOutputs) !== JSON.stringify(pendingOutputs)) changes.push("problems.output");
  }
  return changes;
}

export async function loadContestRuntimeSnapshot(
  env: WasmOjWorkerEnv,
  contestId: string,
  session: AuthenticatedSession | null,
  now = new Date(),
): Promise<ContestRuntimeSnapshot> {
  await materializeContestRuntime(env, contestId, now);
  await reconcileContestCheckpointsForContest(env, contestId, now);
  const row = await runtimeRow(env, contestId, session);
  const rules = parseContestRules(JSON.parse(row.rules_json) as unknown, "stored contest rules");
  const problemRows = await env.DB.prepare(`SELECT rule_problems.problem_id,
      problems.slug AS problem_slug, epochs.problem_epoch, epochs.content_epoch,
      epochs.content_commit, epochs.judge_epoch, epochs.judge_digest
    FROM contest_rule_problems AS rule_problems
    JOIN problem_series AS problems ON problems.id=rule_problems.problem_id
    JOIN contest_problem_epochs AS epochs
      ON epochs.contest_id=rule_problems.contest_id
     AND epochs.problem_id=rule_problems.problem_id AND epochs.state='effective'
    WHERE rule_problems.contest_id=? AND rule_problems.rules_commit=?
    ORDER BY rule_problems.ordinal`)
    .bind(contestId, row.rules_commit).all<ProblemEpochRow>();
  if (problemRows.results.length !== rules.problems.length) {
    throw new ApiError(503, "contest-runtime-incomplete", "Contest problem epochs are not fully materialized.");
  }
  const attemptRows = row.entrant_id === null
    ? { results: [] as readonly { readonly problem_slug: string; readonly attempts: number }[] }
    : rules.officialTrack.kind === "prompt-program"
      ? await env.DB.prepare(`SELECT problems.slug AS problem_slug, COUNT(*) AS attempts
          FROM prompt_attempts AS attempts
          JOIN problem_series AS problems ON problems.id=attempts.problem_id
          JOIN prompt_attempt_quota AS quota ON quota.prompt_attempt_id=attempts.id
          WHERE attempts.contest_id=? AND attempts.entrant_id=? AND attempts.eligibility='eligible'
            AND quota.state IN ('reserved','consumed')
          GROUP BY problems.slug`)
        .bind(contestId, row.entrant_id).all<{ readonly problem_slug: string; readonly attempts: number }>()
      : await env.DB.prepare(`SELECT problems.slug AS problem_slug, COUNT(*) AS attempts
          FROM contest_submission_records AS records
          JOIN submissions ON submissions.id=records.submission_id
          JOIN problem_series AS problems ON problems.id=submissions.problem_id
          WHERE records.contest_id=? AND records.entrant_id=? AND records.eligibility='eligible'
            AND submissions.origin_submission_id=submissions.id
          GROUP BY problems.slug`)
        .bind(contestId, row.entrant_id).all<{ readonly problem_slug: string; readonly attempts: number }>();
  const attemptedByProblem = Object.fromEntries(attemptRows.results.map((attempt) => [attempt.problem_slug, attempt.attempts]));
  let clock: ContestLogicalClockSnapshot | null = null;
  if (rules.clock.kind === "individual" && (row.state === "paused" || row.state === "ended")) {
    clock = {
      generation: row.timeline_generation,
      state: "paused",
      logicalSeconds: row.entrant_started_at ? row.individual_logical_anchor_seconds ?? 0 : 0,
      capturedAt: row.paused_at ?? now.toISOString(),
    };
  } else if (row.state === "paused" || row.state === "ended") {
    clock = {
      generation: row.timeline_generation,
      state: "paused",
      logicalSeconds: row.logical_anchor_seconds,
      capturedAt: row.paused_at ?? now.toISOString(),
    };
  } else if (rules.clock.kind === "global" && row.state === "running" && row.wall_anchor_at) {
    clock = {
      generation: row.timeline_generation,
      state: "running",
      logicalSeconds: row.logical_anchor_seconds,
      capturedAt: row.wall_anchor_at,
    };
  } else if (rules.clock.kind === "individual" && row.entrant_started_at && row.individual_wall_anchor_at) {
    clock = {
      generation: row.timeline_generation,
      state: row.state === "running" ? "running" : "paused",
      logicalSeconds: row.individual_logical_anchor_seconds ?? 0,
      capturedAt: row.individual_wall_anchor_at,
    };
  }
  const entrant = row.entrant_id === null ? null : {
    entrantId: row.entrant_id,
    joined: true,
    started: row.entrant_started_at !== null || rules.clock.kind === "global",
    state: row.entrant_state!,
    completed: row.entrant_state === "completed",
    eliminatedAtSeconds: row.entrant_state === "eliminated"
      && row.entrant_state_generation === row.timeline_generation
      ? row.eliminated_logical_seconds : null,
  };
  const projection = ContestRuleEngine.project({
    rules,
    clock,
    entrant,
    attemptedByProblem,
    observedAt: now.toISOString(),
    scheduleShiftSeconds: row.schedule_shift_seconds,
    contestEnded: row.state === "ended",
  });
  return {
    contestId,
    rulesCommit: row.rules_commit,
    rulesDigest: row.rules_sha256,
    rules,
    state: row.state,
    pausedFromState: row.paused_from_state,
    scheduleShiftSeconds: row.schedule_shift_seconds,
    pauseReason: row.pause_reason,
    clock,
    epochs: { timelineGeneration: row.timeline_generation, ruleEpoch: row.rules_epoch },
    entrant,
    problems: problemRows.results.map((problem) => ({
      problemId: problem.problem_id,
      problemSlug: problem.problem_slug,
      problemEpoch: problem.problem_epoch,
      contentEpoch: problem.content_epoch,
      contentCommit: problem.content_commit,
      judgeEpoch: problem.judge_epoch,
      judgeDigest: problem.judge_digest,
      timelineGeneration: row.timeline_generation,
      ruleEpoch: row.rules_epoch,
    })),
    projection,
    publicRepositoryTimingWarning: row.is_private === 0
      && rules.problems.some((problem) => problem.releaseAfterSeconds > 0),
  };
}

export function prepareContestSubmissionAdmission(
  env: WasmOjWorkerEnv,
  fence: ContestAdmissionFence,
  submissionId: string,
  admittedAt: string,
): D1PreparedStatement {
  return env.DB.prepare(`WITH admission_clock(admitted_at) AS (VALUES (?)),
      current_clock(logical_seconds) AS (
        SELECT CAST(MIN(revisions.duration_seconds,
          CASE WHEN revisions.clock_kind='global'
            THEN runtime.logical_anchor_seconds
              + CAST(MAX(0, ROUND((julianday(admission_clock.admitted_at)
                - julianday(runtime.wall_anchor_at))*86400000))/1000 AS INTEGER)
            ELSE entrant.individual_logical_anchor_seconds
              + CAST(MAX(0, ROUND((julianday(admission_clock.admitted_at)
                - julianday(entrant.individual_wall_anchor_at))*86400000))/1000 AS INTEGER)
          END) AS INTEGER)
        FROM contest_runtimes AS runtime
        JOIN contest_rule_revisions AS revisions
          ON revisions.contest_id=runtime.contest_id
         AND revisions.rules_commit=runtime.active_rules_commit
         AND revisions.rules_sha256=runtime.active_rules_sha256
        JOIN contest_entrants AS entrant
          ON entrant.id=? AND entrant.contest_id=runtime.contest_id
        CROSS JOIN admission_clock
        WHERE runtime.contest_id=? AND runtime.state='running'
          AND runtime.timeline_generation=? AND runtime.rules_epoch=?
          AND entrant.state='active'
          AND entrant.state_timeline_generation=runtime.timeline_generation
          AND (revisions.clock_kind='global' OR entrant.individual_wall_anchor_at IS NOT NULL)
      )
    INSERT INTO contest_submission_records
      (submission_id, contest_id, entrant_id, timeline_generation, rules_epoch,
       content_epoch, judge_epoch, admitted_logical_seconds, evidence_at,
       evidence_logical_seconds, eligibility, created_at)
    SELECT submissions.id, runtime.contest_id, entrant.id, runtime.timeline_generation,
      runtime.rules_epoch, epoch.content_epoch, epoch.judge_epoch,
      current_clock.logical_seconds, revisions.evidence_at,
      CASE WHEN revisions.evidence_at='input-admitted' THEN current_clock.logical_seconds ELSE NULL END,
      'eligible', admission_clock.admitted_at
    FROM submissions
    CROSS JOIN admission_clock
    CROSS JOIN current_clock
    JOIN contest_runtimes AS runtime ON runtime.contest_id=submissions.contest_id
    JOIN contest_rule_revisions AS revisions
      ON revisions.contest_id=runtime.contest_id
     AND revisions.rules_commit=runtime.active_rules_commit
     AND revisions.rules_sha256=runtime.active_rules_sha256
    JOIN contest_rule_problems AS problem
      ON problem.contest_id=runtime.contest_id
     AND problem.rules_commit=runtime.active_rules_commit
     AND problem.problem_id=submissions.problem_id
    JOIN contest_entrants AS entrant
      ON entrant.id=? AND entrant.contest_id=runtime.contest_id
    JOIN contest_problem_epochs AS epoch
      ON epoch.contest_id=runtime.contest_id AND epoch.problem_id=submissions.problem_id
     AND epoch.problem_epoch=? AND epoch.state='effective'
    WHERE submissions.id=? AND submissions.problem_id=?
      AND runtime.contest_id=? AND runtime.state='running'
      AND runtime.timeline_generation=? AND runtime.rules_epoch=?
      AND entrant.state='active' AND entrant.state_timeline_generation=runtime.timeline_generation
      AND revisions.official_track='code'
      AND epoch.content_commit=?
      AND current_clock.logical_seconds>=problem.release_after_seconds
      AND current_clock.logical_seconds<problem.submission_closes_after_seconds
      AND (SELECT COUNT(*) FROM contest_submission_records AS prior
        JOIN submissions AS prior_submission ON prior_submission.id=prior.submission_id
        WHERE prior.contest_id=runtime.contest_id AND prior.entrant_id=entrant.id
          AND prior_submission.problem_id=submissions.problem_id
          AND prior.eligibility='eligible'
          AND prior_submission.origin_submission_id=prior_submission.id)<problem.attempt_limit`)
    .bind(
      admittedAt, fence.entrantId, fence.contestId,
      fence.timelineGeneration, fence.ruleEpoch,
      fence.entrantId, fence.problemEpoch, submissionId, fence.problemId,
      fence.contestId, fence.timelineGeneration, fence.ruleEpoch, fence.contentCommit,
    );
}

export async function startContestEntrant(request: Request, env: WasmOjWorkerEnv, contestId: string): Promise<Response> {
  const session = await requireBrowserOrBearerMutationSession(request, env);
  await requireFormalMutationsEnabled(env, request);
  exactRecord(await readJsonBody(request, 1_024), []);
  const now = new Date();
  const timestamp = now.toISOString();
  const row = await env.DB.prepare(`SELECT runtime.state, runtime.timeline_generation,
      runtime.schedule_shift_seconds,
      revisions.clock_kind, revisions.registration_opens_at, revisions.registration_closes_at,
      entrants.id AS entrant_id, entrants.started_at
    FROM contest_runtimes AS runtime
    JOIN contest_rule_revisions AS revisions
      ON revisions.contest_id=runtime.contest_id
     AND revisions.rules_commit=runtime.active_rules_commit
     AND revisions.rules_sha256=runtime.active_rules_sha256
    LEFT JOIN contest_entrants AS entrants
      ON entrants.contest_id=runtime.contest_id
     AND entrants.kind='account' AND entrants.account_user_id=?
    WHERE runtime.contest_id=? AND revisions.status='published'`)
    .bind(session.userId, contestId).first<{
      readonly state: string;
      readonly timeline_generation: number;
      readonly schedule_shift_seconds: number;
      readonly clock_kind: string;
      readonly registration_opens_at: string;
      readonly registration_closes_at: string;
      readonly entrant_id: string | null;
      readonly started_at: string | null;
    }>();
  if (!row) throw new ApiError(404, "contest-not-found", "Contest was not found.");
  if (!row.entrant_id) throw new ApiError(409, "contest-not-joined", "Join the contest before starting its clock.");
  if (row.clock_kind !== "individual") throw new ApiError(409, "contest-start-not-required", "This contest uses one global clock.");
  if (row.state === "paused") throw new ApiError(409, "contest-paused", "The contest is paused.");
  const effectiveOpensAt = Date.parse(row.registration_opens_at) + row.schedule_shift_seconds * 1_000;
  const effectiveClosesAt = Date.parse(row.registration_closes_at) + row.schedule_shift_seconds * 1_000;
  if (row.state === "ended" || now.getTime() < effectiveOpensAt || now.getTime() >= effectiveClosesAt) {
    throw new ApiError(409, "contest-start-window-closed", "The individual start window is closed.");
  }
  if (row.started_at) return jsonResponse({ contestId, entrantId: row.entrant_id, startedAt: row.started_at, replayed: true });
  const [entrantResult] = await env.DB.batch([
    env.DB.prepare(`UPDATE contest_entrants
      SET started_at=?, start_timeline_generation=?, individual_wall_anchor_at=?,
          individual_logical_anchor_seconds=0, state='active',
          state_timeline_generation=?, updated_at=?
      WHERE id=? AND contest_id=? AND started_at IS NULL AND state='joined'
        AND EXISTS (SELECT 1 FROM contest_runtimes
          WHERE contest_id=? AND timeline_generation=? AND state IN ('scheduled','running')
            AND ROUND((julianday(?) - julianday(?))*86400000)>=schedule_shift_seconds*1000
            AND ROUND((julianday(?) - julianday(?))*86400000)<schedule_shift_seconds*1000)`)
      .bind(
        timestamp, row.timeline_generation, timestamp, row.timeline_generation, timestamp,
        row.entrant_id, contestId, contestId, row.timeline_generation,
        timestamp, row.registration_opens_at, timestamp, row.registration_closes_at,
      ),
    env.DB.prepare(`UPDATE contest_runtimes
      SET state='running', wall_anchor_at=COALESCE(wall_anchor_at, ?),
          first_started_at=COALESCE(first_started_at, ?), updated_at=?
      WHERE contest_id=? AND timeline_generation=? AND state IN ('scheduled','running')
        AND EXISTS (SELECT 1 FROM contest_entrants
          WHERE id=? AND contest_id=? AND started_at=?
            AND start_timeline_generation=? AND state='active'
            AND state_timeline_generation=?)`)
      .bind(
        timestamp, timestamp, timestamp, contestId, row.timeline_generation,
        row.entrant_id, contestId, timestamp, row.timeline_generation, row.timeline_generation,
      ),
    env.DB.prepare(`INSERT INTO contest_timeline_events
      (contest_id, event_key, event_type, from_generation, to_generation,
       logical_seconds, target_logical_seconds, actor_user_id, payload_json, created_at)
      SELECT ?, ?, 'start', ?, ?, 0, NULL, ?, json_object('entrantId', ?), ?
      WHERE EXISTS (SELECT 1 FROM contest_entrants WHERE id=? AND started_at=?)
      ON CONFLICT(contest_id, event_key) DO NOTHING`)
      .bind(
        contestId, `start:${row.timeline_generation}:${row.entrant_id}`,
        row.timeline_generation, row.timeline_generation, session.userId, row.entrant_id,
        timestamp, row.entrant_id, timestamp,
      ),
  ]);
  if (entrantResult.meta.changes !== 1) {
    const winner = await env.DB.prepare("SELECT started_at FROM contest_entrants WHERE id=?")
      .bind(row.entrant_id).first<{ readonly started_at: string | null }>();
    if (!winner?.started_at) throw new ApiError(409, "contest-start-conflict", "The contest clock changed while starting.");
    return jsonResponse({ contestId, entrantId: row.entrant_id, startedAt: winner.started_at, replayed: true });
  }
  return jsonResponse({ contestId, entrantId: row.entrant_id, startedAt: timestamp, replayed: false }, 201);
}

export async function pauseContest(request: Request, env: WasmOjWorkerEnv, contestId: string): Promise<Response> {
  const session = await requireBrowserMutationSession(request, env);
  await requireOrganizer(env, session);
  await requireFormalMutationsEnabled(env, request);
  const body = exactRecord(await readJsonBody(request, 8 * 1024), ["reason"]);
  if (typeof body.reason !== "string" || body.reason.trim().length < 1 || body.reason.length > 500) {
    throw new ApiError(400, "contest-pause-reason-invalid", "Pause reason must contain 1–500 characters.");
  }
  const now = new Date();
  const timestamp = now.toISOString();
  const row = await ownedOperationalRuntime(env, contestId, session);
  if (row.state === "paused") return jsonResponse({ contestId, state: "paused", pausedAt: row.paused_at, replayed: true });
  if (row.state === "ended") throw new ApiError(409, "contest-ended", "An ended contest cannot be paused.");
  const logicalSeconds = row.clock_kind === "global" && row.state === "running"
    ? logicalAt(row.logical_anchor_seconds, row.wall_anchor_at, now, row.duration_seconds)
    : row.logical_anchor_seconds;
  const eventKey = `pause:${row.timeline_generation}:${crypto.randomUUID()}`;
  const [runtimeResult] = await env.DB.batch([
    env.DB.prepare(`UPDATE contest_runtimes
      SET state='paused', wall_anchor_at=NULL, logical_anchor_seconds=?,
          paused_from_state=?, pause_reason=?, paused_at=?, updated_at=?
      WHERE contest_id=? AND timeline_generation=? AND state=?`)
      .bind(logicalSeconds, row.state, body.reason.trim(), timestamp, timestamp, contestId, row.timeline_generation, row.state),
    env.DB.prepare(`UPDATE contest_entrants
      SET individual_logical_anchor_seconds=MIN(?, individual_logical_anchor_seconds
            + CAST(MAX(0, ROUND((julianday(?)
              - julianday(individual_wall_anchor_at))*86400000))/1000 AS INTEGER)),
          individual_wall_anchor_at=NULL, updated_at=?
      WHERE contest_id=? AND started_at IS NOT NULL AND individual_wall_anchor_at IS NOT NULL
        AND state IN ('active','eliminated')
        AND EXISTS (SELECT 1 FROM contest_runtimes
          WHERE contest_id=? AND timeline_generation=? AND state='paused' AND paused_at=?)`)
      .bind(
        row.duration_seconds, timestamp, timestamp, contestId,
        contestId, row.timeline_generation, timestamp,
      ),
    env.DB.prepare(`INSERT INTO contest_timeline_events
      (contest_id, event_key, event_type, from_generation, to_generation,
       logical_seconds, target_logical_seconds, actor_user_id, payload_json, created_at)
      SELECT ?, ?, 'pause', ?, ?, ?, NULL, ?, json_object('reason', ?), ?
      WHERE EXISTS (SELECT 1 FROM contest_runtimes WHERE contest_id=? AND state='paused' AND paused_at=?)`)
      .bind(
        contestId, eventKey, row.timeline_generation, row.timeline_generation,
        logicalSeconds, session.userId, body.reason.trim(), timestamp, contestId, timestamp,
      ),
  ]);
  if (runtimeResult.meta.changes !== 1) throw new ApiError(409, "contest-runtime-conflict", "Contest state changed while pausing.");
  return jsonResponse({ contestId, state: "paused", logicalSeconds, pausedAt: timestamp, reason: body.reason.trim() });
}

export async function resumeContest(request: Request, env: WasmOjWorkerEnv, contestId: string): Promise<Response> {
  const session = await requireBrowserMutationSession(request, env);
  await requireOrganizer(env, session);
  await requireFormalMutationsEnabled(env, request);
  exactRecord(await readJsonBody(request, 1_024), []);
  const now = new Date();
  const timestamp = now.toISOString();
  const row = await ownedOperationalRuntime(env, contestId, session);
  if (row.state !== "paused" || !row.paused_at || !row.paused_from_state) {
    throw new ApiError(409, "contest-not-paused", "Only a paused contest can resume.");
  }
  const pauseSeconds = Math.max(0, Math.floor((now.getTime() - Date.parse(row.paused_at)) / 1_000));
  const resumedState = row.paused_from_state;
  const wallAnchor = resumedState === "running" ? timestamp : null;
  const eventKey = `resume:${row.timeline_generation}:${crypto.randomUUID()}`;
  const [runtimeResult] = await env.DB.batch([
    env.DB.prepare(`UPDATE contest_runtimes
      SET state=?, wall_anchor_at=?, paused_from_state=NULL,
          schedule_shift_seconds=schedule_shift_seconds+?,
          pause_reason=NULL, paused_at=NULL, updated_at=?
      WHERE contest_id=? AND timeline_generation=? AND state='paused' AND paused_at=?`)
      .bind(resumedState, wallAnchor, pauseSeconds, timestamp, contestId, row.timeline_generation, row.paused_at),
    env.DB.prepare(`UPDATE contest_entrants SET individual_wall_anchor_at=?, updated_at=?
      WHERE contest_id=? AND started_at IS NOT NULL AND individual_wall_anchor_at IS NULL
        AND state='active' AND state_timeline_generation=?
        AND EXISTS (SELECT 1 FROM contest_runtimes
          WHERE contest_id=? AND timeline_generation=? AND state=? AND updated_at=?)`)
      .bind(
        timestamp, timestamp, contestId, row.timeline_generation,
        contestId, row.timeline_generation, resumedState, timestamp,
      ),
    env.DB.prepare(`INSERT INTO contest_timeline_events
      (contest_id, event_key, event_type, from_generation, to_generation,
       logical_seconds, target_logical_seconds, actor_user_id, payload_json, created_at)
      SELECT ?, ?, 'resume', ?, ?, ?, NULL, ?, '{}', ?
      WHERE EXISTS (SELECT 1 FROM contest_runtimes WHERE contest_id=? AND state=? AND updated_at=?)`)
      .bind(
        contestId, eventKey, row.timeline_generation, row.timeline_generation,
        row.logical_anchor_seconds, session.userId, timestamp, contestId, resumedState, timestamp,
      ),
  ]);
  if (runtimeResult.meta.changes !== 1) throw new ApiError(409, "contest-runtime-conflict", "Contest state changed while resuming.");
  return jsonResponse({ contestId, state: resumedState, logicalSeconds: row.logical_anchor_seconds, resumedAt: timestamp });
}

export async function previewPendingContestRules(request: Request, env: WasmOjWorkerEnv, contestId: string): Promise<Response> {
  const session = await requireBrowserMutationSession(request, env);
  await requireOrganizer(env, session);
  const runtime = await ownedOperationalRuntime(env, contestId, session);
  const pending = await pendingRulesRow(env, contestId);
  if (!pending.pending_rules_commit || !pending.pending_rules_sha256 || !pending.pending_rules_json) {
    return jsonResponse({ contestId, pending: null }, 200, { "cache-control": "private, no-store" });
  }
  const activeRules = parseContestRules(JSON.parse(pending.active_rules_json) as unknown, "active contest rules");
  const pendingRules = parseContestRules(JSON.parse(pending.pending_rules_json) as unknown, "pending contest rules");
  const immutable = immutableRuleChanges(activeRules, pendingRules);
  const rewindZero = rewindZeroRuleChanges(activeRules, pendingRules);
  return jsonResponse({
    contestId,
    pending: {
      activeRulesCommit: pending.active_rules_commit,
      activeRulesDigest: pending.active_rules_sha256,
      rulesCommit: pending.pending_rules_commit,
      rulesDigest: pending.pending_rules_sha256,
      state: runtime.state,
      logicalSeconds: runtime.logical_anchor_seconds,
      timelineGeneration: runtime.timeline_generation,
      ruleEpoch: runtime.rules_epoch,
      firstStarted: runtime.first_started_at !== null,
      immutableChanges: immutable,
      rewindToZeroChanges: rewindZero,
      canMonotonicRecalculate: runtime.state === "paused"
        && immutable.length === 0 && rewindZero.length === 0,
      canRewind: runtime.state === "paused" && immutable.length === 0,
      requiresRewindToZero: rewindZero.length > 0,
    },
  }, 200, { "cache-control": "private, no-store" });
}

export async function activatePendingContestRules(request: Request, env: WasmOjWorkerEnv, contestId: string): Promise<Response> {
  const session = await requireBrowserMutationSession(request, env);
  await requireOrganizer(env, session);
  await requireFormalMutationsEnabled(env, request);
  const body = exactRecord(await readJsonBody(request, 8 * 1024), ["mode", "reason"], ["rewindTargetLogicalSeconds"]);
  if (body.mode !== "monotonic-recalculate" && body.mode !== "rewind") {
    throw new ApiError(400, "contest-rule-activation-mode-invalid", "Rule activation mode is invalid.");
  }
  if (typeof body.reason !== "string" || body.reason.trim().length < 1 || body.reason.length > 500) {
    throw new ApiError(400, "contest-rule-activation-reason-invalid", "Activation reason must contain 1–500 characters.");
  }
  if (body.mode === "monotonic-recalculate" && body.rewindTargetLogicalSeconds !== undefined) {
    throw new ApiError(400, "contest-rule-activation-target-invalid", "Monotonic recalculation does not accept a rewind target.");
  }
  if (body.mode === "rewind"
    && (!Number.isSafeInteger(body.rewindTargetLogicalSeconds) || (body.rewindTargetLogicalSeconds as number) < 0)) {
    throw new ApiError(400, "contest-rule-activation-target-invalid", "Rewind activation requires a non-negative logical target.");
  }
  const runtime = await ownedOperationalRuntime(env, contestId, session);
  if (runtime.state !== "paused") throw new ApiError(409, "contest-not-paused", "Pause the contest before activating rules.");
  const pending = await pendingRulesRow(env, contestId);
  if (!pending.pending_rules_commit || !pending.pending_rules_sha256
    || !pending.pending_activation_sha256 || !pending.pending_rules_json) {
    throw new ApiError(409, "contest-rules-not-pending", "No pending repository rules are available.");
  }
  const activeRules = parseContestRules(JSON.parse(pending.active_rules_json) as unknown, "active contest rules");
  const nextRules = parseContestRules(JSON.parse(pending.pending_rules_json) as unknown, "pending contest rules");
  const immutable = immutableRuleChanges(activeRules, nextRules);
  if (runtime.first_started_at !== null && immutable.length > 0) {
    throw new ApiError(409, "contest-rules-immutable", `Started contest fields cannot change: ${immutable.join(", ")}.`);
  }
  const zeroOnly = rewindZeroRuleChanges(activeRules, nextRules);
  const rewindTarget = body.mode === "rewind" ? body.rewindTargetLogicalSeconds as number : null;
  if (zeroOnly.length > 0 && (body.mode !== "rewind" || rewindTarget !== 0)) {
    throw new ApiError(409, "contest-rules-require-zero-rewind", `These fields require rewind to logical time 0: ${zeroOnly.join(", ")}.`);
  }
  let maximumCurrent = runtime.logical_anchor_seconds;
  if (runtime.clock_kind === "individual") {
    const aggregate = await env.DB.prepare(`SELECT COALESCE(MAX(individual_logical_anchor_seconds), 0) AS maximum
      FROM contest_entrants WHERE contest_id=? AND started_at IS NOT NULL`)
      .bind(contestId).first<{ readonly maximum: number }>();
    maximumCurrent = aggregate?.maximum ?? 0;
  }
  if (rewindTarget !== null && (rewindTarget > maximumCurrent || rewindTarget > runtime.duration_seconds)) {
    throw new ApiError(409, "contest-rewind-target-future", "Rewind target must not exceed current logical time.");
  }
  const activationNow = new Date();
  const timestamp = activationNow.toISOString();
  const reason = body.reason.trim();
  const oldGeneration = runtime.timeline_generation;
  const newGeneration = body.mode === "rewind" ? oldGeneration + 1 : oldGeneration;
  const newRuleEpoch = runtime.rules_epoch + 1;
  const target = rewindTarget ?? runtime.logical_anchor_seconds;
  const activationKind = body.mode;
  const eventType = body.mode === "rewind" ? "rewind" : "rules-recalculated";
  const eventKey = `${eventType}:${oldGeneration}:${newRuleEpoch}:${crypto.randomUUID()}`;
  const statements: D1PreparedStatement[] = [
    env.DB.prepare(`UPDATE contest_runtimes
      SET active_rules_commit=?, active_rules_sha256=?, active_activation_sha256=?,
          pending_rules_commit=NULL, pending_rules_sha256=NULL, pending_activation_sha256=NULL,
          rules_epoch=?, timeline_generation=?, logical_anchor_seconds=MIN(logical_anchor_seconds, ?),
          pause_reason=?, updated_at=?
      WHERE contest_id=? AND state='paused' AND timeline_generation=? AND rules_epoch=?
        AND pending_rules_commit=? AND pending_rules_sha256=? AND pending_activation_sha256=?`)
      .bind(
        pending.pending_rules_commit, pending.pending_rules_sha256, pending.pending_activation_sha256,
        newRuleEpoch, newGeneration, target, reason, timestamp, contestId,
        oldGeneration, runtime.rules_epoch, pending.pending_rules_commit,
        pending.pending_rules_sha256, pending.pending_activation_sha256,
      ),
    env.DB.prepare(`INSERT INTO contest_rule_epochs
      (contest_id, rules_epoch, rules_commit, rules_sha256, timeline_generation,
       activation_kind, activated_logical_seconds, activated_at, activated_by)
      SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?
      WHERE EXISTS (SELECT 1 FROM contest_runtimes
        WHERE contest_id=? AND rules_epoch=? AND timeline_generation=?
          AND active_rules_commit=? AND updated_at=? AND state='paused')`)
      .bind(
        contestId, newRuleEpoch, pending.pending_rules_commit, pending.pending_rules_sha256,
        newGeneration, activationKind, target, timestamp, session.userId,
        contestId, newRuleEpoch, newGeneration, pending.pending_rules_commit, timestamp,
      ),
    env.DB.prepare(`INSERT INTO contest_problem_epochs
      (contest_id, problem_id, problem_epoch, rules_epoch, content_epoch, judge_epoch,
       content_commit, judge_commit, judge_digest, state, rollout_batch_id,
       created_at, effective_at, failure_code)
      SELECT rules.contest_id, rules.problem_id,
        COALESCE((SELECT MAX(history.problem_epoch)+1 FROM contest_problem_epochs AS history
          WHERE history.contest_id=rules.contest_id AND history.problem_id=rules.problem_id), 1),
        ?,
        COALESCE((SELECT MAX(history.content_epoch)+1 FROM contest_problem_epochs AS history
          WHERE history.contest_id=rules.contest_id AND history.problem_id=rules.problem_id), 1),
        COALESCE((SELECT MAX(history.judge_epoch)+1 FROM contest_problem_epochs AS history
          WHERE history.contest_id=rules.contest_id AND history.problem_id=rules.problem_id), 1),
        ?, ?, revisions.judge_digest, 'effective', NULL, ?, ?, NULL
      FROM contest_rule_problems AS rules
      JOIN problem_revisions AS revisions
        ON revisions.problem_id=rules.problem_id AND revisions.commit_sha=?
      WHERE rules.contest_id=? AND rules.rules_commit=?
        AND EXISTS (SELECT 1 FROM contest_runtimes AS runtime
          WHERE runtime.contest_id=rules.contest_id AND runtime.rules_epoch=?
            AND runtime.timeline_generation=? AND runtime.active_rules_commit=?
            AND runtime.updated_at=? AND runtime.state='paused')
        AND NOT EXISTS (SELECT 1 FROM contest_problem_epochs AS current
          WHERE current.contest_id=rules.contest_id AND current.problem_id=rules.problem_id
            AND current.state='effective')`)
      .bind(
        newRuleEpoch, pending.pending_rules_commit, pending.pending_rules_commit,
        timestamp, timestamp, pending.pending_rules_commit, contestId, pending.pending_rules_commit,
        newRuleEpoch, newGeneration, pending.pending_rules_commit, timestamp,
      ),
    env.DB.prepare(`INSERT INTO contest_problem_prompt_contexts
        (contest_id, problem_id, content_epoch, public_context_sha256, created_at)
      SELECT epochs.contest_id, epochs.problem_id, epochs.content_epoch,
        revisions.contest_bundle_sha256, ?
      FROM contest_problem_epochs AS epochs
      JOIN problem_revisions AS revisions
        ON revisions.problem_id=epochs.problem_id AND revisions.commit_sha=epochs.content_commit
      JOIN prompt_public_contexts AS contexts
        ON contexts.sha256=revisions.contest_bundle_sha256
      WHERE epochs.contest_id=? AND epochs.rules_epoch=?
        AND EXISTS (SELECT 1 FROM contest_runtimes AS runtime
          WHERE runtime.contest_id=epochs.contest_id AND runtime.rules_epoch=?
            AND runtime.timeline_generation=? AND runtime.active_rules_commit=?
            AND runtime.updated_at=? AND runtime.state='paused')
      ON CONFLICT(contest_id, problem_id, content_epoch) DO NOTHING`)
      .bind(
        timestamp, contestId, newRuleEpoch,
        newRuleEpoch, newGeneration, pending.pending_rules_commit, timestamp,
      ),
    env.DB.prepare(`UPDATE contest_submission_records AS record
      SET eligibility='invalid', invalidated_at=?, invalidation_reason='rules-recalculated'
      WHERE record.contest_id=? AND record.eligibility='eligible'
        AND EXISTS (SELECT 1 FROM contest_runtimes AS runtime
          WHERE runtime.contest_id=record.contest_id AND runtime.rules_epoch=?
            AND runtime.timeline_generation=? AND runtime.active_rules_commit=?
            AND runtime.updated_at=? AND runtime.state='paused')
        AND EXISTS (SELECT 1 FROM submissions WHERE submissions.id=record.submission_id
          AND NOT EXISTS (SELECT 1 FROM contest_rule_problems AS rule_problem
            WHERE rule_problem.contest_id=record.contest_id AND rule_problem.rules_commit=?
              AND rule_problem.problem_id=submissions.problem_id
              AND record.admitted_logical_seconds>=rule_problem.release_after_seconds
              AND record.admitted_logical_seconds<rule_problem.submission_closes_after_seconds))`)
      .bind(
        timestamp, contestId, newRuleEpoch, newGeneration,
        pending.pending_rules_commit, timestamp, pending.pending_rules_commit,
      ),
    env.DB.prepare(`WITH ranked AS (
        SELECT record.submission_id, rule_problem.attempt_limit,
          ROW_NUMBER() OVER (PARTITION BY record.entrant_id, submissions.problem_id
            ORDER BY record.admitted_logical_seconds, submissions.origin_submitted_at, record.submission_id) AS ordinal
        FROM contest_submission_records AS record
        JOIN submissions ON submissions.id=record.submission_id
        JOIN contest_rule_problems AS rule_problem
          ON rule_problem.contest_id=record.contest_id
         AND rule_problem.rules_commit=? AND rule_problem.problem_id=submissions.problem_id
        WHERE record.contest_id=? AND record.eligibility='eligible'
          AND EXISTS (SELECT 1 FROM contest_runtimes AS runtime
            WHERE runtime.contest_id=record.contest_id AND runtime.rules_epoch=?
              AND runtime.timeline_generation=? AND runtime.active_rules_commit=?
              AND runtime.updated_at=? AND runtime.state='paused')
          AND submissions.origin_submission_id=submissions.id
      )
      UPDATE contest_submission_records
      SET eligibility='invalid', invalidated_at=?, invalidation_reason='attempt-limit-recalculated'
      WHERE submission_id IN (SELECT submission_id FROM ranked WHERE ordinal>attempt_limit)`)
      .bind(
        pending.pending_rules_commit, contestId, newRuleEpoch, newGeneration,
        pending.pending_rules_commit, timestamp, timestamp,
      ),
    env.DB.prepare(`UPDATE prompt_attempts AS attempt
      SET eligibility='invalid', invalidated_at=?, invalidation_reason='rules-recalculated', updated_at=?
      WHERE attempt.contest_id=? AND attempt.eligibility='eligible'
        AND EXISTS (SELECT 1 FROM contest_runtimes AS runtime
          WHERE runtime.contest_id=attempt.contest_id AND runtime.rules_epoch=?
            AND runtime.timeline_generation=? AND runtime.active_rules_commit=?
            AND runtime.updated_at=? AND runtime.state='paused')
        AND NOT EXISTS (SELECT 1 FROM contest_rule_problems AS rule_problem
          WHERE rule_problem.contest_id=attempt.contest_id AND rule_problem.rules_commit=?
            AND rule_problem.problem_id=attempt.problem_id
            AND attempt.admitted_logical_seconds>=rule_problem.release_after_seconds
            AND attempt.admitted_logical_seconds<rule_problem.submission_closes_after_seconds)`)
      .bind(
        timestamp, timestamp, contestId, newRuleEpoch, newGeneration,
        pending.pending_rules_commit, timestamp, pending.pending_rules_commit,
      ),
    env.DB.prepare(`WITH ranked AS (
        SELECT attempt.id, rule_problem.attempt_limit,
          ROW_NUMBER() OVER (PARTITION BY attempt.entrant_id, attempt.problem_id
            ORDER BY attempt.admitted_logical_seconds, attempt.created_at, attempt.id) AS ordinal
        FROM prompt_attempts AS attempt
        JOIN contest_rule_problems AS rule_problem
          ON rule_problem.contest_id=attempt.contest_id
         AND rule_problem.rules_commit=? AND rule_problem.problem_id=attempt.problem_id
        WHERE attempt.contest_id=? AND attempt.eligibility='eligible'
          AND EXISTS (SELECT 1 FROM contest_runtimes AS runtime
            WHERE runtime.contest_id=attempt.contest_id AND runtime.rules_epoch=?
              AND runtime.timeline_generation=? AND runtime.active_rules_commit=?
              AND runtime.updated_at=? AND runtime.state='paused')
      )
      UPDATE prompt_attempts
      SET eligibility='invalid', invalidated_at=?, invalidation_reason='attempt-limit-recalculated',
          updated_at=?
      WHERE id IN (SELECT id FROM ranked WHERE ordinal>attempt_limit)`)
      .bind(
        pending.pending_rules_commit, contestId, newRuleEpoch, newGeneration,
        pending.pending_rules_commit, timestamp, timestamp, timestamp,
      ),
  ];
  if (body.mode === "rewind") {
    statements.push(
      env.DB.prepare(`UPDATE contest_entrants
        SET individual_logical_anchor_seconds=CASE WHEN started_at IS NULL
              THEN individual_logical_anchor_seconds ELSE MIN(individual_logical_anchor_seconds, ?) END,
            state=CASE WHEN started_at IS NULL THEN 'joined' ELSE 'active' END,
            state_timeline_generation=?,
            eliminated_at=NULL, eliminated_logical_seconds=NULL,
            eliminated_checkpoint_id=NULL, elimination_reason=NULL,
            updated_at=?
        WHERE contest_id=? AND state_timeline_generation=?
          AND EXISTS (SELECT 1 FROM contest_runtimes
            WHERE contest_id=? AND timeline_generation=? AND rules_epoch=?
              AND active_rules_commit=? AND updated_at=? AND state='paused')`)
        .bind(
          target, newGeneration, timestamp, contestId, oldGeneration,
          contestId, newGeneration, newRuleEpoch, pending.pending_rules_commit, timestamp,
        ),
      env.DB.prepare(`UPDATE contest_reveal_grants
        SET eligibility='invalid', invalidated_at=?, invalidation_reason='timeline-rewind'
        WHERE contest_id=? AND timeline_generation<=? AND eligibility='eligible'
          AND EXISTS (SELECT 1 FROM contest_runtimes
            WHERE contest_id=? AND timeline_generation=? AND rules_epoch=?
              AND active_rules_commit=? AND updated_at=? AND state='paused')`)
        .bind(
          timestamp, contestId, oldGeneration, contestId, newGeneration,
          newRuleEpoch, pending.pending_rules_commit, timestamp,
        ),
      env.DB.prepare(`UPDATE contest_checkpoint_runs
        SET state='invalid', invalidated_at=?, invalidation_reason='timeline-rewind'
        WHERE contest_id=? AND timeline_generation<=? AND logical_seconds>?
          AND state IN ('evaluating','provisional','final')
          AND EXISTS (SELECT 1 FROM contest_runtimes
            WHERE contest_id=? AND timeline_generation=? AND rules_epoch=?
              AND active_rules_commit=? AND updated_at=? AND state='paused')`)
        .bind(
          timestamp, contestId, oldGeneration, target, contestId, newGeneration,
          newRuleEpoch, pending.pending_rules_commit, timestamp,
        ),
      env.DB.prepare(`UPDATE contest_submission_records
        SET eligibility='invalid', invalidated_at=?, invalidation_reason='timeline-rewind'
        WHERE contest_id=? AND timeline_generation<=? AND eligibility='eligible'
          AND (evidence_logical_seconds IS NULL OR evidence_logical_seconds>
            CASE WHEN ?='individual' THEN COALESCE((SELECT individual_logical_anchor_seconds
              FROM contest_entrants WHERE contest_entrants.id=contest_submission_records.entrant_id), 0)
            ELSE ? END)
          AND EXISTS (SELECT 1 FROM contest_runtimes
            WHERE contest_id=? AND timeline_generation=? AND rules_epoch=?
              AND active_rules_commit=? AND updated_at=? AND state='paused')`)
        .bind(
          timestamp, contestId, oldGeneration, runtime.clock_kind, target,
          contestId, newGeneration, newRuleEpoch, pending.pending_rules_commit, timestamp,
        ),
      env.DB.prepare(`UPDATE prompt_attempts
        SET eligibility='invalid', invalidated_at=?, invalidation_reason='timeline-rewind', updated_at=?
        WHERE contest_id=? AND timeline_generation<=? AND eligibility='eligible'
          AND (evidence_logical_seconds IS NULL OR evidence_logical_seconds>
            CASE WHEN ?='individual' THEN COALESCE((SELECT individual_logical_anchor_seconds
              FROM contest_entrants WHERE contest_entrants.id=prompt_attempts.entrant_id), 0)
            ELSE ? END)
          AND EXISTS (SELECT 1 FROM contest_runtimes
            WHERE contest_id=? AND timeline_generation=? AND rules_epoch=?
              AND active_rules_commit=? AND updated_at=? AND state='paused')`)
        .bind(
          timestamp, timestamp, contestId, oldGeneration, runtime.clock_kind, target,
          contestId, newGeneration, newRuleEpoch, pending.pending_rules_commit, timestamp,
        ),
    );
  }
  statements.push(
    env.DB.prepare(`INSERT INTO prompt_attempt_events
      (prompt_attempt_id, event_key, event_type, payload_json, created_at)
      SELECT id, 'eligibility:rules-epoch:' || ?, 'invalidated',
        json_object('reason', invalidation_reason, 'timelineGeneration', ?), ?
      FROM prompt_attempts
      WHERE contest_id=? AND eligibility='invalid' AND invalidated_at=?
      ON CONFLICT(prompt_attempt_id, event_key) DO NOTHING`)
      .bind(newRuleEpoch, newGeneration, timestamp, contestId, timestamp),
    env.DB.prepare(`UPDATE prompt_attempt_quota
      SET state='invalid', settled_at=?, settlement_reason=?
      WHERE state IN ('reserved','consumed') AND prompt_attempt_id IN (
        SELECT id FROM prompt_attempts WHERE contest_id=? AND eligibility='invalid'
      ) AND EXISTS (SELECT 1 FROM contest_runtimes
        WHERE contest_id=? AND timeline_generation=? AND rules_epoch=?
          AND active_rules_commit=? AND updated_at=? AND state='paused')`)
      .bind(
        timestamp, body.mode === "rewind" ? "timeline-rewind" : "rules-recalculated", contestId,
        contestId, newGeneration, newRuleEpoch, pending.pending_rules_commit, timestamp,
      ),
    env.DB.prepare(`INSERT INTO contest_timeline_events
      (contest_id, event_key, event_type, from_generation, to_generation,
       logical_seconds, target_logical_seconds, actor_user_id, payload_json, created_at)
      SELECT ?, ?, ?, ?, ?, ?, ?, ?, json_object('reason', ?, 'rulesCommit', ?), ?
      WHERE EXISTS (SELECT 1 FROM contest_runtimes
        WHERE contest_id=? AND rules_epoch=? AND timeline_generation=?
          AND active_rules_commit=? AND updated_at=? AND state='paused')`)
      .bind(
        contestId, eventKey, eventType, oldGeneration, newGeneration,
        maximumCurrent, rewindTarget, session.userId, reason, pending.pending_rules_commit,
        timestamp, contestId, newRuleEpoch, newGeneration,
        pending.pending_rules_commit, timestamp,
      ),
  );
  const [runtimeResult] = await env.DB.batch(statements);
  if (runtimeResult.meta.changes !== 1) throw new ApiError(409, "contest-runtime-conflict", "Contest state changed while activating rules.");
  const checkpointRecalculation = await reconcilePausedContestCheckpoints(env, {
    contestId,
    timelineGeneration: newGeneration,
    rulesEpoch: newRuleEpoch,
  }, activationNow);
  return jsonResponse({
    contestId,
    mode: body.mode,
    rulesCommit: pending.pending_rules_commit,
    rulesDigest: pending.pending_rules_sha256,
    ruleEpoch: newRuleEpoch,
    timelineGeneration: newGeneration,
    logicalSeconds: target,
    activatedAt: timestamp,
    checkpointRecalculation,
  });
}

export async function rewindContest(request: Request, env: WasmOjWorkerEnv, contestId: string): Promise<Response> {
  const session = await requireBrowserMutationSession(request, env);
  await requireOrganizer(env, session);
  await requireFormalMutationsEnabled(env, request);
  const body = exactRecord(await readJsonBody(request, 8 * 1024), ["reason", "targetLogicalSeconds"]);
  if (!Number.isSafeInteger(body.targetLogicalSeconds) || (body.targetLogicalSeconds as number) < 0) {
    throw new ApiError(400, "contest-rewind-target-invalid", "Rewind target must be a non-negative logical second.");
  }
  if (typeof body.reason !== "string" || body.reason.trim().length < 1 || body.reason.length > 500) {
    throw new ApiError(400, "contest-rewind-reason-invalid", "Rewind reason must contain 1–500 characters.");
  }
  const row = await ownedOperationalRuntime(env, contestId, session);
  if (row.state !== "paused") throw new ApiError(409, "contest-not-paused", "Pause the contest before rewinding it.");
  const target = body.targetLogicalSeconds as number;
  let maximumCurrent = row.logical_anchor_seconds;
  if (row.clock_kind === "individual") {
    const aggregate = await env.DB.prepare(`SELECT COALESCE(MAX(individual_logical_anchor_seconds), 0) AS maximum
      FROM contest_entrants WHERE contest_id=? AND started_at IS NOT NULL`)
      .bind(contestId).first<{ readonly maximum: number }>();
    maximumCurrent = aggregate?.maximum ?? 0;
  }
  if (target > maximumCurrent || target > row.duration_seconds) {
    throw new ApiError(409, "contest-rewind-target-future", "Rewind target must not exceed current logical time.");
  }
  const oldGeneration = row.timeline_generation;
  const newGeneration = oldGeneration + 1;
  const rewindNow = new Date();
  const timestamp = rewindNow.toISOString();
  const reason = body.reason.trim();
  const eventKey = `rewind:${oldGeneration}:${newGeneration}:${crypto.randomUUID()}`;
  const statements: D1PreparedStatement[] = [
    env.DB.prepare(`UPDATE contest_runtimes
      SET timeline_generation=?, logical_anchor_seconds=MIN(logical_anchor_seconds, ?),
          pause_reason=?, updated_at=?
      WHERE contest_id=? AND timeline_generation=? AND state='paused'`)
      .bind(newGeneration, target, reason, timestamp, contestId, oldGeneration),
    env.DB.prepare(`UPDATE contest_entrants
      SET individual_logical_anchor_seconds=CASE WHEN started_at IS NULL
            THEN individual_logical_anchor_seconds
            ELSE MIN(individual_logical_anchor_seconds, ?) END,
          state=CASE WHEN started_at IS NULL THEN 'joined' ELSE 'active' END,
          state_timeline_generation=?,
          eliminated_at=NULL, eliminated_logical_seconds=NULL,
          eliminated_checkpoint_id=NULL, elimination_reason=NULL,
          updated_at=?
      WHERE contest_id=? AND state_timeline_generation=?
        AND EXISTS (SELECT 1 FROM contest_runtimes
          WHERE contest_id=? AND timeline_generation=? AND rules_epoch=?
            AND updated_at=? AND state='paused')`)
      .bind(
        target, newGeneration, timestamp, contestId, oldGeneration,
        contestId, newGeneration, row.rules_epoch, timestamp,
      ),
    env.DB.prepare(`UPDATE contest_reveal_grants
      SET eligibility='invalid', invalidated_at=?, invalidation_reason='timeline-rewind'
      WHERE contest_id=? AND timeline_generation<=? AND eligibility='eligible'
        AND EXISTS (SELECT 1 FROM contest_runtimes
          WHERE contest_id=? AND timeline_generation=? AND rules_epoch=?
            AND updated_at=? AND state='paused')`)
      .bind(
        timestamp, contestId, oldGeneration, contestId, newGeneration,
        row.rules_epoch, timestamp,
      ),
    env.DB.prepare(`UPDATE contest_checkpoint_runs
      SET state='invalid', invalidated_at=?, invalidation_reason='timeline-rewind'
      WHERE contest_id=? AND timeline_generation<=? AND logical_seconds>?
        AND state IN ('evaluating','provisional','final')
        AND EXISTS (SELECT 1 FROM contest_runtimes
          WHERE contest_id=? AND timeline_generation=? AND rules_epoch=?
            AND updated_at=? AND state='paused')`)
      .bind(
        timestamp, contestId, oldGeneration, target, contestId, newGeneration,
        row.rules_epoch, timestamp,
      ),
    env.DB.prepare(`UPDATE contest_submission_records
      SET eligibility='invalid', invalidated_at=?, invalidation_reason='timeline-rewind'
      WHERE contest_id=? AND timeline_generation<=? AND eligibility='eligible'
        AND (evidence_logical_seconds IS NULL OR evidence_logical_seconds>
          CASE WHEN ?='individual' THEN COALESCE((SELECT individual_logical_anchor_seconds
            FROM contest_entrants WHERE contest_entrants.id=contest_submission_records.entrant_id), 0)
          ELSE ? END)
        AND EXISTS (SELECT 1 FROM contest_runtimes
          WHERE contest_id=? AND timeline_generation=? AND rules_epoch=?
            AND updated_at=? AND state='paused')`)
      .bind(
        timestamp, contestId, oldGeneration, row.clock_kind, target,
        contestId, newGeneration, row.rules_epoch, timestamp,
      ),
    env.DB.prepare(`UPDATE prompt_attempts
      SET eligibility='invalid', invalidated_at=?, invalidation_reason='timeline-rewind', updated_at=?
      WHERE contest_id=? AND timeline_generation<=? AND eligibility='eligible'
        AND (evidence_logical_seconds IS NULL OR evidence_logical_seconds>
          CASE WHEN ?='individual' THEN COALESCE((SELECT individual_logical_anchor_seconds
            FROM contest_entrants WHERE contest_entrants.id=prompt_attempts.entrant_id), 0)
          ELSE ? END)
        AND EXISTS (SELECT 1 FROM contest_runtimes
          WHERE contest_id=? AND timeline_generation=? AND rules_epoch=?
            AND updated_at=? AND state='paused')`)
      .bind(
        timestamp, timestamp, contestId, oldGeneration, row.clock_kind, target,
        contestId, newGeneration, row.rules_epoch, timestamp,
      ),
    env.DB.prepare(`UPDATE prompt_attempt_quota
      SET state='invalid', settled_at=?, settlement_reason='timeline-rewind'
      WHERE state IN ('reserved','consumed') AND prompt_attempt_id IN (
        SELECT id FROM prompt_attempts WHERE contest_id=? AND eligibility='invalid'
      ) AND EXISTS (SELECT 1 FROM contest_runtimes
        WHERE contest_id=? AND timeline_generation=? AND rules_epoch=?
          AND updated_at=? AND state='paused')`)
      .bind(
        timestamp, contestId, contestId, newGeneration, row.rules_epoch, timestamp,
      ),
    env.DB.prepare(`INSERT INTO prompt_attempt_events
      (prompt_attempt_id, event_key, event_type, payload_json, created_at)
      SELECT id, 'eligibility:timeline-rewind:' || ?, 'invalidated',
        json_object('reason', 'timeline-rewind', 'timelineGeneration', ?), ?
      FROM prompt_attempts
      WHERE contest_id=? AND eligibility='invalid' AND invalidated_at=?
        AND invalidation_reason='timeline-rewind'
      ON CONFLICT(prompt_attempt_id, event_key) DO NOTHING`)
      .bind(newGeneration, newGeneration, timestamp, contestId, timestamp),
    env.DB.prepare(`INSERT INTO contest_timeline_events
      (contest_id, event_key, event_type, from_generation, to_generation,
       logical_seconds, target_logical_seconds, actor_user_id, payload_json, created_at)
      SELECT ?, ?, 'rewind', ?, ?, ?, ?, ?, json_object('reason', ?), ?
      WHERE EXISTS (SELECT 1 FROM contest_runtimes
        WHERE contest_id=? AND timeline_generation=? AND rules_epoch=?
          AND updated_at=? AND state='paused')`)
      .bind(
        contestId, eventKey, oldGeneration, newGeneration, maximumCurrent, target,
        session.userId, reason, timestamp, contestId, newGeneration,
        row.rules_epoch, timestamp,
      ),
  ];
  const [runtimeResult] = await env.DB.batch(statements);
  if (runtimeResult.meta.changes !== 1) throw new ApiError(409, "contest-runtime-conflict", "Contest state changed while rewinding.");
  const checkpointRecalculation = await reconcilePausedContestCheckpoints(env, {
    contestId,
    timelineGeneration: newGeneration,
    rulesEpoch: row.rules_epoch,
  }, rewindNow);
  return jsonResponse({
    contestId,
    state: "paused",
    fromTimelineGeneration: oldGeneration,
    timelineGeneration: newGeneration,
    targetLogicalSeconds: target,
    rewoundAt: timestamp,
    checkpointRecalculation,
  });
}
