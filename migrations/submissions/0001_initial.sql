PRAGMA foreign_keys = ON;

CREATE TABLE submissions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  managed_problem_version_id TEXT NOT NULL,
  contest_id TEXT,
  language TEXT NOT NULL,
  target TEXT NOT NULL CHECK (target IN ('wasip1', 'wasix')),
  optimization TEXT NOT NULL CHECK (optimization IN ('debug', 'release')),
  entry_path TEXT NOT NULL,
  source_r2_key TEXT NOT NULL,
  source_digest TEXT NOT NULL,
  forge_release_id TEXT NOT NULL,
  forge_manifest_sha256 TEXT NOT NULL CHECK (length(forge_manifest_sha256) = 64),
  state TEXT NOT NULL CHECK (state IN ('admitting', 'queued', 'waiting-capacity', 'preparing', 'compiling', 'running', 'finalizing', 'completed', 'compile-error', 'judge-error', 'infrastructure-error', 'cancelled')),
  visibility TEXT NOT NULL DEFAULT 'private' CHECK (visibility IN ('private', 'public')),
  score REAL,
  fully_passed_cases INTEGER,
  deterministic_cost INTEGER,
  peak_memory_bytes INTEGER,
  effective_attempt INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT,
  reservation_released_at TEXT
) STRICT;
CREATE INDEX submissions_terminal_reservation_release ON submissions(reservation_released_at, completed_at)
  WHERE state IN ('completed', 'compile-error', 'judge-error', 'infrastructure-error', 'cancelled');
CREATE INDEX submissions_user_created ON submissions(user_id, created_at DESC);
CREATE INDEX submissions_problem_score ON submissions(managed_problem_version_id, score DESC);
CREATE INDEX submissions_contest_created ON submissions(contest_id, created_at);

CREATE TABLE submission_idempotency (
  user_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  request_digest TEXT NOT NULL,
  submission_id TEXT NOT NULL REFERENCES submissions(id),
  created_at TEXT NOT NULL,
  PRIMARY KEY (user_id, idempotency_key)
) STRICT;

CREATE TABLE submission_attempts (
  submission_id TEXT NOT NULL REFERENCES submissions(id),
  attempt INTEGER NOT NULL,
  token_hash TEXT NOT NULL,
  container_key TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('created', 'running', 'succeeded', 'failed', 'superseded', 'cancelled')),
  started_at TEXT,
  finished_at TEXT,
  failure_code TEXT,
  audit_r2_key TEXT,
  PRIMARY KEY (submission_id, attempt)
) STRICT;

CREATE TABLE effective_rejudges (
  old_submission_id TEXT PRIMARY KEY REFERENCES submissions(id),
  rejudge_batch_id TEXT NOT NULL,
  new_submission_id TEXT NOT NULL REFERENCES submissions(id),
  became_effective_at TEXT
) STRICT;

CREATE TABLE submission_outbox (
  id TEXT PRIMARY KEY,
  submission_id TEXT NOT NULL REFERENCES submissions(id),
  kind TEXT NOT NULL CHECK (kind IN ('start-workflow', 'reconcile-terminal-event', 'update-profile', 'update-leaderboard', 'update-contest')),
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  delivered_at TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT
) STRICT;
CREATE INDEX submission_outbox_pending ON submission_outbox(delivered_at, created_at);
CREATE UNIQUE INDEX submission_terminal_event_unique ON submission_outbox(submission_id, kind)
  WHERE kind = 'reconcile-terminal-event';
