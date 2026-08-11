CREATE TABLE submission_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  submission_id TEXT NOT NULL REFERENCES submissions(id) ON DELETE CASCADE,
  event_key TEXT NOT NULL,
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
  created_at TEXT NOT NULL,
  UNIQUE (submission_id, event_key),
  CHECK (length(event_key) BETWEEN 1 AND 200)
) STRICT;

CREATE INDEX submission_events_replay
ON submission_events(submission_id, id);

CREATE INDEX submissions_global_capacity
ON submissions(state)
WHERE state IN ('admitting', 'queued', 'waiting-capacity', 'preparing', 'compiling', 'running', 'finalizing');

CREATE INDEX submissions_user_queue_capacity
ON submissions(user_id, state)
WHERE state IN ('admitting', 'queued', 'waiting-capacity');

CREATE UNIQUE INDEX submissions_one_executing_per_user
ON submissions(user_id)
WHERE state IN ('preparing', 'compiling', 'running', 'finalizing');

CREATE TABLE formal_risk_allowances (
  user_id TEXT NOT NULL,
  request_key TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (user_id, request_key),
  CHECK (length(user_id) BETWEEN 1 AND 128),
  CHECK (length(request_key) = 64 AND request_key NOT GLOB '*[^0-9a-f]*')
) STRICT;

CREATE INDEX formal_risk_allowances_expiry
ON formal_risk_allowances(expires_at);

DROP INDEX submission_terminal_event_unique;
DROP INDEX submission_projection_outbox_unique;
ALTER TABLE submission_outbox RENAME TO submission_outbox_obsolete;

CREATE TABLE submission_outbox (
  id TEXT PRIMARY KEY,
  submission_id TEXT NOT NULL REFERENCES submissions(id),
  kind TEXT NOT NULL CHECK (kind IN ('start-workflow', 'update-profile')),
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  delivered_at TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT
) STRICT;

INSERT INTO submission_outbox
  (id, submission_id, kind, payload_json, created_at, delivered_at, attempts, last_error)
SELECT id, submission_id, kind, payload_json, created_at, delivered_at, attempts, last_error
  FROM submission_outbox_obsolete
 WHERE kind IN ('start-workflow', 'update-profile');

DROP TABLE submission_outbox_obsolete;

CREATE INDEX submission_outbox_pending
ON submission_outbox(delivered_at, created_at);

CREATE UNIQUE INDEX submission_profile_outbox_unique
ON submission_outbox(submission_id, kind)
WHERE kind = 'update-profile';

DROP INDEX submissions_terminal_reservation_release;
ALTER TABLE submissions DROP COLUMN reservation_released_at;
ALTER TABLE rejudge_jobs DROP COLUMN reservation_released_at;
