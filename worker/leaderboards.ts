import {
  ContestRuleEngine,
  parseContestRules,
  type ContestResultFact,
  type ContestRules,
} from "../src/online-judge/contest-rules";

export interface LeaderboardEntryRow {
  readonly rank?: number;
  readonly userId: string;
  readonly language?: string;
  readonly score: number;
  readonly fullyPassedCases: number;
  readonly deterministicCost: number;
  readonly peakMemoryBytes: number;
  readonly achievedAt: string;
  readonly attemptedProblems?: number;
  readonly problemResults?: readonly {
    readonly problemId: string;
    readonly score: number;
    readonly fullyPassedCases: number;
  }[];
  readonly submissionId?: string;
  readonly solved?: number;
  readonly penaltyMinutes?: number;
  readonly furthestCheckpoint?: number;
  readonly achievedAtLogicalSeconds?: number;
  readonly eliminated?: boolean;
  readonly provisional?: boolean;
}

interface ProblemLeaderboardRow {
  readonly user_id: string;
  readonly language: string;
  readonly score: number;
  readonly fully_passed_cases: number;
  readonly deterministic_cost: number;
  readonly peak_memory_bytes: number;
  readonly achieved_at: string;
  readonly submission_id: string;
}

export interface ContestResultRow {
  readonly entrant_id: string;
  readonly account_user_id: string;
  readonly problem_id: string;
  readonly problem_slug: string;
  readonly verdict: ContestResultFact["verdict"];
  readonly score: number;
  readonly fully_passed_cases: number | null;
  readonly deterministic_cost: number | null;
  readonly peak_memory_bytes: number | null;
  readonly logical_seconds: number;
  readonly submission_id: string;
  readonly origin_submission_id: string;
}

const COMPLETE_RESULT_METRICS = `result.state='completed'
  AND result.score IS NOT NULL
  AND result.fully_passed_cases IS NOT NULL
  AND result.deterministic_cost IS NOT NULL
  AND result.peak_memory_bytes IS NOT NULL
  AND result.completed_at IS NOT NULL
  AND origin.completed_at IS NOT NULL`;

function entry(row: ProblemLeaderboardRow): LeaderboardEntryRow {
  return {
    userId: row.user_id,
    language: row.language,
    score: row.score,
    fullyPassedCases: row.fully_passed_cases,
    deterministicCost: row.deterministic_cost,
    peakMemoryBytes: row.peak_memory_bytes,
    achievedAt: row.achieved_at,
    submissionId: row.submission_id,
  };
}

/**
 * Reads only the canonical effective-result view. Direct submissions and every
 * rejudge generation therefore share one ranking path.
 */
export async function queryProblemLeaderboard(
  database: D1Database,
  input: {
    readonly problemId: string;
    readonly language?: string;
    readonly limit: number;
  },
): Promise<readonly LeaderboardEntryRow[]> {
  const bindings: unknown[] = [input.problemId];
  if (input.language) bindings.push(input.language);
  bindings.push(input.limit);
  const rows = await database.prepare(`WITH candidates AS (
      SELECT result.id AS submission_id,
        origin.user_id,
        result.language,
        result.score,
        result.fully_passed_cases,
        result.deterministic_cost,
        result.peak_memory_bytes,
        origin.completed_at AS achieved_at
      FROM effective_submission_results AS effective
      JOIN submissions AS origin ON origin.id=effective.origin_submission_id
      JOIN submissions AS result ON result.id=effective.effective_submission_id
      WHERE effective.problem_id=?
        AND origin.contest_id IS NULL
        AND ${COMPLETE_RESULT_METRICS}
        ${input.language ? "AND result.language=?" : ""}
    ), ranked AS (
      SELECT candidates.*,
        ROW_NUMBER() OVER (
          PARTITION BY user_id
          ORDER BY score DESC, fully_passed_cases DESC, deterministic_cost ASC,
            peak_memory_bytes ASC, achieved_at ASC, submission_id ASC
        ) AS candidate_rank
      FROM candidates
    )
    SELECT user_id, language, score, fully_passed_cases, deterministic_cost,
      peak_memory_bytes, achieved_at, submission_id
    FROM ranked
    WHERE candidate_rank=1
    ORDER BY score DESC, fully_passed_cases DESC, deterministic_cost ASC,
      peak_memory_bytes ASC, achieved_at ASC, user_id ASC
    LIMIT ?`)
    .bind(...bindings).all<ProblemLeaderboardRow>();
  return rows.results.map(entry);
}

