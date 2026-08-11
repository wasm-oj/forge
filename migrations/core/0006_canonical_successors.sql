ALTER TABLE collection_imports ADD COLUMN source_kind TEXT NOT NULL DEFAULT 'github-archive'
  CHECK (source_kind IN ('github-archive', 'canonical-successor'));
ALTER TABLE collection_imports ADD COLUMN predecessor_import_id TEXT REFERENCES collection_imports(id);
ALTER TABLE collection_imports ADD COLUMN canonical_expired_at TEXT;

CREATE UNIQUE INDEX collection_imports_one_github_import
ON collection_imports(github_repository_id, commit_sha, index_path, forge_release_id)
WHERE source_kind = 'github-archive';

CREATE UNIQUE INDEX collection_imports_one_release_successor
ON collection_imports(predecessor_import_id, forge_release_id)
WHERE predecessor_import_id IS NOT NULL;

CREATE INDEX collection_imports_canonical_expiry
ON collection_imports(canonical_draft_delete_after, status)
WHERE canonical_draft_delete_after IS NOT NULL;

CREATE INDEX collection_imports_successor_lookup
ON collection_imports(forge_release_id, predecessor_import_id, status)
WHERE source_kind = 'canonical-successor';

CREATE TABLE collection_import_objects (
  import_id TEXT NOT NULL REFERENCES collection_imports(id) ON DELETE CASCADE,
  object_key TEXT NOT NULL,
  object_sha256 TEXT NOT NULL CHECK (length(object_sha256) = 64),
  object_bytes INTEGER NOT NULL CHECK (object_bytes > 0 AND object_bytes <= 33554432),
  claimed_at TEXT NOT NULL,
  PRIMARY KEY (import_id, object_key),
  CHECK (object_key = 'snapshots/objects/' || object_sha256)
) STRICT;

CREATE INDEX collection_import_objects_key
ON collection_import_objects(object_key, import_id);

CREATE TABLE canonical_object_gc (
  object_key TEXT PRIMARY KEY,
  object_sha256 TEXT NOT NULL CHECK (length(object_sha256) = 64),
  object_bytes INTEGER NOT NULL CHECK (object_bytes > 0 AND object_bytes <= 33554432),
  not_before TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'deleting')),
  delete_token TEXT,
  lease_expires_at TEXT,
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  last_error TEXT,
  created_at TEXT NOT NULL,
  CHECK (object_key = 'snapshots/objects/' || object_sha256),
  CHECK ((state = 'pending' AND delete_token IS NULL AND lease_expires_at IS NULL) OR (state = 'deleting' AND delete_token IS NOT NULL AND lease_expires_at IS NOT NULL))
) STRICT;

CREATE INDEX canonical_object_gc_ready
ON canonical_object_gc(state, not_before, lease_expires_at);

CREATE UNIQUE INDEX core_outbox_one_archive_cleanup
ON core_outbox(kind, aggregate_id)
WHERE kind = 'cleanup-import-archive' AND delivered_at IS NULL;
