import type {
  ContestCheckpointDecision,
  ContestCheckpointRule,
  ContestResultFact,
  ContestRules,
  ContestStanding,
} from "../src/online-judge/contest-rules";
import { ContestRuleEngine, parseContestRules } from "../src/online-judge/contest-rules";
import type { WasmOjWorkerEnv } from "./env";

const RUNTIME_SCAN_LIMIT = 20;
const CHECKPOINT_WORK_LIMIT = 50;
const TERMINAL_SUBMISSION_STATES = new Set([
  "completed",
  "compile-error",
  "judge-error",
  "infrastructure-error",
  "cancelled",
]);

interface RuntimeRow {
  readonly contest_id: string;
  readonly organizer_user_id: string;
  readonly active_rules_commit: string;
  readonly rules_epoch: number;
  readonly timeline_generation: number;
  readonly state: "scheduled" | "running" | "paused" | "ended";
  readonly wall_anchor_at: string | null;
  readonly logical_anchor_seconds: number;
  readonly pause_reason: string | null;
  readonly activation_kind: "initial" | "monotonic-recalculate" | "rewind";
  readonly has_generation_rewind: number;
  readonly rules_json: string;
}

interface EntrantRow {
  readonly id: string;
  readonly state: "joined" | "active" | "eliminated" | "completed";
  readonly started_at: string | null;
  readonly individual_wall_anchor_at: string | null;
  readonly individual_logical_anchor_seconds: number;
}

interface CheckpointRunRow {
  readonly id: string;
  readonly checkpoint_id: string;
  readonly state: "evaluating" | "provisional" | "final" | "invalid";
  readonly settlement: "provisional" | "pause-until-terminal";
}

interface StoredDecisionRow {
  readonly checkpoint_run_id: string;
  readonly checkpoint_id: string;
  readonly entrant_id: string;
  readonly decision: "advanced" | "eliminated";
  readonly provisional: number;
}

interface SubmissionWorkRow {
  readonly entrant_id: string;
  readonly problem_slug: string;
  readonly origin_state: string;
  readonly result_state: string | null;
  readonly verdict: ContestResultFact["verdict"] | null;
  readonly score: number | null;
  readonly fully_passed_cases: number | null;
  readonly deterministic_cost: number | null;
  readonly peak_memory_bytes: number | null;
  readonly evidence_logical_seconds: number | null;
  readonly admitted_logical_seconds: number;
}

interface PromptWorkRow {
  readonly entrant_id: string;
  readonly problem_slug: string;
  readonly state: string;
  readonly admitted_logical_seconds: number;
}

interface Evaluation {
  readonly standings: readonly ContestStanding[];
  readonly decisions: readonly ContestCheckpointDecision[];
  readonly pendingWork: number;
}

export interface ContestCheckpointReconciliation {
  readonly visited: number;
  readonly created: number;
  readonly provisional: number;
  readonly finalized: number;
  readonly eliminated: number;
  readonly paused: number;
  readonly resumed: number;
}

interface MutableCounts {
  visited: number;
  created: number;
  provisional: number;
  finalized: number;
  eliminated: number;
  paused: number;
  resumed: number;
}

function clampLogicalSeconds(value: number, durationSeconds: number): number {
  if (!Number.isFinite(value)) throw new TypeError("Contest runtime logical time is invalid.");
  return Math.max(0, Math.min(durationSeconds, Math.floor(value)));
}

function globalLogicalSeconds(runtime: RuntimeRow, rules: ContestRules, now: Date): number {
  if (runtime.state !== "running") return clampLogicalSeconds(runtime.logical_anchor_seconds, rules.clock.durationSeconds);
  if (!runtime.wall_anchor_at) throw new TypeError("Running contest runtime is missing its wall anchor.");
  const anchor = Date.parse(runtime.wall_anchor_at);
  if (!Number.isFinite(anchor)) throw new TypeError("Contest runtime wall anchor is invalid.");
  return clampLogicalSeconds(
    runtime.logical_anchor_seconds + Math.max(0, (now.getTime() - anchor) / 1_000),
    rules.clock.durationSeconds,
  );
}

function individualLogicalSeconds(runtime: RuntimeRow, entrant: EntrantRow, rules: ContestRules, now: Date): number {
  if (runtime.state !== "running" || !entrant.individual_wall_anchor_at) {
    return clampLogicalSeconds(entrant.individual_logical_anchor_seconds, rules.clock.durationSeconds);
  }
  const anchor = Date.parse(entrant.individual_wall_anchor_at);
  if (!Number.isFinite(anchor)) throw new TypeError("Contest entrant wall anchor is invalid.");
  return clampLogicalSeconds(
    entrant.individual_logical_anchor_seconds + Math.max(0, (now.getTime() - anchor) / 1_000),
    rules.clock.durationSeconds,
  );
}

