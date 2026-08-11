-- Product state now has one authoritative D1 database. Existing submission and
-- rejudge-derived history is intentionally reset during this one-way cutover.

DROP TABLE rejudge_verified_solves;
DROP TABLE verified_solves;
DROP TABLE formal_submission_admissions;
DROP TABLE effective_problem_versions;
DROP TABLE rejudge_batches;

-- Product-facing review feedback is intentionally a single current note, not
-- an audit trail. Existing applications remain valid with no note.
ALTER TABLE organizer_applications ADD COLUMN review_note TEXT;

-- Canonical successors were release-coupling jobs, not Organizer imports. They
-- are no longer produced. Remove any unfinished successor projection before
-- dropping the discriminator; a published successor is an unexpected data
-- preservation conflict and deliberately aborts this one-way migration.
DELETE FROM contest_problems
WHERE managed_problem_version_id IN (
  SELECT versions.id
  FROM managed_problem_versions AS versions
  JOIN managed_snapshots AS snapshots ON snapshots.id = versions.snapshot_id
  JOIN collection_imports AS imports ON imports.id = snapshots.import_id
  WHERE imports.source_kind = 'canonical-successor'
    AND snapshots.status <> 'published'
);

DELETE FROM managed_problem_versions
WHERE snapshot_id IN (
  SELECT snapshots.id
  FROM managed_snapshots AS snapshots
  JOIN collection_imports AS imports ON imports.id = snapshots.import_id
  WHERE imports.source_kind = 'canonical-successor'
    AND snapshots.status <> 'published'
);

DELETE FROM managed_snapshots
WHERE import_id IN (
  SELECT id FROM collection_imports WHERE source_kind = 'canonical-successor'
)
AND status <> 'published';

DELETE FROM collection_import_objects
WHERE import_id IN (
  SELECT id FROM collection_imports WHERE source_kind = 'canonical-successor'
);

DELETE FROM core_outbox
WHERE aggregate_id IN (
  SELECT id FROM collection_imports WHERE source_kind = 'canonical-successor'
);

DELETE FROM collection_imports
WHERE source_kind = 'canonical-successor'
  AND NOT EXISTS (
    SELECT 1 FROM managed_snapshots WHERE import_id = collection_imports.id
  );

CREATE TABLE canonical_successor_cutover_guard (
  remaining_rows INTEGER NOT NULL CHECK (remaining_rows = 0)
) STRICT;

INSERT INTO canonical_successor_cutover_guard (remaining_rows)
SELECT count(*) FROM collection_imports WHERE source_kind = 'canonical-successor';

DROP TABLE canonical_successor_cutover_guard;
DROP INDEX collection_imports_one_github_import;
DROP INDEX collection_imports_one_release_successor;
DROP INDEX collection_imports_successor_lookup;
ALTER TABLE collection_imports DROP COLUMN predecessor_import_id;
ALTER TABLE collection_imports DROP COLUMN source_kind;
ALTER TABLE collection_imports ADD COLUMN retry_of_import_id TEXT REFERENCES collection_imports(id);

CREATE UNIQUE INDEX collection_imports_one_root_source
ON collection_imports(github_repository_id, commit_sha, index_path, forge_release_id)
WHERE retry_of_import_id IS NULL;

CREATE UNIQUE INDEX collection_imports_one_retry
ON collection_imports(retry_of_import_id)
WHERE retry_of_import_id IS NOT NULL;

CREATE TABLE rejudge_batches (
  id TEXT PRIMARY KEY,
  old_problem_version_id TEXT NOT NULL REFERENCES managed_problem_versions(id),
  new_problem_version_id TEXT NOT NULL REFERENCES managed_problem_versions(id),
  requested_by TEXT NOT NULL REFERENCES users(id),
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'ready', 'effective', 'failed')),
  expected_count INTEGER NOT NULL DEFAULT 0 CHECK (expected_count >= 0),
  completed_count INTEGER NOT NULL DEFAULT 0 CHECK (completed_count >= 0),
  idempotency_key TEXT,
  request_digest TEXT CHECK (request_digest IS NULL OR length(request_digest) = 64),
  forge_release_id TEXT REFERENCES forge_releases(id),
  forge_manifest_sha256 TEXT CHECK (forge_manifest_sha256 IS NULL OR length(forge_manifest_sha256) = 64),
  ready_count INTEGER NOT NULL DEFAULT 0 CHECK (ready_count >= 0),
  failed_count INTEGER NOT NULL DEFAULT 0 CHECK (failed_count >= 0),
  failure_code TEXT,
  cancel_requested_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  effective_at TEXT,
  mappings_finalized_at TEXT,
  CHECK (old_problem_version_id <> new_problem_version_id)
) STRICT;

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

