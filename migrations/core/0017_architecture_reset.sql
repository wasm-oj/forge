-- One-way formal-domain reset. Identity, authentication, profiles, roles,
-- GitHub authority, account-erasure records, and the formal mutation switch
-- survive. Catalog, contest, judging, rejudge, release, and delivery state do
-- not. Run the external reset preflight before applying this migration.

PRAGMA foreign_keys = ON;

-- Fail closed before the first destructive statement. External Workflow and
-- R2 quiescence cannot be proven by SQL and are checked by the preflight tool.
DROP TABLE IF EXISTS architecture_reset_guard;
CREATE TABLE architecture_reset_guard (
  violations INTEGER NOT NULL CHECK (violations = 0)
) STRICT;

INSERT INTO architecture_reset_guard (violations)
SELECT
  (SELECT COUNT(*) FROM formal_mutation_controls
    WHERE environment IN ('staging', 'production') AND formal_mutations_enabled <> 0)
  + (SELECT COUNT(*) FROM account_erasure_jobs
      WHERE status NOT IN ('completed', 'failed'))
  + (SELECT COUNT(*) FROM collection_imports
      WHERE status IN ('queued', 'downloading', 'validating'))
  + (SELECT COUNT(*) FROM submissions
      WHERE state NOT IN ('completed', 'compile-error', 'judge-error', 'infrastructure-error', 'cancelled'))
  + (SELECT COUNT(*) FROM rejudge_batches
      WHERE status IN ('queued', 'running', 'ready'))
  + (SELECT COUNT(*) FROM outbox WHERE delivered_at IS NULL);

DROP TABLE architecture_reset_guard;

-- The full reset preflight retrieves each exact legacy R2 receipt, verifies its
-- original digest and canonical v1 identity, then stages the exact JSON bytes
-- (including the final newline). Require a complete one-to-one snapshot before
-- changing any durable table. The preflight is the trusted SHA-256 boundary
-- because SQLite/D1 exposes no SHA-256 SQL function.
-- A brand-new empty database has no preflight stage, so create the same empty
-- shape; the one-to-one guard below still rejects any historic receipt unless
-- the verified stage was populated.
CREATE TABLE IF NOT EXISTS architecture_reset_erasure_receipts (
  record_kind TEXT NOT NULL CHECK (record_kind IN ('job', 'tombstone')),
  record_id TEXT NOT NULL CHECK (length(record_id) BETWEEN 1 AND 1024),
  anonymous_user_id TEXT NOT NULL CHECK (length(anonymous_user_id) BETWEEN 1 AND 1024),
  erased_at TEXT NOT NULL,
  receipt_r2_key TEXT NOT NULL CHECK (length(receipt_r2_key) BETWEEN 1 AND 1024),
  receipt_json TEXT NOT NULL CHECK (
    json_valid(receipt_json)
    AND length(CAST(receipt_json AS BLOB)) BETWEEN 2 AND 65536
    AND substr(receipt_json, -1) = char(10)
    AND json_extract(receipt_json, '$.schema') IS 'forge-account-erasure-receipt-v1'
    AND json_extract(receipt_json, '$.anonymousUserId') IS anonymous_user_id
    AND json_extract(receipt_json, '$.erasedAt') IS erased_at
    AND (record_kind <> 'job' OR json_extract(receipt_json, '$.jobId') IS record_id)
  ),
  receipt_sha256 TEXT NOT NULL
    CHECK (length(receipt_sha256) = 64 AND receipt_sha256 NOT GLOB '*[^0-9a-f]*'),
  PRIMARY KEY (record_kind, record_id)
) STRICT;

DROP TABLE IF EXISTS architecture_reset_receipt_guard;
CREATE TABLE architecture_reset_receipt_guard (
  violations INTEGER NOT NULL CHECK (violations = 0)
) STRICT;

INSERT INTO architecture_reset_receipt_guard (violations)
SELECT
  (SELECT COUNT(*) FROM account_erasure_jobs
    WHERE (deletion_receipt_r2_key IS NULL) <> (deletion_receipt_sha256 IS NULL)
      OR (status = 'completed' AND (completed_at IS NULL OR deletion_receipt_sha256 IS NULL)))
  + (SELECT COUNT(*) FROM account_erasure_jobs AS legacy
    WHERE legacy.deletion_receipt_sha256 IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM architecture_reset_erasure_receipts AS staged
        WHERE staged.record_kind = 'job'
          AND staged.record_id = legacy.id
          AND staged.anonymous_user_id = legacy.anonymous_user_id
          AND staged.erased_at = legacy.requested_at
          AND staged.receipt_r2_key = legacy.deletion_receipt_r2_key
          AND staged.receipt_sha256 = legacy.deletion_receipt_sha256
      ))
  + (SELECT COUNT(*) FROM erased_user_tombstones AS legacy
    WHERE NOT EXISTS (
      SELECT 1 FROM architecture_reset_erasure_receipts AS staged
      WHERE staged.record_kind = 'tombstone'
        AND staged.record_id = legacy.anonymous_user_id
        AND staged.anonymous_user_id = legacy.anonymous_user_id
        AND staged.erased_at = legacy.erased_at
        AND staged.receipt_r2_key = legacy.deletion_receipt_r2_key
        AND staged.receipt_sha256 = legacy.deletion_receipt_sha256
    ))
  + (SELECT COUNT(*) FROM architecture_reset_erasure_receipts AS staged
    WHERE (staged.record_kind = 'job' AND NOT EXISTS (
      SELECT 1 FROM account_erasure_jobs AS legacy
      WHERE legacy.id = staged.record_id
        AND legacy.anonymous_user_id = staged.anonymous_user_id
        AND legacy.requested_at = staged.erased_at
        AND legacy.deletion_receipt_r2_key = staged.receipt_r2_key
        AND legacy.deletion_receipt_sha256 = staged.receipt_sha256
    )) OR (staged.record_kind = 'tombstone' AND NOT EXISTS (
      SELECT 1 FROM erased_user_tombstones AS legacy
      WHERE legacy.anonymous_user_id = staged.record_id
        AND legacy.anonymous_user_id = staged.anonymous_user_id
        AND legacy.erased_at = staged.erased_at
        AND legacy.deletion_receipt_r2_key = staged.receipt_r2_key
        AND legacy.deletion_receipt_sha256 = staged.receipt_sha256
    )))
  + (SELECT COUNT(*) FROM architecture_reset_erasure_receipts
    WHERE NOT json_valid(receipt_json)
      OR receipt_json <> json(receipt_json) || char(10)
      OR length(CAST(receipt_json AS BLOB)) NOT BETWEEN 2 AND 65536
      OR json_extract(receipt_json, '$.schema') IS NOT 'forge-account-erasure-receipt-v1'
      OR json_extract(receipt_json, '$.anonymousUserId') IS NOT anonymous_user_id
      OR json_extract(receipt_json, '$.erasedAt') IS NOT erased_at
      OR (record_kind = 'job' AND json_extract(receipt_json, '$.jobId') IS NOT record_id)
      OR (SELECT COUNT(*) FROM json_each(receipt_json)) <> 7
      OR EXISTS (
        SELECT 1 FROM json_each(receipt_json)
        WHERE key NOT IN (
          'schema', 'jobId', 'anonymousUserId', 'erasedAt',
          'deletedSourceObjects', 'affectedProblems', 'affectedContests'
        )
      )
      OR json_type(receipt_json, '$.jobId') IS NOT 'text'
      OR json_type(receipt_json, '$.deletedSourceObjects') IS NOT 'integer'
      OR json_extract(receipt_json, '$.deletedSourceObjects') < 0
      OR json_type(receipt_json, '$.affectedProblems') IS NOT 'integer'
      OR json_extract(receipt_json, '$.affectedProblems') < 0
      OR json_type(receipt_json, '$.affectedContests') IS NOT 'integer'
      OR json_extract(receipt_json, '$.affectedContests') < 0
      OR length(receipt_sha256) <> 64
      OR receipt_sha256 GLOB '*[^0-9a-f]*');

DROP TABLE architecture_reset_receipt_guard;

UPDATE formal_mutation_controls
SET formal_mutations_enabled = 0,
    reason = 'architecture-reset-maintenance',
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now');

-- Admission records capture this generation before any R2 write. Account
-- erasure increments it in the same D1 transaction that creates the erasure
-- job, so a late source finalizer cannot make erased bytes live again.
ALTER TABLE users ADD COLUMN erasure_epoch INTEGER NOT NULL DEFAULT 0
  CHECK (erasure_epoch >= 0);

CREATE TRIGGER users_erasure_epoch_monotonic
BEFORE UPDATE OF erasure_epoch ON users
WHEN NEW.erasure_epoch <> OLD.erasure_epoch + 1
BEGIN
  SELECT RAISE(ABORT, 'user erasure epoch must increment by one');
END;

-- Preserve erasure history while cutting the last receipt dependency on R2.
-- Historic rows retain their exact bounded receipt JSON and original digest in
-- D1; all newly completed erasures also write their receipt directly.
ALTER TABLE account_erasure_jobs RENAME TO account_erasure_jobs_legacy;
ALTER TABLE erased_user_tombstones RENAME TO erased_user_tombstones_legacy;

CREATE TABLE account_erasure_jobs (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL UNIQUE,
  anonymous_user_id TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK (status IN ('queued', 'revoking', 'deleting-sources', 'anonymizing', 'completed', 'failed')),
  requested_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT,
  receipt_json TEXT CHECK (
    receipt_json IS NULL
    OR (json_valid(receipt_json) AND length(CAST(receipt_json AS BLOB)) BETWEEN 2 AND 65536)
  ),
  receipt_sha256 TEXT CHECK (
    receipt_sha256 IS NULL
    OR (length(receipt_sha256) = 64 AND receipt_sha256 NOT GLOB '*[^0-9a-f]*')
  ),
  last_error TEXT,
  CHECK ((receipt_json IS NULL) = (receipt_sha256 IS NULL)),
  CHECK (
    status <> 'completed'
    OR (completed_at IS NOT NULL AND receipt_json IS NOT NULL AND receipt_sha256 IS NOT NULL)
  )
) STRICT;

INSERT INTO account_erasure_jobs (
  id, user_id, anonymous_user_id, status, requested_at, updated_at,
  completed_at, receipt_json, receipt_sha256, last_error
)
SELECT
  legacy.id, legacy.user_id, legacy.anonymous_user_id, legacy.status,
  legacy.requested_at, legacy.updated_at, legacy.completed_at,
  staged.receipt_json, staged.receipt_sha256, legacy.last_error