function checkpointProblemSlugs(rules: ContestRules, checkpoint: ContestCheckpointRule): ReadonlySet<string> {
  if (checkpoint.scope.kind === "problems") return new Set(checkpoint.scope.slugs);
  const batch = checkpoint.scope.kind === "batch" ? checkpoint.scope.batch : null;
  return new Set(rules.problems
    .filter((problem) => problem.releaseAfterSeconds <= checkpoint.atSeconds
      && (batch === null || problem.batch === batch))
    .map((problem) => problem.slug));
}

function competitiveKey(standing: ContestStanding): string {
  return JSON.stringify({
    achievedAtSeconds: standing.achievedAtSeconds,
    deterministicCost: standing.deterministicCost,
    fullyPassedCases: standing.fullyPassedCases,
    furthestCheckpoint: standing.furthestCheckpoint,
    peakMemoryBytes: standing.peakMemoryBytes,
    penaltyMinutes: standing.penaltyMinutes,
    rank: standing.rank,
    score: standing.score,
    solved: standing.solved,
  });
}

async function runtimes(env: WasmOjWorkerEnv): Promise<readonly RuntimeRow[]> {
  const rows = await env.DB.prepare(`SELECT runtime.contest_id, catalogs.organizer_user_id,
      runtime.active_rules_commit, runtime.rules_epoch, runtime.timeline_generation,
      runtime.state, runtime.wall_anchor_at, runtime.logical_anchor_seconds,
      runtime.pause_reason, epochs.activation_kind,
      EXISTS (SELECT 1 FROM contest_timeline_events AS event
        WHERE event.contest_id=runtime.contest_id AND event.event_type='rewind'
          AND event.to_generation=runtime.timeline_generation) AS has_generation_rewind,
      revisions.rules_json
    FROM contest_runtimes AS runtime
    JOIN contest_series AS series ON series.id=runtime.contest_id
    JOIN catalogs ON catalogs.id=series.catalog_id
    JOIN contest_rule_revisions AS revisions
      ON revisions.contest_id=runtime.contest_id
     AND revisions.rules_commit=runtime.active_rules_commit
     AND revisions.rules_sha256=runtime.active_rules_sha256
    JOIN contest_rule_epochs AS epochs
      ON epochs.contest_id=runtime.contest_id AND epochs.rules_epoch=runtime.rules_epoch
    WHERE revisions.status='published' AND runtime.state IN ('running','paused','ended')
    ORDER BY runtime.updated_at, runtime.contest_id
    LIMIT ?`).bind(RUNTIME_SCAN_LIMIT).all<RuntimeRow>();
  return rows.results;
}

async function exactRuntime(
  env: WasmOjWorkerEnv,
  contestId: string,
  timelineGeneration: number,
  rulesEpoch: number,
): Promise<RuntimeRow | null> {
  return env.DB.prepare(`SELECT runtime.contest_id, catalogs.organizer_user_id,
      runtime.active_rules_commit, runtime.rules_epoch, runtime.timeline_generation,
      runtime.state, runtime.wall_anchor_at, runtime.logical_anchor_seconds,
      runtime.pause_reason, epochs.activation_kind,
      EXISTS (SELECT 1 FROM contest_timeline_events AS event
        WHERE event.contest_id=runtime.contest_id AND event.event_type='rewind'
          AND event.to_generation=runtime.timeline_generation) AS has_generation_rewind,
      revisions.rules_json
    FROM contest_runtimes AS runtime
    JOIN contest_series AS series ON series.id=runtime.contest_id
    JOIN catalogs ON catalogs.id=series.catalog_id
    JOIN contest_rule_revisions AS revisions
      ON revisions.contest_id=runtime.contest_id
     AND revisions.rules_commit=runtime.active_rules_commit
     AND revisions.rules_sha256=runtime.active_rules_sha256
    JOIN contest_rule_epochs AS epochs
      ON epochs.contest_id=runtime.contest_id AND epochs.rules_epoch=runtime.rules_epoch
    WHERE runtime.contest_id=? AND runtime.timeline_generation=? AND runtime.rules_epoch=?
      AND revisions.status='published'`)
    .bind(contestId, timelineGeneration, rulesEpoch).first<RuntimeRow>();
}

async function entrantRows(env: WasmOjWorkerEnv, runtime: RuntimeRow): Promise<readonly EntrantRow[]> {
  const rows = await env.DB.prepare(`SELECT id, state, started_at,
      individual_wall_anchor_at, individual_logical_anchor_seconds
    FROM contest_entrants
    WHERE contest_id=? AND state_timeline_generation=?
    ORDER BY id`)
    .bind(runtime.contest_id, runtime.timeline_generation).all<EntrantRow>();
  return rows.results;
}