-- Rebuild contests so stored state is publication state only. Runtime phase is
-- derived from starts_at, ends_at, and freeze_at.
ALTER TABLE contest_problems RENAME TO contest_problems_legacy;
ALTER TABLE contest_participants RENAME TO contest_participants_legacy;
ALTER TABLE contests RENAME TO contests_legacy;

CREATE TABLE contests (
  id TEXT PRIMARY KEY,
  organizer_user_id TEXT NOT NULL REFERENCES users(id),
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  access_mode TEXT NOT NULL CHECK (access_mode IN ('public', 'invite')),
  invite_code_hash TEXT,
  starts_at TEXT NOT NULL,
  ends_at TEXT NOT NULL,
  freeze_at TEXT,
  status TEXT NOT NULL CHECK (status IN ('draft', 'published', 'archived')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (ends_at > starts_at),
  CHECK (freeze_at IS NULL OR (freeze_at > starts_at AND freeze_at < ends_at))
) STRICT;

INSERT INTO contests (
  id, organizer_user_id, title, description, access_mode, invite_code_hash,
  starts_at, ends_at, freeze_at, status, created_at, updated_at
)
SELECT
  id, organizer_user_id, title, description, access_mode, invite_code_hash,
  starts_at, ends_at, freeze_at,
  CASE status WHEN 'running' THEN 'published' WHEN 'ended' THEN 'published' ELSE status END,
  created_at, updated_at
FROM contests_legacy;

CREATE TABLE contest_problems (
  contest_id TEXT NOT NULL REFERENCES contests(id) ON DELETE CASCADE,
  managed_problem_version_id TEXT NOT NULL REFERENCES managed_problem_versions(id),
  ordinal INTEGER NOT NULL,
  PRIMARY KEY (contest_id, managed_problem_version_id),
  UNIQUE (contest_id, ordinal)
) STRICT;

INSERT INTO contest_problems (contest_id, managed_problem_version_id, ordinal)
SELECT contest_id, managed_problem_version_id, ordinal FROM contest_problems_legacy;

CREATE TABLE contest_participants (
  contest_id TEXT NOT NULL REFERENCES contests(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id),
  joined_at TEXT NOT NULL,
  PRIMARY KEY (contest_id, user_id)
) STRICT;

INSERT INTO contest_participants (contest_id, user_id, joined_at)
SELECT contest_id, user_id, joined_at FROM contest_participants_legacy;

DROP TABLE contest_problems_legacy;
DROP TABLE contest_participants_legacy;
DROP TABLE contests_legacy;

-- The previous release-control tables were deployment machinery, not product
-- state. Keep one active pointer and remove the qualification/drain/retention
-- state machines during the same one-way maintenance cutover.
DROP TABLE IF EXISTS release_drain_checks;
DROP TABLE IF EXISTS release_smoke_checks;
DROP TABLE IF EXISTS staging_acceptance;
DROP TABLE IF EXISTS staging_acceptances;
DROP TABLE IF EXISTS forge_release_package_mutation_leases;
DROP TABLE IF EXISTS forge_release_package_active_roots;

ALTER TABLE forge_active_releases RENAME TO forge_active_releases_legacy;

CREATE TABLE forge_active_releases (
  environment TEXT PRIMARY KEY CHECK (environment IN ('development', 'staging', 'production')),
  forge_release_id TEXT NOT NULL UNIQUE REFERENCES forge_releases(id),
  activated_by TEXT NOT NULL,
  activated_at TEXT NOT NULL
) STRICT;

INSERT INTO forge_active_releases (environment, forge_release_id, activated_by, activated_at)
SELECT environment, forge_release_id, activated_by, activated_at
FROM forge_active_releases_legacy;

DROP TABLE forge_active_releases_legacy;
DROP TABLE IF EXISTS forge_release_qualifications;

ALTER TABLE forge_releases DROP COLUMN manifest_mirror_r2_key;
ALTER TABLE collection_imports DROP COLUMN canonical_source_mirror_r2_key;

CREATE TABLE submissions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  managed_problem_version_id TEXT NOT NULL REFERENCES managed_problem_versions(id),
  contest_id TEXT REFERENCES contests(id),
  language TEXT NOT NULL,
  target TEXT NOT NULL CHECK (target IN ('wasip1', 'wasix')),
  optimization TEXT NOT NULL CHECK (optimization IN ('debug', 'release')),
  entry_path TEXT NOT NULL,
  source_r2_key TEXT NOT NULL,
  source_digest TEXT NOT NULL CHECK (length(source_digest) = 64),
  source_erased_at TEXT,
  forge_release_id TEXT NOT NULL REFERENCES forge_releases(id),
  forge_manifest_sha256 TEXT NOT NULL CHECK (length(forge_manifest_sha256) = 64),
  state TEXT NOT NULL CHECK (state IN ('admitting', 'queued', 'waiting-capacity', 'preparing', 'compiling', 'running', 'finalizing', 'completed', 'compile-error', 'judge-error', 'infrastructure-error', 'cancelled')),
  verdict TEXT CHECK (verdict IS NULL OR verdict IN ('accepted', 'wrong-answer', 'runtime-error', 'instruction-limit', 'memory-limit', 'output-limit', 'filesystem-limit', 'logical-time-limit', 'wall-time-limit', 'compile-error', 'judge-error', 'cancelled')),
  visibility TEXT NOT NULL DEFAULT 'private' CHECK (visibility IN ('private', 'public')),
  score REAL,
  fully_passed_cases INTEGER,
  deterministic_cost INTEGER,
  peak_memory_bytes INTEGER,
  effective_attempt INTEGER,
  admitted_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT,
  rejudge_batch_id TEXT REFERENCES rejudge_batches(id),
  rejudge_of_submission_id TEXT REFERENCES submissions(id),
  CHECK (
    (rejudge_batch_id IS NULL AND rejudge_of_submission_id IS NULL)
    OR (rejudge_batch_id IS NOT NULL AND rejudge_of_submission_id IS NOT NULL)
  )
) STRICT;