FROM account_erasure_jobs_legacy AS legacy
LEFT JOIN architecture_reset_erasure_receipts AS staged
  ON staged.record_kind = 'job'
  AND staged.record_id = legacy.id
  AND staged.anonymous_user_id = legacy.anonymous_user_id
  AND staged.erased_at = legacy.requested_at
  AND staged.receipt_r2_key = legacy.deletion_receipt_r2_key
  AND staged.receipt_sha256 = legacy.deletion_receipt_sha256;

CREATE TABLE erased_user_tombstones (
  anonymous_user_id TEXT PRIMARY KEY,
  original_user_sha256 TEXT NOT NULL UNIQUE
    CHECK (length(original_user_sha256) = 64 AND original_user_sha256 NOT GLOB '*[^0-9a-f]*'),
  erased_at TEXT NOT NULL,
  receipt_json TEXT NOT NULL CHECK (
    json_valid(receipt_json) AND length(CAST(receipt_json AS BLOB)) BETWEEN 2 AND 65536
  ),
  receipt_sha256 TEXT NOT NULL
    CHECK (length(receipt_sha256) = 64 AND receipt_sha256 NOT GLOB '*[^0-9a-f]*')
) STRICT;

INSERT INTO erased_user_tombstones (
  anonymous_user_id, original_user_sha256, erased_at, receipt_json, receipt_sha256
)
SELECT
  legacy.anonymous_user_id,
  legacy.original_user_sha256,
  legacy.erased_at,
  staged.receipt_json,
  staged.receipt_sha256
FROM erased_user_tombstones_legacy AS legacy
JOIN architecture_reset_erasure_receipts AS staged
  ON staged.record_kind = 'tombstone'
  AND staged.record_id = legacy.anonymous_user_id
  AND staged.anonymous_user_id = legacy.anonymous_user_id
  AND staged.erased_at = legacy.erased_at
  AND staged.receipt_r2_key = legacy.deletion_receipt_r2_key
  AND staged.receipt_sha256 = legacy.deletion_receipt_sha256;

DROP TABLE account_erasure_jobs_legacy;
DROP TABLE erased_user_tombstones_legacy;
DROP TABLE architecture_reset_erasure_receipts;

-- Drop children before parents. No compatibility tables or views survive.
DROP TABLE effective_rejudges;
DROP TABLE rejudge_jobs;
DROP TABLE submission_events;
DROP TABLE submission_attempts;
DROP TABLE submission_idempotency;
DROP TABLE submissions;
DROP TABLE formal_risk_allowances;
DROP TABLE effective_problem_versions;
DROP TABLE rejudge_batches;
DROP TABLE contest_participants;
DROP TABLE contest_problems;
DROP TABLE contests;
DROP TABLE managed_problem_versions;
DROP TABLE managed_snapshots;
DROP TABLE collection_import_objects;
DROP TABLE canonical_object_gc;
DROP TABLE outbox;
DROP TABLE collection_imports;
DROP TABLE repository_push_notices;
DROP TABLE forge_active_releases;
DROP TABLE forge_releases;

CREATE TABLE formal_risk_allowances (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  request_key TEXT NOT NULL
    CHECK (length(request_key) = 64 AND request_key NOT GLOB '*[^0-9a-f]*'),
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (user_id, request_key)
) STRICT;

CREATE INDEX formal_risk_allowances_expiry
ON formal_risk_allowances(expires_at);

-- Release manifests are small canonical control documents and live in D1.
-- R2 is no longer an authority for release identity.
CREATE TABLE wasm_oj_releases (
  id TEXT PRIMARY KEY CHECK (length(id) = 36),
  version TEXT NOT NULL UNIQUE,
  manifest_json TEXT NOT NULL
    CHECK (json_valid(manifest_json) AND length(CAST(manifest_json AS BLOB)) BETWEEN 2 AND 262144),
  manifest_bytes INTEGER NOT NULL CHECK (manifest_bytes BETWEEN 2 AND 262144),
  manifest_sha256 TEXT NOT NULL
    CHECK (length(manifest_sha256) = 64 AND manifest_sha256 NOT GLOB '*[^0-9a-f]*'),
  source_git_commit TEXT NOT NULL
    CHECK (length(source_git_commit) = 40 AND source_git_commit NOT GLOB '*[^0-9a-f]*'),
  created_at TEXT NOT NULL,
  revoked_at TEXT,
  CHECK (manifest_bytes = length(CAST(manifest_json AS BLOB)))
) STRICT;

CREATE UNIQUE INDEX wasm_oj_releases_identity
ON wasm_oj_releases(id, manifest_sha256);

CREATE TABLE wasm_oj_active_releases (
  environment TEXT PRIMARY KEY CHECK (environment IN ('development', 'staging', 'production')),
  wasm_oj_release_id TEXT NOT NULL REFERENCES wasm_oj_releases(id) ON DELETE RESTRICT,
  activated_by TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  activated_at TEXT NOT NULL
) STRICT;

CREATE TRIGGER wasm_oj_release_manifest_immutable
BEFORE UPDATE OF id, version, manifest_json, manifest_bytes, manifest_sha256,
  source_git_commit, created_at ON wasm_oj_releases
BEGIN
  SELECT RAISE(ABORT, 'WASM-OJ release identity is immutable');
END;

CREATE TRIGGER wasm_oj_release_revocation_guard
BEFORE UPDATE OF revoked_at ON wasm_oj_releases
WHEN OLD.revoked_at IS NOT NULL OR NEW.revoked_at IS NULL
BEGIN
  SELECT RAISE(ABORT, 'WASM-OJ release revocation is one-way');
END;

CREATE TRIGGER wasm_oj_active_release_target_guard
BEFORE INSERT ON wasm_oj_active_releases
WHEN NOT EXISTS (
  SELECT 1 FROM wasm_oj_releases
  WHERE id = NEW.wasm_oj_release_id AND revoked_at IS NULL
)
BEGIN
  SELECT RAISE(ABORT, 'active release must reference a non-revoked release');
END;

CREATE TRIGGER wasm_oj_active_release_update_guard
BEFORE UPDATE OF wasm_oj_release_id ON wasm_oj_active_releases
WHEN NOT EXISTS (
  SELECT 1 FROM wasm_oj_releases
  WHERE id = NEW.wasm_oj_release_id AND revoked_at IS NULL
)
BEGIN
  SELECT RAISE(ABORT, 'active release must reference a non-revoked release');
END;

CREATE TRIGGER wasm_oj_active_release_environment_immutable
BEFORE UPDATE OF environment ON wasm_oj_active_releases
BEGIN
  SELECT RAISE(ABORT, 'active release environment is immutable');
END;

CREATE TRIGGER wasm_oj_release_delete_forbidden
BEFORE DELETE ON wasm_oj_releases
BEGIN
  SELECT RAISE(ABORT, 'WASM-OJ releases are immutable');
END;

