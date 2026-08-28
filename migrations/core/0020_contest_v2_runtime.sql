-- Additive Contest v2 cutover. Legacy repository-v1 rows remain immutable
-- source evidence until the bounded application phase materializes canonical
-- classic-code v2 snapshots and marks the cutover complete. Runtime code never
-- reads the legacy tables.

PRAGMA foreign_keys = ON;

ALTER TABLE submission_sources ADD COLUMN source_kind TEXT NOT NULL DEFAULT 'user-code'
  CHECK (source_kind IN ('user-code', 'prompt-generated'));

-- Rejudge batches created by a live contest judge rollout share the existing
-- child-submission pipeline, but carry a durable attempt identity.  A failed
-- rollout is retried by syncing the same repository commit again; the next
-- attempt is deterministic and never mutates the failed audit record.
ALTER TABLE rejudge_batches ADD COLUMN purpose TEXT NOT NULL DEFAULT 'manual'
  CHECK (purpose IN ('manual', 'contest-judge-rollout'));
ALTER TABLE rejudge_batches ADD COLUMN rollout_attempt INTEGER
  CHECK (rollout_attempt IS NULL OR rollout_attempt >= 1);
ALTER TABLE rejudge_batches ADD COLUMN snapshot_timeline_generation INTEGER
  CHECK (snapshot_timeline_generation IS NULL OR snapshot_timeline_generation >= 1);

CREATE UNIQUE INDEX rejudge_batches_contest_rollout_attempt
ON rejudge_batches(contest_id, problem_id, to_commit, rollout_attempt)
WHERE purpose='contest-judge-rollout';

CREATE TABLE contest_judge_rollout_origins (
  rejudge_batch_id TEXT NOT NULL REFERENCES rejudge_batches(id) ON DELETE RESTRICT,
  origin_submission_id TEXT NOT NULL REFERENCES submissions(id) ON DELETE RESTRICT,
  state TEXT NOT NULL DEFAULT 'included' CHECK (state IN ('included', 'excluded')),
  exclusion_reason TEXT,
  snapshotted_at TEXT NOT NULL,
  excluded_at TEXT,
  PRIMARY KEY (rejudge_batch_id, origin_submission_id),
  CHECK (
    (state='included' AND exclusion_reason IS NULL AND excluded_at IS NULL)
    OR (state='excluded' AND exclusion_reason IS NOT NULL AND excluded_at IS NOT NULL)
  )
) STRICT;

CREATE INDEX contest_judge_rollout_origins_pending
ON contest_judge_rollout_origins(rejudge_batch_id, state, origin_submission_id);

CREATE TRIGGER contest_judge_rollout_origin_identity_immutable
BEFORE UPDATE OF rejudge_batch_id, origin_submission_id, snapshotted_at
ON contest_judge_rollout_origins
BEGIN
  SELECT RAISE(ABORT, 'contest judge rollout snapshot identity is immutable');
END;

CREATE TRIGGER submission_source_kind_immutable
BEFORE UPDATE OF source_kind ON submission_sources
WHEN NEW.source_kind <> OLD.source_kind
BEGIN
  SELECT RAISE(ABORT, 'submission source kind is immutable');
END;

-- Immutable repository projections. rules_json contains only the canonical
-- ContestRules value. activation_sha256 additionally covers status and access
-- mode, which are operational gates outside ContestRules.
CREATE TABLE contest_rule_revisions (
  contest_id TEXT NOT NULL REFERENCES contest_series(id) ON DELETE RESTRICT,
  rules_commit TEXT NOT NULL
    CHECK (length(rules_commit)=40 AND rules_commit NOT GLOB '*[^0-9a-f]*'),
  status TEXT NOT NULL CHECK (status IN ('draft', 'published', 'archived')),
  title TEXT NOT NULL CHECK (length(CAST(title AS BLOB)) <= 4096),
  description TEXT NOT NULL CHECK (length(CAST(description AS BLOB)) <= 65536),
  access_mode TEXT NOT NULL CHECK (access_mode IN ('public', 'invite')),
  rules_json TEXT NOT NULL CHECK (
    json_valid(rules_json) AND length(CAST(rules_json AS BLOB)) BETWEEN 2 AND 262144
  ),
  rules_sha256 TEXT NOT NULL
    CHECK (length(rules_sha256)=64 AND rules_sha256 NOT GLOB '*[^0-9a-f]*'),
  activation_sha256 TEXT NOT NULL
    CHECK (length(activation_sha256)=64 AND activation_sha256 NOT GLOB '*[^0-9a-f]*'),
  clock_kind TEXT NOT NULL CHECK (clock_kind IN ('global', 'individual')),
  registration_opens_at TEXT NOT NULL,
  registration_closes_at TEXT NOT NULL,
  global_starts_at TEXT,
  duration_seconds INTEGER NOT NULL CHECK (duration_seconds BETWEEN 1 AND 31622400),
  official_track TEXT NOT NULL CHECK (official_track IN ('code', 'prompt-program')),
  evidence_at TEXT NOT NULL CHECK (
    evidence_at IN ('input-admitted', 'generated-source-ready', 'judge-terminal')
  ),
  ai_assist TEXT CHECK (ai_assist IN ('allowed', 'disabled')),
  prompt_compiler_config_id TEXT,
  prompt_compiler_config_sha256 TEXT CHECK (
    prompt_compiler_config_sha256 IS NULL
    OR (length(prompt_compiler_config_sha256)=64
      AND prompt_compiler_config_sha256 NOT GLOB '*[^0-9a-f]*')
  ),
  prompt_max_bytes INTEGER,
  prompt_input_tokens INTEGER,
  prompt_output_tokens INTEGER,
  prompt_generated_source_bytes INTEGER,
  prompt_timeout_seconds INTEGER,
  prompt_disclosure TEXT CHECK (prompt_disclosure IN ('private', 'best-after-end')),
  scoring_kind TEXT NOT NULL CHECK (scoring_kind IN ('score', 'icpc', 'progress')),
  leaderboard_kind TEXT NOT NULL CHECK (
    leaderboard_kind IN ('live', 'freeze', 'hidden-until-end')
  ),
  leaderboard_freeze_after_seconds INTEGER,
  created_at TEXT NOT NULL,
  PRIMARY KEY (contest_id, rules_commit),
  UNIQUE (contest_id, rules_commit, rules_sha256),
  UNIQUE (contest_id, rules_commit, rules_sha256, activation_sha256),
  CHECK (registration_closes_at > registration_opens_at),
  CHECK (
    (clock_kind='global' AND global_starts_at IS NOT NULL)
    OR (clock_kind='individual' AND global_starts_at IS NULL)
  ),
  CHECK (
    (official_track='code'
      AND ai_assist IS NOT NULL
      AND evidence_at <> 'generated-source-ready'
      AND prompt_compiler_config_id IS NULL
      AND prompt_compiler_config_sha256 IS NULL
      AND prompt_max_bytes IS NULL
      AND prompt_input_tokens IS NULL
      AND prompt_output_tokens IS NULL
      AND prompt_generated_source_bytes IS NULL
      AND prompt_timeout_seconds IS NULL
      AND prompt_disclosure IS NULL)
    OR (official_track='prompt-program'
      AND ai_assist IS NULL
      AND prompt_compiler_config_id IS NOT NULL
      AND length(prompt_compiler_config_id) BETWEEN 1 AND 200
      AND prompt_compiler_config_sha256 IS NOT NULL
      AND prompt_max_bytes BETWEEN 1 AND 16384
      AND prompt_input_tokens > 0
      AND prompt_output_tokens > 0
      AND prompt_generated_source_bytes BETWEEN 1 AND 1048576
      AND prompt_timeout_seconds > 0
      AND prompt_disclosure IS NOT NULL)
  ),
  CHECK (
    (leaderboard_kind='freeze' AND leaderboard_freeze_after_seconds BETWEEN 1 AND duration_seconds-1)
    OR (leaderboard_kind<>'freeze' AND leaderboard_freeze_after_seconds IS NULL)
  )
) STRICT;

CREATE INDEX contest_rule_revisions_commit
ON contest_rule_revisions(rules_commit, status);

