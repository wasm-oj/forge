-- One-way cutover from publication/release identities to exact repository commits.
-- Run only after disabling formal mutations and draining every asynchronous job.

PRAGMA foreign_keys = ON;

CREATE TABLE repository_cutover_guard (
  violations INTEGER NOT NULL CHECK (violations = 0)
) STRICT;

INSERT INTO repository_cutover_guard (violations)
SELECT
  (SELECT COUNT(*) FROM formal_mutation_controls
    WHERE environment IN ('staging', 'production') AND formal_mutations_enabled <> 0)
  + (SELECT COUNT(*) FROM contests)
  + (SELECT COUNT(*) FROM catalog_validation_jobs WHERE state IN ('queued', 'running'))
  + (SELECT COUNT(*) FROM catalog_publish_jobs WHERE state IN ('queued', 'materializing'))
  + (SELECT COUNT(*) FROM submissions
      WHERE state NOT IN ('completed', 'compile-error', 'judge-error', 'infrastructure-error', 'cancelled'))
  + (SELECT COUNT(*) FROM rejudge_batches WHERE state IN ('queued', 'running', 'ready'))
  + (SELECT COUNT(*) FROM rejudge_jobs WHERE state IN ('pending', 'dispatched'))
  + (SELECT COUNT(*) FROM workflow_outbox WHERE state = 'pending')
  + (SELECT COUNT(*) FROM (
      SELECT collections.github_repository_id
      FROM problem_collections AS collections
      WHERE EXISTS (
        SELECT 1 FROM problem_series WHERE collection_id=collections.id
      ) OR EXISTS (
        SELECT 1 FROM collection_revisions WHERE collection_id=collections.id
      )
      GROUP BY collections.github_repository_id
      HAVING COUNT(*) > 1
    ));

DROP TABLE repository_cutover_guard;

-- Capture the identities needed after the old views and foreign keys disappear.
CREATE TABLE repository_cutover_version_map AS
SELECT versions.id AS version_id,
       versions.problem_series_id AS problem_id,
       details.collection_id AS catalog_id,
       revisions.commit_sha,
       versions.execution_semantic_sha256 AS judge_digest
FROM problem_versions AS versions
JOIN problem_version_details AS details ON details.id=versions.id
JOIN collection_revisions AS revisions ON revisions.id=details.collection_revision_id;

CREATE UNIQUE INDEX repository_cutover_version_map_id
ON repository_cutover_version_map(version_id);

CREATE TABLE repository_cutover_active_commits AS
SELECT collection_id AS catalog_id, commit_sha
FROM (
  SELECT revisions.collection_id, revisions.commit_sha,
         row_number() OVER (
           PARTITION BY revisions.collection_id
           ORDER BY publications.published_at DESC, publications.id DESC
         ) AS precedence
  FROM official_practice_heads AS heads
  JOIN problem_versions AS versions ON versions.id=heads.problem_version_id
  JOIN catalog_publications AS publications ON publications.id=versions.catalog_publication_id
  JOIN collection_revisions AS revisions ON revisions.id=publications.collection_revision_id
  GROUP BY revisions.collection_id, revisions.commit_sha, publications.published_at, publications.id
)
WHERE precedence=1;

CREATE TABLE repository_cutover_kept_revisions AS
SELECT revision_problems.collection_revision_id, revision_problems.problem_series_id
FROM repository_cutover_active_commits AS active
JOIN collection_revisions AS revisions
  ON revisions.collection_id=active.catalog_id AND revisions.commit_sha=active.commit_sha
JOIN collection_revision_problems AS revision_problems
  ON revision_problems.collection_revision_id=revisions.id
UNION
SELECT details.collection_revision_id, submissions.problem_series_id
FROM submissions
JOIN problem_version_details AS details ON details.id=submissions.problem_version_id
UNION
SELECT details.collection_revision_id, batches.problem_series_id
FROM rejudge_batches AS batches
JOIN problem_version_details AS details
  ON details.id IN (batches.old_problem_version_id, batches.new_problem_version_id);

CREATE TABLE repository_cutover_effective AS
SELECT origin_submission_id, effective_submission_id,
       effective_rejudge_batch_id, became_effective_at
FROM effective_submission_results
WHERE effective_submission_id <> origin_submission_id;

DROP TRIGGER official_practice_head_insert_guard;
DROP TRIGGER official_practice_head_update_guard;
DROP TRIGGER contest_problem_publication_insert_guard;
DROP TRIGGER contest_problem_publication_update_guard;
DROP TRIGGER submission_problem_version_guard;
DROP TRIGGER problem_version_lineage_endpoint_guard;
DROP VIEW effective_submission_results;
DROP VIEW problem_version_details;