async function checkpointRuns(
  env: WasmOjWorkerEnv,
  runtime: RuntimeRow,
): Promise<Map<string, CheckpointRunRow>> {
  const rows = await env.DB.prepare(`SELECT id, checkpoint_id, state, settlement
    FROM contest_checkpoint_runs
    WHERE contest_id=? AND timeline_generation=? AND rules_epoch=? AND state<>'invalid'
    ORDER BY logical_seconds, checkpoint_id`)
    .bind(runtime.contest_id, runtime.timeline_generation, runtime.rules_epoch).all<CheckpointRunRow>();
  return new Map(rows.results.map((row) => [row.checkpoint_id, row]));
}

async function storedDecisions(
  env: WasmOjWorkerEnv,
  runtime: RuntimeRow,
): Promise<readonly StoredDecisionRow[]> {
  const rows = await env.DB.prepare(`SELECT decisions.checkpoint_run_id, runs.checkpoint_id,
      decisions.entrant_id, decisions.decision, decisions.provisional
    FROM contest_checkpoint_decisions AS decisions
    JOIN contest_checkpoint_runs AS runs ON runs.id=decisions.checkpoint_run_id
    WHERE runs.contest_id=? AND runs.timeline_generation=? AND runs.rules_epoch=?
      AND runs.state<>'invalid'
    ORDER BY runs.logical_seconds, decisions.entrant_id`)
    .bind(runtime.contest_id, runtime.timeline_generation, runtime.rules_epoch).all<StoredDecisionRow>();
  return rows.results;
}

function passedCheckpointCounts(decisions: readonly StoredDecisionRow[]): Readonly<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const decision of decisions) {
    if (decision.provisional === 0 && decision.decision === "advanced") {
      counts[decision.entrant_id] = (counts[decision.entrant_id] ?? 0) + 1;
    }
  }
  return counts;
}

async function submissionWork(
  env: WasmOjWorkerEnv,
  runtime: RuntimeRow,
  checkpoint: ContestCheckpointRule,
  evidenceAt: ContestRules["evidenceAt"],
): Promise<readonly SubmissionWorkRow[]> {
  const rows = await env.DB.prepare(`SELECT records.entrant_id, problems.slug AS problem_slug,
      origins.state AS origin_state, results.state AS result_state,
      results.verdict, results.score, results.fully_passed_cases,
      results.deterministic_cost, results.peak_memory_bytes,
      records.evidence_logical_seconds, records.admitted_logical_seconds
    FROM contest_submission_records AS records
    JOIN submissions AS origins
      ON origins.id=records.submission_id AND origins.origin_submission_id=origins.id
    JOIN problem_series AS problems ON problems.id=origins.problem_id
    LEFT JOIN effective_submission_results AS links
      ON links.origin_submission_id=origins.id
    LEFT JOIN submissions AS results ON results.id=links.effective_submission_id
    WHERE records.contest_id=? AND records.timeline_generation<=?
      AND records.evidence_at=? AND records.eligibility='eligible'
      AND records.admitted_logical_seconds<=?
    ORDER BY records.entrant_id, origins.created_at, origins.id`)
    .bind(runtime.contest_id, runtime.timeline_generation, evidenceAt, checkpoint.atSeconds)
    .all<SubmissionWorkRow>();
  return rows.results;
}

async function promptWork(
  env: WasmOjWorkerEnv,
  runtime: RuntimeRow,
  checkpoint: ContestCheckpointRule,
): Promise<readonly PromptWorkRow[]> {
  const rows = await env.DB.prepare(`SELECT attempts.entrant_id,
      problems.slug AS problem_slug, attempts.state, attempts.admitted_logical_seconds
    FROM prompt_attempts AS attempts
    JOIN problem_series AS problems ON problems.id=attempts.problem_id
    JOIN prompt_attempt_quota AS quota ON quota.prompt_attempt_id=attempts.id
    WHERE attempts.contest_id=? AND attempts.timeline_generation<=?
      AND attempts.eligibility='eligible' AND attempts.admitted_logical_seconds<=?
      AND quota.state IN ('reserved','consumed')
    ORDER BY attempts.entrant_id, attempts.created_at, attempts.id`)
    .bind(runtime.contest_id, runtime.timeline_generation, checkpoint.atSeconds)
    .all<PromptWorkRow>();
  return rows.results;
}

async function unsettledJudgeRollouts(
  env: WasmOjWorkerEnv,
  runtime: RuntimeRow,
  problemSlugs: ReadonlySet<string>,
): Promise<number> {
  const slugs = [...problemSlugs].sort();
  if (slugs.length === 0) return 0;
  const row = await env.DB.prepare(`SELECT COUNT(DISTINCT epochs.problem_id) AS count
    FROM contest_problem_epochs AS epochs
    JOIN problem_series AS problems ON problems.id=epochs.problem_id
    JOIN rejudge_batches AS rollout ON rollout.id=epochs.rollout_batch_id
    WHERE epochs.contest_id=? AND epochs.state='effective'
      AND problems.slug IN (${slugs.map(() => "?").join(",")})
      AND rollout.purpose='contest-judge-rollout' AND rollout.state<>'effective'`)
    .bind(runtime.contest_id, ...slugs).first<{ readonly count: number }>();
  return row?.count ?? 0;
}

