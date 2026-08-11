CREATE INDEX submissions_problem_leaderboard
ON submissions(
  managed_problem_version_id,
  rejudge_batch_id,
  user_id,
  score DESC,
  fully_passed_cases DESC,
  deterministic_cost,
  peak_memory_bytes,
  completed_at,
  id
)
WHERE state='completed' AND contest_id IS NULL;

CREATE INDEX submissions_contest_leaderboard
ON submissions(
  contest_id,
  managed_problem_version_id,
  rejudge_batch_id,
  user_id,
  score DESC,
  fully_passed_cases DESC,
  deterministic_cost,
  peak_memory_bytes,
  completed_at,
  id
)
WHERE state='completed' AND contest_id IS NOT NULL;