/**
 * Aggregates results only for problems in the catalog's active contest revision.
 * The view may point at a later rejudge child, but the public breakdown keeps
 * the contest's stable problem IDs. Freeze eligibility is bound to the immutable
 * origin submission time, never delayed judge completion.
 */
export async function queryContestLeaderboard(
  database: D1Database,
  input: {
    readonly contestId: string;
    readonly evidenceLogicalAtOrBefore?: number;
    readonly limit: number;
  },
): Promise<readonly LeaderboardEntryRow[]> {
  if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 100) throw new TypeError("Contest leaderboard limit is invalid.");
  if (input.evidenceLogicalAtOrBefore !== undefined
    && (!Number.isFinite(input.evidenceLogicalAtOrBefore) || input.evidenceLogicalAtOrBefore < 0)) {
    throw new TypeError("Contest leaderboard logical cutoff is invalid.");
  }
  const runtime = await database.prepare(`SELECT revisions.rules_json, revisions.global_starts_at,
      runtime.timeline_generation, runtime.rules_epoch,
      EXISTS (SELECT 1 FROM contest_problem_epochs AS epochs
        JOIN rejudge_batches AS rollout ON rollout.id=epochs.rollout_batch_id
        WHERE epochs.contest_id=runtime.contest_id AND epochs.state='effective'
          AND rollout.state<>'effective') AS provisional
    FROM contest_runtimes AS runtime
    JOIN contest_rule_revisions AS revisions
      ON revisions.contest_id=runtime.contest_id
     AND revisions.rules_commit=runtime.active_rules_commit
     AND revisions.rules_sha256=runtime.active_rules_sha256
    WHERE runtime.contest_id=?`)
    .bind(input.contestId).first<{
      readonly rules_json: string;
      readonly global_starts_at: string | null;
      readonly timeline_generation: number;
      readonly rules_epoch: number;
      readonly provisional: number;
    }>();
  if (!runtime) return [];
  const rules = parseContestRules(JSON.parse(runtime.rules_json) as unknown, "stored contest leaderboard rules");
  const entrants = await database.prepare(`SELECT id, account_user_id, state
    FROM contest_entrants
    WHERE contest_id=? AND kind='account' AND account_user_id IS NOT NULL
      AND state_timeline_generation=?
    ORDER BY id`)
    .bind(input.contestId, runtime.timeline_generation)
    .all<{ readonly id: string; readonly account_user_id: string; readonly state: string }>();
  const bindings: unknown[] = [input.contestId];
  if (input.evidenceLogicalAtOrBefore !== undefined) bindings.push(input.evidenceLogicalAtOrBefore);
  const rows = await database.prepare(`SELECT records.entrant_id, entrants.account_user_id,
      origin.problem_id, problems.slug AS problem_slug, result.verdict, COALESCE(result.score, 0) AS score,
      result.fully_passed_cases, result.deterministic_cost, result.peak_memory_bytes,
      records.evidence_logical_seconds AS logical_seconds, result.id AS submission_id,
      origin.id AS origin_submission_id
    FROM contest_submission_records AS records
    JOIN contest_entrants AS entrants ON entrants.id=records.entrant_id
    JOIN submissions AS origin ON origin.id=records.submission_id
      AND origin.origin_submission_id=origin.id
    JOIN effective_submission_results AS effective
      ON effective.origin_submission_id=origin.id
    JOIN submissions AS result ON result.id=effective.effective_submission_id
    JOIN problem_series AS problems ON problems.id=origin.problem_id
    JOIN contest_runtimes AS runtime ON runtime.contest_id=records.contest_id
    JOIN contest_rule_problems AS contest_problem
      ON contest_problem.contest_id=records.contest_id
     AND contest_problem.rules_commit=runtime.active_rules_commit
     AND contest_problem.problem_id=origin.problem_id
    WHERE records.contest_id=? AND records.eligibility='eligible'
      AND records.evidence_logical_seconds IS NOT NULL
      AND result.state IN ('completed','compile-error','judge-error','infrastructure-error','cancelled')
      AND result.verdict IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM contest_problem_epochs AS rollout_epoch
        JOIN rejudge_batches AS rollout ON rollout.id=rollout_epoch.rollout_batch_id
        WHERE rollout_epoch.contest_id=records.contest_id
          AND rollout_epoch.problem_id=origin.problem_id
          AND rollout_epoch.judge_epoch=records.judge_epoch
          AND rollout_epoch.state='effective' AND rollout.state<>'effective'
      )
      AND NOT EXISTS (
        SELECT 1 FROM contest_judge_rollout_prompt_attempts AS prompt_membership
        JOIN contest_problem_epochs AS prompt_target_epoch
          ON prompt_target_epoch.contest_id=records.contest_id
         AND prompt_target_epoch.problem_id=origin.problem_id
         AND prompt_target_epoch.judge_epoch=prompt_membership.target_judge_epoch
         AND prompt_target_epoch.state='effective'
        JOIN rejudge_batches AS prompt_rollout
          ON prompt_rollout.id=prompt_target_epoch.rollout_batch_id
        WHERE prompt_membership.prompt_attempt_id=records.prompt_attempt_id
          AND prompt_membership.state IN ('included','promoted')
          AND prompt_rollout.purpose='contest-judge-rollout'
          AND prompt_rollout.state<>'effective'
      )
      ${input.evidenceLogicalAtOrBefore !== undefined ? "AND records.evidence_logical_seconds<=?" : ""}
    ORDER BY records.entrant_id, contest_problem.ordinal,
      records.evidence_logical_seconds, origin.id`)
    .bind(...bindings).all<ContestResultRow>();
  const facts: ContestResultFact[] = rows.results.map((row) => ({
    entrantId: row.entrant_id,
    problemSlug: row.problem_slug,
    verdict: row.verdict,
    score: row.score,
    fullyPassedCases: row.fully_passed_cases ?? 0,
    deterministicCost: row.deterministic_cost ?? 0,
    peakMemoryBytes: row.peak_memory_bytes ?? 0,
    logicalSeconds: row.logical_seconds,
    eligible: true,
  }));
  const checkpointBindings: unknown[] = [
    input.contestId,
    runtime.timeline_generation,
    runtime.rules_epoch,
  ];
  if (input.evidenceLogicalAtOrBefore !== undefined) {
    checkpointBindings.push(input.evidenceLogicalAtOrBefore);
  }
  const checkpoints = await database.prepare(`SELECT decisions.entrant_id,
      SUM(CASE WHEN decisions.decision='advanced' AND decisions.provisional=0
        THEN 1 ELSE 0 END) AS passed,
      MAX(CASE WHEN runs.state='provisional' OR decisions.provisional=1
        THEN 1 ELSE 0 END) AS provisional
    FROM contest_checkpoint_decisions AS decisions
    JOIN contest_checkpoint_runs AS runs ON runs.id=decisions.checkpoint_run_id
    WHERE runs.contest_id=? AND runs.timeline_generation=? AND runs.rules_epoch=?
      AND runs.state IN ('provisional','final')
      ${input.evidenceLogicalAtOrBefore !== undefined ? "AND runs.logical_seconds<=?" : ""}
    GROUP BY decisions.entrant_id`)
    .bind(...checkpointBindings)
    .all<{
      readonly entrant_id: string;
      readonly passed: number;
      readonly provisional: number;
    }>();
  const passed = Object.fromEntries(checkpoints.results.map((row) => [row.entrant_id, row.passed]));
  const checkpointProvisional = checkpoints.results.some((row) => row.provisional === 1);
  const standings = ContestRuleEngine.rank(rules, entrants.results.map((entrant) => entrant.id), facts, passed);
  const userByEntrant = new Map(entrants.results.map((entrant) => [entrant.id, entrant]));
  const factsByEntrant = new Map<string, ContestResultRow[]>();
  for (const row of rows.results) {
    const collected = factsByEntrant.get(row.entrant_id) ?? [];
    collected.push(row);
    factsByEntrant.set(row.entrant_id, collected);
  }
  return standings.slice(0, input.limit).map((standing): LeaderboardEntryRow => {
    const entrant = userByEntrant.get(standing.entrantId)!;
    const resultRows = factsByEntrant.get(standing.entrantId) ?? [];
    const bestByProblem = bestContestProblemRows(rules, resultRows);
    const achievedAt = runtime.global_starts_at
      ? new Date(Date.parse(runtime.global_starts_at) + standing.achievedAtSeconds * 1_000).toISOString()
      : new Date(standing.achievedAtSeconds * 1_000).toISOString();
    return {
      rank: standing.rank,
      userId: entrant.account_user_id,
      score: standing.score,
      solved: standing.solved,
      penaltyMinutes: standing.penaltyMinutes,
      furthestCheckpoint: standing.furthestCheckpoint,
      fullyPassedCases: standing.fullyPassedCases,
      deterministicCost: standing.deterministicCost,
      peakMemoryBytes: standing.peakMemoryBytes,
      achievedAt,
      achievedAtLogicalSeconds: standing.achievedAtSeconds,
      attemptedProblems: new Set(resultRows.map((row) => row.problem_slug)).size,
      problemResults: [...bestByProblem.values()].map((row) => ({
        problemId: row.problem_id,
        score: row.score,
        fullyPassedCases: row.fully_passed_cases ?? 0,
      })),
      eliminated: entrant.state === "eliminated",
      provisional: runtime.provisional === 1 || checkpointProvisional,
    };
  });
}

