export interface PerformanceFrontierRow {
  readonly userId: string;
  readonly submissionId: string;
  readonly language: string;
  readonly score: number;
  readonly fullyPassedCases: number;
  readonly deterministicCost: number;
  readonly peakMemoryBytes: number;
  readonly achievedAt: string;
  readonly isPareto: boolean;
}

export interface PerformanceEvolutionRow {
  readonly submissionId: string;
  readonly attemptNumber: number;
  readonly language: string;
  readonly state: string;
  readonly verdict: string | null;
  readonly score: number | null;
  readonly fullyPassedCases: number | null;
  readonly deterministicCost: number | null;
  readonly peakMemoryBytes: number | null;
  readonly createdAt: string;
  readonly completedAt: string | null;
  readonly policySummaryAvailable: boolean;
}

interface FrontierDatabaseRow {
  readonly user_id: string;
  readonly submission_id: string;
  readonly language: string;
  readonly score: number;
  readonly fully_passed_cases: number;
  readonly deterministic_cost: number;
  readonly peak_memory_bytes: number;
  readonly achieved_at: string;
}

interface EvolutionDatabaseRow {
  readonly submission_id: string;
  readonly attempt_number: number;
  readonly language: string;
  readonly state: string;
  readonly verdict: string | null;
  readonly score: number | null;
  readonly fully_passed_cases: number | null;
  readonly deterministic_cost: number | null;
  readonly peak_memory_bytes: number | null;
  readonly created_at: string;
  readonly completed_at: string | null;
  readonly policy_summary_available: number;
}

function dominated(candidate: FrontierDatabaseRow, rows: readonly FrontierDatabaseRow[]): boolean {
  return rows.some((other) => other.submission_id !== candidate.submission_id
    && other.score >= candidate.score
    && other.deterministic_cost <= candidate.deterministic_cost
    && other.peak_memory_bytes <= candidate.peak_memory_bytes
    && (
      other.score > candidate.score
      || other.deterministic_cost < candidate.deterministic_cost
      || other.peak_memory_bytes < candidate.peak_memory_bytes
    ));
}

export function markParetoFrontier(rows: readonly FrontierDatabaseRow[]): readonly PerformanceFrontierRow[] {
  return rows.map((row) => ({
    userId: row.user_id,
    submissionId: row.submission_id,
    language: row.language,
    score: row.score,
    fullyPassedCases: row.fully_passed_cases,
    deterministicCost: row.deterministic_cost,
    peakMemoryBytes: row.peak_memory_bytes,
    achievedAt: row.achieved_at,
    isPareto: !dominated(row, rows),
  }));
}

/**
 * Selects one canonical effective result per participant. Contest queries keep
 * the pinned contest version as their identity while still reading rejudged
 * metrics through effective_submission_results. The final order is compatible
 * with the dominance relation: every possible dominator sorts before the point
 * it dominates. Consequently, Pareto marking over the first 100 rows is exact
 * for every returned point without a quadratic full-inventory SQL join.
 */
export async function queryPerformanceFrontier(
  database: D1Database,
  input: {
    readonly problemVersionId: string;
    readonly contestId?: string;
    readonly language?: string;
    readonly submittedAtOrBefore?: string;
  },
): Promise<readonly PerformanceFrontierRow[]> {
  const contest = input.contestId !== undefined;
  const bindings: unknown[] = contest
    ? [input.contestId, input.problemVersionId]
    : [input.problemVersionId];
  if (input.language) bindings.push(input.language);
  if (input.submittedAtOrBefore) bindings.push(input.submittedAtOrBefore);
  const rows = await database.prepare(`WITH candidates AS (
      SELECT result.id AS submission_id,
        origin.user_id,
        result.language,
        result.score,
        result.fully_passed_cases,
        result.deterministic_cost,
        result.peak_memory_bytes,
        origin.origin_submitted_at AS achieved_at
      FROM effective_submission_results AS effective
      JOIN submissions AS origin ON origin.id=effective.origin_submission_id
      JOIN submissions AS result ON result.id=effective.effective_submission_id
      ${contest ? `JOIN contest_problems AS contest_problem
        ON contest_problem.contest_id=origin.contest_id
       AND contest_problem.problem_series_id=origin.problem_series_id` : ""}
      WHERE ${contest
        ? "origin.contest_id=? AND contest_problem.problem_version_id=?"
        : "origin.contest_id IS NULL AND effective.effective_problem_version_id=?"}
        AND result.state='completed'
        AND result.score IS NOT NULL
        AND result.fully_passed_cases IS NOT NULL
        AND result.deterministic_cost IS NOT NULL
        AND result.peak_memory_bytes IS NOT NULL
        AND result.completed_at IS NOT NULL
        AND origin.origin_submitted_at IS NOT NULL
        ${input.language ? "AND result.language=?" : ""}
        ${input.submittedAtOrBefore ? "AND origin.origin_submitted_at<=?" : ""}
    ), ranked AS (
      SELECT candidates.*,
        ROW_NUMBER() OVER (
          PARTITION BY user_id
          ORDER BY score DESC, deterministic_cost ASC, peak_memory_bytes ASC,
            fully_passed_cases DESC, achieved_at ASC, submission_id ASC
        ) AS candidate_rank
      FROM candidates
    )
    SELECT user_id, submission_id, language, score, fully_passed_cases,
      deterministic_cost, peak_memory_bytes, achieved_at
    FROM ranked
    WHERE candidate_rank=1
    ORDER BY score DESC, deterministic_cost ASC, peak_memory_bytes ASC,
      fully_passed_cases DESC, achieved_at ASC, user_id ASC
    LIMIT 100`)
    .bind(...bindings).all<FrontierDatabaseRow>();
  return markParetoFrontier(rows.results);
}

