ALTER TABLE submissions ADD COLUMN rejudge_batch_id TEXT;
ALTER TABLE submissions ADD COLUMN rejudge_of_submission_id TEXT REFERENCES submissions(id);

CREATE UNIQUE INDEX submissions_rejudge_source
ON submissions(rejudge_batch_id, rejudge_of_submission_id)
WHERE rejudge_batch_id IS NOT NULL;

CREATE INDEX submissions_rejudge_batch
ON submissions(rejudge_batch_id, state);

CREATE TABLE rejudge_jobs (
  rejudge_batch_id TEXT NOT NULL,
  old_submission_id TEXT NOT NULL REFERENCES submissions(id),
  new_submission_id TEXT NOT NULL UNIQUE REFERENCES submissions(id),
  old_problem_version_id TEXT NOT NULL,
  new_problem_version_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending', 'dispatched', 'ready', 'failed', 'cancelled')),
  result_state TEXT CHECK (result_state IS NULL OR result_state IN ('completed', 'compile-error', 'judge-error', 'infrastructure-error', 'cancelled')),
  reservation_released_at TEXT,
  workflow_payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (rejudge_batch_id, old_submission_id)
) STRICT;

CREATE INDEX rejudge_jobs_dispatch
ON rejudge_jobs(rejudge_batch_id, state, created_at);

CREATE TABLE rejudge_result_outbox (
  id TEXT PRIMARY KEY,
  rejudge_batch_id TEXT NOT NULL,
  old_submission_id TEXT NOT NULL REFERENCES submissions(id),
  new_submission_id TEXT NOT NULL REFERENCES submissions(id),
  created_at TEXT NOT NULL,
  delivered_at TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  UNIQUE (rejudge_batch_id, old_submission_id)
) STRICT;

CREATE INDEX rejudge_result_outbox_pending
ON rejudge_result_outbox(delivered_at, created_at);
