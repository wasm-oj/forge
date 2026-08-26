export interface LeaderboardEntryRow {
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

interface ContestLeaderboardRow extends Omit<ProblemLeaderboardRow, "submission_id" | "language"> {
  readonly attempted_problems: number;
  readonly problem_results_json: string;
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
    readonly submittedAtOrBefore?: string;
    readonly limit: number;
  },
): Promise<readonly LeaderboardEntryRow[]> {
  const rows = await database.prepare(`WITH candidates AS (
      SELECT result.id AS submission_id,
        origin.user_id,
        contest_problem.ordinal,
        contest_problem.problem_id,
        result.score,
        result.fully_passed_cases,
        result.deterministic_cost,
        result.peak_memory_bytes,
        origin.completed_at AS achieved_at
      FROM effective_submission_results AS effective
      JOIN submissions AS origin ON origin.id=effective.origin_submission_id
      JOIN submissions AS result ON result.id=effective.effective_submission_id
      JOIN contest_series AS contest ON contest.id=origin.contest_id
      JOIN catalogs ON catalogs.id=contest.catalog_id
      JOIN contest_revision_problems AS contest_problem
        ON contest_problem.contest_id=origin.contest_id
       AND contest_problem.commit_sha=catalogs.active_commit_sha
       AND contest_problem.problem_id=origin.problem_id
      WHERE origin.contest_id=?
        AND ${COMPLETE_RESULT_METRICS}
        ${input.submittedAtOrBefore ? "AND origin.origin_submitted_at<=?" : ""}
    ), ranked AS (
      SELECT candidates.*,
        ROW_NUMBER() OVER (
          PARTITION BY user_id, problem_id
          ORDER BY score DESC, fully_passed_cases DESC, deterministic_cost ASC,
            peak_memory_bytes ASC, achieved_at ASC, submission_id ASC
        ) AS candidate_rank
      FROM candidates
    ), effective_results AS (
      SELECT * FROM ranked WHERE candidate_rank=1
    ), aggregates AS (
      SELECT user_id,
        SUM(score) AS score,
        SUM(fully_passed_cases) AS fully_passed_cases,
        SUM(deterministic_cost) AS deterministic_cost,
        MAX(peak_memory_bytes) AS peak_memory_bytes,
        MAX(achieved_at) AS achieved_at,
        COUNT(*) AS attempted_problems
      FROM effective_results
      GROUP BY user_id
    )
    SELECT aggregates.*,
      (SELECT json_group_array(json_object(
          'problemId', ordered.problem_id,
          'score', ordered.score,
          'fullyPassedCases', ordered.fully_passed_cases
        ))
        FROM (
          SELECT problem_id, score, fully_passed_cases
          FROM effective_results
          WHERE effective_results.user_id=aggregates.user_id
          ORDER BY ordinal
        ) AS ordered
      ) AS problem_results_json
    FROM aggregates
    ORDER BY aggregates.score DESC, aggregates.fully_passed_cases DESC, aggregates.deterministic_cost ASC,
      aggregates.peak_memory_bytes ASC, aggregates.achieved_at ASC, aggregates.user_id ASC
    LIMIT ?`)
    .bind(input.contestId, ...(input.submittedAtOrBefore ? [input.submittedAtOrBefore] : []), input.limit)
    .all<ContestLeaderboardRow>();
  return rows.results.map((row) => {
    const problemResults = JSON.parse(row.problem_results_json) as Array<Record<string, unknown>>;
    if (!Array.isArray(problemResults) || problemResults.some((result) => (
      typeof result.problemId !== "string"
      || typeof result.score !== "number"
      || !Number.isFinite(result.score)
      || !Number.isSafeInteger(result.fullyPassedCases)
    ))) throw new TypeError("Contest leaderboard problem breakdown is invalid.");
    return {
      userId: row.user_id,
      score: row.score,
      fullyPassedCases: row.fully_passed_cases,
      deterministicCost: row.deterministic_cost,
      peakMemoryBytes: row.peak_memory_bytes,
      achievedAt: row.achieved_at,
      attemptedProblems: row.attempted_problems,
      problemResults: problemResults.map((result) => ({
        problemId: result.problemId as string,
        score: result.score as number,
        fullyPassedCases: result.fullyPassedCases as number,
      })),
    };
  });
}