export function bestContestProblemRows(
  rules: ContestRules,
  rows: readonly ContestResultRow[],
): ReadonlyMap<string, ContestResultRow> {
  const selected = new Map<string, ContestResultRow>();
  for (const problem of rules.problems) {
    const candidates = rows.filter((row) => row.problem_slug === problem.slug);
    if (rules.scoring.kind === "icpc") {
      const accepted = candidates.find((row) => row.score === 100);
      if (accepted) selected.set(problem.slug, accepted);
      continue;
    }
    candidates.sort((left, right) => {
      let comparison = right.score - left.score;
      for (const tieBreak of rules.scoring.tieBreaks) {
        if (comparison !== 0) break;
        if (tieBreak === "fully-passed-cases") {
          comparison = (right.fully_passed_cases ?? 0) - (left.fully_passed_cases ?? 0);
        } else if (tieBreak === "deterministic-cost") {
          comparison = (left.deterministic_cost ?? 0) - (right.deterministic_cost ?? 0);
        } else if (tieBreak === "peak-memory") {
          comparison = (left.peak_memory_bytes ?? 0) - (right.peak_memory_bytes ?? 0);
        } else {
          comparison = left.logical_seconds - right.logical_seconds;
        }
      }
      return comparison || left.logical_seconds - right.logical_seconds
        || left.submission_id.localeCompare(right.submission_id);
    });
    if (candidates[0]) selected.set(problem.slug, candidates[0]);
  }
  return selected;
}