async function evaluate(
  env: WasmOjWorkerEnv,
  runtime: RuntimeRow,
  rules: ContestRules,
  checkpoint: ContestCheckpointRule,
  entrantIds: readonly string[],
  priorDecisions: readonly StoredDecisionRow[],
): Promise<Evaluation> {
  const entrantSet = new Set(entrantIds);
  const problemSlugs = checkpointProblemSlugs(rules, checkpoint);
  const work = await submissionWork(env, runtime, checkpoint, rules.evidenceAt);
  const pendingByEntrant = new Map(entrantIds.map((entrantId) => [entrantId, 0]));
  const facts: ContestResultFact[] = [];
  for (const row of work) {
    if (!entrantSet.has(row.entrant_id) || !problemSlugs.has(row.problem_slug)) continue;
    if (!TERMINAL_SUBMISSION_STATES.has(row.origin_state)) {
      pendingByEntrant.set(row.entrant_id, pendingByEntrant.get(row.entrant_id)! + 1);
      continue;
    }
    if (row.evidence_logical_seconds === null || row.evidence_logical_seconds > checkpoint.atSeconds
      || row.result_state === null || row.verdict === null) continue;
    facts.push({
      entrantId: row.entrant_id,
      problemSlug: row.problem_slug,
      verdict: row.verdict,
      score: row.score ?? 0,
      fullyPassedCases: row.fully_passed_cases ?? 0,
      deterministicCost: row.deterministic_cost ?? 0,
      peakMemoryBytes: row.peak_memory_bytes ?? 0,
      logicalSeconds: row.evidence_logical_seconds,
      eligible: true,
    });
  }
  if (rules.officialTrack.kind === "prompt-program") {
    for (const row of await promptWork(env, runtime, checkpoint)) {
      if (!entrantSet.has(row.entrant_id) || !problemSlugs.has(row.problem_slug)) continue;
      if (row.state === "reserved" || row.state === "generating" || row.state === "source-ready") {
        pendingByEntrant.set(row.entrant_id, pendingByEntrant.get(row.entrant_id)! + 1);
      }
    }
  }
  const pendingJudgeRollouts = await unsettledJudgeRollouts(env, runtime, problemSlugs);
  if (pendingJudgeRollouts > 0) {
    for (const entrantId of entrantIds) {
      pendingByEntrant.set(entrantId, pendingByEntrant.get(entrantId)! + pendingJudgeRollouts);
    }
  }
  const standings = ContestRuleEngine.rank(
    rules,
    entrantIds,
    facts,
    passedCheckpointCounts(priorDecisions),
  );
  const standingsByEntrant = new Map(standings.map((standing) => [standing.entrantId, standing]));
  const pendingWork = [...pendingByEntrant.values()].reduce((total, count) => total + count, 0);
  const rankingUnsettled = checkpoint.ranking !== null && pendingWork > 0;
  const decisions = checkpoint.settlement === "pause-until-terminal" && pendingWork > 0
    ? []
    : ContestRuleEngine.checkpoint(
      rules,
      checkpoint,
      standings,
      entrantIds.map((entrantId) => ({
        entrantId,
        solved: standingsByEntrant.get(entrantId)!.solved,
        score: standingsByEntrant.get(entrantId)!.score,
        pending: rankingUnsettled || (pendingByEntrant.get(entrantId) ?? 0) > 0,
      })),
    );
  return { standings, decisions, pendingWork };
}

async function ensureRun(
  env: WasmOjWorkerEnv,
  runtime: RuntimeRow,
  checkpoint: ContestCheckpointRule,
  population: number,
  pendingWork: number,
  now: string,
): Promise<{ readonly run: CheckpointRunRow; readonly created: boolean }> {
  const runId = crypto.randomUUID();
  const inserted = await env.DB.prepare(`INSERT INTO contest_checkpoint_runs
      (id, contest_id, checkpoint_id, timeline_generation, rules_epoch,
       logical_seconds, settlement, state, population, pending_work, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'evaluating', ?, ?, ?)
    ON CONFLICT(contest_id, timeline_generation, rules_epoch, checkpoint_id) DO NOTHING`)
    .bind(
      runId, runtime.contest_id, checkpoint.id, runtime.timeline_generation,
      runtime.rules_epoch, checkpoint.atSeconds, checkpoint.settlement,
      population, pendingWork, now,
    ).run();
  const run = await env.DB.prepare(`SELECT id, checkpoint_id, state, settlement
    FROM contest_checkpoint_runs
    WHERE contest_id=? AND timeline_generation=? AND rules_epoch=? AND checkpoint_id=?`)
    .bind(runtime.contest_id, runtime.timeline_generation, runtime.rules_epoch, checkpoint.id)
    .first<CheckpointRunRow>();
  if (!run) throw new Error("Checkpoint run creation lost its durable row.");
  return { run, created: inserted.meta.changes === 1 };
}

