PRAGMA foreign_keys = ON;

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'suspended'))
) STRICT;

CREATE TABLE github_identities (
  github_user_id INTEGER PRIMARY KEY,
  user_id TEXT NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  login TEXT NOT NULL,
  avatar_url TEXT NOT NULL,
  profile_url TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  csrf_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL
) STRICT;
CREATE INDEX sessions_user_id ON sessions(user_id);
CREATE INDEX sessions_expires_at ON sessions(expires_at);

CREATE TABLE oauth_states (
  state_hash TEXT PRIMARY KEY,
  verifier_hash TEXT NOT NULL,
  return_path TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
) STRICT;

CREATE TABLE github_installation_states (
  state_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
) STRICT;

CREATE TABLE profiles (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  display_name TEXT NOT NULL,
  bio TEXT NOT NULL DEFAULT '',
  website_url TEXT,
  visibility TEXT NOT NULL DEFAULT 'public' CHECK (visibility IN ('public', 'private')),
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE user_roles (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('admin', 'organizer')),
  granted_at TEXT NOT NULL,
  granted_by TEXT REFERENCES users(id),
  PRIMARY KEY (user_id, role)
) STRICT;

CREATE TABLE organizer_applications (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  statement TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'rejected')),
  reviewed_by TEXT REFERENCES users(id),
  reviewed_at TEXT,
  created_at TEXT NOT NULL
) STRICT;
CREATE INDEX organizer_applications_user_status ON organizer_applications(user_id, status);