-- Rename preserved operational history while the new foreign-key graph is built.
ALTER TABLE submission_events RENAME TO submission_events_legacy;
ALTER TABLE submission_attempts RENAME TO submission_attempts_legacy;
ALTER TABLE submission_idempotency RENAME TO submission_idempotency_legacy;
ALTER TABLE rejudge_jobs RENAME TO rejudge_jobs_legacy;
ALTER TABLE problem_version_lineages RENAME TO problem_version_lineages_legacy;
ALTER TABLE rejudge_batches RENAME TO rejudge_batches_legacy;
ALTER TABLE submissions RENAME TO submissions_legacy;
ALTER TABLE contest_participants RENAME TO contest_participants_legacy;
ALTER TABLE contest_problems RENAME TO contest_problems_legacy;
ALTER TABLE contests RENAME TO contests_legacy;
ALTER TABLE problem_series RENAME TO problem_series_legacy;
ALTER TABLE workflow_outbox RENAME TO workflow_outbox_legacy;
ALTER TABLE maintenance_cursors RENAME TO maintenance_cursors_legacy;

DROP INDEX submissions_user_created;
DROP INDEX submissions_problem_score;
DROP INDEX submissions_contest_created;
DROP INDEX submissions_origin_created;
DROP INDEX submissions_global_capacity;
DROP INDEX submissions_user_queue_capacity;
DROP INDEX submissions_one_executing_per_user;
DROP INDEX submission_events_replay;
DROP INDEX rejudge_jobs_dispatch;
DROP INDEX workflow_outbox_validation_target;
DROP INDEX workflow_outbox_publish_target;
DROP INDEX workflow_outbox_submission_target;
DROP INDEX workflow_outbox_pending;

CREATE TABLE catalogs (
  id TEXT PRIMARY KEY CHECK (length(id)=36),
  organizer_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  github_repository_id INTEGER NOT NULL UNIQUE
    REFERENCES github_repositories(github_repository_id) ON DELETE RESTRICT,
  active_commit_sha TEXT CHECK (
    active_commit_sha IS NULL
    OR (length(active_commit_sha)=40 AND active_commit_sha NOT GLOB '*[^0-9a-f]*')
  ),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

INSERT INTO catalogs (
  id, organizer_user_id, github_repository_id, active_commit_sha, created_at, updated_at
)
SELECT collections.id, collections.organizer_user_id, collections.github_repository_id,
       active.commit_sha, collections.created_at, collections.updated_at
FROM problem_collections AS collections
LEFT JOIN repository_cutover_active_commits AS active ON active.catalog_id=collections.id
WHERE EXISTS (
  SELECT 1 FROM problem_series_legacy WHERE collection_id=collections.id
) OR EXISTS (
  SELECT 1 FROM collection_revisions WHERE collection_id=collections.id
);

CREATE TABLE catalog_sync_jobs (
  id TEXT PRIMARY KEY CHECK (length(id)=36),
  catalog_id TEXT NOT NULL REFERENCES catalogs(id) ON DELETE RESTRICT,
  requested_ref TEXT NOT NULL CHECK (length(requested_ref) BETWEEN 1 AND 256),
  commit_sha TEXT NOT NULL
    CHECK (length(commit_sha)=40 AND commit_sha NOT GLOB '*[^0-9a-f]*'),
  state TEXT NOT NULL CHECK (state IN ('queued', 'running', 'succeeded', 'failed')),
  requested_by TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  idempotency_key TEXT NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 128),
  request_digest TEXT NOT NULL
    CHECK (length(request_digest)=64 AND request_digest NOT GLOB '*[^0-9a-f]*'),
  error_code TEXT,
  summary_json TEXT CHECK (
    summary_json IS NULL OR (json_valid(summary_json) AND length(CAST(summary_json AS BLOB)) <= 65536)
  ),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT,
  UNIQUE (requested_by, idempotency_key),
  CHECK (
    (state='queued' AND started_at IS NULL AND finished_at IS NULL AND error_code IS NULL AND summary_json IS NULL)
    OR (state='running' AND started_at IS NOT NULL AND finished_at IS NULL AND error_code IS NULL AND summary_json IS NULL)
    OR (state='succeeded' AND started_at IS NOT NULL AND finished_at IS NOT NULL AND error_code IS NULL AND summary_json IS NOT NULL)
    OR (state='failed' AND started_at IS NOT NULL AND finished_at IS NOT NULL AND error_code IS NOT NULL AND summary_json IS NULL)
  )
) STRICT;