function automaticPauseReason(runtime: RuntimeRow, checkpoint: ContestCheckpointRule): string {
  return `checkpoint:${runtime.timeline_generation}:${checkpoint.id}`;
}

async function waitForPendingWork(
  env: WasmOjWorkerEnv,
  runtime: RuntimeRow,
  checkpoint: ContestCheckpointRule,
  run: CheckpointRunRow,
  population: number,
  pendingWork: number,
  now: string,
): Promise<boolean> {
  const pauseReason = automaticPauseReason(runtime, checkpoint);
  const results = await env.DB.batch([
    env.DB.prepare(`UPDATE contest_checkpoint_runs
      SET state='evaluating', population=?, pending_work=?
      WHERE id=? AND state IN ('evaluating','provisional')`)
      .bind(population, pendingWork, run.id),
    env.DB.prepare(`UPDATE contest_runtimes
      SET state='paused', wall_anchor_at=NULL, logical_anchor_seconds=?,
          pause_reason=?, paused_at=?, paused_from_state='running', updated_at=?
      WHERE contest_id=? AND timeline_generation=? AND rules_epoch=? AND state='running'`)
      .bind(
        checkpoint.atSeconds, pauseReason, now, now, runtime.contest_id,
        runtime.timeline_generation, runtime.rules_epoch,
      ),
    env.DB.prepare(`INSERT INTO contest_timeline_events
      (contest_id, event_key, event_type, from_generation, to_generation,
       logical_seconds, target_logical_seconds, actor_user_id, payload_json, created_at)
      SELECT ?, ?, 'pause', ?, ?, ?, NULL, ?,
        json_object('automatic', 1, 'checkpointId', ?), ?
      WHERE EXISTS (SELECT 1 FROM contest_runtimes
        WHERE contest_id=? AND timeline_generation=? AND state='paused' AND pause_reason=?)
      ON CONFLICT(contest_id, event_key) DO NOTHING`)
      .bind(
        runtime.contest_id, `checkpoint-pause:${runtime.timeline_generation}:${checkpoint.id}`,
        runtime.timeline_generation, runtime.timeline_generation, checkpoint.atSeconds,
        runtime.organizer_user_id, checkpoint.id, now,
        runtime.contest_id, runtime.timeline_generation, pauseReason,
      ),
  ]);
  return results[1]?.meta.changes === 1;
}