CREATE TABLE contest_rule_problems (
  contest_id TEXT NOT NULL,
  rules_commit TEXT NOT NULL,
  problem_id TEXT NOT NULL REFERENCES problem_series(id) ON DELETE RESTRICT,
  ordinal INTEGER NOT NULL CHECK (ordinal BETWEEN 1 AND 100),
  batch INTEGER NOT NULL CHECK (batch >= 1),
  release_after_seconds INTEGER NOT NULL CHECK (release_after_seconds >= 0),
  submission_closes_after_seconds INTEGER NOT NULL CHECK (submission_closes_after_seconds > 0),
  points REAL NOT NULL CHECK (points > 0),
  attempt_limit INTEGER NOT NULL CHECK (attempt_limit > 0),
  output_language TEXT,
  output_target TEXT CHECK (output_target IN ('wasip1', 'wasix')),
  output_optimization TEXT CHECK (output_optimization IN ('debug', 'release')),
  output_entry_path TEXT,
  problem_rules_json TEXT NOT NULL CHECK (
    json_valid(problem_rules_json) AND length(CAST(problem_rules_json AS BLOB)) BETWEEN 2 AND 16384
  ),
  PRIMARY KEY (contest_id, rules_commit, problem_id),
  UNIQUE (contest_id, rules_commit, ordinal),
  FOREIGN KEY (contest_id, rules_commit)
    REFERENCES contest_rule_revisions(contest_id, rules_commit) ON DELETE CASCADE,
  CHECK (submission_closes_after_seconds > release_after_seconds),
  CHECK (
    (output_language IS NULL AND output_target IS NULL
      AND output_optimization IS NULL AND output_entry_path IS NULL)
    OR (output_language IS NOT NULL AND length(output_language) BETWEEN 1 AND 64
      AND output_target IS NOT NULL AND output_optimization IS NOT NULL
      AND output_entry_path IS NOT NULL AND length(output_entry_path) BETWEEN 1 AND 512)
  )
) STRICT;

CREATE INDEX contest_rule_problems_release
ON contest_rule_problems(contest_id, rules_commit, release_after_seconds, batch, ordinal);

CREATE TABLE contest_rule_checkpoints (
  contest_id TEXT NOT NULL,
  rules_commit TEXT NOT NULL,
  checkpoint_id TEXT NOT NULL CHECK (length(checkpoint_id) BETWEEN 1 AND 128),
  ordinal INTEGER NOT NULL CHECK (ordinal BETWEEN 1 AND 1000),
  at_seconds INTEGER NOT NULL CHECK (at_seconds > 0),
  scope_kind TEXT NOT NULL CHECK (scope_kind IN ('all-released', 'batch', 'problems')),
  scope_batch INTEGER,
  scope_problem_slugs_json TEXT CHECK (
    scope_problem_slugs_json IS NULL
    OR (json_valid(scope_problem_slugs_json)
      AND json_type(scope_problem_slugs_json)='array'
      AND length(CAST(scope_problem_slugs_json AS BLOB)) <= 16384)
  ),
  minimum_solved INTEGER CHECK (minimum_solved IS NULL OR minimum_solved >= 0),
  minimum_score REAL CHECK (minimum_score IS NULL OR minimum_score >= 0),
  ranking_kind TEXT CHECK (ranking_kind IN ('top-k', 'top-percent')),
  ranking_value REAL CHECK (ranking_value IS NULL OR ranking_value > 0),
  settlement TEXT NOT NULL CHECK (settlement IN ('provisional', 'pause-until-terminal')),
  checkpoint_rules_json TEXT NOT NULL CHECK (
    json_valid(checkpoint_rules_json)
    AND length(CAST(checkpoint_rules_json AS BLOB)) BETWEEN 2 AND 16384
  ),
  PRIMARY KEY (contest_id, rules_commit, checkpoint_id),
  UNIQUE (contest_id, rules_commit, ordinal),
  FOREIGN KEY (contest_id, rules_commit)
    REFERENCES contest_rule_revisions(contest_id, rules_commit) ON DELETE CASCADE,
  CHECK (
    (scope_kind='all-released' AND scope_batch IS NULL AND scope_problem_slugs_json IS NULL)
    OR (scope_kind='batch' AND scope_batch >= 1 AND scope_problem_slugs_json IS NULL)
    OR (scope_kind='problems' AND scope_batch IS NULL AND scope_problem_slugs_json IS NOT NULL)
  ),
  CHECK (minimum_solved IS NOT NULL OR minimum_score IS NOT NULL OR ranking_kind IS NOT NULL),
  CHECK (
    (ranking_kind IS NULL AND ranking_value IS NULL)
    OR (ranking_kind='top-k' AND ranking_value=CAST(ranking_value AS INTEGER))
    OR (ranking_kind='top-percent' AND ranking_value <= 100)
  )
) STRICT;

-- One mutable row locates current operational state; immutable epoch/event
-- tables retain how that state was reached.
CREATE TABLE contest_runtimes (
  contest_id TEXT PRIMARY KEY REFERENCES contest_series(id) ON DELETE RESTRICT,
  active_rules_commit TEXT NOT NULL,
  active_rules_sha256 TEXT NOT NULL,
  active_activation_sha256 TEXT NOT NULL,
  pending_rules_commit TEXT,
  pending_rules_sha256 TEXT,
  pending_activation_sha256 TEXT,
  rules_epoch INTEGER NOT NULL CHECK (rules_epoch >= 1),
  timeline_generation INTEGER NOT NULL CHECK (timeline_generation >= 1),
  state TEXT NOT NULL CHECK (state IN ('scheduled', 'running', 'paused', 'ended')),
  wall_anchor_at TEXT,
  logical_anchor_seconds INTEGER NOT NULL CHECK (logical_anchor_seconds >= 0),
  pause_reason TEXT,
  paused_at TEXT,
  paused_from_state TEXT CHECK (paused_from_state IN ('scheduled', 'running')),
  schedule_shift_seconds INTEGER NOT NULL DEFAULT 0 CHECK (schedule_shift_seconds >= 0),
  first_started_at TEXT,
  ended_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (contest_id, active_rules_commit, active_rules_sha256, active_activation_sha256)
    REFERENCES contest_rule_revisions(
      contest_id, rules_commit, rules_sha256, activation_sha256
    ) ON DELETE RESTRICT,
  FOREIGN KEY (contest_id, pending_rules_commit, pending_rules_sha256, pending_activation_sha256)
    REFERENCES contest_rule_revisions(
      contest_id, rules_commit, rules_sha256, activation_sha256
    ) ON DELETE RESTRICT,
  CHECK ((pending_rules_commit IS NULL) = (pending_rules_sha256 IS NULL)),
  CHECK ((pending_rules_commit IS NULL) = (pending_activation_sha256 IS NULL)),
  CHECK (
    (state='scheduled' AND wall_anchor_at IS NULL AND paused_at IS NULL
      AND paused_from_state IS NULL AND ended_at IS NULL)
    OR (state='running' AND wall_anchor_at IS NOT NULL AND paused_at IS NULL
      AND paused_from_state IS NULL AND ended_at IS NULL)
    OR (state='paused' AND wall_anchor_at IS NULL AND paused_at IS NOT NULL
      AND paused_from_state IS NOT NULL AND ended_at IS NULL)
    OR (state='ended' AND wall_anchor_at IS NULL AND paused_at IS NULL
      AND paused_from_state IS NULL AND ended_at IS NOT NULL)
  )
) STRICT;

CREATE TABLE contest_rule_epochs (
  contest_id TEXT NOT NULL REFERENCES contest_series(id) ON DELETE RESTRICT,
  rules_epoch INTEGER NOT NULL CHECK (rules_epoch >= 1),
  rules_commit TEXT NOT NULL,
  rules_sha256 TEXT NOT NULL,
  timeline_generation INTEGER NOT NULL CHECK (timeline_generation >= 1),
  activation_kind TEXT NOT NULL CHECK (activation_kind IN ('initial', 'monotonic-recalculate', 'rewind')),
  activated_logical_seconds INTEGER NOT NULL CHECK (activated_logical_seconds >= 0),
  activated_at TEXT NOT NULL,
  activated_by TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  PRIMARY KEY (contest_id, rules_epoch),
  FOREIGN KEY (contest_id, rules_commit, rules_sha256)
    REFERENCES contest_rule_revisions(contest_id, rules_commit, rules_sha256) ON DELETE RESTRICT
) STRICT;

CREATE TRIGGER contest_rule_epoch_identity_immutable
BEFORE UPDATE OF
  contest_id, rules_epoch, rules_commit, rules_sha256, timeline_generation,
  activation_kind, activated_logical_seconds, activated_at
ON contest_rule_epochs
BEGIN
  SELECT RAISE(ABORT, 'contest rule epoch history is immutable');
END;

CREATE TRIGGER contest_rule_epoch_actor_erasure_guard
BEFORE UPDATE OF activated_by ON contest_rule_epochs
WHEN NOT EXISTS (
  SELECT 1 FROM account_erasure_jobs
  WHERE user_id=OLD.activated_by AND anonymous_user_id=NEW.activated_by
)
BEGIN
  SELECT RAISE(ABORT, 'contest rule epoch actor may change only for account erasure');