CREATE TABLE github_installations (
  installation_id INTEGER PRIMARY KEY,
  account_github_id INTEGER NOT NULL,
  account_login TEXT NOT NULL,
  installed_by_user_id TEXT REFERENCES users(id),
  status TEXT NOT NULL CHECK (status IN ('active', 'suspended', 'removed')),
  permissions_json TEXT NOT NULL,
  repository_selection TEXT NOT NULL CHECK (repository_selection IN ('all', 'selected')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE github_repositories (
  github_repository_id INTEGER PRIMARY KEY,
  installation_id INTEGER NOT NULL REFERENCES github_installations(installation_id),
  owner_login TEXT NOT NULL,
  name TEXT NOT NULL,
  is_private INTEGER NOT NULL CHECK (is_private IN (0, 1)),
  authorization_status TEXT NOT NULL CHECK (authorization_status IN ('authorized', 'removed')),
  updated_at TEXT NOT NULL,
  UNIQUE (owner_login, name)
) STRICT;
CREATE INDEX github_repositories_installation ON github_repositories(installation_id, authorization_status);

CREATE TABLE github_webhook_deliveries (
  delivery_id TEXT PRIMARY KEY,
  event_name TEXT NOT NULL,
  body_sha256 TEXT NOT NULL CHECK (length(body_sha256) = 64),
  received_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 1 CHECK (attempts > 0),
  outcome TEXT NOT NULL CHECK (outcome IN ('processing', 'accepted', 'failed'))
) STRICT;

CREATE TABLE repository_push_notices (
  id TEXT PRIMARY KEY,
  github_repository_id INTEGER NOT NULL REFERENCES github_repositories(github_repository_id),
  commit_sha TEXT NOT NULL,
  ref TEXT NOT NULL,
  received_at TEXT NOT NULL,
  acknowledged_at TEXT
) STRICT;

CREATE TABLE forge_releases (
  id TEXT PRIMARY KEY,
  version TEXT NOT NULL UNIQUE,
  manifest_r2_key TEXT NOT NULL,
  manifest_mirror_r2_key TEXT NOT NULL,
  manifest_sha256 TEXT NOT NULL CHECK (length(manifest_sha256) = 64),
  source_git_commit TEXT NOT NULL CHECK (length(source_git_commit) = 40),
  status TEXT NOT NULL CHECK (status IN ('candidate', 'qualified', 'active', 'retired', 'revoked')),
  created_at TEXT NOT NULL,
  qualified_at TEXT,
  activated_at TEXT,
  retired_at TEXT,
  revoked_at TEXT
) STRICT;

CREATE TABLE collection_imports (
  id TEXT PRIMARY KEY,
  organizer_user_id TEXT NOT NULL REFERENCES users(id),
  github_repository_id INTEGER NOT NULL REFERENCES github_repositories(github_repository_id),
  requested_ref TEXT NOT NULL,
  commit_sha TEXT NOT NULL,
  index_path TEXT NOT NULL,
  forge_release_id TEXT NOT NULL REFERENCES forge_releases(id),
  archive_r2_key TEXT,
  validation_report_r2_key TEXT,
  status TEXT NOT NULL CHECK (status IN ('queued', 'downloading', 'validating', 'valid', 'invalid', 'infrastructure-error')),
  error_code TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE managed_snapshots (
  id TEXT PRIMARY KEY,
  import_id TEXT NOT NULL REFERENCES collection_imports(id),
  mode TEXT NOT NULL CHECK (mode IN ('official-practice', 'contest')),
  collection_revision TEXT NOT NULL,
  practice_projection_digest TEXT,
  contest_public_projection_digest TEXT,
  judge_projection_digest TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('draft', 'published', 'superseded')),
  published_at TEXT,
  published_by TEXT REFERENCES users(id),
  created_at TEXT NOT NULL,
  UNIQUE (import_id, mode)
) STRICT;

CREATE TABLE managed_problem_versions (
  id TEXT PRIMARY KEY,
  snapshot_id TEXT NOT NULL REFERENCES managed_snapshots(id),
  problem_slug TEXT NOT NULL,
  problem_number INTEGER NOT NULL,
  title_json TEXT NOT NULL,
  bundle_digest TEXT NOT NULL,
  public_projection_r2_key TEXT NOT NULL,
  judge_projection_r2_key TEXT NOT NULL,
  maximum_score REAL NOT NULL DEFAULT 100,
  created_at TEXT NOT NULL,
  UNIQUE (snapshot_id, problem_slug),
  UNIQUE (snapshot_id, problem_number)
) STRICT;
CREATE INDEX managed_problem_versions_digest ON managed_problem_versions(bundle_digest);

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
  status TEXT NOT NULL CHECK (status IN ('draft', 'published', 'running', 'ended', 'archived')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (ends_at > starts_at),
  CHECK (freeze_at IS NULL OR (freeze_at > starts_at AND freeze_at < ends_at))
) STRICT;

CREATE TABLE contest_problems (
  contest_id TEXT NOT NULL REFERENCES contests(id) ON DELETE CASCADE,
  managed_problem_version_id TEXT NOT NULL REFERENCES managed_problem_versions(id),
  ordinal INTEGER NOT NULL,
  PRIMARY KEY (contest_id, managed_problem_version_id),
  UNIQUE (contest_id, ordinal)
) STRICT;

CREATE TABLE contest_participants (
  contest_id TEXT NOT NULL REFERENCES contests(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id),
  joined_at TEXT NOT NULL,
  PRIMARY KEY (contest_id, user_id)
) STRICT;

CREATE TABLE verified_solves (
  user_id TEXT NOT NULL REFERENCES users(id),
  managed_problem_version_id TEXT NOT NULL REFERENCES managed_problem_versions(id),
  effective_submission_id TEXT NOT NULL,
  score REAL NOT NULL,
  solved_at TEXT NOT NULL,
  PRIMARY KEY (user_id, managed_problem_version_id)
) STRICT;

CREATE TABLE rejudge_batches (
  id TEXT PRIMARY KEY,
  old_problem_version_id TEXT NOT NULL REFERENCES managed_problem_versions(id),
  new_problem_version_id TEXT NOT NULL REFERENCES managed_problem_versions(id),
  requested_by TEXT NOT NULL REFERENCES users(id),
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'ready', 'effective', 'failed')),
  expected_count INTEGER NOT NULL,
  completed_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  effective_at TEXT
) STRICT;

CREATE TABLE core_outbox (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  aggregate_id TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  delivered_at TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT
) STRICT;
CREATE INDEX core_outbox_pending ON core_outbox(delivered_at, created_at);