async function persistEvaluation(
  env: WasmOjWorkerEnv,
  runtime: RuntimeRow,
  checkpoint: ContestCheckpointRule,
  run: CheckpointRunRow,
  evaluation: Evaluation,
  stored: readonly StoredDecisionRow[],
  keepRunProvisional: boolean,
  now: string,
): Promise<{ readonly eliminated: number; readonly resumed: boolean; readonly provisional: boolean }> {
  const standingByEntrant = new Map(evaluation.standings.map((standing) => [standing.entrantId, standing]));
  const provisional = keepRunProvisional || evaluation.decisions.some((decision) => decision.provisional);
  const statements: D1PreparedStatement[] = [];
  for (const decision of evaluation.decisions) {
    statements.push(env.DB.prepare(`INSERT INTO contest_checkpoint_decisions
        (checkpoint_run_id, entrant_id, decision, provisional, competitive_key_json, decided_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(checkpoint_run_id, entrant_id) DO UPDATE SET
        decision=excluded.decision, provisional=excluded.provisional,
        competitive_key_json=excluded.competitive_key_json, decided_at=excluded.decided_at
      WHERE contest_checkpoint_decisions.provisional=1`)
      .bind(
        run.id, decision.entrantId, decision.advances ? "advanced" : "eliminated",
        decision.provisional ? 1 : 0,
        competitiveKey(standingByEntrant.get(decision.entrantId)!), now,
      ));
  }
  statements.push(env.DB.prepare(`UPDATE contest_checkpoint_runs
      SET state=?,
          population=(SELECT COUNT(*) FROM contest_checkpoint_decisions WHERE checkpoint_run_id=?),
          pending_work=?, finalized_at=?
      WHERE id=? AND state IN ('evaluating','provisional')`)
    .bind(
      provisional ? "provisional" : "final",
      run.id,
      evaluation.pendingWork,
      provisional ? null : now,
      run.id,
    ));
  const eliminationIndexes: number[] = [];
  for (const decision of evaluation.decisions) {
    const immutable = stored.find((candidate) => candidate.checkpoint_run_id === run.id
      && candidate.entrant_id === decision.entrantId && candidate.provisional === 0);
    if (immutable || decision.provisional || decision.advances) continue;
    eliminationIndexes.push(statements.length);
    const reason = `checkpoint:${checkpoint.id}`;
    statements.push(
      env.DB.prepare(`UPDATE contest_entrants
        SET state='eliminated', state_timeline_generation=?, eliminated_at=?,
            eliminated_logical_seconds=?, eliminated_checkpoint_id=?,
            elimination_reason=?, individual_wall_anchor_at=NULL, updated_at=?
        WHERE id=? AND contest_id=? AND state_timeline_generation=?
          AND state IN ('joined','active','completed')`)
        .bind(
          runtime.timeline_generation, now, checkpoint.atSeconds, checkpoint.id,
          reason, now, decision.entrantId, runtime.contest_id, runtime.timeline_generation,
        ),
      env.DB.prepare(`UPDATE contest_reveal_grants
        SET eligibility='invalid', invalidated_at=?, invalidation_reason=?
        WHERE contest_id=? AND entrant_id=? AND timeline_generation=?
          AND granted_logical_seconds>? AND eligibility='eligible'
          AND EXISTS (SELECT 1 FROM contest_entrants
            WHERE id=? AND state='eliminated' AND eliminated_checkpoint_id=?)`)
        .bind(
          now, reason, runtime.contest_id, decision.entrantId, runtime.timeline_generation,
          checkpoint.atSeconds, decision.entrantId, checkpoint.id,
        ),
      env.DB.prepare(`UPDATE contest_submission_records
        SET eligibility='invalid', invalidated_at=?, invalidation_reason=?
        WHERE contest_id=? AND entrant_id=? AND timeline_generation=?
          AND admitted_logical_seconds>? AND eligibility='eligible'
          AND EXISTS (SELECT 1 FROM contest_entrants
            WHERE id=? AND state='eliminated' AND eliminated_checkpoint_id=?)`)
        .bind(
          now, reason, runtime.contest_id, decision.entrantId, runtime.timeline_generation,
          checkpoint.atSeconds, decision.entrantId, checkpoint.id,
        ),
      env.DB.prepare(`UPDATE prompt_attempts
        SET eligibility='invalid', invalidated_at=?, invalidation_reason=?, updated_at=?
        WHERE contest_id=? AND entrant_id=? AND timeline_generation=?
          AND admitted_logical_seconds>? AND eligibility='eligible'
          AND EXISTS (SELECT 1 FROM contest_entrants
            WHERE id=? AND state='eliminated' AND eliminated_checkpoint_id=?)`)
        .bind(
          now, reason, now, runtime.contest_id, decision.entrantId,
          runtime.timeline_generation, checkpoint.atSeconds, decision.entrantId, checkpoint.id,
        ),
      env.DB.prepare(`UPDATE prompt_attempt_quota
        SET state='invalid', settled_at=?, settlement_reason=?
        WHERE state IN ('reserved','consumed') AND prompt_attempt_id IN (
          SELECT id FROM prompt_attempts
          WHERE contest_id=? AND entrant_id=? AND timeline_generation=?
            AND admitted_logical_seconds>? AND eligibility='invalid'
            AND invalidation_reason=?
        )`)
        .bind(
          now, reason, runtime.contest_id, decision.entrantId,
          runtime.timeline_generation, checkpoint.atSeconds, reason,
        ),
    );
  }
  const pauseReason = automaticPauseReason(runtime, checkpoint);
  const resumeIndex = statements.length;
  if (!provisional) {
    statements.push(
      env.DB.prepare(`UPDATE contest_runtimes
        SET state='running', wall_anchor_at=?, pause_reason=NULL,
            schedule_shift_seconds=schedule_shift_seconds
              + MAX(0, unixepoch(?) - unixepoch(paused_at)),
            paused_at=NULL, paused_from_state=NULL, updated_at=?
        WHERE contest_id=? AND timeline_generation=? AND rules_epoch=?
          AND state='paused' AND paused_from_state='running' AND pause_reason=?`)
        .bind(
          now, now, now, runtime.contest_id, runtime.timeline_generation,
          runtime.rules_epoch, pauseReason,
        ),
      env.DB.prepare(`INSERT INTO contest_timeline_events
        (contest_id, event_key, event_type, from_generation, to_generation,
         logical_seconds, target_logical_seconds, actor_user_id, payload_json, created_at)
        SELECT ?, ?, 'resume', ?, ?, ?, NULL, ?,
          json_object('automatic', 1, 'checkpointId', ?), ?
        WHERE EXISTS (SELECT 1 FROM contest_runtimes
          WHERE contest_id=? AND timeline_generation=? AND state='running'
            AND pause_reason IS NULL AND updated_at=?)
        ON CONFLICT(contest_id, event_key) DO NOTHING`)
        .bind(
          runtime.contest_id, `checkpoint-resume:${runtime.timeline_generation}:${checkpoint.id}`,
          runtime.timeline_generation, runtime.timeline_generation, checkpoint.atSeconds,
          runtime.organizer_user_id, checkpoint.id, now,
          runtime.contest_id, runtime.timeline_generation, now,
        ),
    );
  }
  const results = await env.DB.batch(statements);
  const eliminated = eliminationIndexes.reduce(
    (total, index) => total + (results[index]?.meta.changes === 1 ? 1 : 0),
    0,
  );
  return {
    eliminated,
    resumed: !provisional && results[resumeIndex]?.meta.changes === 1,
    provisional,
  };
}