END;

CREATE TRIGGER contest_rule_epoch_delete_forbidden
BEFORE DELETE ON contest_rule_epochs
BEGIN
  SELECT RAISE(ABORT, 'contest rule epoch history is immutable');
END;

CREATE TABLE contest_timeline_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  contest_id TEXT NOT NULL REFERENCES contest_series(id) ON DELETE RESTRICT,
  event_key TEXT NOT NULL CHECK (length(event_key) BETWEEN 1 AND 200),
  event_type TEXT NOT NULL CHECK (
    event_type IN ('start', 'pause', 'resume', 'rules-recalculated', 'rewind', 'end')
  ),
  from_generation INTEGER NOT NULL CHECK (from_generation >= 1),
  to_generation INTEGER NOT NULL CHECK (to_generation >= from_generation),
  logical_seconds INTEGER NOT NULL CHECK (logical_seconds >= 0),
  target_logical_seconds INTEGER CHECK (target_logical_seconds IS NULL OR target_logical_seconds >= 0),
  actor_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  payload_json TEXT NOT NULL CHECK (
    json_valid(payload_json) AND length(CAST(payload_json AS BLOB)) <= 65536
  ),
  created_at TEXT NOT NULL,
  UNIQUE (contest_id, event_key),
  CHECK ((event_type='rewind') = (target_logical_seconds IS NOT NULL)),
  CHECK ((event_type='rewind' AND to_generation=from_generation+1)
    OR (event_type<>'rewind' AND to_generation=from_generation))
) STRICT;

CREATE INDEX contest_timeline_events_replay
ON contest_timeline_events(contest_id, id);

CREATE TRIGGER contest_timeline_event_identity_immutable
BEFORE UPDATE OF
  id, contest_id, event_key, event_type, from_generation, to_generation,
  logical_seconds, target_logical_seconds, payload_json, created_at
ON contest_timeline_events
BEGIN
  SELECT RAISE(ABORT, 'contest timeline event history is immutable');
END;

CREATE TRIGGER contest_timeline_event_actor_erasure_guard
BEFORE UPDATE OF actor_user_id ON contest_timeline_events
WHEN NOT EXISTS (
  SELECT 1 FROM account_erasure_jobs
  WHERE user_id=OLD.actor_user_id AND anonymous_user_id=NEW.actor_user_id
)
BEGIN
  SELECT RAISE(ABORT, 'contest timeline event actor may change only for account erasure');
END;

CREATE TRIGGER contest_timeline_event_delete_forbidden
BEFORE DELETE ON contest_timeline_events
BEGIN
  SELECT RAISE(ABORT, 'contest timeline events are append-only');
END;

CREATE TABLE contest_entrants (
  id TEXT PRIMARY KEY CHECK (length(id)=36),
  contest_id TEXT NOT NULL REFERENCES contest_series(id) ON DELETE RESTRICT,
  kind TEXT NOT NULL CHECK (kind IN ('account', 'system')),
  subject_key TEXT NOT NULL CHECK (length(subject_key) BETWEEN 1 AND 256),
  account_user_id TEXT REFERENCES users(id) ON DELETE RESTRICT,
  owner_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  joined_at TEXT NOT NULL,
  started_at TEXT,
  start_timeline_generation INTEGER,
  individual_wall_anchor_at TEXT,
  individual_logical_anchor_seconds INTEGER NOT NULL DEFAULT 0
    CHECK (individual_logical_anchor_seconds >= 0),
  state TEXT NOT NULL CHECK (state IN ('joined', 'active', 'eliminated', 'completed')),
  state_timeline_generation INTEGER NOT NULL CHECK (state_timeline_generation >= 1),
  eliminated_at TEXT,
  eliminated_logical_seconds INTEGER,
  eliminated_checkpoint_id TEXT,
  elimination_reason TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (contest_id, kind, subject_key),
  UNIQUE (id, contest_id),
  CHECK (
    (kind='account' AND account_user_id IS NOT NULL
      AND owner_user_id=account_user_id AND subject_key=account_user_id)
    OR (kind='system' AND account_user_id IS NULL)
  ),
  CHECK (
    (started_at IS NULL AND start_timeline_generation IS NULL AND individual_wall_anchor_at IS NULL)
    OR (started_at IS NOT NULL AND start_timeline_generation >= 1)
  ),
  CHECK (
    (state<>'eliminated' AND eliminated_at IS NULL AND eliminated_logical_seconds IS NULL
      AND eliminated_checkpoint_id IS NULL AND elimination_reason IS NULL)
    OR (state='eliminated' AND eliminated_at IS NOT NULL
      AND eliminated_logical_seconds >= 0 AND elimination_reason IS NOT NULL)
  )
) STRICT;

CREATE INDEX contest_entrants_account
ON contest_entrants(account_user_id, contest_id) WHERE account_user_id IS NOT NULL;

CREATE INDEX contest_entrants_state
ON contest_entrants(contest_id, state_timeline_generation, state);

CREATE TRIGGER contest_entrant_identity_immutable
BEFORE UPDATE OF id, contest_id, kind, created_at ON contest_entrants
BEGIN
  SELECT RAISE(ABORT, 'contest entrant identity is immutable');
END;

CREATE TRIGGER contest_entrant_account_erasure_guard
BEFORE UPDATE OF subject_key, account_user_id, owner_user_id ON contest_entrants
WHEN NOT (
  OLD.kind='account'
  AND OLD.account_user_id IS NOT NULL
  AND OLD.owner_user_id IS OLD.account_user_id
  AND OLD.subject_key IS OLD.account_user_id
  AND NEW.account_user_id IS NOT OLD.account_user_id
  AND NEW.owner_user_id IS NEW.account_user_id
  AND NEW.subject_key IS NEW.account_user_id
  AND EXISTS (
    SELECT 1 FROM account_erasure_jobs
    WHERE user_id=OLD.account_user_id AND anonymous_user_id=NEW.account_user_id
  )
)
BEGIN
  SELECT RAISE(ABORT, 'contest entrant account may change only for account erasure');
END;

CREATE TRIGGER contest_entrant_elimination_generation_guard
BEFORE UPDATE OF state, state_timeline_generation ON contest_entrants
WHEN OLD.state='eliminated' AND NEW.state<>'eliminated'
  AND NEW.state_timeline_generation <= OLD.state_timeline_generation
BEGIN
  SELECT RAISE(ABORT, 'elimination is irreversible within one timeline generation');
END;

CREATE TABLE contest_problem_epochs (
  contest_id TEXT NOT NULL REFERENCES contest_series(id) ON DELETE RESTRICT,
  problem_id TEXT NOT NULL REFERENCES problem_series(id) ON DELETE RESTRICT,
  problem_epoch INTEGER NOT NULL CHECK (problem_epoch >= 1),
  rules_epoch INTEGER NOT NULL CHECK (rules_epoch >= 1),
  content_epoch INTEGER NOT NULL CHECK (content_epoch >= 1),
  judge_epoch INTEGER NOT NULL CHECK (judge_epoch >= 1),
  content_commit TEXT NOT NULL,
  judge_commit TEXT NOT NULL,
  judge_digest TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending', 'effective', 'superseded', 'failed')),
  rollout_batch_id TEXT,
  created_at TEXT NOT NULL,
  effective_at TEXT,
  failure_code TEXT,
  PRIMARY KEY (contest_id, problem_id, problem_epoch),
  UNIQUE (contest_id, problem_id, content_epoch, judge_epoch),
  FOREIGN KEY (contest_id, rules_epoch)
    REFERENCES contest_rule_epochs(contest_id, rules_epoch) ON DELETE RESTRICT,
  FOREIGN KEY (problem_id, content_commit)
    REFERENCES problem_revisions(problem_id, commit_sha) ON DELETE RESTRICT,
  FOREIGN KEY (problem_id, judge_commit, judge_digest)
    REFERENCES problem_revisions(problem_id, commit_sha, judge_digest) ON DELETE RESTRICT,
  CHECK (
    (state='pending' AND effective_at IS NULL AND failure_code IS NULL)
    OR (state IN ('effective', 'superseded') AND effective_at IS NOT NULL AND failure_code IS NULL)
    OR (state='failed' AND effective_at IS NULL AND failure_code IS NOT NULL)
  )
) STRICT;

CREATE UNIQUE INDEX contest_problem_epochs_one_effective
ON contest_problem_epochs(contest_id, problem_id) WHERE state='effective';

