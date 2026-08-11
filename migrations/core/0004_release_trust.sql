CREATE UNIQUE INDEX forge_releases_one_active ON forge_releases(status) WHERE status = 'active';

CREATE TABLE forge_active_releases (
  environment TEXT PRIMARY KEY CHECK (environment IN ('development', 'staging', 'production')),
  forge_release_id TEXT NOT NULL UNIQUE REFERENCES forge_releases(id),
  activated_by TEXT NOT NULL,
  activated_at TEXT NOT NULL
) STRICT;

ALTER TABLE collection_imports ADD COLUMN canonical_source_r2_key TEXT;
ALTER TABLE collection_imports ADD COLUMN canonical_source_mirror_r2_key TEXT;
ALTER TABLE collection_imports ADD COLUMN canonical_source_sha256 TEXT CHECK (canonical_source_sha256 IS NULL OR length(canonical_source_sha256) = 64);
ALTER TABLE collection_imports ADD COLUMN archive_disposition TEXT NOT NULL DEFAULT 'pending' CHECK (archive_disposition IN ('pending', 'deleted', 'quarantined'));
ALTER TABLE collection_imports ADD COLUMN archive_delete_after TEXT;
ALTER TABLE collection_imports ADD COLUMN canonical_draft_delete_after TEXT;

CREATE TABLE account_erasure_jobs (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL UNIQUE,
  anonymous_user_id TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK (status IN ('queued', 'revoking', 'deleting-sources', 'anonymizing', 'completed', 'failed')),
  requested_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT,
  deletion_receipt_r2_key TEXT,
  deletion_receipt_sha256 TEXT CHECK (deletion_receipt_sha256 IS NULL OR length(deletion_receipt_sha256) = 64),
  last_error TEXT
) STRICT;

CREATE TABLE erased_user_tombstones (
  anonymous_user_id TEXT PRIMARY KEY,
  original_user_sha256 TEXT NOT NULL UNIQUE CHECK (length(original_user_sha256) = 64),
  erased_at TEXT NOT NULL,
  deletion_receipt_r2_key TEXT NOT NULL,
  deletion_receipt_sha256 TEXT NOT NULL CHECK (length(deletion_receipt_sha256) = 64)
) STRICT;