function globalCohort(
  entrants: readonly EntrantRow[],
  existing: readonly StoredDecisionRow[],
  run: CheckpointRunRow | undefined,
): readonly string[] {
  if (run) {
    const stored = existing.filter((decision) => decision.checkpoint_run_id === run.id)
      .map((decision) => decision.entrant_id);
    if (stored.length > 0) return stored;
  }
  return entrants.filter((entrant) => entrant.state !== "eliminated").map((entrant) => entrant.id);
}

function individualCohort(
  entrants: readonly EntrantRow[],
  existing: readonly StoredDecisionRow[],
  priorCheckpointIds: readonly string[],
  checkpoint: ContestCheckpointRule,
  runtime: RuntimeRow,
  rules: ContestRules,
  now: Date,
): readonly string[] {
  const current = new Map(existing
    .filter((decision) => decision.checkpoint_id === checkpoint.id && decision.provisional === 1)
    .map((decision) => [decision.entrant_id, decision.entrant_id]));
  for (const entrant of entrants) {
    if (entrant.state === "eliminated" || !entrant.started_at
      || individualLogicalSeconds(runtime, entrant, rules, now) < checkpoint.atSeconds) continue;
    const passedPrior = priorCheckpointIds.every((checkpointId) => existing.some((decision) =>
      decision.checkpoint_id === checkpointId && decision.entrant_id === entrant.id
      && decision.provisional === 0 && decision.decision === "advanced"));
    if (passedPrior && !existing.some((decision) =>
      decision.checkpoint_id === checkpoint.id && decision.entrant_id === entrant.id
      && decision.provisional === 0)) current.set(entrant.id, entrant.id);
  }
  return [...current.keys()].sort();
}

async function reconcileRuntime(
  env: WasmOjWorkerEnv,
  runtime: RuntimeRow,
  now: Date,
  counts: MutableCounts,
  allowPausedNewRuns = runtime.activation_kind !== "initial" || runtime.has_generation_rewind === 1,
  workLimit = CHECKPOINT_WORK_LIMIT,
): Promise<void> {
  const rules = parseContestRules(JSON.parse(runtime.rules_json) as unknown, "stored contest rules");
  const entrants = await entrantRows(env, runtime);
  const runs = await checkpointRuns(env, runtime);
  let decisions = await storedDecisions(env, runtime);
  const globalLogical = rules.clock.kind === "global" ? globalLogicalSeconds(runtime, rules, now) : null;
  const timestamp = now.toISOString();
  for (let index = 0; index < rules.checkpoints.length && counts.visited < workLimit; index += 1) {
    const checkpoint = rules.checkpoints[index]!;
    const existingRun = runs.get(checkpoint.id);
    if (existingRun?.state === "final" || existingRun?.state === "invalid") continue;
    if (rules.clock.kind === "global") {
      const earlierUnsettled = rules.checkpoints.slice(0, index).some((prior) => {
        const priorRun = runs.get(prior.id);
        return priorRun !== undefined && priorRun.state !== "final" && priorRun.state !== "invalid";
      });
      if (earlierUnsettled || globalLogical! < checkpoint.atSeconds) break;
    }
    if (runtime.state === "paused" && existingRun === undefined && !allowPausedNewRuns) break;
    const cohort = rules.clock.kind === "global"
      ? globalCohort(entrants, decisions, existingRun)
      : individualCohort(
        entrants,
        decisions,
        rules.checkpoints.slice(0, index).map((prior) => prior.id),
        checkpoint,
        runtime,
        rules,
        now,
      );
    if (cohort.length === 0) {
      if (rules.clock.kind === "individual" && runtime.state === "ended"
        && existingRun?.state === "provisional") {
        const finalized = await env.DB.prepare(`UPDATE contest_checkpoint_runs
          SET state='final', pending_work=0, finalized_at=?
          WHERE id=? AND state='provisional'`)
          .bind(timestamp, existingRun.id).run();
        if (finalized.meta.changes === 1) counts.finalized += 1;
      }
      continue;
    }
    counts.visited += 1;
    const evaluation = await evaluate(env, runtime, rules, checkpoint, cohort, decisions);
    const ensured = existingRun
      ? { run: existingRun, created: false }
      : await ensureRun(env, runtime, checkpoint, cohort.length, evaluation.pendingWork, timestamp);
    runs.set(checkpoint.id, ensured.run);
    if (ensured.created) counts.created += 1;
    if (checkpoint.settlement === "pause-until-terminal" && evaluation.pendingWork > 0) {
      if (await waitForPendingWork(
        env,
        runtime,
        checkpoint,
        ensured.run,
        cohort.length,
        evaluation.pendingWork,
        timestamp,
      )) counts.paused += 1;
      break;
    }
    const keepRunProvisional = rules.clock.kind === "individual" && runtime.state !== "ended";
    const persisted = await persistEvaluation(
      env,
      runtime,
      checkpoint,
      ensured.run,
      evaluation,
      decisions,
      keepRunProvisional,
      timestamp,
    );
    counts.eliminated += persisted.eliminated;
    if (persisted.resumed) counts.resumed += 1;
    if (persisted.provisional) counts.provisional += 1;
    else counts.finalized += 1;
    decisions = await storedDecisions(env, runtime);
    runs.set(checkpoint.id, { ...ensured.run, state: persisted.provisional ? "provisional" : "final" });
    if (rules.clock.kind === "global" && persisted.provisional) break;
  }
}