CREATE TABLE contest_reveal_grants (
  contest_id TEXT NOT NULL,
  entrant_id TEXT NOT NULL,
  problem_id TEXT NOT NULL REFERENCES problem_series(id) ON DELETE RESTRICT,
  timeline_generation INTEGER NOT NULL CHECK (timeline_generation >= 1),
  rules_epoch INTEGER NOT NULL CHECK (rules_epoch >= 1),
  problem_epoch INTEGER NOT NULL CHECK (problem_epoch >= 1),
  content_epoch INTEGER NOT NULL CHECK (content_epoch >= 1),
  granted_logical_seconds INTEGER NOT NULL CHECK (granted_logical_seconds >= 0),
  granted_at TEXT NOT NULL,
  eligibility TEXT NOT NULL DEFAULT 'eligible' CHECK (eligibility IN ('eligible', 'invalid')),
  invalidated_at TEXT,
  invalidation_reason TEXT,
  PRIMARY KEY (contest_id, entrant_id, problem_id, timeline_generation),
  FOREIGN KEY (entrant_id, contest_id)
    REFERENCES contest_entrants(id, contest_id) ON DELETE RESTRICT,
  FOREIGN KEY (contest_id, rules_epoch)
    REFERENCES contest_rule_epochs(contest_id, rules_epoch) ON DELETE RESTRICT,
  CHECK (
    (eligibility='eligible' AND invalidated_at IS NULL AND invalidation_reason IS NULL)
    OR (eligibility='invalid' AND invalidated_at IS NOT NULL AND invalidation_reason IS NOT NULL)
  )
) STRICT;

CREATE TABLE contest_checkpoint_runs (
  id TEXT PRIMARY KEY CHECK (length(id)=36),
  contest_id TEXT NOT NULL REFERENCES contest_series(id) ON DELETE RESTRICT,
  checkpoint_id TEXT NOT NULL CHECK (length(checkpoint_id) BETWEEN 1 AND 128),
  timeline_generation INTEGER NOT NULL CHECK (timeline_generation >= 1),
  rules_epoch INTEGER NOT NULL CHECK (rules_epoch >= 1),
  logical_seconds INTEGER NOT NULL CHECK (logical_seconds >= 0),
  settlement TEXT NOT NULL CHECK (settlement IN ('provisional', 'pause-until-terminal')),
  state TEXT NOT NULL CHECK (state IN ('evaluating', 'provisional', 'final', 'invalid')),
  population INTEGER NOT NULL CHECK (population >= 0),
  pending_work INTEGER NOT NULL CHECK (pending_work >= 0),
  created_at TEXT NOT NULL,
  finalized_at TEXT,
  invalidated_at TEXT,
  invalidation_reason TEXT,
  -- A monotonic rules activation keeps the timeline generation but creates a
  -- new rule epoch.  Retaining the old run is part of the audit trail, while
  -- the new epoch must be able to evaluate the same declared checkpoint id.
  UNIQUE (contest_id, timeline_generation, rules_epoch, checkpoint_id),
  FOREIGN KEY (contest_id, rules_epoch)
    REFERENCES contest_rule_epochs(contest_id, rules_epoch) ON DELETE RESTRICT,
  CHECK (
    (state IN ('evaluating', 'provisional') AND finalized_at IS NULL AND invalidated_at IS NULL)
    OR (state='final' AND finalized_at IS NOT NULL AND invalidated_at IS NULL)
    OR (state='invalid' AND invalidated_at IS NOT NULL AND invalidation_reason IS NOT NULL)
  )
) STRICT;

CREATE TABLE contest_checkpoint_decisions (
  checkpoint_run_id TEXT NOT NULL REFERENCES contest_checkpoint_runs(id) ON DELETE RESTRICT,
  entrant_id TEXT NOT NULL REFERENCES contest_entrants(id) ON DELETE RESTRICT,
  decision TEXT NOT NULL CHECK (decision IN ('advanced', 'eliminated')),
  provisional INTEGER NOT NULL CHECK (provisional IN (0, 1)),
  competitive_key_json TEXT NOT NULL CHECK (
    json_valid(competitive_key_json) AND length(CAST(competitive_key_json AS BLOB)) <= 16384
  ),
  decided_at TEXT NOT NULL,
  PRIMARY KEY (checkpoint_run_id, entrant_id)
) STRICT;

-- Contest submissions remain in the existing submissions table. This sidecar
-- is mandatory for every v2 contest admission and carries all fence tokens and
-- rewind eligibility without rewriting historic v1 submissions.
CREATE TABLE contest_submission_records (
  submission_id TEXT PRIMARY KEY REFERENCES submissions(id) ON DELETE RESTRICT,
  contest_id TEXT NOT NULL REFERENCES contest_series(id) ON DELETE RESTRICT,
  entrant_id TEXT NOT NULL,
  timeline_generation INTEGER NOT NULL CHECK (timeline_generation >= 1),
  rules_epoch INTEGER NOT NULL CHECK (rules_epoch >= 1),
  content_epoch INTEGER NOT NULL CHECK (content_epoch >= 1),
  judge_epoch INTEGER NOT NULL CHECK (judge_epoch >= 1),
  admitted_logical_seconds INTEGER NOT NULL CHECK (admitted_logical_seconds >= 0),
  evidence_at TEXT NOT NULL CHECK (
    evidence_at IN ('input-admitted', 'generated-source-ready', 'judge-terminal')
  ),
  evidence_logical_seconds INTEGER CHECK (evidence_logical_seconds IS NULL OR evidence_logical_seconds >= 0),
  eligibility TEXT NOT NULL DEFAULT 'eligible' CHECK (eligibility IN ('eligible', 'invalid')),
  invalidated_at TEXT,
  invalidation_reason TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (entrant_id, contest_id)
    REFERENCES contest_entrants(id, contest_id) ON DELETE RESTRICT,
  FOREIGN KEY (contest_id, rules_epoch)
    REFERENCES contest_rule_epochs(contest_id, rules_epoch) ON DELETE RESTRICT,
  CHECK (
    (evidence_at='input-admitted' AND evidence_logical_seconds IS NOT NULL)
    OR evidence_at<>'input-admitted'
  ),
  CHECK (
    (eligibility='eligible' AND invalidated_at IS NULL AND invalidation_reason IS NULL)
    OR (eligibility='invalid' AND invalidated_at IS NOT NULL AND invalidation_reason IS NOT NULL)
  )
) STRICT;

CREATE TRIGGER contest_submission_record_identity_guard
BEFORE INSERT ON contest_submission_records
WHEN NOT EXISTS (
  SELECT 1
  FROM submissions
  JOIN contest_entrants AS entrants
    ON entrants.id=NEW.entrant_id AND entrants.contest_id=NEW.contest_id
  WHERE submissions.id=NEW.submission_id
    AND submissions.contest_id=NEW.contest_id
    AND submissions.user_id=entrants.owner_user_id
)
BEGIN
  SELECT RAISE(ABORT, 'contest submission record does not match submission and entrant identity');
END;

CREATE INDEX contest_submission_records_timeline
ON contest_submission_records(contest_id, timeline_generation, entrant_id, admitted_logical_seconds);

CREATE TRIGGER contest_submission_eligibility_one_way
BEFORE UPDATE OF eligibility ON contest_submission_records
WHEN OLD.eligibility='invalid' AND NEW.eligibility<>'invalid'
BEGIN
  SELECT RAISE(ABORT, 'invalid contest submission history cannot become eligible');
END;

CREATE TABLE prompt_public_contexts (
  sha256 TEXT PRIMARY KEY
    CHECK (length(sha256)=64 AND sha256 NOT GLOB '*[^0-9a-f]*'),
  bytes INTEGER NOT NULL CHECK (bytes BETWEEN 0 AND 8388608),
  storage_key TEXT NOT NULL UNIQUE CHECK (length(storage_key) BETWEEN 1 AND 1024),
  created_at TEXT NOT NULL
) STRICT;

-- A content digest is selectable by Prompt Program only when the active
-- contest problem content epoch explicitly grants it.  This prevents a caller
-- from naming some other cached public context by digest.
CREATE TABLE contest_problem_prompt_contexts (
  contest_id TEXT NOT NULL REFERENCES contest_series(id) ON DELETE RESTRICT,
  problem_id TEXT NOT NULL REFERENCES problem_series(id) ON DELETE RESTRICT,
  content_epoch INTEGER NOT NULL CHECK (content_epoch >= 1),
  public_context_sha256 TEXT NOT NULL
    REFERENCES prompt_public_contexts(sha256) ON DELETE RESTRICT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (contest_id, problem_id, content_epoch)
) STRICT;

CREATE TRIGGER contest_problem_prompt_context_insert_guard
BEFORE INSERT ON contest_problem_prompt_contexts
WHEN NOT EXISTS (
  SELECT 1 FROM contest_problem_epochs AS epoch
  WHERE epoch.contest_id=NEW.contest_id AND epoch.problem_id=NEW.problem_id
    AND epoch.content_epoch=NEW.content_epoch
)
BEGIN
  SELECT RAISE(ABORT, 'prompt context must identify a contest problem content epoch');