CREATE INDEX submissions_user_created ON submissions(user_id, created_at DESC);
CREATE INDEX submissions_problem_score ON submissions(managed_problem_version_id, score DESC);
CREATE INDEX submissions_contest_created ON submissions(contest_id, created_at);
CREATE UNIQUE INDEX submissions_rejudge_source
ON submissions(rejudge_batch_id, rejudge_of_submission_id)
WHERE rejudge_batch_id IS NOT NULL;
CREATE INDEX submissions_rejudge_batch ON submissions(rejudge_batch_id, state);
CREATE INDEX submissions_rejudge_source_availability
ON submissions(managed_problem_version_id, state, source_erased_at, user_id);
CREATE INDEX submissions_global_capacity
ON submissions(state)
WHERE state IN ('admitting', 'queued', 'waiting-capacity', 'preparing', 'compiling', 'running', 'finalizing');
CREATE INDEX submissions_user_queue_capacity
ON submissions(user_id, state)
WHERE state IN ('admitting', 'queued', 'waiting-capacity');
CREATE UNIQUE INDEX submissions_one_executing_per_user
ON submissions(user_id)
WHERE state IN ('preparing', 'compiling', 'running', 'finalizing');
CREATE INDEX submissions_problem_leaderboard
ON submissions(
  managed_problem_version_id, rejudge_batch_id, user_id, score DESC,
  fully_passed_cases DESC, deterministic_cost, peak_memory_bytes, completed_at, id
)
WHERE state='completed' AND contest_id IS NULL;
CREATE INDEX submissions_contest_leaderboard
ON submissions(
  contest_id, managed_problem_version_id, rejudge_batch_id, user_id, score DESC,
  fully_passed_cases DESC, deterministic_cost, peak_memory_bytes, completed_at, id
)
WHERE state='completed' AND contest_id IS NOT NULL;