CREATE TABLE problem_collections (
  id TEXT PRIMARY KEY CHECK (length(id) = 36),
  organizer_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  github_repository_id INTEGER NOT NULL REFERENCES github_repositories(github_repository_id) ON DELETE RESTRICT,
  index_path TEXT NOT NULL CHECK (
    length(index_path) BETWEEN 1 AND 512
    AND index_path NOT LIKE '/%'
    AND index_path NOT LIKE '%/'
    AND index_path NOT LIKE '%//%'
    AND instr(index_path, '\') = 0
    AND ('/' || index_path || '/') NOT LIKE '%/./%'
    AND ('/' || index_path || '/') NOT LIKE '%/../%'
  ),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (github_repository_id, index_path),
  UNIQUE (id, index_path)
) STRICT;

CREATE TABLE catalog_validation_jobs (
  id TEXT PRIMARY KEY CHECK (length(id) = 36),
  collection_id TEXT NOT NULL REFERENCES problem_collections(id) ON DELETE RESTRICT,
  requested_ref TEXT NOT NULL CHECK (length(requested_ref) BETWEEN 1 AND 256),
  commit_sha TEXT NOT NULL
    CHECK (length(commit_sha) = 40 AND commit_sha NOT GLOB '*[^0-9a-f]*'),
  state TEXT NOT NULL CHECK (state IN ('queued', 'running', 'valid', 'invalid', 'infrastructure-error')),
  created_by TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  error_code TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT,
  CHECK (
    (state = 'queued' AND started_at IS NULL AND finished_at IS NULL AND error_code IS NULL)
    OR (state = 'running' AND started_at IS NOT NULL AND finished_at IS NULL AND error_code IS NULL)
    OR (state = 'valid' AND started_at IS NOT NULL AND finished_at IS NOT NULL AND error_code IS NULL)
    OR (state IN ('invalid', 'infrastructure-error') AND started_at IS NOT NULL AND finished_at IS NOT NULL AND error_code IS NOT NULL)
  )
) STRICT;

CREATE UNIQUE INDEX catalog_validation_jobs_one_active
ON catalog_validation_jobs(collection_id, commit_sha)
WHERE state IN ('queued', 'running');

CREATE TRIGGER catalog_validation_job_identity_immutable
BEFORE UPDATE OF id, collection_id, requested_ref, commit_sha, created_at
ON catalog_validation_jobs
BEGIN
  SELECT RAISE(ABORT, 'catalog validation job identity is immutable');
END;

CREATE TRIGGER catalog_validation_job_actor_erasure_guard
BEFORE UPDATE OF created_by ON catalog_validation_jobs
WHEN NOT EXISTS (
  SELECT 1 FROM account_erasure_jobs
  WHERE user_id = OLD.created_by AND anonymous_user_id = NEW.created_by
)
BEGIN
  SELECT RAISE(ABORT, 'catalog validation actor may change only for account erasure');
END;

CREATE TRIGGER catalog_validation_job_state_transition_guard
BEFORE UPDATE OF state ON catalog_validation_jobs
WHEN NOT (
  OLD.state = NEW.state
  OR (OLD.state = 'queued' AND NEW.state = 'running')
  OR (OLD.state = 'running' AND NEW.state IN ('valid', 'invalid', 'infrastructure-error'))
)
BEGIN
  SELECT RAISE(ABORT, 'catalog validation job transition is invalid');
END;

CREATE TRIGGER catalog_validation_job_terminal_immutable
BEFORE UPDATE OF state, error_code, updated_at, started_at, finished_at
ON catalog_validation_jobs
WHEN OLD.state IN ('valid', 'invalid', 'infrastructure-error')
BEGIN
  SELECT RAISE(ABORT, 'terminal catalog validation jobs are immutable');
END;

CREATE TABLE collection_revisions (
  id TEXT PRIMARY KEY CHECK (length(id) = 36),
  collection_id TEXT NOT NULL,
  validation_job_id TEXT NOT NULL UNIQUE,
  commit_sha TEXT NOT NULL
    CHECK (length(commit_sha) = 40 AND commit_sha NOT GLOB '*[^0-9a-f]*'),
  collection_revision_sha256 TEXT NOT NULL
    CHECK (length(collection_revision_sha256) = 64 AND collection_revision_sha256 NOT GLOB '*[^0-9a-f]*'),
  index_path TEXT NOT NULL,
  index_git_sha TEXT NOT NULL
    CHECK (length(index_git_sha) = 40 AND index_git_sha NOT GLOB '*[^0-9a-f]*'),
  index_bytes INTEGER NOT NULL CHECK (index_bytes BETWEEN 1 AND 524288),
  index_sha256 TEXT NOT NULL
    CHECK (length(index_sha256) = 64 AND index_sha256 NOT GLOB '*[^0-9a-f]*'),
  managed_path TEXT NOT NULL CHECK (
    length(managed_path) BETWEEN 1 AND 512
    AND managed_path NOT LIKE '/%'
    AND managed_path NOT LIKE '%/'
    AND managed_path NOT LIKE '%//%'
    AND instr(managed_path, '\') = 0
    AND ('/' || managed_path || '/') NOT LIKE '%/./%'
    AND ('/' || managed_path || '/') NOT LIKE '%/../%'
  ),
  managed_git_sha TEXT NOT NULL
    CHECK (length(managed_git_sha) = 40 AND managed_git_sha NOT GLOB '*[^0-9a-f]*'),
  managed_bytes INTEGER NOT NULL CHECK (managed_bytes BETWEEN 1 AND 2097152),
  managed_sha256 TEXT NOT NULL
    CHECK (length(managed_sha256) = 64 AND managed_sha256 NOT GLOB '*[^0-9a-f]*'),
  contract_version INTEGER NOT NULL CHECK (contract_version = 2),
  validation_summary_json TEXT NOT NULL CHECK (
    json_valid(validation_summary_json)
    AND length(CAST(validation_summary_json AS BLOB)) BETWEEN 2 AND 65536
  ),
  validated_by TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  validated_at TEXT NOT NULL,
  FOREIGN KEY (collection_id, index_path)
    REFERENCES problem_collections(id, index_path) ON DELETE RESTRICT,
  -- The validation job is bounded operational history and is retained for only
  -- 30 days. Keep its immutable identifier as provenance, but do not make the
  -- durable revision depend on the ephemeral job row.
  UNIQUE (collection_id, commit_sha)
) STRICT;

CREATE TRIGGER collection_revision_validation_fence
BEFORE INSERT ON collection_revisions
WHEN NOT EXISTS (
  SELECT 1 FROM catalog_validation_jobs AS job
  WHERE job.id = NEW.validation_job_id
    AND job.collection_id = NEW.collection_id
    AND job.commit_sha = NEW.commit_sha
    AND job.state = 'valid'
    AND job.created_by = NEW.validated_by
)
BEGIN
  SELECT RAISE(ABORT, 'collection revision requires its exact valid validation job');
END;

CREATE TRIGGER collection_revision_identity_immutable
BEFORE UPDATE OF
  id, collection_id, validation_job_id, commit_sha,
  collection_revision_sha256, index_path, index_git_sha, index_bytes,
  index_sha256, managed_path, managed_git_sha, managed_bytes, managed_sha256,
  contract_version, validation_summary_json, validated_at
ON collection_revisions
BEGIN
  SELECT RAISE(ABORT, 'collection revisions are immutable');
END;

CREATE TRIGGER collection_revision_actor_erasure_guard
BEFORE UPDATE OF validated_by ON collection_revisions
WHEN NOT EXISTS (
  SELECT 1 FROM account_erasure_jobs
  WHERE user_id = OLD.validated_by AND anonymous_user_id = NEW.validated_by
)
BEGIN
  SELECT RAISE(ABORT, 'collection revision actor may change only for account erasure');
END;

CREATE TRIGGER collection_revision_delete_forbidden
BEFORE DELETE ON collection_revisions
BEGIN
  SELECT RAISE(ABORT, 'collection revisions are immutable');
END;

CREATE TABLE problem_series (
  id TEXT PRIMARY KEY CHECK (length(id) = 36),
  collection_id TEXT NOT NULL REFERENCES problem_collections(id) ON DELETE RESTRICT,
  problem_slug TEXT NOT NULL CHECK (
    length(problem_slug) BETWEEN 1 AND 128
    AND problem_slug GLOB '[a-z0-9]*'
    AND problem_slug NOT GLOB '*[^a-z0-9-]*'
    AND problem_slug NOT LIKE '%-'
    AND problem_slug NOT LIKE '%--%'
  ),
  created_at TEXT NOT NULL,
  UNIQUE (collection_id, problem_slug)
) STRICT;

CREATE TRIGGER problem_series_identity_immutable
BEFORE UPDATE OF collection_id, problem_slug ON problem_series
BEGIN
  SELECT RAISE(ABORT, 'problem series identity is immutable');
END;

CREATE TRIGGER problem_series_delete_forbidden
BEFORE DELETE ON problem_series
BEGIN
  SELECT RAISE(ABORT, 'problem series are immutable');
END;

CREATE TABLE collection_revision_problems (
  collection_revision_id TEXT NOT NULL,
  problem_series_id TEXT NOT NULL,
  problem_number INTEGER NOT NULL CHECK (problem_number BETWEEN 1 AND 1000),
  title_json TEXT NOT NULL CHECK (json_valid(title_json) AND length(CAST(title_json AS BLOB)) <= 4096),
  difficulty TEXT CHECK (difficulty IN ('easy', 'medium', 'hard')),
  tags_json TEXT CHECK (tags_json IS NULL OR (json_valid(tags_json) AND length(CAST(tags_json AS BLOB)) <= 4096)),
  track_id TEXT CHECK (
    track_id IS NULL OR (
      length(track_id) BETWEEN 1 AND 128
      AND track_id GLOB '[a-z0-9]*'
      AND track_id NOT GLOB '*[^a-z0-9-]*'
      AND track_id NOT LIKE '%-'
      AND track_id NOT LIKE '%--%'
    )
  ),
  track_json TEXT CHECK (track_json IS NULL OR (json_valid(track_json) AND length(CAST(track_json AS BLOB)) <= 4096)),
  practice_bundle_path TEXT NOT NULL,
  practice_bundle_git_sha TEXT NOT NULL
    CHECK (length(practice_bundle_git_sha) = 40 AND practice_bundle_git_sha NOT GLOB '*[^0-9a-f]*'),
  practice_bundle_bytes INTEGER NOT NULL CHECK (practice_bundle_bytes BETWEEN 1 AND 8388608),
  practice_bundle_sha256 TEXT NOT NULL
    CHECK (length(practice_bundle_sha256) = 64 AND practice_bundle_sha256 NOT GLOB '*[^0-9a-f]*'),
  contest_public_path TEXT NOT NULL,
  contest_public_git_sha TEXT NOT NULL
    CHECK (length(contest_public_git_sha) = 40 AND contest_public_git_sha NOT GLOB '*[^0-9a-f]*'),
  contest_public_bytes INTEGER NOT NULL CHECK (contest_public_bytes BETWEEN 1 AND 8388608),
  contest_public_sha256 TEXT NOT NULL
    CHECK (length(contest_public_sha256) = 64 AND contest_public_sha256 NOT GLOB '*[^0-9a-f]*'),
  judge_package_path TEXT NOT NULL,
  judge_package_git_sha TEXT NOT NULL
    CHECK (length(judge_package_git_sha) = 40 AND judge_package_git_sha NOT GLOB '*[^0-9a-f]*'),
  judge_package_bytes INTEGER NOT NULL CHECK (judge_package_bytes BETWEEN 1 AND 33554432),
  judge_package_sha256 TEXT NOT NULL
    CHECK (length(judge_package_sha256) = 64 AND judge_package_sha256 NOT GLOB '*[^0-9a-f]*'),
  allowed_profiles_json TEXT NOT NULL CHECK (
    json_valid(allowed_profiles_json) AND length(CAST(allowed_profiles_json AS BLOB)) <= 16384
  ),
  maximum_score REAL NOT NULL DEFAULT 100 CHECK (maximum_score > 0),
  PRIMARY KEY (collection_revision_id, problem_series_id),
  FOREIGN KEY (collection_revision_id) REFERENCES collection_revisions(id) ON DELETE RESTRICT,
  FOREIGN KEY (problem_series_id) REFERENCES problem_series(id) ON DELETE RESTRICT,
  UNIQUE (collection_revision_id, problem_number),
  CHECK (
    length(practice_bundle_path) BETWEEN 1 AND 512
    AND practice_bundle_path NOT LIKE '/%'
    AND practice_bundle_path NOT LIKE '%/'
    AND practice_bundle_path NOT LIKE '%//%'
    AND instr(practice_bundle_path, '\') = 0
    AND ('/' || practice_bundle_path || '/') NOT LIKE '%/./%'
    AND ('/' || practice_bundle_path || '/') NOT LIKE '%/../%'
  ),
  CHECK (
    length(contest_public_path) BETWEEN 1 AND 512
    AND contest_public_path NOT LIKE '/%'
    AND contest_public_path NOT LIKE '%/'
    AND contest_public_path NOT LIKE '%//%'
    AND instr(contest_public_path, '\') = 0
    AND ('/' || contest_public_path || '/') NOT LIKE '%/./%'
    AND ('/' || contest_public_path || '/') NOT LIKE '%/../%'
  ),
  CHECK (
    length(judge_package_path) BETWEEN 1 AND 512
    AND judge_package_path NOT LIKE '/%'
    AND judge_package_path NOT LIKE '%/'
    AND judge_package_path NOT LIKE '%//%'
    AND instr(judge_package_path, '\') = 0
    AND ('/' || judge_package_path || '/') NOT LIKE '%/./%'
    AND ('/' || judge_package_path || '/') NOT LIKE '%/../%'
  )
) STRICT;

CREATE TRIGGER collection_revision_problem_update_forbidden
BEFORE UPDATE ON collection_revision_problems
BEGIN
  SELECT RAISE(ABORT, 'collection revision problems are immutable');
END;

CREATE TRIGGER collection_revision_problem_delete_forbidden
BEFORE DELETE ON collection_revision_problems
BEGIN
  SELECT RAISE(ABORT, 'collection revision problems are immutable');
END;

CREATE TRIGGER collection_revision_problem_collection_guard
BEFORE INSERT ON collection_revision_problems
WHEN NOT EXISTS (
  SELECT 1
  FROM collection_revisions
  JOIN problem_series
    ON problem_series.collection_id = collection_revisions.collection_id
  WHERE collection_revisions.id = NEW.collection_revision_id
    AND problem_series.id = NEW.problem_series_id
)
BEGIN
  SELECT RAISE(ABORT, 'revision problem must belong to the revision collection');
END;

CREATE TABLE catalog_publish_jobs (
  id TEXT PRIMARY KEY CHECK (length(id) = 36),
  collection_revision_id TEXT NOT NULL REFERENCES collection_revisions(id) ON DELETE RESTRICT,
  mode TEXT NOT NULL CHECK (mode IN ('official-practice', 'contest')),
  state TEXT NOT NULL CHECK (state IN ('queued', 'materializing', 'published', 'failed', 'cancelled')),
  requested_by TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  idempotency_key TEXT NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 128),
  request_digest TEXT NOT NULL
    CHECK (length(request_digest) = 64 AND request_digest NOT GLOB '*[^0-9a-f]*'),
  error_code TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT,
  CHECK (
    (state = 'queued' AND started_at IS NULL AND finished_at IS NULL AND error_code IS NULL)
    OR (state = 'materializing' AND started_at IS NOT NULL AND finished_at IS NULL AND error_code IS NULL)
    OR (state = 'published' AND started_at IS NOT NULL AND finished_at IS NOT NULL AND error_code IS NULL)
    OR (state = 'failed' AND started_at IS NOT NULL AND finished_at IS NOT NULL AND error_code IS NOT NULL)
    OR (state = 'cancelled' AND finished_at IS NOT NULL)
  ),
  UNIQUE (requested_by, idempotency_key)
) STRICT;

CREATE UNIQUE INDEX catalog_publish_jobs_one_active
ON catalog_publish_jobs(collection_revision_id, mode)
WHERE state IN ('queued', 'materializing');

CREATE TRIGGER catalog_publish_job_identity_immutable
BEFORE UPDATE OF
  id, collection_revision_id, mode, idempotency_key, request_digest, created_at
ON catalog_publish_jobs
BEGIN
  SELECT RAISE(ABORT, 'catalog publish job identity is immutable');
END;

CREATE TRIGGER catalog_publish_job_actor_erasure_guard
BEFORE UPDATE OF requested_by ON catalog_publish_jobs
WHEN NOT EXISTS (
  SELECT 1 FROM account_erasure_jobs
  WHERE user_id = OLD.requested_by AND anonymous_user_id = NEW.requested_by
)
BEGIN
  SELECT RAISE(ABORT, 'catalog publish actor may change only for account erasure');
END;

CREATE TRIGGER catalog_publish_job_state_transition_guard
BEFORE UPDATE OF state ON catalog_publish_jobs
WHEN NOT (
  OLD.state = NEW.state
  OR (OLD.state = 'queued' AND NEW.state IN ('materializing', 'cancelled'))
  OR (OLD.state = 'materializing' AND NEW.state IN ('published', 'failed', 'cancelled'))
)
BEGIN
  SELECT RAISE(ABORT, 'catalog publish job transition is invalid');
END;

CREATE TRIGGER catalog_publish_job_terminal_immutable
BEFORE UPDATE OF state, error_code, updated_at, started_at, finished_at
ON catalog_publish_jobs
WHEN OLD.state IN ('published', 'failed', 'cancelled')
BEGIN
  SELECT RAISE(ABORT, 'terminal catalog publish jobs are immutable');
END;

CREATE TABLE judge_packages (
  sha256 TEXT PRIMARY KEY
    CHECK (length(sha256) = 64 AND sha256 NOT GLOB '*[^0-9a-f]*'),
  bytes INTEGER NOT NULL CHECK (bytes BETWEEN 1 AND 33554432),
  state TEXT NOT NULL CHECK (state IN ('staging', 'ready', 'deleting')),
  staged_at TEXT NOT NULL,
  ready_at TEXT,
  delete_token TEXT,
  lease_expires_at TEXT,
  last_error TEXT,
  CHECK (
    (state = 'staging' AND ready_at IS NULL AND delete_token IS NULL AND lease_expires_at IS NULL)
    OR (state = 'ready' AND ready_at IS NOT NULL AND delete_token IS NULL AND lease_expires_at IS NULL AND last_error IS NULL)
    OR (state = 'deleting' AND ready_at IS NULL AND delete_token IS NOT NULL AND lease_expires_at IS NOT NULL)
  )
) STRICT;

CREATE INDEX judge_packages_staging_gc
ON judge_packages(state, staged_at, lease_expires_at);

CREATE TRIGGER judge_package_identity_immutable
BEFORE UPDATE OF sha256, bytes, staged_at ON judge_packages
BEGIN
  SELECT RAISE(ABORT, 'judge package identity is immutable');
END;

CREATE TRIGGER judge_package_ready_immutable
BEFORE UPDATE ON judge_packages
WHEN OLD.state = 'ready'
BEGIN
  SELECT RAISE(ABORT, 'ready judge packages are immutable');
END;

CREATE TRIGGER judge_package_state_transition_guard
BEFORE UPDATE OF state ON judge_packages
WHEN NOT (
  OLD.state = NEW.state
  OR (OLD.state = 'staging' AND NEW.state IN ('ready', 'deleting'))
)
BEGIN
  SELECT RAISE(ABORT, 'judge package transition is invalid');
END;

CREATE TRIGGER judge_package_delete_guard
BEFORE DELETE ON judge_packages
WHEN OLD.state <> 'deleting' OR OLD.delete_token IS NULL
BEGIN
  SELECT RAISE(ABORT, 'only a deletion-fenced staging judge package may be deleted');
END;

CREATE TABLE catalog_publications (
  id TEXT PRIMARY KEY CHECK (length(id) = 36),
  publish_job_id TEXT NOT NULL UNIQUE,
  collection_revision_id TEXT NOT NULL REFERENCES collection_revisions(id) ON DELETE RESTRICT,
  mode TEXT NOT NULL CHECK (mode IN ('official-practice', 'contest')),
  published_by TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  published_at TEXT NOT NULL,
  -- The publish job is bounded operational history and is retained for only
  -- 30 days. Publication identity keeps the job id without an FK so pruning the
  -- job cannot delete or invalidate published product data.
  CHECK (length(publish_job_id) = 36)
) STRICT;

CREATE TRIGGER catalog_publication_publish_fence
BEFORE INSERT ON catalog_publications
WHEN NOT EXISTS (
  SELECT 1 FROM catalog_publish_jobs AS job
  WHERE job.id = NEW.publish_job_id
    AND job.collection_revision_id = NEW.collection_revision_id
    AND job.mode = NEW.mode
    AND job.state = 'published'
    AND job.requested_by = NEW.published_by
)
BEGIN
  SELECT RAISE(ABORT, 'catalog publication requires its exact published job');
END;

CREATE TRIGGER catalog_publication_identity_immutable
BEFORE UPDATE OF
  id, publish_job_id, collection_revision_id, mode, published_at
ON catalog_publications
BEGIN
  SELECT RAISE(ABORT, 'catalog publication identity is immutable');
END;

CREATE TRIGGER catalog_publication_actor_erasure_guard
BEFORE UPDATE OF published_by ON catalog_publications
WHEN NOT EXISTS (
  SELECT 1 FROM account_erasure_jobs
  WHERE user_id = OLD.published_by AND anonymous_user_id = NEW.published_by
)
BEGIN
  SELECT RAISE(ABORT, 'catalog publication actor may change only for account erasure');
END;

CREATE TRIGGER catalog_publication_delete_forbidden
BEFORE DELETE ON catalog_publications
BEGIN
  SELECT RAISE(ABORT, 'catalog publications are immutable');
END;

CREATE TABLE problem_versions (
  id TEXT PRIMARY KEY CHECK (length(id) = 36),
  catalog_publication_id TEXT NOT NULL REFERENCES catalog_publications(id) ON DELETE RESTRICT,
  problem_series_id TEXT NOT NULL REFERENCES problem_series(id) ON DELETE RESTRICT,
  execution_semantic_sha256 TEXT NOT NULL REFERENCES judge_packages(sha256) ON DELETE RESTRICT,
  created_at TEXT NOT NULL,
  UNIQUE (catalog_publication_id, problem_series_id),
  UNIQUE (id, problem_series_id)
) STRICT;

CREATE INDEX problem_versions_semantic
ON problem_versions(execution_semantic_sha256);

CREATE TRIGGER problem_version_matches_revision
BEFORE INSERT ON problem_versions
WHEN NOT EXISTS (
  SELECT 1
  FROM catalog_publications AS publication
  JOIN collection_revision_problems AS revision_problem
    ON revision_problem.collection_revision_id = publication.collection_revision_id
  JOIN judge_packages AS package ON package.sha256 = revision_problem.judge_package_sha256
  WHERE publication.id = NEW.catalog_publication_id
    AND revision_problem.problem_series_id = NEW.problem_series_id
    AND revision_problem.judge_package_sha256 = NEW.execution_semantic_sha256
    AND revision_problem.judge_package_bytes = package.bytes
    AND package.state = 'ready'
)
BEGIN
  SELECT RAISE(ABORT, 'problem version does not match its validated revision');
END;

CREATE TRIGGER problem_version_update_forbidden
BEFORE UPDATE ON problem_versions
BEGIN
  SELECT RAISE(ABORT, 'problem versions are immutable');
END;

CREATE TRIGGER problem_version_delete_forbidden
BEFORE DELETE ON problem_versions
BEGIN
  SELECT RAISE(ABORT, 'problem versions are immutable');
END;

-- Product metadata has one normalized authority: the validated revision
-- problem. Runtime readers use this view; immutable version rows retain only
-- management identity and execution semantics.
CREATE VIEW problem_version_details AS
SELECT
  version.id AS id,
  version.problem_series_id AS problem_series_id,
  version.catalog_publication_id AS catalog_publication_id,
  revision.collection_id AS collection_id,
  publication.collection_revision_id AS collection_revision_id,
  publication.mode AS mode,
  series.problem_slug AS problem_slug,
  revision_problem.problem_number AS problem_number,
  revision_problem.title_json AS title_json,
  revision_problem.difficulty AS difficulty,
  revision_problem.tags_json AS tags_json,
  revision_problem.track_id AS track_id,
  revision_problem.track_json AS track_json,
  revision_problem.practice_bundle_path AS practice_bundle_path,
  revision_problem.practice_bundle_git_sha AS practice_bundle_git_sha,
  revision_problem.practice_bundle_bytes AS practice_bundle_bytes,
  revision_problem.practice_bundle_sha256 AS practice_bundle_sha256,
  revision_problem.contest_public_path AS contest_public_path,
  revision_problem.contest_public_git_sha AS contest_public_git_sha,
  revision_problem.contest_public_bytes AS contest_public_bytes,
  revision_problem.contest_public_sha256 AS contest_public_sha256,
  version.execution_semantic_sha256 AS execution_semantic_sha256,
  revision_problem.allowed_profiles_json AS allowed_profiles_json,
  revision_problem.maximum_score AS maximum_score,
  version.created_at AS created_at
FROM problem_versions AS version
JOIN catalog_publications AS publication
  ON publication.id = version.catalog_publication_id
JOIN collection_revisions AS revision
  ON revision.id = publication.collection_revision_id
JOIN problem_series AS series
  ON series.id = version.problem_series_id
JOIN collection_revision_problems AS revision_problem
  ON revision_problem.collection_revision_id = publication.collection_revision_id
 AND revision_problem.problem_series_id = version.problem_series_id;

CREATE TABLE official_practice_heads (
  problem_series_id TEXT PRIMARY KEY,
  problem_version_id TEXT NOT NULL UNIQUE,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (problem_version_id, problem_series_id)
    REFERENCES problem_versions(id, problem_series_id) ON DELETE RESTRICT
) STRICT;

CREATE TRIGGER official_practice_head_insert_guard
BEFORE INSERT ON official_practice_heads
WHEN NOT EXISTS (
  SELECT 1 FROM problem_version_details
  WHERE id = NEW.problem_version_id
    AND problem_series_id = NEW.problem_series_id
    AND mode = 'official-practice'
)
BEGIN
  SELECT RAISE(ABORT, 'official practice head requires a published publication');
END;

CREATE TRIGGER official_practice_head_update_guard
BEFORE UPDATE ON official_practice_heads
WHEN OLD.problem_series_id <> NEW.problem_series_id
  OR NOT EXISTS (
    SELECT 1 FROM problem_version_details
    WHERE id = NEW.problem_version_id
      AND problem_series_id = NEW.problem_series_id
      AND mode = 'official-practice'
  )
BEGIN
  SELECT RAISE(ABORT, 'official practice head transition is invalid');
END;

CREATE TABLE contests (
  id TEXT PRIMARY KEY CHECK (length(id) = 36),
  organizer_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  catalog_publication_id TEXT NOT NULL REFERENCES catalog_publications(id) ON DELETE RESTRICT,
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

CREATE TRIGGER contest_publication_insert_guard
BEFORE INSERT ON contests
WHEN NOT EXISTS (
  SELECT 1 FROM catalog_publications
  WHERE id = NEW.catalog_publication_id
    AND mode = 'contest'
)
BEGIN
  SELECT RAISE(ABORT, 'contest requires a published contest publication');
END;

CREATE TRIGGER contest_publication_update_guard
BEFORE UPDATE OF catalog_publication_id ON contests
WHEN NOT EXISTS (
    SELECT 1 FROM catalog_publications
    WHERE id = NEW.catalog_publication_id
      AND mode = 'contest'
  ) OR EXISTS (
    SELECT 1
    FROM contest_problems AS problem
    JOIN problem_versions AS version ON version.id = problem.problem_version_id
    WHERE problem.contest_id = OLD.id
      AND version.catalog_publication_id <> NEW.catalog_publication_id
  )
BEGIN
  SELECT RAISE(ABORT, 'contest publication transition is invalid');
END;

CREATE TABLE contest_problems (
  contest_id TEXT NOT NULL REFERENCES contests(id) ON DELETE CASCADE,
  problem_series_id TEXT NOT NULL REFERENCES problem_series(id) ON DELETE RESTRICT,
  problem_version_id TEXT NOT NULL REFERENCES problem_versions(id) ON DELETE RESTRICT,
  ordinal INTEGER NOT NULL CHECK (ordinal > 0),
  PRIMARY KEY (contest_id, problem_series_id),
  UNIQUE (contest_id, problem_version_id),
  UNIQUE (contest_id, ordinal)
) STRICT;

CREATE TRIGGER contest_problem_publication_insert_guard
BEFORE INSERT ON contest_problems
WHEN NOT EXISTS (
  SELECT 1
  FROM problem_version_details AS selected
  JOIN contests AS contest ON contest.id = NEW.contest_id
  WHERE selected.id = NEW.problem_version_id
    AND selected.problem_series_id = NEW.problem_series_id
    AND selected.mode = 'contest'
    AND selected.catalog_publication_id = contest.catalog_publication_id
)
BEGIN
  SELECT RAISE(ABORT, 'contest problems must use one published contest publication');
END;

CREATE TRIGGER contest_problem_publication_update_guard
BEFORE UPDATE OF contest_id, problem_series_id, problem_version_id
ON contest_problems
WHEN NOT EXISTS (
  SELECT 1
  FROM problem_version_details AS selected
  JOIN contests AS contest ON contest.id = NEW.contest_id
  WHERE selected.id = NEW.problem_version_id
    AND selected.problem_series_id = NEW.problem_series_id
    AND selected.mode = 'contest'
    AND selected.catalog_publication_id = contest.catalog_publication_id
)
BEGIN
  SELECT RAISE(ABORT, 'contest problems must use one published contest publication');
END;

CREATE TABLE contest_participants (
  contest_id TEXT NOT NULL REFERENCES contests(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  joined_at TEXT NOT NULL,
  PRIMARY KEY (contest_id, user_id)
) STRICT;

CREATE TABLE submission_sources (
  id TEXT PRIMARY KEY CHECK (length(id) = 36),
  owner_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  admission_erasure_epoch INTEGER NOT NULL CHECK (admission_erasure_epoch >= 0),
  content_sha256 TEXT CHECK (
    content_sha256 IS NULL
    OR (length(content_sha256) = 64 AND content_sha256 NOT GLOB '*[^0-9a-f]*')
  ),
  bytes INTEGER CHECK (bytes IS NULL OR bytes BETWEEN 1 AND 2097152),
  state TEXT NOT NULL CHECK (state IN ('reserved', 'ready', 'erasing', 'erased')),
  created_at TEXT NOT NULL,
  ready_at TEXT,
  erased_at TEXT,
  erasure_requested_at TEXT,
  erasure_attempts INTEGER NOT NULL DEFAULT 0 CHECK (erasure_attempts >= 0),
  erasure_next_attempt_at TEXT,
  erasure_last_error TEXT,
  CHECK (
    (state = 'reserved' AND owner_user_id IS NOT NULL AND content_sha256 IS NOT NULL
      AND bytes IS NOT NULL AND ready_at IS NULL AND erased_at IS NULL
      AND erasure_requested_at IS NULL AND erasure_attempts = 0
      AND erasure_next_attempt_at IS NULL AND erasure_last_error IS NULL)
    OR (state = 'ready' AND owner_user_id IS NOT NULL AND content_sha256 IS NOT NULL
      AND bytes IS NOT NULL AND ready_at IS NOT NULL AND erased_at IS NULL
      AND erasure_requested_at IS NULL AND erasure_attempts = 0
      AND erasure_next_attempt_at IS NULL AND erasure_last_error IS NULL)
    OR (state = 'erasing' AND owner_user_id IS NOT NULL AND content_sha256 IS NULL
      AND bytes IS NULL AND erased_at IS NULL AND erasure_requested_at IS NOT NULL
      AND erasure_next_attempt_at IS NOT NULL)
    OR (state = 'erased' AND owner_user_id IS NULL AND content_sha256 IS NULL
      AND bytes IS NULL AND erased_at IS NOT NULL AND erasure_requested_at IS NOT NULL
      AND erasure_next_attempt_at IS NULL AND erasure_last_error IS NULL)
  )
) STRICT;

CREATE INDEX submission_sources_erasure_ready
ON submission_sources(erasure_next_attempt_at, erasure_requested_at, id)
WHERE state = 'erasing';

CREATE TRIGGER submission_source_admission_epoch_guard
BEFORE INSERT ON submission_sources
WHEN NOT EXISTS (
  SELECT 1 FROM users
  WHERE id = NEW.owner_user_id
    AND erasure_epoch = NEW.admission_erasure_epoch
    AND status = 'active'
)
BEGIN
  SELECT RAISE(ABORT, 'submission source admission epoch is stale');
END;

CREATE TRIGGER submission_source_transition_guard
BEFORE UPDATE ON submission_sources
WHEN NOT (
  OLD.id = NEW.id
  AND OLD.created_at = NEW.created_at
  AND OLD.admission_erasure_epoch = NEW.admission_erasure_epoch
  AND (
    (OLD.state = 'reserved' AND NEW.state = 'ready'
      AND OLD.owner_user_id IS NEW.owner_user_id
      AND OLD.content_sha256 = NEW.content_sha256
      AND OLD.bytes = NEW.bytes
      AND NEW.ready_at IS NOT NULL
      AND NEW.erased_at IS NULL
      AND NEW.erasure_requested_at IS NULL
      AND NEW.erasure_attempts = 0
      AND NEW.erasure_next_attempt_at IS NULL
      AND NEW.erasure_last_error IS NULL
      AND EXISTS (
        SELECT 1 FROM users
        WHERE id = NEW.owner_user_id
          AND erasure_epoch = NEW.admission_erasure_epoch
          AND status = 'active'
      )
      AND NOT EXISTS (
        SELECT 1 FROM account_erasure_jobs WHERE user_id = NEW.owner_user_id
      ))
    OR (OLD.state IN ('reserved', 'ready') AND NEW.state = 'erasing'
      AND OLD.owner_user_id IS NEW.owner_user_id
      AND NEW.content_sha256 IS NULL
      AND NEW.bytes IS NULL
      AND NEW.ready_at IS OLD.ready_at
      AND NEW.erased_at IS NULL
      AND NEW.erasure_requested_at IS NOT NULL
      AND NEW.erasure_attempts = OLD.erasure_attempts
      AND NEW.erasure_next_attempt_at IS NOT NULL
      AND NEW.erasure_last_error IS NULL)
    OR (OLD.state = 'erasing' AND NEW.state = 'erasing'
      AND OLD.owner_user_id IS NEW.owner_user_id
      AND NEW.content_sha256 IS NULL
      AND NEW.bytes IS NULL
      AND NEW.ready_at IS OLD.ready_at
      AND NEW.erased_at IS NULL
      AND NEW.erasure_requested_at IS OLD.erasure_requested_at
      AND NEW.erasure_attempts BETWEEN OLD.erasure_attempts AND OLD.erasure_attempts + 1
      AND NEW.erasure_next_attempt_at IS NOT NULL)
    OR (OLD.state = 'erasing' AND NEW.state = 'erased'
      AND NEW.owner_user_id IS NULL
      AND NEW.content_sha256 IS NULL
      AND NEW.bytes IS NULL
      AND NEW.ready_at IS OLD.ready_at
      AND NEW.erased_at IS NOT NULL
      AND NEW.erasure_requested_at IS OLD.erasure_requested_at
      AND NEW.erasure_attempts = OLD.erasure_attempts
      AND NEW.erasure_next_attempt_at IS NULL
      AND NEW.erasure_last_error IS NULL)
  )
)
BEGIN
  SELECT RAISE(ABORT, 'submission source transition is invalid');
END;

CREATE TRIGGER submission_source_delete_forbidden
BEFORE DELETE ON submission_sources
BEGIN
  SELECT RAISE(ABORT, 'submission sources are retained as erasure tombstones');
END;

CREATE TABLE rejudge_batches (
  id TEXT PRIMARY KEY CHECK (length(id) = 36),
  old_problem_version_id TEXT NOT NULL,
  new_problem_version_id TEXT NOT NULL,
  problem_series_id TEXT NOT NULL,
  requested_by TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  state TEXT NOT NULL CHECK (state IN ('queued', 'running', 'ready', 'effective', 'failed', 'cancelled')),
  expected_count INTEGER NOT NULL DEFAULT 0 CHECK (expected_count >= 0),
  idempotency_key TEXT,
  request_digest TEXT CHECK (
    request_digest IS NULL OR (length(request_digest) = 64 AND request_digest NOT GLOB '*[^0-9a-f]*')
  ),
  wasm_oj_release_id TEXT NOT NULL,
  wasm_oj_manifest_sha256 TEXT NOT NULL,
  failure_code TEXT,
  cancel_requested_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  effective_at TEXT,
  FOREIGN KEY (old_problem_version_id, problem_series_id)
    REFERENCES problem_versions(id, problem_series_id) ON DELETE RESTRICT,
  FOREIGN KEY (new_problem_version_id, problem_series_id)
    REFERENCES problem_versions(id, problem_series_id) ON DELETE RESTRICT,
  FOREIGN KEY (wasm_oj_release_id, wasm_oj_manifest_sha256)
    REFERENCES wasm_oj_releases(id, manifest_sha256) ON DELETE RESTRICT,
  CHECK (old_problem_version_id <> new_problem_version_id),
  UNIQUE (requested_by, idempotency_key),
  UNIQUE (id, old_problem_version_id, new_problem_version_id, problem_series_id)
) STRICT;

CREATE UNIQUE INDEX rejudge_batches_one_inflight_series
ON rejudge_batches(problem_series_id)
WHERE state IN ('queued', 'running', 'ready');

CREATE TRIGGER rejudge_batch_identity_immutable
BEFORE UPDATE OF
  id, old_problem_version_id, new_problem_version_id, problem_series_id,
  idempotency_key, request_digest, wasm_oj_release_id, wasm_oj_manifest_sha256,
  created_at
ON rejudge_batches
BEGIN
  SELECT RAISE(ABORT, 'rejudge batch identity is immutable');
END;

CREATE TRIGGER rejudge_batch_actor_erasure_guard
BEFORE UPDATE OF requested_by ON rejudge_batches
WHEN NOT EXISTS (
  SELECT 1 FROM account_erasure_jobs
  WHERE user_id = OLD.requested_by AND anonymous_user_id = NEW.requested_by
)
BEGIN
  SELECT RAISE(ABORT, 'rejudge actor may change only for account erasure');
END;

CREATE TRIGGER rejudge_batch_state_transition_guard
BEFORE UPDATE OF state ON rejudge_batches
WHEN NOT (
  OLD.state = NEW.state
  OR (OLD.state = 'queued' AND NEW.state IN ('running', 'failed', 'cancelled'))
  OR (OLD.state = 'running' AND NEW.state IN ('ready', 'failed', 'cancelled'))
  OR (OLD.state = 'ready' AND NEW.state IN ('effective', 'failed', 'cancelled'))
)
BEGIN
  SELECT RAISE(ABORT, 'rejudge batch transition is invalid');
END;

CREATE TRIGGER rejudge_batch_activation_guard
BEFORE UPDATE OF state ON rejudge_batches
WHEN NEW.state = 'effective' AND (
  NEW.effective_at IS NULL
  OR (SELECT COUNT(*) FROM rejudge_jobs WHERE rejudge_batch_id = NEW.id) <> NEW.expected_count
  OR EXISTS (
    SELECT 1 FROM rejudge_jobs
    WHERE rejudge_batch_id = NEW.id AND state <> 'ready'
  )
)
BEGIN
  SELECT RAISE(ABORT, 'effective rejudge batch requires every expected job to be ready');
END;

CREATE TRIGGER rejudge_batch_terminal_immutable
BEFORE UPDATE OF
  state, expected_count, failure_code, cancel_requested_at, updated_at, effective_at
ON rejudge_batches
WHEN OLD.state IN ('effective', 'failed', 'cancelled')
BEGIN
  SELECT RAISE(ABORT, 'terminal rejudge batches are immutable');
END;

CREATE TABLE submissions (
  id TEXT PRIMARY KEY CHECK (length(id) = 36),
  origin_submission_id TEXT NOT NULL REFERENCES submissions(id) ON DELETE RESTRICT,
  origin_submitted_at TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  problem_version_id TEXT NOT NULL,
  problem_series_id TEXT NOT NULL,
  execution_semantic_sha256 TEXT NOT NULL,
  contest_id TEXT REFERENCES contests(id) ON DELETE RESTRICT,
  source_id TEXT NOT NULL REFERENCES submission_sources(id) ON DELETE RESTRICT,
  language TEXT NOT NULL,
  target TEXT NOT NULL CHECK (target IN ('wasip1', 'wasix')),
  optimization TEXT NOT NULL CHECK (optimization IN ('debug', 'release')),
  entry_path TEXT,
  wasm_oj_release_id TEXT NOT NULL,
  wasm_oj_manifest_sha256 TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('admitting', 'queued', 'preparing', 'compiling', 'running', 'finalizing', 'completed', 'compile-error', 'judge-error', 'infrastructure-error', 'cancelled')),
  verdict TEXT CHECK (verdict IS NULL OR verdict IN ('accepted', 'wrong-answer', 'runtime-error', 'instruction-limit', 'memory-limit', 'output-limit', 'filesystem-limit', 'logical-time-limit', 'wall-time-limit', 'compile-error', 'judge-error', 'cancelled')),
  visibility TEXT NOT NULL DEFAULT 'private' CHECK (visibility IN ('private', 'public')),
  score REAL,
  fully_passed_cases INTEGER CHECK (fully_passed_cases IS NULL OR fully_passed_cases >= 0),
  deterministic_cost INTEGER CHECK (deterministic_cost IS NULL OR deterministic_cost >= 0),
  peak_memory_bytes INTEGER CHECK (peak_memory_bytes IS NULL OR peak_memory_bytes >= 0),
  policy_summary_json TEXT,
  effective_attempt INTEGER CHECK (effective_attempt IS NULL OR effective_attempt > 0),
  admitted_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT,
  FOREIGN KEY (problem_version_id, problem_series_id)
    REFERENCES problem_versions(id, problem_series_id) ON DELETE RESTRICT,
  FOREIGN KEY (contest_id, problem_series_id)
    REFERENCES contest_problems(contest_id, problem_series_id) ON DELETE RESTRICT,
  FOREIGN KEY (wasm_oj_release_id, wasm_oj_manifest_sha256)
    REFERENCES wasm_oj_releases(id, manifest_sha256) ON DELETE RESTRICT,
  CHECK (
    (state IN ('admitting', 'queued', 'preparing', 'compiling', 'running', 'finalizing')
      AND verdict IS NULL AND completed_at IS NULL)
    OR (state = 'completed'
      AND verdict IN ('accepted', 'wrong-answer', 'runtime-error', 'instruction-limit', 'memory-limit', 'output-limit', 'filesystem-limit', 'logical-time-limit', 'wall-time-limit')
      AND completed_at IS NOT NULL)
    OR (state = 'compile-error' AND verdict = 'compile-error' AND completed_at IS NOT NULL)
    OR (state = 'judge-error' AND verdict = 'judge-error' AND completed_at IS NOT NULL)
    OR (state = 'infrastructure-error' AND verdict = 'judge-error' AND completed_at IS NOT NULL)
    OR (state = 'cancelled' AND verdict = 'cancelled' AND completed_at IS NOT NULL)
  ),
  CHECK (
    (origin_submission_id = id AND origin_submitted_at = created_at)
    OR origin_submission_id <> id
  ),
  CHECK (
    (state = 'completed'
      AND policy_summary_json IS NOT NULL
      AND json_valid(policy_summary_json)
      AND length(CAST(policy_summary_json AS BLOB)) <= 2048)
    OR (state <> 'completed' AND policy_summary_json IS NULL)
  ),
  UNIQUE (id, problem_series_id, source_id, user_id),
  UNIQUE (id, problem_version_id, problem_series_id, source_id, user_id)
) STRICT;

CREATE INDEX submissions_user_created ON submissions(user_id, created_at DESC);
CREATE INDEX submissions_problem_score ON submissions(problem_version_id, score DESC);
CREATE INDEX submissions_contest_created ON submissions(contest_id, created_at);
CREATE INDEX submissions_origin_created ON submissions(origin_submission_id, created_at);
CREATE INDEX submissions_global_capacity
ON submissions(state)
WHERE state IN ('admitting', 'queued', 'preparing', 'compiling', 'running', 'finalizing');
CREATE INDEX submissions_user_queue_capacity
ON submissions(user_id, state)
WHERE state IN ('admitting', 'queued');
CREATE UNIQUE INDEX submissions_one_executing_per_user
ON submissions(user_id)
WHERE state IN ('preparing', 'compiling', 'running', 'finalizing');

CREATE TRIGGER submission_identity_immutable
BEFORE UPDATE OF
  origin_submission_id, origin_submitted_at, problem_version_id,
  problem_series_id, execution_semantic_sha256, contest_id,
  source_id, wasm_oj_release_id, wasm_oj_manifest_sha256
ON submissions
BEGIN
  SELECT RAISE(ABORT, 'submission identity is immutable');
END;

CREATE TRIGGER submission_terminal_result_immutable
BEFORE UPDATE OF
  state, verdict, score, fully_passed_cases, deterministic_cost,
  peak_memory_bytes, policy_summary_json, effective_attempt, completed_at
ON submissions
WHEN OLD.state IN ('completed', 'compile-error', 'judge-error', 'infrastructure-error', 'cancelled')
BEGIN
  SELECT RAISE(ABORT, 'terminal submission results are immutable');
END;

CREATE TRIGGER submission_problem_version_guard
BEFORE INSERT ON submissions
WHEN NOT EXISTS (
  SELECT 1 FROM problem_version_details AS version
  WHERE version.id = NEW.problem_version_id
    AND version.problem_series_id = NEW.problem_series_id
    AND version.execution_semantic_sha256 = NEW.execution_semantic_sha256
    AND (
      (NEW.contest_id IS NULL AND version.mode = 'official-practice')
      OR (NEW.contest_id IS NOT NULL AND version.mode = 'contest')
    )
)
BEGIN
  SELECT RAISE(ABORT, 'submission does not match its problem version');
END;

CREATE TRIGGER submission_owner_erasure_guard
BEFORE UPDATE OF user_id ON submissions
WHEN NOT EXISTS (
  SELECT 1 FROM account_erasure_jobs
  WHERE user_id = OLD.user_id AND anonymous_user_id = NEW.user_id
)
BEGIN
  SELECT RAISE(ABORT, 'submission owner may change only for account erasure');
END;

CREATE TRIGGER submission_child_origin_guard
BEFORE INSERT ON submissions
WHEN NEW.origin_submission_id <> NEW.id AND NOT EXISTS (
  SELECT 1 FROM submissions AS origin
  WHERE origin.id = NEW.origin_submission_id
    AND origin.origin_submission_id = origin.id
    AND origin.origin_submitted_at = NEW.origin_submitted_at
    AND origin.user_id = NEW.user_id
    AND origin.problem_series_id = NEW.problem_series_id
    AND origin.source_id = NEW.source_id
    AND origin.contest_id IS NEW.contest_id
)
BEGIN
  SELECT RAISE(ABORT, 'rejudge child does not match its canonical origin');
END;

CREATE TRIGGER submission_original_contest_version_guard
BEFORE INSERT ON submissions
WHEN NEW.contest_id IS NOT NULL
  AND NEW.origin_submission_id = NEW.id
  AND NOT EXISTS (
    SELECT 1 FROM contest_problems
    WHERE contest_id = NEW.contest_id
      AND problem_series_id = NEW.problem_series_id
      AND problem_version_id = NEW.problem_version_id
  )
BEGIN
  SELECT RAISE(ABORT, 'original contest submission must use the bound problem version');
END;

CREATE TRIGGER submission_queue_requires_ready_source
BEFORE UPDATE OF state ON submissions
WHEN NEW.state = 'queued' AND NOT EXISTS (
  SELECT 1
  FROM submission_sources
  JOIN users ON users.id = submission_sources.owner_user_id
  WHERE submission_sources.id = NEW.source_id
    AND submission_sources.state = 'ready'
    AND submission_sources.owner_user_id = NEW.user_id
    AND submission_sources.admission_erasure_epoch = users.erasure_epoch
    AND users.status = 'active'
    AND NOT EXISTS (
      SELECT 1 FROM account_erasure_jobs WHERE user_id = NEW.user_id
    )
)
BEGIN
  SELECT RAISE(ABORT, 'queued submission requires a ready owned source');
END;

CREATE TABLE submission_idempotency (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  idempotency_key TEXT NOT NULL,
  request_digest TEXT NOT NULL
    CHECK (length(request_digest) = 64 AND request_digest NOT GLOB '*[^0-9a-f]*'),
  submission_id TEXT NOT NULL REFERENCES submissions(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  PRIMARY KEY (user_id, idempotency_key),
  UNIQUE (submission_id)
) STRICT;

CREATE TABLE submission_attempts (
  submission_id TEXT NOT NULL REFERENCES submissions(id) ON DELETE CASCADE,
  attempt INTEGER NOT NULL CHECK (attempt > 0),
  token_hash TEXT NOT NULL CHECK (length(token_hash) BETWEEN 1 AND 128),
  state TEXT NOT NULL CHECK (state IN ('created', 'running', 'succeeded', 'failed', 'cancelled')),
  started_at TEXT,
  finished_at TEXT,
  failure_code TEXT,
  PRIMARY KEY (submission_id, attempt)
) STRICT;

CREATE TABLE submission_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  submission_id TEXT NOT NULL REFERENCES submissions(id) ON DELETE CASCADE,
  event_key TEXT NOT NULL CHECK (length(event_key) BETWEEN 1 AND 200),
  payload_json TEXT NOT NULL CHECK (
    json_valid(payload_json) AND length(CAST(payload_json AS BLOB)) <= 65536
  ),
  created_at TEXT NOT NULL,
  UNIQUE (submission_id, event_key)
) STRICT;

CREATE INDEX submission_events_replay ON submission_events(submission_id, id);

CREATE TRIGGER submission_event_update_forbidden
BEFORE UPDATE ON submission_events
BEGIN
  SELECT RAISE(ABORT, 'submission events are append-only');
END;

CREATE TABLE rejudge_jobs (
  id TEXT PRIMARY KEY CHECK (length(id) = 36),
  rejudge_batch_id TEXT NOT NULL,
  problem_series_id TEXT NOT NULL,
  origin_submission_id TEXT NOT NULL,
  old_submission_id TEXT NOT NULL,
  new_submission_id TEXT NOT NULL UNIQUE,
  old_problem_version_id TEXT NOT NULL,
  new_problem_version_id TEXT NOT NULL,
  source_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending', 'dispatched', 'ready', 'failed', 'cancelled')),
  result_state TEXT CHECK (result_state IS NULL OR result_state IN ('completed', 'compile-error', 'judge-error', 'infrastructure-error', 'cancelled')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (rejudge_batch_id, old_problem_version_id, new_problem_version_id, problem_series_id)
    REFERENCES rejudge_batches(id, old_problem_version_id, new_problem_version_id, problem_series_id) ON DELETE CASCADE,
  FOREIGN KEY (origin_submission_id, problem_series_id, source_id, user_id)
    REFERENCES submissions(id, problem_series_id, source_id, user_id) ON DELETE CASCADE ON UPDATE CASCADE,
  -- A same-semantic publication lineage advances the effective management
  -- version without creating a physical child submission. A later changed
  -- rejudge therefore points at the effective submission bytes/owner while
  -- `old_problem_version_id` remains the lineage's effective identity.
  FOREIGN KEY (old_submission_id, problem_series_id, source_id, user_id)
    REFERENCES submissions(id, problem_series_id, source_id, user_id) ON DELETE CASCADE ON UPDATE CASCADE,
  FOREIGN KEY (new_submission_id, new_problem_version_id, problem_series_id, source_id, user_id)
    REFERENCES submissions(id, problem_version_id, problem_series_id, source_id, user_id) ON DELETE CASCADE ON UPDATE CASCADE,
  CHECK (
    (state IN ('pending', 'dispatched') AND result_state IS NULL)
    OR (state = 'ready' AND result_state IN ('completed', 'compile-error'))
    OR (state = 'failed' AND result_state IN ('judge-error', 'infrastructure-error'))
    OR (state = 'cancelled' AND result_state = 'cancelled')
  ),
  UNIQUE (rejudge_batch_id, old_submission_id),
  UNIQUE (rejudge_batch_id, origin_submission_id)
) STRICT;

CREATE INDEX rejudge_jobs_dispatch
ON rejudge_jobs(rejudge_batch_id, state, created_at);

CREATE TRIGGER rejudge_job_identity_immutable
BEFORE UPDATE OF
  id, rejudge_batch_id, problem_series_id, origin_submission_id,
  old_submission_id, new_submission_id, old_problem_version_id,
  new_problem_version_id, source_id, created_at
ON rejudge_jobs
WHEN OLD.id IS NOT NEW.id
  OR OLD.rejudge_batch_id IS NOT NEW.rejudge_batch_id
  OR OLD.problem_series_id IS NOT NEW.problem_series_id
  OR OLD.origin_submission_id IS NOT NEW.origin_submission_id
  OR OLD.old_submission_id IS NOT NEW.old_submission_id
  OR OLD.new_submission_id IS NOT NEW.new_submission_id
  OR OLD.old_problem_version_id IS NOT NEW.old_problem_version_id
  OR OLD.new_problem_version_id IS NOT NEW.new_problem_version_id
  OR OLD.source_id IS NOT NEW.source_id
  OR OLD.created_at IS NOT NEW.created_at
BEGIN
  SELECT RAISE(ABORT, 'rejudge job identity is immutable');
END;

CREATE TRIGGER rejudge_job_state_transition_guard
BEFORE UPDATE OF state ON rejudge_jobs
WHEN NOT (
  OLD.state = NEW.state
  OR (OLD.state = 'pending' AND NEW.state IN ('dispatched', 'failed', 'cancelled'))
  OR (OLD.state = 'dispatched' AND NEW.state IN ('ready', 'failed', 'cancelled'))
)
BEGIN
  SELECT RAISE(ABORT, 'rejudge job transition is invalid');
END;

CREATE TRIGGER rejudge_job_terminal_immutable
BEFORE UPDATE OF state, result_state, updated_at
ON rejudge_jobs
WHEN OLD.state IN ('ready', 'failed', 'cancelled')
BEGIN
  SELECT RAISE(ABORT, 'terminal rejudge jobs are immutable');
END;

CREATE TRIGGER rejudge_job_result_insert_guard
BEFORE INSERT ON rejudge_jobs
WHEN NEW.state IN ('ready', 'failed', 'cancelled') AND NOT EXISTS (
  SELECT 1 FROM submissions
  WHERE id = NEW.new_submission_id AND state = NEW.result_state
)
BEGIN
  SELECT RAISE(ABORT, 'terminal rejudge job must match its child result');
END;

CREATE TRIGGER rejudge_job_result_update_guard
BEFORE UPDATE OF state, result_state ON rejudge_jobs
WHEN NEW.state IN ('ready', 'failed', 'cancelled') AND NOT EXISTS (
  SELECT 1 FROM submissions
  WHERE id = NEW.new_submission_id AND state = NEW.result_state
)
BEGIN
  SELECT RAISE(ABORT, 'terminal rejudge job must match its child result');
END;

CREATE TRIGGER rejudge_job_origin_guard
BEFORE INSERT ON rejudge_jobs
WHEN NOT EXISTS (
  SELECT 1 FROM submissions AS predecessor
  WHERE predecessor.id = NEW.old_submission_id
    AND predecessor.origin_submission_id = NEW.origin_submission_id
)
BEGIN
  SELECT RAISE(ABORT, 'rejudge predecessor does not match the canonical origin');
END;

CREATE TABLE problem_version_lineages (
  problem_series_id TEXT NOT NULL,
  predecessor_problem_version_id TEXT PRIMARY KEY,
  successor_problem_version_id TEXT NOT NULL,
  reason TEXT NOT NULL CHECK (reason IN ('publication', 'rejudge')),
  rejudge_batch_id TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (predecessor_problem_version_id, problem_series_id)
    REFERENCES problem_versions(id, problem_series_id) ON DELETE RESTRICT,
  FOREIGN KEY (successor_problem_version_id, problem_series_id)
    REFERENCES problem_versions(id, problem_series_id) ON DELETE RESTRICT,
  FOREIGN KEY (
    rejudge_batch_id, predecessor_problem_version_id,
    successor_problem_version_id, problem_series_id
  ) REFERENCES rejudge_batches(
    id, old_problem_version_id, new_problem_version_id, problem_series_id
  ) ON DELETE RESTRICT,
  CHECK (predecessor_problem_version_id <> successor_problem_version_id),
  CHECK (
    (reason = 'publication' AND rejudge_batch_id IS NULL)
    OR (reason = 'rejudge' AND rejudge_batch_id IS NOT NULL)
  ),
  UNIQUE (successor_problem_version_id)
) STRICT;

CREATE TRIGGER problem_version_lineage_endpoint_guard
BEFORE INSERT ON problem_version_lineages
WHEN NOT EXISTS (
  SELECT 1
  FROM problem_version_details AS predecessor
  JOIN problem_version_details AS successor
    ON successor.id = NEW.successor_problem_version_id
   AND successor.problem_series_id = predecessor.problem_series_id
   AND successor.mode = predecessor.mode
  WHERE predecessor.id = NEW.predecessor_problem_version_id
    AND predecessor.problem_series_id = NEW.problem_series_id
    AND (NEW.reason <> 'publication' OR predecessor.mode = 'official-practice')
    AND (
      NEW.reason <> 'rejudge'
      OR EXISTS (
        SELECT 1 FROM rejudge_batches
        WHERE id = NEW.rejudge_batch_id
          AND state = 'effective'
          AND effective_at IS NOT NULL
      )
    )
)
BEGIN
  SELECT RAISE(ABORT, 'problem version lineage endpoints must share one series and mode');
END;

CREATE TRIGGER problem_version_lineage_cycle_guard
BEFORE INSERT ON problem_version_lineages
WHEN EXISTS (
  WITH RECURSIVE successors(problem_version_id) AS (
    SELECT NEW.successor_problem_version_id
    UNION ALL
    SELECT lineages.successor_problem_version_id
    FROM problem_version_lineages AS lineages
    JOIN successors
      ON lineages.predecessor_problem_version_id = successors.problem_version_id
  )
  SELECT 1 FROM successors
  WHERE problem_version_id = NEW.predecessor_problem_version_id
)
BEGIN
  SELECT RAISE(ABORT, 'problem version lineage cannot contain a cycle');
END;

CREATE TRIGGER problem_version_lineage_update_forbidden
BEFORE UPDATE ON problem_version_lineages
BEGIN
  SELECT RAISE(ABORT, 'problem version lineages are immutable');
END;

CREATE TRIGGER problem_version_lineage_delete_forbidden
BEFORE DELETE ON problem_version_lineages
BEGIN
  SELECT RAISE(ABORT, 'problem version lineages are immutable');
END;

CREATE TABLE workflow_outbox (
  id TEXT PRIMARY KEY CHECK (length(id) = 36),
  catalog_validation_job_id TEXT REFERENCES catalog_validation_jobs(id) ON DELETE CASCADE,
  catalog_publish_job_id TEXT REFERENCES catalog_publish_jobs(id) ON DELETE CASCADE,
  submission_id TEXT REFERENCES submissions(id) ON DELETE CASCADE,
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'delivered', 'cancelled', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  settled_at TEXT,
  CHECK (
    (catalog_validation_job_id IS NOT NULL)
    + (catalog_publish_job_id IS NOT NULL)
    + (submission_id IS NOT NULL) = 1
  ),
  CHECK (
    (state = 'pending' AND settled_at IS NULL)
    OR (state IN ('delivered', 'cancelled', 'failed') AND settled_at IS NOT NULL)
  )
) STRICT;

CREATE UNIQUE INDEX workflow_outbox_validation_target
ON workflow_outbox(catalog_validation_job_id) WHERE catalog_validation_job_id IS NOT NULL;
CREATE UNIQUE INDEX workflow_outbox_publish_target
ON workflow_outbox(catalog_publish_job_id) WHERE catalog_publish_job_id IS NOT NULL;
CREATE UNIQUE INDEX workflow_outbox_submission_target
ON workflow_outbox(submission_id) WHERE submission_id IS NOT NULL;
CREATE INDEX workflow_outbox_pending
ON workflow_outbox(created_at, id) WHERE state = 'pending';

CREATE TRIGGER workflow_outbox_identity_immutable
BEFORE UPDATE OF
  id, catalog_validation_job_id, catalog_publish_job_id, submission_id, created_at
ON workflow_outbox
BEGIN
  SELECT RAISE(ABORT, 'workflow outbox identity is immutable');
END;

CREATE TRIGGER workflow_outbox_state_transition_guard
BEFORE UPDATE OF state ON workflow_outbox
WHEN NOT (
  OLD.state = NEW.state
  OR (OLD.state = 'pending' AND NEW.state IN ('delivered', 'cancelled', 'failed'))
)
BEGIN
  SELECT RAISE(ABORT, 'workflow outbox transition is invalid');
END;

CREATE TRIGGER workflow_outbox_terminal_immutable
BEFORE UPDATE ON workflow_outbox
WHEN OLD.state IN ('delivered', 'cancelled', 'failed')
BEGIN
  SELECT RAISE(ABORT, 'terminal workflow outbox rows are immutable');
END;

-- Each bounded retention class advances independently. Cursors are operational
-- state rather than audit history: a missed scheduled invocation resumes from
-- the last committed cursor and no class can starve another class.
CREATE TABLE maintenance_cursors (
  kind TEXT PRIMARY KEY CHECK (kind IN (
    'submission-events',
    'terminal-catalog-jobs',
    'github-webhook-deliveries',
    'settled-outbox',
    'expired-auth',
    'orphan-judge-packages'
  )),
  cursor TEXT,
  last_completed_at TEXT,
  updated_at TEXT NOT NULL
) STRICT;

-- Canonical mapping for profile, leaderboard, and product reads. Result bytes
-- advance only after a terminal child is explicitly activated. A same-semantic
-- publication may advance management identity without recomputing those bytes.
CREATE VIEW effective_submission_results AS
WITH RECURSIVE
lineage_walk(root_problem_version_id, problem_version_id, depth) AS (
  SELECT id, id, 0 FROM problem_versions
  UNION ALL
  SELECT lineage_walk.root_problem_version_id, lineages.successor_problem_version_id,
    lineage_walk.depth + 1
  FROM lineage_walk
  JOIN problem_version_lineages AS lineages
    ON lineages.predecessor_problem_version_id = lineage_walk.problem_version_id
),
lineage_tips(root_problem_version_id, problem_version_id) AS (
  SELECT lineage_walk.root_problem_version_id, lineage_walk.problem_version_id
  FROM lineage_walk
  WHERE NOT EXISTS (
    SELECT 1 FROM problem_version_lineages
    WHERE predecessor_problem_version_id = lineage_walk.problem_version_id
  )
),
effective_children AS (
  SELECT
    jobs.origin_submission_id,
    jobs.new_submission_id,
    jobs.new_problem_version_id,
    jobs.rejudge_batch_id,
    batches.effective_at AS became_effective_at,
    row_number() OVER (
      PARTITION BY jobs.origin_submission_id
      ORDER BY lineage_walk.depth DESC, batches.effective_at DESC,
        jobs.new_submission_id DESC
    ) AS precedence
  FROM rejudge_jobs AS jobs
  JOIN submissions AS origin ON origin.id = jobs.origin_submission_id
  JOIN submissions AS child
    ON child.id = jobs.new_submission_id
   AND child.state = jobs.result_state
  JOIN rejudge_batches AS batches
    ON batches.id = jobs.rejudge_batch_id
   AND batches.state = 'effective'
  JOIN lineage_walk
    ON lineage_walk.root_problem_version_id = origin.problem_version_id
   AND lineage_walk.problem_version_id = child.problem_version_id
  WHERE jobs.state = 'ready'
    AND batches.effective_at IS NOT NULL
    AND child.state IN ('completed', 'compile-error')
)
SELECT
  origin.id AS origin_submission_id,
  coalesce(children.new_submission_id, origin.id) AS effective_submission_id,
  -- A publication lineage with identical execution semantics intentionally has
  -- no child submission. It still advances product identity to the lineage tip
  -- while retaining the origin's already-computed result.
  tips.problem_version_id AS effective_problem_version_id,
  children.rejudge_batch_id AS effective_rejudge_batch_id,
  children.became_effective_at
FROM submissions AS origin
JOIN lineage_tips AS tips
  ON tips.root_problem_version_id = origin.problem_version_id
LEFT JOIN effective_children AS children
  ON children.origin_submission_id = origin.id
 AND children.precedence = 1
WHERE origin.origin_submission_id = origin.id
  AND origin.state IN ('completed', 'compile-error', 'judge-error', 'infrastructure-error', 'cancelled');

PRAGMA foreign_key_check;