END;

CREATE TRIGGER contest_problem_prompt_context_update_forbidden
BEFORE UPDATE ON contest_problem_prompt_contexts
BEGIN
  SELECT RAISE(ABORT, 'contest problem prompt context is immutable');
END;

CREATE TRIGGER contest_problem_prompt_context_delete_forbidden
BEFORE DELETE ON contest_problem_prompt_contexts
BEGIN
  SELECT RAISE(ABORT, 'contest problem prompt context is immutable');
END;

CREATE TABLE prompt_attempts (
  id TEXT PRIMARY KEY CHECK (length(id)=36),
  contest_id TEXT NOT NULL REFERENCES contest_series(id) ON DELETE RESTRICT,
  entrant_id TEXT NOT NULL,
  problem_id TEXT NOT NULL REFERENCES problem_series(id) ON DELETE RESTRICT,
  timeline_generation INTEGER NOT NULL CHECK (timeline_generation >= 1),
  rules_epoch INTEGER NOT NULL CHECK (rules_epoch >= 1),
  problem_epoch INTEGER NOT NULL CHECK (problem_epoch >= 1),
  content_epoch INTEGER NOT NULL CHECK (content_epoch >= 1),
  judge_epoch INTEGER NOT NULL CHECK (judge_epoch >= 1),
  compiler_config_id TEXT NOT NULL CHECK (length(compiler_config_id) BETWEEN 1 AND 200),
  compiler_config_sha256 TEXT NOT NULL
    CHECK (length(compiler_config_sha256)=64 AND compiler_config_sha256 NOT GLOB '*[^0-9a-f]*'),
  public_context_sha256 TEXT NOT NULL REFERENCES prompt_public_contexts(sha256) ON DELETE RESTRICT,
  prompt_text TEXT,
  prompt_bytes INTEGER,
  prompt_sha256 TEXT CHECK (
    prompt_sha256 IS NULL
    OR (length(prompt_sha256)=64 AND prompt_sha256 NOT GLOB '*[^0-9a-f]*')
  ),
  output_language TEXT NOT NULL CHECK (length(output_language) BETWEEN 1 AND 64),
  output_target TEXT NOT NULL CHECK (output_target IN ('wasip1', 'wasix')),
  output_optimization TEXT NOT NULL CHECK (output_optimization IN ('debug', 'release')),
  output_entry_path TEXT NOT NULL CHECK (length(output_entry_path) BETWEEN 1 AND 512),
  state TEXT NOT NULL CHECK (
    state IN ('reserved', 'generating', 'source-ready', 'submitted', 'failed', 'cancelled')
  ),
  generated_source_id TEXT REFERENCES submission_sources(id) ON DELETE RESTRICT,
  generated_source_sha256 TEXT CHECK (
    generated_source_sha256 IS NULL
    OR (length(generated_source_sha256)=64 AND generated_source_sha256 NOT GLOB '*[^0-9a-f]*')
  ),
  submission_id TEXT UNIQUE REFERENCES submissions(id) ON DELETE RESTRICT,
  admitted_logical_seconds INTEGER NOT NULL CHECK (admitted_logical_seconds >= 0),
  evidence_logical_seconds INTEGER CHECK (evidence_logical_seconds IS NULL OR evidence_logical_seconds >= 0),
  response_received_at TEXT,
  source_ready_at TEXT,
  terminal_at TEXT,
  provider_duration_ms INTEGER CHECK (provider_duration_ms IS NULL OR provider_duration_ms >= 0),
  failure_code TEXT,
  eligibility TEXT NOT NULL DEFAULT 'eligible' CHECK (eligibility IN ('eligible', 'invalid')),
  invalidated_at TEXT,
  invalidation_reason TEXT,
  erased_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (entrant_id, contest_id)
    REFERENCES contest_entrants(id, contest_id) ON DELETE RESTRICT,
  FOREIGN KEY (contest_id, rules_epoch)
    REFERENCES contest_rule_epochs(contest_id, rules_epoch) ON DELETE RESTRICT,
  CHECK (
    (erased_at IS NULL AND prompt_text IS NOT NULL AND prompt_bytes BETWEEN 1 AND 16384
      AND prompt_bytes=length(CAST(prompt_text AS BLOB)) AND prompt_sha256 IS NOT NULL)
    OR (erased_at IS NOT NULL AND prompt_text IS NULL AND prompt_bytes IS NULL AND prompt_sha256 IS NULL)
  ),
  CHECK (
    (generated_source_id IS NULL AND generated_source_sha256 IS NULL)
    OR (generated_source_id IS NOT NULL AND generated_source_sha256 IS NOT NULL)
    OR (erased_at IS NOT NULL AND generated_source_id IS NOT NULL AND generated_source_sha256 IS NULL)
  ),
  CHECK (
    (state IN ('reserved', 'generating') AND generated_source_id IS NULL AND submission_id IS NULL)
    OR (state='source-ready' AND generated_source_id IS NOT NULL AND submission_id IS NULL)
    OR (state='submitted' AND generated_source_id IS NOT NULL AND submission_id IS NOT NULL)
    OR state IN ('failed', 'cancelled')
  ),
  CHECK (
    (eligibility='eligible' AND invalidated_at IS NULL AND invalidation_reason IS NULL)
    OR (eligibility='invalid' AND invalidated_at IS NOT NULL AND invalidation_reason IS NOT NULL)
  )
) STRICT;

CREATE INDEX prompt_attempts_history
ON prompt_attempts(contest_id, entrant_id, problem_id, created_at);

CREATE TRIGGER prompt_attempt_identity_immutable
BEFORE UPDATE OF
  contest_id, entrant_id, problem_id, timeline_generation, rules_epoch,
  problem_epoch, content_epoch, judge_epoch, compiler_config_id, compiler_config_sha256,
  public_context_sha256, output_language, output_target, output_optimization,
  output_entry_path, admitted_logical_seconds, created_at
ON prompt_attempts
BEGIN
  SELECT RAISE(ABORT, 'prompt attempt identity is immutable');
END;

-- This link is added after prompt_attempts exists so every durable official
-- product can be reconciled to exactly one model invocation even when the
-- host call returns an uncertain transport/platform error.
ALTER TABLE contest_submission_records
ADD COLUMN prompt_attempt_id TEXT REFERENCES prompt_attempts(id) ON DELETE RESTRICT;

CREATE UNIQUE INDEX contest_submission_records_prompt_attempt
ON contest_submission_records(prompt_attempt_id)
WHERE prompt_attempt_id IS NOT NULL;

CREATE TRIGGER contest_submission_prompt_attempt_identity_guard
BEFORE INSERT ON contest_submission_records
WHEN NEW.prompt_attempt_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM prompt_attempts AS attempts
  JOIN submissions ON submissions.id=NEW.submission_id
  WHERE attempts.id=NEW.prompt_attempt_id
    AND attempts.contest_id=NEW.contest_id
    AND attempts.entrant_id=NEW.entrant_id
    AND attempts.problem_id=submissions.problem_id
    AND attempts.timeline_generation=NEW.timeline_generation
    AND attempts.rules_epoch=NEW.rules_epoch
    AND attempts.content_epoch=NEW.content_epoch
    AND attempts.judge_epoch=NEW.judge_epoch
)
BEGIN
  SELECT RAISE(ABORT, 'contest submission prompt attempt identity mismatch');
END;

CREATE TRIGGER contest_submission_prompt_attempt_immutable
BEFORE UPDATE OF prompt_attempt_id ON contest_submission_records
WHEN NEW.prompt_attempt_id IS NOT OLD.prompt_attempt_id
BEGIN
  SELECT RAISE(ABORT, 'contest submission prompt attempt identity is immutable');
END;

CREATE TRIGGER prompt_attempt_source_once
BEFORE UPDATE OF generated_source_id, generated_source_sha256 ON prompt_attempts
WHEN OLD.generated_source_id IS NOT NULL
  AND (NEW.generated_source_id IS NOT OLD.generated_source_id
    OR NEW.generated_source_sha256 IS NOT OLD.generated_source_sha256)
  AND NOT (NEW.erased_at IS NOT NULL AND NEW.generated_source_id IS OLD.generated_source_id
    AND NEW.generated_source_sha256 IS NULL)
BEGIN
  SELECT RAISE(ABORT, 'prompt generated source is immutable');
END;