/**
 * Recalculate already-due checkpoints for one exactly fenced paused runtime.
 * This is the operational continuation used after a rule activation or
 * rewind.  Existing eliminations are never changed here; a rewind resets the
 * cohort before calling this entry point, while monotonic activation does not.
 */
export async function reconcilePausedContestCheckpoints(
  env: WasmOjWorkerEnv,
  input: {
    readonly contestId: string;
    readonly timelineGeneration: number;
    readonly rulesEpoch: number;
  },
  now = new Date(),
): Promise<ContestCheckpointReconciliation> {
  if (Number.isNaN(now.getTime())) throw new TypeError("Checkpoint reconciliation time is invalid.");
  const runtime = await exactRuntime(
    env,
    input.contestId,
    input.timelineGeneration,
    input.rulesEpoch,
  );
  if (!runtime || runtime.state !== "paused") {
    throw new Error("Paused checkpoint recalculation lost its exact runtime fence.");
  }
  const counts: MutableCounts = {
    visited: 0,
    created: 0,
    provisional: 0,
    finalized: 0,
    eliminated: 0,
    paused: 0,
    resumed: 0,
  };
  await reconcileRuntime(env, runtime, now, counts, true, Number.MAX_SAFE_INTEGER);
  return counts;
}

/**
 * Materialize every due boundary for one contest before serving a projection
 * or admitting new work. Cron remains a recovery sweep; correctness at short
 * boundaries comes from this request-path reconciliation plus final-write
 * admission fences.
 */
export async function reconcileContestCheckpointsForContest(
  env: WasmOjWorkerEnv,
  contestId: string,
  now = new Date(),
): Promise<ContestCheckpointReconciliation> {
  if (Number.isNaN(now.getTime())) throw new TypeError("Checkpoint reconciliation time is invalid.");
  const identity = await env.DB.prepare(`SELECT timeline_generation, rules_epoch
    FROM contest_runtimes WHERE contest_id=?`)
    .bind(contestId).first<{ readonly timeline_generation: number; readonly rules_epoch: number }>();
  const counts: MutableCounts = {
    visited: 0,
    created: 0,
    provisional: 0,
    finalized: 0,
    eliminated: 0,
    paused: 0,
    resumed: 0,
  };
  if (!identity) return counts;
  const runtime = await exactRuntime(
    env,
    contestId,
    identity.timeline_generation,
    identity.rules_epoch,
  );
  if (!runtime || runtime.state === "scheduled") return counts;
  await reconcileRuntime(env, runtime, now, counts, undefined, Number.MAX_SAFE_INTEGER);
  return counts;
}

/** Reconcile a bounded set of due checkpoint boundaries and their captured work. */
export async function reconcileContestCheckpoints(
  env: WasmOjWorkerEnv,
  now = new Date(),
): Promise<ContestCheckpointReconciliation> {
  if (Number.isNaN(now.getTime())) throw new TypeError("Checkpoint reconciliation time is invalid.");
  const counts: MutableCounts = {
    visited: 0,
    created: 0,
    provisional: 0,
    finalized: 0,
    eliminated: 0,
    paused: 0,
    resumed: 0,
  };
  for (const runtime of await runtimes(env)) {
    if (counts.visited >= CHECKPOINT_WORK_LIMIT) break;
    await reconcileRuntime(env, runtime, now, counts);
  }
  return counts;
}
