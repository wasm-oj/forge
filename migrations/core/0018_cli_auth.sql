PRAGMA foreign_keys = ON;

-- Browser-approved, short-lived device authorization. The CLI keeps the
-- verifier; D1 stores only its S256 challenge. A flow can mint at most one
-- access token and cannot change identities after approval.
CREATE TABLE cli_login_flows (
  id TEXT PRIMARY KEY
    CHECK (length(id) = 36),
  code_challenge TEXT NOT NULL
    CHECK (length(code_challenge) = 43 AND code_challenge NOT GLOB '*[^A-Za-z0-9_-]*'),
  device_name TEXT NOT NULL
    CHECK (length(device_name) BETWEEN 1 AND 80),
  approved_user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  approved_at TEXT,
  exchange_nonce TEXT UNIQUE
    CHECK (exchange_nonce IS NULL OR (length(exchange_nonce) = 43 AND exchange_nonce NOT GLOB '*[^A-Za-z0-9_-]*')),
  exchanged_at TEXT,
  CHECK ((approved_user_id IS NULL) = (approved_at IS NULL)),
  CHECK ((exchange_nonce IS NULL) = (exchanged_at IS NULL)),
  CHECK (exchanged_at IS NULL OR approved_user_id IS NOT NULL)
) STRICT;
CREATE INDEX cli_login_flows_expires_at ON cli_login_flows(expires_at);

-- Raw bearer credentials never enter D1. A token is bound to the one flow
-- which created it so a raced or replayed exchange cannot mint a second one.
CREATE TABLE cli_access_tokens (
  token_hash TEXT PRIMARY KEY
    CHECK (length(token_hash) = 64 AND token_hash NOT GLOB '*[^0-9a-f]*'),
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  login_flow_id TEXT NOT NULL UNIQUE REFERENCES cli_login_flows(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL
) STRICT;
CREATE INDEX cli_access_tokens_user_id ON cli_access_tokens(user_id);
CREATE INDEX cli_access_tokens_expires_at ON cli_access_tokens(expires_at);