CREATE UNIQUE INDEX catalog_sync_jobs_one_active
ON catalog_sync_jobs(catalog_id) WHERE state IN ('queued', 'running');
CREATE INDEX catalog_sync_jobs_retention ON catalog_sync_jobs(finished_at)
WHERE state IN ('succeeded', 'failed');

CREATE TABLE catalog_deployments (
  catalog_id TEXT NOT NULL REFERENCES catalogs(id) ON DELETE RESTRICT,
  commit_sha TEXT NOT NULL
    CHECK (length(commit_sha)=40 AND commit_sha NOT GLOB '*[^0-9a-f]*'),
  sync_job_id TEXT NOT NULL CHECK (length(sync_job_id)=36),
  synced_by TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  synced_at TEXT NOT NULL,
  problem_count INTEGER NOT NULL CHECK (problem_count BETWEEN 1 AND 1000),
  contest_count INTEGER NOT NULL CHECK (contest_count BETWEEN 0 AND 1000),
  PRIMARY KEY (catalog_id, commit_sha)
) STRICT;

CREATE TABLE problem_series (
  id TEXT PRIMARY KEY CHECK (length(id)=36),
  catalog_id TEXT NOT NULL REFERENCES catalogs(id) ON DELETE RESTRICT,
  slug TEXT NOT NULL CHECK (
    length(slug) BETWEEN 1 AND 128
    AND slug GLOB '[a-z0-9]*'
    AND slug NOT GLOB '*[^a-z0-9-]*'
    AND slug NOT LIKE '%-'
    AND slug NOT LIKE '%--%'
  ),
  created_at TEXT NOT NULL,
  UNIQUE (catalog_id, slug)
) STRICT;

INSERT INTO problem_series (id, catalog_id, slug, created_at)
SELECT id, collection_id, problem_slug, created_at FROM problem_series_legacy;