/** Reads every origin attempt for the signed-in viewer; freeze never applies. */
export async function queryPerformanceEvolution(
  database: D1Database,
  input: {
    readonly userId: string;
    readonly problemSeriesId: string;
    readonly contestId?: string;
    readonly language?: string;
  },
): Promise<{ readonly entries: readonly PerformanceEvolutionRow[]; readonly truncated: boolean }> {
  const bindings: unknown[] = [input.userId, input.problemSeriesId];
  if (input.contestId) bindings.push(input.contestId);
  if (input.language) bindings.push(input.language);
  const rows = await database.prepare(`WITH resolved AS (SELECT
      origin.id AS submission_id,
      CASE WHEN result.id IS NULL THEN origin.language ELSE result.language END AS language,
      CASE WHEN result.id IS NULL THEN origin.state ELSE result.state END AS state,
      CASE WHEN result.id IS NULL THEN origin.verdict ELSE result.verdict END AS verdict,
      CASE WHEN result.id IS NULL THEN origin.score ELSE result.score END AS resolved_score,
      CASE WHEN result.id IS NULL THEN origin.fully_passed_cases ELSE result.fully_passed_cases END AS resolved_fully_passed_cases,
      CASE WHEN result.id IS NULL THEN origin.deterministic_cost ELSE result.deterministic_cost END AS resolved_deterministic_cost,
      CASE WHEN result.id IS NULL THEN origin.peak_memory_bytes ELSE result.peak_memory_bytes END AS resolved_peak_memory_bytes,
      origin.created_at,
      CASE WHEN result.id IS NULL THEN origin.completed_at ELSE result.completed_at END AS completed_at,
      CASE WHEN result.id IS NULL THEN origin.policy_summary_json ELSE result.policy_summary_json END AS resolved_policy_summary
    FROM submissions AS origin
    LEFT JOIN effective_submission_results AS effective
      ON effective.origin_submission_id=origin.id
    LEFT JOIN submissions AS result
      ON result.id=effective.effective_submission_id
    WHERE origin.origin_submission_id=origin.id
      AND origin.user_id=?
      AND origin.problem_series_id=?
      AND ${input.contestId ? "origin.contest_id=?" : "origin.contest_id IS NULL"}
    ), numbered AS (SELECT
      submission_id,
      ROW_NUMBER() OVER (ORDER BY created_at ASC, submission_id ASC) AS attempt_number,
      language,
      state,
      verdict,
      CASE WHEN state='completed' THEN resolved_score ELSE NULL END AS score,
      CASE WHEN state='completed' THEN resolved_fully_passed_cases ELSE NULL END AS fully_passed_cases,
      CASE WHEN state='completed' THEN resolved_deterministic_cost ELSE NULL END AS deterministic_cost,
      CASE WHEN state='completed' THEN resolved_peak_memory_bytes ELSE NULL END AS peak_memory_bytes,
      created_at,
      completed_at,
      CASE WHEN state='completed' AND resolved_policy_summary IS NOT NULL
        THEN 1 ELSE 0 END AS policy_summary_available
    FROM resolved
    ), filtered AS (
      SELECT * FROM numbered ${input.language ? "WHERE language=?" : ""}
    ), recent AS (
      SELECT * FROM filtered ORDER BY attempt_number DESC LIMIT 201
    )
    SELECT * FROM recent ORDER BY attempt_number ASC`)
    .bind(...bindings).all<EvolutionDatabaseRow>();
  const selected = rows.results.length > 200 ? rows.results.slice(1) : rows.results;
  return { truncated: rows.results.length > 200, entries: selected.map((row) => ({
    submissionId: row.submission_id,
    attemptNumber: row.attempt_number,
    language: row.language,
    state: row.state,
    verdict: row.verdict,
    score: row.score,
    fullyPassedCases: row.fully_passed_cases,
    deterministicCost: row.deterministic_cost,
    peakMemoryBytes: row.peak_memory_bytes,
    createdAt: row.created_at,
    completedAt: row.completed_at,
    policySummaryAvailable: row.policy_summary_available === 1,
  })) };
}
