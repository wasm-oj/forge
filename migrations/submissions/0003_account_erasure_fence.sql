ALTER TABLE submissions ADD COLUMN source_erased_at TEXT;

CREATE INDEX submissions_rejudge_source_availability
ON submissions(managed_problem_version_id, state, source_erased_at, user_id);

CREATE TABLE submission_owner_erasure_fences (
  owner_user_id TEXT PRIMARY KEY,
  erasure_job_id TEXT NOT NULL,
  anonymous_user_id TEXT NOT NULL,
  fenced_at TEXT NOT NULL,
  CHECK (length(owner_user_id) BETWEEN 1 AND 128),
  CHECK (length(erasure_job_id) BETWEEN 1 AND 128),
  CHECK (length(anonymous_user_id) BETWEEN 1 AND 128)
) STRICT;

CREATE INDEX submission_owner_erasure_fences_anonymous
ON submission_owner_erasure_fences(anonymous_user_id);

ALTER TABLE rejudge_jobs ADD COLUMN erasure_excluded_at TEXT;

CREATE INDEX rejudge_jobs_erasure_eligible
ON rejudge_jobs(rejudge_batch_id, erasure_excluded_at, state, created_at);
