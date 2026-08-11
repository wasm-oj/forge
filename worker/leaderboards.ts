export interface LeaderboardEntryRow {
  readonly userId: string;
  readonly score: number;
  readonly fullyPassedCases: number;
  readonly deterministicCost: number;
  readonly peakMemoryBytes: number;
  readonly achievedAt: string;
  readonly attemptedProblems?: number;
  readonly submissionId?: string;
}

export interface ContestProblemSelection {
  readonly originalProblemVersionId: string;
  readonly effectiveProblemVersionId: string;
  readonly rejudgeBatchId?: string;
}

interface ProblemLeaderboardRow {
  readonly user_id: string;
  readonly score: number;
  readonly fully_passed_cases: number;
  readonly deterministic_cost: number;
  readonly peak_memory_bytes: number;
  readonly achieved_at: string;
  readonly submission_id: string;
}

interface ContestLeaderboardRow extends Omit<ProblemLeaderboardRow, "submission_id"> {
  readonly attempted_problems: number;
}

const COMPLETE_METRICS = `submissions.state='completed'
  AND submissions.score IS NOT NULL
  AND submissions.fully_passed_cases IS NOT NULL
  AND submissions.deterministic_cost IS NOT NULL
  AND submissions.peak_memory_bytes IS NOT NULL
  AND submissions.completed_at IS NOT NULL`;

function entry(row: ProblemLeaderboardRow): LeaderboardEntryRow {
  return {
    userId: row.user_id,
    score: row.score,
    fullyPassedCases: row.fully_passed_cases,
    deterministicCost: row.deterministic_cost,
    peakMemoryBytes: row.peak_memory_bytes,
    achievedAt: row.achieved_at,
    submissionId: row.submission_id,
  };
}

export async function queryProblemLeaderboard(
  database: D1Database,
  input: {
    readonly effectiveProblemVersionId: string;
    readonly rejudgeBatchId?: string;
    readonly limit: number;
  },
): Promise<readonly LeaderboardEntryRow[]> {
  const batchPredicate = input.rejudgeBatchId
    ? "(submissions.rejudge_batch_id IS NULL OR submissions.rejudge_batch_id=?)"
    : "submissions.rejudge_batch_id IS NULL";
  const bindings: unknown[] = [input.effectiveProblemVersionId];
  if (input.rejudgeBatchId) bindings.push(input.rejudgeBatchId);
  bindings.push(input.limit);
  const rows = await database.prepare(`WITH candidates AS (
      SELECT submissions.id AS submission_id,
        submissions.user_id,
        submissions.score,
        submissions.fully_passed_cases,
        submissions.deterministic_cost,
        submissions.peak_memory_bytes,
        COALESCE(original.completed_at, submissions.completed_at) AS achieved_at
      FROM submissions
      LEFT JOIN submissions AS original ON original.id=submissions.rejudge_of_submission_id
      WHERE submissions.managed_problem_version_id=?
        AND submissions.contest_id IS NULL
        AND ${COMPLETE_METRICS}
        AND ${batchPredicate}
    ), ranked AS (
      SELECT candidates.*,
        ROW_NUMBER() OVER (
          PARTITION BY user_id
          ORDER BY score DESC, fully_passed_cases DESC, deterministic_cost ASC,
            peak_memory_bytes ASC, achieved_at ASC, submission_id ASC
        ) AS candidate_rank
      FROM candidates
    )
    SELECT user_id, score, fully_passed_cases, deterministic_cost,
      peak_memory_bytes, achieved_at, submission_id
    FROM ranked
    WHERE candidate_rank=1
    ORDER BY score DESC, fully_passed_cases DESC, deterministic_cost ASC,
      peak_memory_bytes ASC, achieved_at ASC, user_id ASC
    LIMIT ?`)
    .bind(...bindings).all<ProblemLeaderboardRow>();
  return rows.results.map(entry);
}

export async function queryContestLeaderboard(
  database: D1Database,
  input: {
    readonly contestId: string;
    readonly problems: readonly ContestProblemSelection[];
    readonly completedAtOrBefore?: string;
    readonly limit: number;
  },
): Promise<readonly LeaderboardEntryRow[]> {
  if (input.problems.length === 0) return [];
  const selectionJson = JSON.stringify(input.problems);
  const rows = await database.prepare(`WITH problem_selection AS (
      SELECT
        json_extract(value, '$.originalProblemVersionId') AS original_problem_version_id,
        json_extract(value, '$.effectiveProblemVersionId') AS effective_problem_version_id,
        json_extract(value, '$.rejudgeBatchId') AS rejudge_batch_id
      FROM json_each(?)
    ), candidates AS (
      SELECT submissions.id AS submission_id,
        submissions.user_id,
        problem_selection.original_problem_version_id AS problem_version_id,
        submissions.score,
        submissions.fully_passed_cases,
        submissions.deterministic_cost,
        submissions.peak_memory_bytes,
        COALESCE(original.completed_at, submissions.completed_at) AS achieved_at
      FROM problem_selection
      JOIN submissions ON submissions.managed_problem_version_id=problem_selection.effective_problem_version_id
      LEFT JOIN submissions AS original ON original.id=submissions.rejudge_of_submission_id
      WHERE submissions.contest_id=?
        AND ${COMPLETE_METRICS}
        AND (
          (problem_selection.rejudge_batch_id IS NULL AND submissions.rejudge_batch_id IS NULL)
          OR (
            problem_selection.rejudge_batch_id IS NOT NULL
            AND (submissions.rejudge_batch_id IS NULL OR submissions.rejudge_batch_id=problem_selection.rejudge_batch_id)
          )
        )
        ${input.completedAtOrBefore ? "AND COALESCE(original.completed_at, submissions.completed_at)<=?" : ""}
    ), ranked AS (
      SELECT candidates.*,
        ROW_NUMBER() OVER (
          PARTITION BY user_id, problem_version_id
          ORDER BY score DESC, fully_passed_cases DESC, deterministic_cost ASC,
            peak_memory_bytes ASC, achieved_at ASC, submission_id ASC
        ) AS candidate_rank
      FROM candidates
    ), effective_results AS (
      SELECT * FROM ranked WHERE candidate_rank=1
    )
    SELECT user_id,
      SUM(score) AS score,
      SUM(fully_passed_cases) AS fully_passed_cases,
      SUM(deterministic_cost) AS deterministic_cost,
      MAX(peak_memory_bytes) AS peak_memory_bytes,
      MAX(achieved_at) AS achieved_at,
      COUNT(*) AS attempted_problems
    FROM effective_results
    GROUP BY user_id
    ORDER BY score DESC, fully_passed_cases DESC, deterministic_cost ASC,
      peak_memory_bytes ASC, achieved_at ASC, user_id ASC
    LIMIT ?`)
    .bind(selectionJson, input.contestId, ...(input.completedAtOrBefore ? [input.completedAtOrBefore] : []), input.limit)
    .all<ContestLeaderboardRow>();
  return rows.results.map((row) => ({
    userId: row.user_id,
    score: row.score,
    fullyPassedCases: row.fully_passed_cases,
    deterministicCost: row.deterministic_cost,
    peakMemoryBytes: row.peak_memory_bytes,
    achievedAt: row.achieved_at,
    attemptedProblems: row.attempted_problems,
  }));
}