CREATE TRIGGER prompt_attempt_erasure_guard
BEFORE UPDATE OF prompt_text, prompt_bytes, prompt_sha256, erased_at ON prompt_attempts
WHEN NOT (
  OLD.erased_at IS NULL AND NEW.erased_at IS NOT NULL
  AND NEW.prompt_text IS NULL AND NEW.prompt_bytes IS NULL AND NEW.prompt_sha256 IS NULL
)
BEGIN
  SELECT RAISE(ABORT, 'prompt contents may change only during one-way erasure');
END;

CREATE TRIGGER prompt_attempt_submission_once
BEFORE UPDATE OF submission_id ON prompt_attempts
WHEN OLD.submission_id IS NOT NULL AND NEW.submission_id IS NOT OLD.submission_id
BEGIN
  SELECT RAISE(ABORT, 'prompt attempt submission link is immutable');
END;

CREATE TRIGGER prompt_attempt_eligibility_one_way
BEFORE UPDATE OF eligibility ON prompt_attempts
WHEN OLD.eligibility='invalid' AND NEW.eligibility<>'invalid'
BEGIN
  SELECT RAISE(ABORT, 'invalid prompt attempt history cannot become eligible');
END;

CREATE TABLE prompt_attempt_idempotency (
  owner_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  idempotency_key TEXT NOT NULL CHECK (
    length(idempotency_key) BETWEEN 16 AND 128
    AND idempotency_key NOT GLOB '*[^A-Za-z0-9._:-]*'
  ),
  request_sha256 TEXT NOT NULL CHECK (
    length(request_sha256)=64 AND request_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  prompt_attempt_id TEXT NOT NULL UNIQUE REFERENCES prompt_attempts(id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (owner_user_id, idempotency_key)
) STRICT;

CREATE TRIGGER prompt_attempt_idempotency_immutable
BEFORE UPDATE ON prompt_attempt_idempotency
BEGIN
  SELECT RAISE(ABORT, 'prompt attempt idempotency identity is immutable');
END;

CREATE TABLE prompt_attempt_dispatches (
  prompt_attempt_id TEXT PRIMARY KEY REFERENCES prompt_attempts(id) ON DELETE RESTRICT,
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'delivered', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  settled_at TEXT,
  CHECK (
    (state='pending' AND settled_at IS NULL)
    OR (state<>'pending' AND settled_at IS NOT NULL)
  )
) STRICT;

CREATE INDEX prompt_attempt_dispatches_pending
ON prompt_attempt_dispatches(created_at, prompt_attempt_id)
WHERE state='pending';

CREATE TRIGGER prompt_attempt_dispatch_identity_immutable
BEFORE UPDATE OF prompt_attempt_id, created_at ON prompt_attempt_dispatches
BEGIN
  SELECT RAISE(ABORT, 'prompt attempt dispatch identity is immutable');
END;

CREATE TABLE prompt_attempt_quota (
  prompt_attempt_id TEXT PRIMARY KEY REFERENCES prompt_attempts(id) ON DELETE RESTRICT,
  contest_id TEXT NOT NULL,
  entrant_id TEXT NOT NULL,
  problem_id TEXT NOT NULL,
  timeline_generation INTEGER NOT NULL CHECK (timeline_generation >= 1),
  quota_slot INTEGER NOT NULL CHECK (quota_slot >= 1),
  configured_limit INTEGER NOT NULL CHECK (configured_limit >= quota_slot),
  state TEXT NOT NULL CHECK (state IN ('reserved', 'consumed', 'released', 'invalid')),
  reserved_at TEXT NOT NULL,
  settled_at TEXT,
  settlement_reason TEXT,
  FOREIGN KEY (entrant_id, contest_id)
    REFERENCES contest_entrants(id, contest_id) ON DELETE RESTRICT,
  FOREIGN KEY (problem_id) REFERENCES problem_series(id) ON DELETE RESTRICT,
  CHECK (
    (state='reserved' AND settled_at IS NULL AND settlement_reason IS NULL)
    OR (state<>'reserved' AND settled_at IS NOT NULL AND settlement_reason IS NOT NULL)
  )
) STRICT;

CREATE UNIQUE INDEX prompt_attempt_quota_live_slot
ON prompt_attempt_quota(contest_id, entrant_id, problem_id, timeline_generation, quota_slot)
WHERE state IN ('reserved', 'consumed');

CREATE TRIGGER prompt_attempt_quota_identity_guard
BEFORE INSERT ON prompt_attempt_quota
WHEN NOT EXISTS (
  SELECT 1 FROM prompt_attempts
  WHERE id=NEW.prompt_attempt_id
    AND contest_id=NEW.contest_id
    AND entrant_id=NEW.entrant_id
    AND problem_id=NEW.problem_id
    AND timeline_generation=NEW.timeline_generation
)
BEGIN
  SELECT RAISE(ABORT, 'prompt quota reservation does not match its attempt');
END;

CREATE TRIGGER prompt_attempt_quota_identity_immutable
BEFORE UPDATE OF
  prompt_attempt_id, contest_id, entrant_id, problem_id, timeline_generation,
  quota_slot, configured_limit, reserved_at
ON prompt_attempt_quota
BEGIN
  SELECT RAISE(ABORT, 'prompt quota reservation identity is immutable');
END;

CREATE TRIGGER prompt_attempt_quota_transition_guard
BEFORE UPDATE OF state ON prompt_attempt_quota
WHEN NOT (
  OLD.state=NEW.state
  OR (OLD.state='reserved' AND NEW.state IN ('consumed', 'released', 'invalid'))
  OR (OLD.state='consumed' AND NEW.state='invalid')
  OR (OLD.state='consumed' AND NEW.state='released'
    AND NEW.settlement_reason='prompt-submission-host-failure')
)
BEGIN
  SELECT RAISE(ABORT, 'prompt quota transition is invalid');
END;

CREATE TABLE prompt_attempt_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  prompt_attempt_id TEXT NOT NULL REFERENCES prompt_attempts(id) ON DELETE RESTRICT,
  event_key TEXT NOT NULL CHECK (length(event_key) BETWEEN 1 AND 200),
  event_type TEXT NOT NULL CHECK (
    event_type IN ('reserved', 'generation-started', 'response-received', 'source-ready',
      'submission-created', 'failed', 'cancelled', 'quota-released', 'invalidated',
      'reconciled', 'erased')
  ),
  payload_json TEXT NOT NULL CHECK (
    json_valid(payload_json) AND length(CAST(payload_json AS BLOB)) <= 65536
  ),
  created_at TEXT NOT NULL,
  UNIQUE (prompt_attempt_id, event_key)
) STRICT;

CREATE INDEX prompt_attempt_events_replay
ON prompt_attempt_events(prompt_attempt_id, id);

CREATE TRIGGER prompt_attempt_event_update_forbidden
BEFORE UPDATE ON prompt_attempt_events
BEGIN
  SELECT RAISE(ABORT, 'prompt attempt events are append-only');
END;

CREATE TRIGGER prompt_attempt_event_delete_forbidden
BEFORE DELETE ON prompt_attempt_events
BEGIN
  SELECT RAISE(ABORT, 'prompt attempt events are append-only');
END;

CREATE TRIGGER prompt_attempt_generated_source_insert_guard
BEFORE INSERT ON prompt_attempts
WHEN NEW.generated_source_id IS NOT NULL AND NEW.generated_source_sha256 IS NOT NULL AND NOT EXISTS (
  SELECT 1
  FROM submission_sources
  JOIN contest_entrants AS entrants
    ON entrants.id=NEW.entrant_id AND entrants.contest_id=NEW.contest_id
  WHERE submission_sources.id=NEW.generated_source_id
    AND submission_sources.source_kind='prompt-generated'
    AND submission_sources.state='ready'
    AND submission_sources.content_sha256=NEW.generated_source_sha256
    AND submission_sources.owner_user_id=entrants.owner_user_id
)
BEGIN
  SELECT RAISE(ABORT, 'prompt attempt requires a ready owned prompt-generated source');
END;

CREATE TRIGGER prompt_attempt_generated_source_update_guard
BEFORE UPDATE OF generated_source_id, generated_source_sha256 ON prompt_attempts
WHEN NEW.generated_source_id IS NOT NULL AND NEW.generated_source_sha256 IS NOT NULL AND NOT EXISTS (
  SELECT 1
  FROM submission_sources
  JOIN contest_entrants AS entrants
    ON entrants.id=NEW.entrant_id AND entrants.contest_id=NEW.contest_id
  WHERE submission_sources.id=NEW.generated_source_id
    AND submission_sources.source_kind='prompt-generated'
    AND submission_sources.state='ready'
    AND submission_sources.content_sha256=NEW.generated_source_sha256
    AND submission_sources.owner_user_id=entrants.owner_user_id
)
BEGIN
  SELECT RAISE(ABORT, 'prompt attempt requires a ready owned prompt-generated source');
END;

-- A live judge rollout must also snapshot Prompt Program work which has been
-- admitted but has not produced an origin submission yet.  Membership is
-- bounded at catalog-sync time; an included attempt may only be promoted to
-- the ordinary origin snapshot or excluded by a terminal attempt outcome.
CREATE TABLE contest_judge_rollout_prompt_attempts (
  rejudge_batch_id TEXT NOT NULL REFERENCES rejudge_batches(id) ON DELETE RESTRICT,
  prompt_attempt_id TEXT NOT NULL REFERENCES prompt_attempts(id) ON DELETE RESTRICT,
  target_judge_epoch INTEGER NOT NULL CHECK (target_judge_epoch >= 1),
  state TEXT NOT NULL DEFAULT 'included'
    CHECK (state IN ('included', 'promoted', 'excluded')),
  origin_submission_id TEXT REFERENCES submissions(id) ON DELETE RESTRICT,
  resolution_reason TEXT,
  snapshotted_at TEXT NOT NULL,
  resolved_at TEXT,
  PRIMARY KEY (rejudge_batch_id, prompt_attempt_id),
  UNIQUE (rejudge_batch_id, origin_submission_id),
  CHECK (
    (state='included' AND origin_submission_id IS NULL
      AND resolution_reason IS NULL AND resolved_at IS NULL)
    OR (state='promoted' AND origin_submission_id IS NOT NULL
      AND resolution_reason='official-submission-created' AND resolved_at IS NOT NULL)
    OR (state='excluded' AND origin_submission_id IS NULL
      AND resolution_reason IS NOT NULL AND resolved_at IS NOT NULL)
  )
) STRICT;

CREATE INDEX contest_judge_rollout_prompt_attempts_pending
ON contest_judge_rollout_prompt_attempts(rejudge_batch_id, state, prompt_attempt_id);

CREATE TRIGGER contest_judge_rollout_prompt_attempt_snapshot_guard
BEFORE INSERT ON contest_judge_rollout_prompt_attempts
WHEN NOT EXISTS (
  SELECT 1 FROM rejudge_batches AS batch
  JOIN prompt_attempts AS attempts ON attempts.id=NEW.prompt_attempt_id
  JOIN prompt_attempt_quota AS quota ON quota.prompt_attempt_id=attempts.id
  WHERE batch.id=NEW.rejudge_batch_id
    AND batch.purpose='contest-judge-rollout'
    AND batch.state='queued' AND batch.expected_count=0
    AND batch.created_at=NEW.snapshotted_at
    AND attempts.contest_id=batch.contest_id
    AND attempts.problem_id=batch.problem_id
    AND attempts.timeline_generation=batch.snapshot_timeline_generation
    AND attempts.judge_epoch<NEW.target_judge_epoch
    AND attempts.state IN ('reserved','generating','source-ready')
    AND attempts.eligibility='eligible' AND attempts.erased_at IS NULL
    AND attempts.submission_id IS NULL
    AND quota.state IN ('reserved','consumed')
)
BEGIN
  SELECT RAISE(ABORT, 'contest judge rollout Prompt membership snapshot is sealed');
END;

CREATE TRIGGER contest_judge_rollout_prompt_attempt_identity_immutable
BEFORE UPDATE OF rejudge_batch_id, prompt_attempt_id, target_judge_epoch, snapshotted_at
ON contest_judge_rollout_prompt_attempts
BEGIN
  SELECT RAISE(ABORT, 'contest judge rollout Prompt attempt identity is immutable');
END;

CREATE TRIGGER contest_judge_rollout_prompt_attempt_resolution_once
BEFORE UPDATE OF state, origin_submission_id, resolution_reason, resolved_at
ON contest_judge_rollout_prompt_attempts
WHEN OLD.state<>'included'
  AND (NEW.state IS NOT OLD.state
    OR NEW.origin_submission_id IS NOT OLD.origin_submission_id
    OR NEW.resolution_reason IS NOT OLD.resolution_reason
    OR NEW.resolved_at IS NOT OLD.resolved_at)
BEGIN
  SELECT RAISE(ABORT, 'contest judge rollout Prompt attempt resolution is immutable');
END;

-- SHA-256 is deliberately absent from the SQL phase. The deployment tool reads
-- bounded legacy facts, canonicalizes the v2 rules in application code, hashes
-- them, and writes idempotent projections. These rows make that phase durable
-- and resumable without inventing a random digest or a runtime fallback.
CREATE TABLE contest_v2_cutover_state (
  singleton INTEGER PRIMARY KEY CHECK (singleton=1),
  state TEXT NOT NULL CHECK (state IN ('pending', 'applying', 'completed', 'failed')),
  application_version INTEGER NOT NULL CHECK (application_version=1),
  legacy_contest_count INTEGER NOT NULL CHECK (legacy_contest_count >= 0),
  legacy_revision_count INTEGER NOT NULL CHECK (legacy_revision_count >= 0),
  completed_contest_count INTEGER NOT NULL DEFAULT 0
    CHECK (completed_contest_count >= 0 AND completed_contest_count <= legacy_contest_count),
  started_at TEXT,
  completed_at TEXT,
  failure_code TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (
    (state='pending' AND started_at IS NULL AND completed_at IS NULL AND failure_code IS NULL)
    OR (state='applying' AND started_at IS NOT NULL AND completed_at IS NULL AND failure_code IS NULL)
    OR (state='completed' AND started_at IS NOT NULL AND completed_at IS NOT NULL
      AND failure_code IS NULL AND completed_contest_count=legacy_contest_count)
    OR (state='failed' AND started_at IS NOT NULL AND completed_at IS NULL AND failure_code IS NOT NULL)
  )
) STRICT;

INSERT INTO contest_v2_cutover_state (
  singleton, state, application_version, legacy_contest_count,
  legacy_revision_count, completed_contest_count,
  started_at, completed_at, failure_code, created_at, updated_at
)
VALUES (
  1, 'pending', 1,
  (SELECT COUNT(*) FROM contest_series),
  (SELECT COUNT(*) FROM contest_revisions),
  0, NULL, NULL, NULL,
  strftime('%Y-%m-%dT%H:%M:%fZ','now'),
  strftime('%Y-%m-%dT%H:%M:%fZ','now')
);

-- Empty installations have nothing for the application cutover phase to
-- translate. Keep the seed INSERT bounded for D1, then atomically establish
-- the completed-state invariant before installing the transition guard.
UPDATE contest_v2_cutover_state
SET state='completed', started_at=created_at, completed_at=created_at
WHERE singleton=1 AND legacy_contest_count=0;

CREATE TRIGGER contest_v2_cutover_state_transition_guard
BEFORE UPDATE OF state ON contest_v2_cutover_state
WHEN NOT (
  (OLD.state='pending' AND NEW.state IN ('applying','failed'))
  OR (OLD.state='applying' AND NEW.state IN ('applying','completed','failed'))
  OR (OLD.state='failed' AND NEW.state='applying')
  OR (OLD.state='completed' AND NEW.state='completed')
)
BEGIN
  SELECT RAISE(ABORT, 'invalid contest v2 cutover state transition');
END;

CREATE TRIGGER contest_v2_cutover_state_identity_immutable
BEFORE UPDATE OF singleton, application_version, legacy_contest_count,
  legacy_revision_count, created_at
ON contest_v2_cutover_state
BEGIN
  SELECT RAISE(ABORT, 'contest v2 cutover source identity is immutable');
END;

CREATE TABLE contest_v2_cutover_items (
  contest_id TEXT PRIMARY KEY REFERENCES contest_series(id) ON DELETE RESTRICT,
  state TEXT NOT NULL CHECK (state IN ('pending', 'completed')),
  source_revision_count INTEGER NOT NULL CHECK (source_revision_count >= 0),
  source_participant_count INTEGER NOT NULL CHECK (source_participant_count >= 0),
  source_submission_count INTEGER NOT NULL CHECK (source_submission_count >= 0),
  translated_revision_count INTEGER,
  translated_entrant_count INTEGER,
  translated_submission_count INTEGER,
  completed_at TEXT,
  CHECK (
    (state='pending' AND translated_revision_count IS NULL
      AND translated_entrant_count IS NULL AND translated_submission_count IS NULL
      AND completed_at IS NULL)
    OR (state='completed' AND translated_revision_count=source_revision_count
      AND translated_entrant_count >= source_participant_count
      AND translated_submission_count=source_submission_count
      AND completed_at IS NOT NULL)
  )
) STRICT;

INSERT INTO contest_v2_cutover_items (
  contest_id, state, source_revision_count, source_participant_count,
  source_submission_count, translated_revision_count,
  translated_entrant_count, translated_submission_count, completed_at
)
SELECT series.id, 'pending',
  (SELECT COUNT(*) FROM contest_revisions WHERE contest_id=series.id),
  (SELECT COUNT(*) FROM contest_participants WHERE contest_id=series.id),
  (SELECT COUNT(*) FROM submissions
    WHERE contest_id=series.id AND origin_submission_id=id),
  NULL, NULL, NULL, NULL
FROM contest_series AS series;

CREATE TRIGGER contest_v2_cutover_item_transition_guard
BEFORE UPDATE OF state ON contest_v2_cutover_items
WHEN NOT (OLD.state='pending' AND NEW.state='completed')
BEGIN
  SELECT RAISE(ABORT, 'invalid contest v2 cutover item transition');
END;

CREATE TRIGGER contest_v2_cutover_item_source_immutable
BEFORE UPDATE OF contest_id, source_revision_count, source_participant_count,
  source_submission_count
ON contest_v2_cutover_items
BEGIN
  SELECT RAISE(ABORT, 'contest v2 cutover item source facts are immutable');
END;

CREATE TRIGGER contest_v2_cutover_item_delete_forbidden
BEFORE DELETE ON contest_v2_cutover_items
BEGIN
  SELECT RAISE(ABORT, 'contest v2 cutover items are immutable');
END;

CREATE TABLE catalog_contest_v2_resync_requirements (
  catalog_id TEXT PRIMARY KEY REFERENCES catalogs(id) ON DELETE RESTRICT,
  legacy_active_commit TEXT NOT NULL
    CHECK (length(legacy_active_commit)=40 AND legacy_active_commit NOT GLOB '*[^0-9a-f]*'),
  state TEXT NOT NULL CHECK (state IN ('pending', 'ready')),
  resynced_commit TEXT CHECK (
    resynced_commit IS NULL
    OR (length(resynced_commit)=40 AND resynced_commit NOT GLOB '*[^0-9a-f]*')
  ),
  required_at TEXT NOT NULL,
  resynced_at TEXT,
  CHECK (
    (state='pending' AND resynced_commit IS NULL AND resynced_at IS NULL)
    OR (state='ready' AND resynced_commit IS NOT NULL AND resynced_at IS NOT NULL)
  )
) STRICT;

INSERT INTO catalog_contest_v2_resync_requirements (
  catalog_id, legacy_active_commit, state, resynced_commit, required_at, resynced_at
)
SELECT id, active_commit_sha, 'pending', NULL,
  strftime('%Y-%m-%dT%H:%M:%fZ','now'), NULL
FROM catalogs WHERE active_commit_sha IS NOT NULL;

CREATE TRIGGER catalog_contest_v2_resync_transition_guard
BEFORE UPDATE OF state ON catalog_contest_v2_resync_requirements
WHEN NOT (OLD.state='pending' AND NEW.state='ready')
BEGIN
  SELECT RAISE(ABORT, 'catalog contests/v2 resync is one-way');
END;

CREATE TRIGGER catalog_contest_v2_resync_source_immutable
BEFORE UPDATE OF catalog_id, legacy_active_commit, required_at
ON catalog_contest_v2_resync_requirements
BEGIN
  SELECT RAISE(ABORT, 'catalog contests/v2 resync source is immutable');
END;

CREATE TRIGGER catalog_contest_v2_resync_delete_forbidden
BEFORE DELETE ON catalog_contest_v2_resync_requirements
BEGIN
  SELECT RAISE(ABORT, 'catalog contests/v2 resync history is immutable');
END;

-- Both global auto-start and irreversible individual Start are fenced in D1,
-- so an API read/check race cannot start a contest from an un-resynced catalog.
CREATE TRIGGER contest_runtime_start_requires_v2_catalog
BEFORE UPDATE OF state ON contest_runtimes
WHEN NEW.state='running' AND OLD.state<>'running'
  AND (
    EXISTS (SELECT 1 FROM contest_v2_cutover_state WHERE state<>'completed')
    OR EXISTS (
      SELECT 1 FROM contest_series AS series
      JOIN catalog_contest_v2_resync_requirements AS requirement
        ON requirement.catalog_id=series.catalog_id AND requirement.state<>'ready'
      WHERE series.id=NEW.contest_id
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'active catalog requires contests/v2 resync before contest start');
END;

CREATE TRIGGER contest_entrant_start_requires_v2_catalog
BEFORE UPDATE OF started_at ON contest_entrants
WHEN OLD.started_at IS NULL AND NEW.started_at IS NOT NULL
  AND (
    EXISTS (SELECT 1 FROM contest_v2_cutover_state WHERE state<>'completed')
    OR EXISTS (
      SELECT 1 FROM contest_series AS series
      JOIN catalog_contest_v2_resync_requirements AS requirement
        ON requirement.catalog_id=series.catalog_id AND requirement.state<>'ready'
      WHERE series.id=NEW.contest_id
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'active catalog requires contests/v2 resync before entrant start');
END;

-- D1 limits one compound SELECT to five arms. Keep each current-time helper
-- within that bound, then expose their union through the stable public view.
CREATE VIEW contest_v2_cutover_execution_blockers AS
SELECT 'formal-mutations-enabled' AS blocker_kind, environment AS blocker_key
FROM formal_mutation_controls
WHERE environment='production' AND formal_mutations_enabled<>0
UNION ALL
SELECT 'legacy-contest-running', revisions.contest_id
FROM contest_revisions AS revisions
JOIN contest_series AS series ON series.id=revisions.contest_id
JOIN catalogs ON catalogs.id=series.catalog_id
  AND catalogs.active_commit_sha=revisions.commit_sha
WHERE revisions.status='published'
  AND julianday('now')>=julianday(revisions.starts_at)
  AND julianday('now')<julianday(revisions.ends_at)
UNION ALL
SELECT 'contest-runtime-not-drained', contest_id
FROM contest_runtimes WHERE state IN ('running','paused')
UNION ALL
SELECT 'contest-submission-nonterminal', id
FROM submissions
WHERE contest_id IS NOT NULL
  AND state IN ('admitting','queued','preparing','compiling','running','finalizing')
UNION ALL
SELECT 'contest-rejudge-nonterminal', id
FROM rejudge_batches
WHERE contest_id IS NOT NULL AND state IN ('queued','running','ready');

CREATE VIEW contest_v2_cutover_repository_blockers AS
SELECT 'catalog-sync-nonterminal' AS blocker_kind, id AS blocker_key
FROM catalog_sync_jobs WHERE state IN ('queued','running')
UNION ALL
SELECT 'contest-workflow-outbox-pending', outbox.id
FROM workflow_outbox AS outbox
LEFT JOIN submissions ON submissions.id=outbox.submission_id
WHERE outbox.state='pending'
  AND (outbox.catalog_sync_job_id IS NOT NULL OR submissions.contest_id IS NOT NULL)
UNION ALL
SELECT 'legacy-active-revision-missing', series.id
FROM contest_series AS series
JOIN catalogs ON catalogs.id=series.catalog_id
LEFT JOIN contest_revisions AS revisions
  ON revisions.contest_id=series.id AND revisions.commit_sha=catalogs.active_commit_sha
WHERE revisions.contest_id IS NULL
UNION ALL
SELECT 'legacy-submission-revision-missing', submissions.id
FROM submissions
WHERE submissions.contest_id IS NOT NULL
  AND submissions.origin_submission_id=submissions.id
  AND NOT EXISTS (
    SELECT 1 FROM contest_revision_problems AS selected
    WHERE selected.contest_id=submissions.contest_id
      AND selected.commit_sha=submissions.catalog_commit
      AND selected.problem_id=submissions.problem_id
  );

-- Blockers which must be empty before the application translation begins.
CREATE VIEW contest_v2_cutover_input_blockers AS
SELECT blocker_kind, blocker_key FROM contest_v2_cutover_execution_blockers
UNION ALL
SELECT blocker_kind, blocker_key FROM contest_v2_cutover_repository_blockers;

-- Activation additionally waits for the deterministic application phase and
-- for every formerly-active catalog to be parsed and synchronized as strict v2.
CREATE VIEW contest_v2_preflight_blockers AS
SELECT blocker_kind, blocker_key FROM contest_v2_cutover_input_blockers
UNION ALL
SELECT 'contest-v2-cutover-not-complete', CAST(singleton AS TEXT)
FROM contest_v2_cutover_state WHERE state<>'completed'
UNION ALL
SELECT 'catalog-contests-v2-resync-required', catalog_id
FROM catalog_contest_v2_resync_requirements WHERE state<>'ready';

PRAGMA foreign_key_check;