CREATE TABLE submission_idempotency (
  user_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  request_digest TEXT NOT NULL CHECK (length(request_digest) = 64),
  submission_id TEXT NOT NULL REFERENCES submissions(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  PRIMARY KEY (user_id, idempotency_key)
) STRICT;

CREATE TABLE submission_attempts (
  submission_id TEXT NOT NULL REFERENCES submissions(id) ON DELETE CASCADE,
  attempt INTEGER NOT NULL CHECK (attempt > 0),
  token_hash TEXT NOT NULL,
  container_key TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('created', 'running', 'succeeded', 'failed', 'superseded', 'cancelled')),
  started_at TEXT,
  finished_at TEXT,
  failure_code TEXT,
  audit_r2_key TEXT,
  PRIMARY KEY (submission_id, attempt)
) STRICT;

CREATE TABLE submission_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  submission_id TEXT NOT NULL REFERENCES submissions(id) ON DELETE CASCADE,
  event_key TEXT NOT NULL CHECK (length(event_key) BETWEEN 1 AND 200),
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
  created_at TEXT NOT NULL,
  UNIQUE (submission_id, event_key)
) STRICT;

CREATE INDEX submission_events_replay ON submission_events(submission_id, id);

CREATE TABLE effective_rejudges (
  old_submission_id TEXT PRIMARY KEY REFERENCES submissions(id) ON DELETE CASCADE,
  rejudge_batch_id TEXT NOT NULL REFERENCES rejudge_batches(id) ON DELETE CASCADE,
  new_submission_id TEXT NOT NULL UNIQUE REFERENCES submissions(id) ON DELETE CASCADE,
  became_effective_at TEXT
) STRICT;

CREATE TABLE rejudge_jobs (
  rejudge_batch_id TEXT NOT NULL REFERENCES rejudge_batches(id) ON DELETE CASCADE,
  old_submission_id TEXT NOT NULL REFERENCES submissions(id) ON DELETE CASCADE,
  new_submission_id TEXT NOT NULL UNIQUE REFERENCES submissions(id) ON DELETE CASCADE,
  old_problem_version_id TEXT NOT NULL REFERENCES managed_problem_versions(id),
  new_problem_version_id TEXT NOT NULL REFERENCES managed_problem_versions(id),
  state TEXT NOT NULL CHECK (state IN ('pending', 'dispatched', 'ready', 'failed', 'cancelled')),
  result_state TEXT CHECK (result_state IS NULL OR result_state IN ('completed', 'compile-error', 'judge-error', 'infrastructure-error', 'cancelled')),
  erasure_excluded_at TEXT,
  workflow_payload_json TEXT NOT NULL CHECK (json_valid(workflow_payload_json)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (rejudge_batch_id, old_submission_id)
) STRICT;

CREATE INDEX rejudge_jobs_dispatch ON rejudge_jobs(rejudge_batch_id, state, created_at);
CREATE INDEX rejudge_jobs_erasure_eligible
ON rejudge_jobs(rejudge_batch_id, erasure_excluded_at, state, created_at);

CREATE TABLE formal_risk_allowances (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  request_key TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (user_id, request_key),
  CHECK (length(request_key) = 64 AND request_key NOT GLOB '*[^0-9a-f]*')
) STRICT;

CREATE INDEX formal_risk_allowances_expiry ON formal_risk_allowances(expires_at);

CREATE TABLE outbox (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('start-submission-workflow', 'start-validation-workflow', 'materialize-rejudge', 'cleanup-import-archive')),
  aggregate_id TEXT NOT NULL,
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
  created_at TEXT NOT NULL,
  delivered_at TEXT,
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  last_error TEXT
) STRICT;

INSERT INTO outbox (
  id, kind, aggregate_id, payload_json, created_at, delivered_at, attempts, last_error
)
SELECT id, kind, aggregate_id, payload_json, created_at, delivered_at, attempts, last_error
FROM core_outbox
WHERE kind = 'cleanup-import-archive' AND delivered_at IS NULL;

DROP TABLE core_outbox;

CREATE INDEX outbox_pending ON outbox(delivered_at, created_at);
CREATE UNIQUE INDEX outbox_one_pending_aggregate
ON outbox(kind, aggregate_id)
WHERE delivered_at IS NULL;

UPDATE formal_mutation_controls
SET formal_mutations_enabled = 0,
    reason = 'single-store-object-reset-pending',
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE environment = 'production';

PRAGMA foreign_key_check;
