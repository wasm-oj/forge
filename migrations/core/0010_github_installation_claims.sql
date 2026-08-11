ALTER TABLE github_installation_states ADD COLUMN installation_id INTEGER;
ALTER TABLE github_installation_states ADD COLUMN bound_at TEXT;
ALTER TABLE github_installation_states ADD COLUMN consumed_at TEXT;

CREATE INDEX github_installation_states_user_expiry
  ON github_installation_states(user_id, expires_at);

CREATE TRIGGER github_installation_state_exact_binding
BEFORE UPDATE OF installation_id ON github_installation_states
WHEN OLD.installation_id IS NOT NULL AND NEW.installation_id IS NOT OLD.installation_id
BEGIN
  SELECT RAISE(ABORT, 'github installation state cannot be rebound');
END;

CREATE TRIGGER github_installation_owner_immutable
BEFORE UPDATE OF installed_by_user_id ON github_installations
WHEN NEW.installed_by_user_id IS NOT OLD.installed_by_user_id
  AND NOT (OLD.installed_by_user_id IS NOT NULL AND NEW.installed_by_user_id IS NULL)
BEGIN
  SELECT RAISE(ABORT, 'github installation owner cannot be transferred or reclaimed');
END;

CREATE TABLE github_installation_claim_proofs (
  installation_id INTEGER PRIMARY KEY CHECK (installation_id > 0),
  installer_github_user_id INTEGER NOT NULL CHECK (installer_github_user_id > 0),
  account_github_id INTEGER NOT NULL CHECK (account_github_id > 0),
  delivery_id TEXT NOT NULL UNIQUE REFERENCES github_webhook_deliveries(delivery_id) ON DELETE RESTRICT,
  received_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  state_hash TEXT,
  claimed_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  claimed_at TEXT,
  activated_at TEXT,
  CHECK (expires_at > received_at),
  CHECK (
    (state_hash IS NULL AND claimed_by_user_id IS NULL AND claimed_at IS NULL AND activated_at IS NULL)
    OR
    (state_hash IS NOT NULL AND claimed_at IS NOT NULL AND (activated_at IS NULL OR activated_at >= claimed_at))
  )
) STRICT;

CREATE INDEX github_installation_claim_proofs_installer_expiry
  ON github_installation_claim_proofs(installer_github_user_id, expires_at);

CREATE TRIGGER github_installation_proof_identity_immutable
BEFORE UPDATE OF installer_github_user_id, account_github_id, delivery_id ON github_installation_claim_proofs
WHEN NEW.installer_github_user_id IS NOT OLD.installer_github_user_id
  OR NEW.account_github_id IS NOT OLD.account_github_id
  OR NEW.delivery_id IS NOT OLD.delivery_id
BEGIN
  SELECT RAISE(ABORT, 'github installation ownership proof is immutable');
END;