CREATE TABLE problem_revisions (
  problem_id TEXT NOT NULL REFERENCES problem_series(id) ON DELETE RESTRICT,
  commit_sha TEXT NOT NULL
    CHECK (length(commit_sha)=40 AND commit_sha NOT GLOB '*[^0-9a-f]*'),
  ordinal INTEGER NOT NULL CHECK (ordinal BETWEEN 1 AND 1000),
  title_json TEXT NOT NULL CHECK (json_valid(title_json) AND length(CAST(title_json AS BLOB)) <= 4096),
  summary_json TEXT NOT NULL CHECK (json_valid(summary_json) AND length(CAST(summary_json AS BLOB)) <= 65536),
  practice_enabled INTEGER NOT NULL CHECK (practice_enabled IN (0, 1)),
  practice_bundle_path TEXT NOT NULL,
  practice_bundle_bytes INTEGER NOT NULL CHECK (practice_bundle_bytes BETWEEN 1 AND 8388608),
  practice_bundle_sha256 TEXT NOT NULL
    CHECK (length(practice_bundle_sha256)=64 AND practice_bundle_sha256 NOT GLOB '*[^0-9a-f]*'),
  contest_bundle_path TEXT NOT NULL,
  contest_bundle_bytes INTEGER NOT NULL CHECK (contest_bundle_bytes BETWEEN 1 AND 8388608),
  contest_bundle_sha256 TEXT NOT NULL
    CHECK (length(contest_bundle_sha256)=64 AND contest_bundle_sha256 NOT GLOB '*[^0-9a-f]*'),
  judge_package_path TEXT NOT NULL,
  judge_package_bytes INTEGER NOT NULL CHECK (judge_package_bytes BETWEEN 1 AND 33554432),
  judge_digest TEXT NOT NULL
    CHECK (length(judge_digest)=64 AND judge_digest NOT GLOB '*[^0-9a-f]*'),
  allowed_profiles_json TEXT NOT NULL
    CHECK (json_valid(allowed_profiles_json) AND length(CAST(allowed_profiles_json AS BLOB)) <= 16384),
  created_at TEXT NOT NULL,
  PRIMARY KEY (problem_id, commit_sha),
  UNIQUE (problem_id, commit_sha, judge_digest),
  CHECK (
    length(practice_bundle_path) BETWEEN 1 AND 512
    AND practice_bundle_path NOT LIKE '/%' AND practice_bundle_path NOT LIKE '%/'
    AND practice_bundle_path NOT LIKE '%//%' AND instr(practice_bundle_path, '\')=0
    AND ('/' || practice_bundle_path || '/') NOT LIKE '%/./%'
    AND ('/' || practice_bundle_path || '/') NOT LIKE '%/../%'
  ),
  CHECK (
    length(contest_bundle_path) BETWEEN 1 AND 512
    AND contest_bundle_path NOT LIKE '/%' AND contest_bundle_path NOT LIKE '%/'
    AND contest_bundle_path NOT LIKE '%//%' AND instr(contest_bundle_path, '\')=0
    AND ('/' || contest_bundle_path || '/') NOT LIKE '%/./%'
    AND ('/' || contest_bundle_path || '/') NOT LIKE '%/../%'
  ),
  CHECK (
    length(judge_package_path) BETWEEN 1 AND 512
    AND judge_package_path NOT LIKE '/%' AND judge_package_path NOT LIKE '%/'
    AND judge_package_path NOT LIKE '%//%' AND instr(judge_package_path, '\')=0
    AND ('/' || judge_package_path || '/') NOT LIKE '%/./%'
    AND ('/' || judge_package_path || '/') NOT LIKE '%/../%'
  )
) STRICT;

CREATE INDEX problem_revisions_commit ON problem_revisions(commit_sha, ordinal);
CREATE INDEX problem_revisions_judge ON problem_revisions(judge_digest);

INSERT INTO problem_revisions (
  problem_id, commit_sha, ordinal, title_json, summary_json, practice_enabled,
  practice_bundle_path, practice_bundle_bytes, practice_bundle_sha256,
  contest_bundle_path, contest_bundle_bytes, contest_bundle_sha256,
  judge_package_path, judge_package_bytes, judge_digest, allowed_profiles_json, created_at
)
SELECT revision_problems.problem_series_id, revisions.commit_sha,
       revision_problems.problem_number, revision_problems.title_json,
       json_object('zh-TW', '', 'en', ''), 1,
       revision_problems.practice_bundle_path, revision_problems.practice_bundle_bytes,
       revision_problems.practice_bundle_sha256,
       revision_problems.contest_public_path, revision_problems.contest_public_bytes,
       revision_problems.contest_public_sha256,
       revision_problems.judge_package_path, revision_problems.judge_package_bytes,
       revision_problems.judge_package_sha256, revision_problems.allowed_profiles_json,
       revisions.validated_at
FROM repository_cutover_kept_revisions AS kept
JOIN collection_revision_problems AS revision_problems
  ON revision_problems.collection_revision_id=kept.collection_revision_id
 AND revision_problems.problem_series_id=kept.problem_series_id
JOIN collection_revisions AS revisions ON revisions.id=kept.collection_revision_id;

INSERT INTO catalog_deployments (
  catalog_id, commit_sha, sync_job_id, synced_by, synced_at, problem_count, contest_count
)
SELECT revisions.collection_id, revisions.commit_sha, revisions.validation_job_id,
       revisions.validated_by, revisions.validated_at, COUNT(*), 0
FROM problem_revisions
JOIN problem_series ON problem_series.id=problem_revisions.problem_id
JOIN collection_revisions AS revisions
  ON revisions.collection_id=problem_series.catalog_id
 AND revisions.commit_sha=problem_revisions.commit_sha
GROUP BY revisions.collection_id, revisions.commit_sha;

CREATE TABLE contest_series (
  id TEXT PRIMARY KEY CHECK (length(id)=36),
  catalog_id TEXT NOT NULL REFERENCES catalogs(id) ON DELETE RESTRICT,
  slug TEXT NOT NULL CHECK (
    length(slug) BETWEEN 1 AND 128
    AND slug GLOB '[a-z0-9]*'
    AND slug NOT GLOB '*[^a-z0-9-]*'
    AND slug NOT LIKE '%-'
    AND slug NOT LIKE '%--%'
  ),
  invite_code_hash TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (catalog_id, slug)
) STRICT;

CREATE TABLE contest_revisions (
  contest_id TEXT NOT NULL REFERENCES contest_series(id) ON DELETE RESTRICT,
  commit_sha TEXT NOT NULL
    CHECK (length(commit_sha)=40 AND commit_sha NOT GLOB '*[^0-9a-f]*'),
  status TEXT NOT NULL CHECK (status IN ('draft', 'published', 'archived')),
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  access_mode TEXT NOT NULL CHECK (access_mode IN ('public', 'invite')),
  starts_at TEXT NOT NULL,
  ends_at TEXT NOT NULL,
  freeze_at TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (contest_id, commit_sha),
  CHECK (ends_at > starts_at),
  CHECK (freeze_at IS NULL OR (freeze_at > starts_at AND freeze_at < ends_at))
) STRICT;

CREATE TABLE contest_revision_problems (
  contest_id TEXT NOT NULL,
  commit_sha TEXT NOT NULL,
  problem_id TEXT NOT NULL REFERENCES problem_series(id) ON DELETE RESTRICT,
  ordinal INTEGER NOT NULL CHECK (ordinal BETWEEN 1 AND 100),
  PRIMARY KEY (contest_id, commit_sha, problem_id),
  UNIQUE (contest_id, commit_sha, ordinal),
  FOREIGN KEY (contest_id, commit_sha)
    REFERENCES contest_revisions(contest_id, commit_sha) ON DELETE CASCADE,
  FOREIGN KEY (problem_id, commit_sha)
    REFERENCES problem_revisions(problem_id, commit_sha) ON DELETE RESTRICT
) STRICT;

CREATE TABLE contest_participants (
  contest_id TEXT NOT NULL REFERENCES contest_series(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  joined_at TEXT NOT NULL,
  PRIMARY KEY (contest_id, user_id)
) STRICT;

CREATE TABLE rejudge_batches (
  id TEXT PRIMARY KEY CHECK (length(id)=36),
  problem_id TEXT NOT NULL REFERENCES problem_series(id) ON DELETE RESTRICT,
  from_commit TEXT NOT NULL,
  to_commit TEXT NOT NULL,
  contest_id TEXT REFERENCES contest_series(id) ON DELETE RESTRICT,
  requested_by TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  state TEXT NOT NULL CHECK (state IN ('queued', 'running', 'ready', 'effective', 'failed', 'cancelled')),
  expected_count INTEGER NOT NULL DEFAULT 0 CHECK (expected_count >= 0),
  idempotency_key TEXT NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 128),
  request_digest TEXT NOT NULL
    CHECK (length(request_digest)=64 AND request_digest NOT GLOB '*[^0-9a-f]*'),
  failure_code TEXT,
  cancel_requested_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  effective_at TEXT,
  FOREIGN KEY (problem_id, from_commit) REFERENCES problem_revisions(problem_id, commit_sha) ON DELETE RESTRICT,
  FOREIGN KEY (problem_id, to_commit) REFERENCES problem_revisions(problem_id, commit_sha) ON DELETE RESTRICT,
  CHECK (from_commit <> to_commit),
  UNIQUE (requested_by, idempotency_key)
) STRICT;

INSERT INTO rejudge_batches (
  id, problem_id, from_commit, to_commit, contest_id, requested_by, state,
  expected_count, idempotency_key, request_digest, failure_code,
  cancel_requested_at, created_at, updated_at, effective_at
)
SELECT batches.id, batches.problem_series_id, old_versions.commit_sha, new_versions.commit_sha,
       NULL, batches.requested_by, batches.state, batches.expected_count,
       coalesce(batches.idempotency_key, batches.id),
       coalesce(batches.request_digest, lower(hex(randomblob(32)))),
       batches.failure_code, batches.cancel_requested_at, batches.created_at,
       batches.updated_at, batches.effective_at
FROM rejudge_batches_legacy AS batches
JOIN repository_cutover_version_map AS old_versions ON old_versions.version_id=batches.old_problem_version_id
JOIN repository_cutover_version_map AS new_versions ON new_versions.version_id=batches.new_problem_version_id;

CREATE TABLE submissions (
  id TEXT PRIMARY KEY CHECK (length(id)=36),
  origin_submission_id TEXT NOT NULL REFERENCES submissions(id) ON DELETE RESTRICT,
  origin_submitted_at TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  problem_id TEXT NOT NULL,
  catalog_commit TEXT NOT NULL,
  judge_digest TEXT NOT NULL,
  contest_id TEXT REFERENCES contest_series(id) ON DELETE RESTRICT,
  source_id TEXT NOT NULL REFERENCES submission_sources(id) ON DELETE RESTRICT,
  language TEXT NOT NULL,
  target TEXT NOT NULL CHECK (target IN ('wasip1', 'wasix')),
  optimization TEXT NOT NULL CHECK (optimization IN ('debug', 'release')),
  entry_path TEXT,
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
  FOREIGN KEY (problem_id, catalog_commit, judge_digest)
    REFERENCES problem_revisions(problem_id, commit_sha, judge_digest) ON DELETE RESTRICT,
  CHECK (
    (state IN ('admitting', 'queued', 'preparing', 'compiling', 'running', 'finalizing') AND verdict IS NULL AND completed_at IS NULL)
    OR (state='completed' AND verdict IN ('accepted', 'wrong-answer', 'runtime-error', 'instruction-limit', 'memory-limit', 'output-limit', 'filesystem-limit', 'logical-time-limit', 'wall-time-limit') AND completed_at IS NOT NULL)
    OR (state='compile-error' AND verdict='compile-error' AND completed_at IS NOT NULL)
    OR (state='judge-error' AND verdict='judge-error' AND completed_at IS NOT NULL)
    OR (state='infrastructure-error' AND verdict='judge-error' AND completed_at IS NOT NULL)
    OR (state='cancelled' AND verdict='cancelled' AND completed_at IS NOT NULL)
  ),
  CHECK ((origin_submission_id=id AND origin_submitted_at=created_at) OR origin_submission_id<>id),
  CHECK (
    (state='completed' AND policy_summary_json IS NOT NULL AND json_valid(policy_summary_json) AND length(CAST(policy_summary_json AS BLOB)) <= 2048)
    OR (state<>'completed' AND policy_summary_json IS NULL)
  ),
  UNIQUE (id, problem_id, source_id, user_id),
  UNIQUE (id, problem_id, catalog_commit, source_id, user_id)
) STRICT;

CREATE INDEX submissions_user_created ON submissions(user_id, created_at DESC);
CREATE INDEX submissions_problem_score ON submissions(problem_id, score DESC);
CREATE INDEX submissions_contest_created ON submissions(contest_id, created_at);
CREATE INDEX submissions_origin_created ON submissions(origin_submission_id, created_at);
CREATE INDEX submissions_global_capacity ON submissions(state)
WHERE state IN ('admitting', 'queued', 'preparing', 'compiling', 'running', 'finalizing');
CREATE INDEX submissions_user_queue_capacity ON submissions(user_id, state)
WHERE state IN ('admitting', 'queued');
CREATE UNIQUE INDEX submissions_one_executing_per_user ON submissions(user_id)
WHERE state IN ('preparing', 'compiling', 'running', 'finalizing');

INSERT INTO submissions (
  id, origin_submission_id, origin_submitted_at, user_id, problem_id,
  catalog_commit, judge_digest, contest_id, source_id, language, target,
  optimization, entry_path, state, verdict, visibility, score,
  fully_passed_cases, deterministic_cost, peak_memory_bytes,
  policy_summary_json, effective_attempt, admitted_at, created_at, updated_at, completed_at
)
SELECT submissions.id, submissions.origin_submission_id, submissions.origin_submitted_at,
       submissions.user_id, submissions.problem_series_id, versions.commit_sha,
       submissions.execution_semantic_sha256, NULL, submissions.source_id,
       submissions.language, submissions.target, submissions.optimization,
       submissions.entry_path, submissions.state, submissions.verdict,
       submissions.visibility, submissions.score, submissions.fully_passed_cases,
       submissions.deterministic_cost, submissions.peak_memory_bytes,
       submissions.policy_summary_json, submissions.effective_attempt,
       submissions.admitted_at, submissions.created_at, submissions.updated_at,
       submissions.completed_at
FROM submissions_legacy AS submissions
JOIN repository_cutover_version_map AS versions ON versions.version_id=submissions.problem_version_id
ORDER BY submissions.origin_submission_id<>submissions.id, submissions.created_at, submissions.id;

CREATE TABLE submission_idempotency (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  idempotency_key TEXT NOT NULL,
  request_digest TEXT NOT NULL
    CHECK (length(request_digest)=64 AND request_digest NOT GLOB '*[^0-9a-f]*'),
  submission_id TEXT NOT NULL UNIQUE REFERENCES submissions(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  PRIMARY KEY (user_id, idempotency_key)
) STRICT;

INSERT INTO submission_idempotency
SELECT * FROM submission_idempotency_legacy;

CREATE TABLE submission_attempts (
  submission_id TEXT NOT NULL REFERENCES submissions(id) ON DELETE CASCADE,
  attempt INTEGER NOT NULL CHECK (attempt > 0),
  token_hash TEXT NOT NULL CHECK (length(token_hash) BETWEEN 1 AND 128),
  runtime_build_id TEXT CHECK (
    runtime_build_id IS NULL
    OR (length(runtime_build_id)=40 AND runtime_build_id NOT GLOB '*[^0-9a-f]*')
  ),
  worker_version_id TEXT,
  state TEXT NOT NULL CHECK (state IN ('created', 'running', 'succeeded', 'failed', 'cancelled')),
  started_at TEXT,
  finished_at TEXT,
  failure_code TEXT,
  PRIMARY KEY (submission_id, attempt)
) STRICT;

INSERT INTO submission_attempts (
  submission_id, attempt, token_hash, runtime_build_id, worker_version_id,
  state, started_at, finished_at, failure_code
)
SELECT attempts.submission_id, attempts.attempt, attempts.token_hash,
       releases.source_git_commit, NULL, attempts.state, attempts.started_at,
       attempts.finished_at, attempts.failure_code
FROM submission_attempts_legacy AS attempts
JOIN submissions_legacy AS submissions ON submissions.id=attempts.submission_id
JOIN wasm_oj_releases AS releases ON releases.id=submissions.wasm_oj_release_id;

CREATE TABLE submission_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  submission_id TEXT NOT NULL REFERENCES submissions(id) ON DELETE CASCADE,
  event_key TEXT NOT NULL CHECK (length(event_key) BETWEEN 1 AND 200),
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json) AND length(CAST(payload_json AS BLOB)) <= 65536),
  created_at TEXT NOT NULL,
  UNIQUE (submission_id, event_key)
) STRICT;

INSERT INTO submission_events (id, submission_id, event_key, payload_json, created_at)
SELECT id, submission_id, event_key, payload_json, created_at FROM submission_events_legacy;
CREATE INDEX submission_events_replay ON submission_events(submission_id, id);

CREATE TABLE rejudge_jobs (
  id TEXT PRIMARY KEY CHECK (length(id)=36),
  rejudge_batch_id TEXT NOT NULL REFERENCES rejudge_batches(id) ON DELETE CASCADE,
  problem_id TEXT NOT NULL,
  origin_submission_id TEXT NOT NULL,
  old_submission_id TEXT NOT NULL,
  new_submission_id TEXT NOT NULL UNIQUE,
  from_commit TEXT NOT NULL,
  to_commit TEXT NOT NULL,
  source_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending', 'dispatched', 'ready', 'failed', 'cancelled')),
  result_state TEXT CHECK (result_state IS NULL OR result_state IN ('completed', 'compile-error', 'judge-error', 'infrastructure-error', 'cancelled')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (origin_submission_id, problem_id, source_id, user_id)
    REFERENCES submissions(id, problem_id, source_id, user_id) ON DELETE CASCADE ON UPDATE CASCADE,
  FOREIGN KEY (old_submission_id, problem_id, source_id, user_id)
    REFERENCES submissions(id, problem_id, source_id, user_id) ON DELETE CASCADE ON UPDATE CASCADE,
  FOREIGN KEY (new_submission_id, problem_id, to_commit, source_id, user_id)
    REFERENCES submissions(id, problem_id, catalog_commit, source_id, user_id) ON DELETE CASCADE ON UPDATE CASCADE,
  CHECK (
    (state IN ('pending', 'dispatched') AND result_state IS NULL)
    OR (state='ready' AND result_state IN ('completed', 'compile-error'))
    OR (state='failed' AND result_state IN ('judge-error', 'infrastructure-error'))
    OR (state='cancelled' AND result_state='cancelled')
  ),
  UNIQUE (rejudge_batch_id, origin_submission_id)
) STRICT;

INSERT INTO rejudge_jobs (
  id, rejudge_batch_id, problem_id, origin_submission_id, old_submission_id,
  new_submission_id, from_commit, to_commit, source_id, user_id,
  state, result_state, created_at, updated_at
)
SELECT jobs.id, jobs.rejudge_batch_id, jobs.problem_series_id,
       jobs.origin_submission_id, jobs.old_submission_id, jobs.new_submission_id,
       old_versions.commit_sha, new_versions.commit_sha, jobs.source_id,
       jobs.user_id, jobs.state, jobs.result_state, jobs.created_at, jobs.updated_at
FROM rejudge_jobs_legacy AS jobs
JOIN repository_cutover_version_map AS old_versions ON old_versions.version_id=jobs.old_problem_version_id
JOIN repository_cutover_version_map AS new_versions ON new_versions.version_id=jobs.new_problem_version_id;

CREATE INDEX rejudge_jobs_dispatch ON rejudge_jobs(rejudge_batch_id, state, created_at);

CREATE TABLE effective_rejudges (
  origin_submission_id TEXT PRIMARY KEY REFERENCES submissions(id) ON DELETE CASCADE,
  effective_submission_id TEXT NOT NULL UNIQUE REFERENCES submissions(id) ON DELETE CASCADE,
  rejudge_batch_id TEXT NOT NULL REFERENCES rejudge_batches(id) ON DELETE RESTRICT,
  became_effective_at TEXT NOT NULL
) STRICT;

INSERT INTO effective_rejudges (
  origin_submission_id, effective_submission_id, rejudge_batch_id, became_effective_at
)
SELECT origin_submission_id, effective_submission_id,
       effective_rejudge_batch_id, became_effective_at
FROM repository_cutover_effective
WHERE effective_rejudge_batch_id IS NOT NULL AND became_effective_at IS NOT NULL;

CREATE VIEW effective_submission_results AS
SELECT origin.id AS origin_submission_id,
       coalesce(links.effective_submission_id, origin.id) AS effective_submission_id,
       effective.problem_id,
       effective.catalog_commit AS judged_commit,
       effective.judge_digest AS judged_digest,
       catalogs.active_commit_sha AS active_commit,
       active.judge_digest AS active_judge_digest,
       CASE WHEN active.judge_digest IS NULL OR active.judge_digest<>effective.judge_digest THEN 1 ELSE 0 END AS stale,
       links.rejudge_batch_id AS effective_rejudge_batch_id,
       links.became_effective_at
FROM submissions AS origin
LEFT JOIN effective_rejudges AS links ON links.origin_submission_id=origin.id
JOIN submissions AS effective ON effective.id=coalesce(links.effective_submission_id, origin.id)
JOIN problem_series AS problems ON problems.id=effective.problem_id
JOIN catalogs ON catalogs.id=problems.catalog_id
LEFT JOIN problem_revisions AS active
  ON active.problem_id=effective.problem_id AND active.commit_sha=catalogs.active_commit_sha
WHERE origin.origin_submission_id=origin.id
  AND origin.state IN ('completed', 'compile-error', 'judge-error', 'infrastructure-error', 'cancelled');

CREATE TABLE workflow_outbox (
  id TEXT PRIMARY KEY CHECK (length(id)=36),
  catalog_sync_job_id TEXT REFERENCES catalog_sync_jobs(id) ON DELETE CASCADE,
  submission_id TEXT REFERENCES submissions(id) ON DELETE CASCADE,
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'delivered', 'cancelled', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  settled_at TEXT,
  CHECK ((catalog_sync_job_id IS NOT NULL) + (submission_id IS NOT NULL) = 1),
  CHECK ((state='pending' AND settled_at IS NULL) OR (state<>'pending' AND settled_at IS NOT NULL))
) STRICT;

CREATE UNIQUE INDEX workflow_outbox_catalog_sync_target
ON workflow_outbox(catalog_sync_job_id) WHERE catalog_sync_job_id IS NOT NULL;
CREATE UNIQUE INDEX workflow_outbox_submission_target
ON workflow_outbox(submission_id) WHERE submission_id IS NOT NULL;
CREATE INDEX workflow_outbox_pending ON workflow_outbox(created_at, id) WHERE state='pending';

CREATE TABLE maintenance_cursors (
  kind TEXT PRIMARY KEY CHECK (kind IN (
    'submission-events', 'terminal-catalog-jobs', 'github-webhook-deliveries',
    'settled-outbox', 'expired-auth'
  )),
  cursor TEXT,
  last_completed_at TEXT,
  updated_at TEXT NOT NULL
) STRICT;

INSERT INTO maintenance_cursors (kind, cursor, last_completed_at, updated_at)
SELECT kind, cursor, last_completed_at, updated_at
FROM maintenance_cursors_legacy WHERE kind<>'orphan-judge-packages';

-- Old catalog, publication, package-lifecycle, release, and reset-era operation tables are no longer runtime authorities.
DROP TABLE workflow_outbox_legacy;
DROP TABLE maintenance_cursors_legacy;
DROP TABLE problem_version_lineages_legacy;
DROP TABLE rejudge_jobs_legacy;
DROP TABLE submission_events_legacy;
DROP TABLE submission_attempts_legacy;
DROP TABLE submission_idempotency_legacy;
DROP TABLE rejudge_batches_legacy;
DROP TABLE submissions_legacy;
DROP TABLE contest_participants_legacy;
DROP TABLE contest_problems_legacy;
DROP TABLE contests_legacy;
DROP TABLE official_practice_heads;
DROP TABLE problem_versions;
DROP TABLE catalog_publications;
DROP TABLE judge_packages;
DROP TABLE catalog_publish_jobs;
DROP TABLE collection_revision_problems;
DROP TABLE problem_series_legacy;
DROP TABLE collection_revisions;
DROP TABLE catalog_validation_jobs;
DROP TABLE problem_collections;
DROP TABLE wasm_oj_active_releases;
DROP TABLE wasm_oj_releases;

DROP TABLE repository_cutover_version_map;
DROP TABLE repository_cutover_active_commits;
DROP TABLE repository_cutover_kept_revisions;
DROP TABLE repository_cutover_effective;

PRAGMA foreign_key_check;
