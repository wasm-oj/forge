ALTER TABLE rejudge_batches ADD COLUMN idempotency_key TEXT;
ALTER TABLE rejudge_batches ADD COLUMN request_digest TEXT CHECK (request_digest IS NULL OR length(request_digest) = 64);
ALTER TABLE rejudge_batches ADD COLUMN forge_release_id TEXT REFERENCES forge_releases(id);
ALTER TABLE rejudge_batches ADD COLUMN forge_manifest_sha256 TEXT CHECK (forge_manifest_sha256 IS NULL OR length(forge_manifest_sha256) = 64);
ALTER TABLE rejudge_batches ADD COLUMN ready_count INTEGER NOT NULL DEFAULT 0 CHECK (ready_count >= 0);
ALTER TABLE rejudge_batches ADD COLUMN failed_count INTEGER NOT NULL DEFAULT 0 CHECK (failed_count >= 0);
ALTER TABLE rejudge_batches ADD COLUMN failure_code TEXT;
ALTER TABLE rejudge_batches ADD COLUMN cancel_requested_at TEXT;
ALTER TABLE rejudge_batches ADD COLUMN updated_at TEXT;
ALTER TABLE rejudge_batches ADD COLUMN mappings_finalized_at TEXT;

CREATE UNIQUE INDEX rejudge_batches_idempotency
ON rejudge_batches(requested_by, idempotency_key)
WHERE idempotency_key IS NOT NULL;

CREATE UNIQUE INDEX rejudge_batches_one_inflight_source
ON rejudge_batches(old_problem_version_id)
WHERE status IN ('queued', 'running', 'ready');

CREATE TABLE effective_problem_versions (
  original_problem_version_id TEXT PRIMARY KEY REFERENCES managed_problem_versions(id),
  effective_problem_version_id TEXT NOT NULL REFERENCES managed_problem_versions(id),
  rejudge_batch_id TEXT NOT NULL REFERENCES rejudge_batches(id),
  effective_at TEXT NOT NULL,
  CHECK (original_problem_version_id <> effective_problem_version_id)
) STRICT;

CREATE TABLE rejudge_verified_solves (
  rejudge_batch_id TEXT NOT NULL REFERENCES rejudge_batches(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  managed_problem_version_id TEXT NOT NULL REFERENCES managed_problem_versions(id),
  effective_submission_id TEXT NOT NULL,
  score REAL NOT NULL CHECK (score = 100),
  solved_at TEXT NOT NULL,
  PRIMARY KEY (rejudge_batch_id, user_id)
) STRICT;

CREATE INDEX rejudge_verified_solves_batch
ON rejudge_verified_solves(rejudge_batch_id);

CREATE TABLE formal_submission_admissions (
  submission_id TEXT PRIMARY KEY,
  managed_problem_version_id TEXT NOT NULL REFERENCES managed_problem_versions(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  state TEXT NOT NULL CHECK (state IN ('pending', 'committed', 'aborted')),
  source_r2_key TEXT,
  source_sha256 TEXT CHECK (source_sha256 IS NULL OR length(source_sha256) = 64),
  cleanup_state TEXT NOT NULL DEFAULT 'retained' CHECK (cleanup_state IN ('pending', 'retained', 'complete')),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (
    (state = 'pending' AND cleanup_state = 'pending' AND source_r2_key IS NOT NULL AND source_sha256 IS NOT NULL)
    OR (state = 'committed' AND cleanup_state = 'retained')
    OR (state = 'aborted' AND cleanup_state IN ('pending', 'complete'))
  )
) STRICT;

CREATE INDEX formal_submission_admissions_problem_state
ON formal_submission_admissions(managed_problem_version_id, state, expires_at);
CREATE INDEX formal_submission_admissions_cleanup
ON formal_submission_admissions(cleanup_state, updated_at)
WHERE state = 'aborted' AND cleanup_state = 'pending';
