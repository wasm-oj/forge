import { ApiError } from "./http";

export const GITHUB_INSTALLATION_PROOF_SECONDS = 15 * 60;

const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/;

interface ClaimRow {
  readonly state_user_id: string;
  readonly state_expires_at: string;
  readonly state_installation_id: number | null;
  readonly state_consumed_at: string | null;
  readonly session_github_user_id: number;
  readonly proof_installation_id: number | null;
  readonly installer_github_user_id: number | null;
  readonly account_github_id: number | null;
  readonly proof_expires_at: string | null;
  readonly proof_state_hash: string | null;
  readonly proof_claimed_by_user_id: string | null;
  readonly proof_claimed_at: string | null;
  readonly proof_activated_at: string | null;
  readonly existing_installation_id: number | null;
  readonly installed_by_user_id: string | null;
  readonly installation_status: string | null;
}

export interface BoundGithubInstallationClaim {
  readonly installationId: number;
  readonly accountGithubId: number;
  readonly installerGithubUserId: number;
  readonly alreadyClaimed: boolean;
  readonly active: boolean;
}

export interface GithubInstallationMetadata {
  readonly installationId: number;
  readonly accountGithubId: number;
  readonly accountLogin: string;
  readonly permissionsJson: string;
  readonly repositorySelection: "selected";
}

export async function deleteGithubInstallationClaimsForUser(
  database: D1Database,
  userId: string,
): Promise<number> {
  if (!userId) throw new TypeError("GitHub installation claim user is invalid.");
  const deleted = await database.prepare(
    `DELETE FROM github_installation_claim_proofs
      WHERE claimed_by_user_id=?
         OR installer_github_user_id IN (SELECT github_user_id FROM github_identities WHERE user_id=?)
         OR installation_id IN (SELECT installation_id FROM github_installations WHERE installed_by_user_id=?)`,
  ).bind(userId, userId, userId).run();
  const retained = await database.prepare(
    `SELECT 1 AS retained
       FROM github_installation_claim_proofs
      WHERE claimed_by_user_id=?
         OR installer_github_user_id IN (SELECT github_user_id FROM github_identities WHERE user_id=?)
         OR installation_id IN (SELECT installation_id FROM github_installations WHERE installed_by_user_id=?)
      LIMIT 1`,
  ).bind(userId, userId, userId).first<{ readonly retained: number }>();
  if (retained) throw new Error("GitHub installation ownership proof survived account erasure.");
  return deleted.meta.changes;
}

export async function cleanupExpiredGithubInstallationClaims(
  database: D1Database,
  now = new Date(),
): Promise<{ readonly proofs: number; readonly states: number }> {
  const timestamp = now.toISOString();
  const [proofs, states] = await database.batch([
    database.prepare(
      `DELETE FROM github_installation_claim_proofs
        WHERE (claimed_at IS NULL AND expires_at<=?)
           OR installation_id IN (SELECT installation_id FROM github_installations WHERE status='removed')`,
    ).bind(timestamp),
    database.prepare("DELETE FROM github_installation_states WHERE expires_at<=?").bind(timestamp),
  ]);
  const retained = await database.prepare(
    "SELECT 1 AS retained FROM github_installation_claim_proofs WHERE claimed_at IS NULL AND expires_at<=? LIMIT 1",
  ).bind(timestamp).first<{ readonly retained: number }>();
  if (retained) throw new Error("Expired GitHub installation ownership proof cleanup lost its fence.");
  return { proofs: proofs?.meta.changes ?? 0, states: states?.meta.changes ?? 0 };
}

function assertPositiveSafeInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 1) throw new TypeError(`${name} must be a positive safe integer.`);
}

function assertCanonicalTimestamp(value: string, name: string): void {
  if (new Date(value).toISOString() !== value) throw new TypeError(`${name} must be a canonical ISO timestamp.`);
}

function assertClaimIdentity(stateHash: string, userId: string, installationId: number): void {
  if (!SHA256_HEX_PATTERN.test(stateHash)) throw new TypeError("GitHub installation state hash is invalid.");
  if (userId.length < 1) throw new TypeError("GitHub installation claim user is invalid.");
  assertPositiveSafeInteger(installationId, "GitHub installation ID");
}

export async function recordGithubInstallationCreatedProof(
  database: D1Database,
  input: {
    readonly installationId: number;
    readonly installerGithubUserId: number;
    readonly accountGithubId: number;
    readonly deliveryId: string;
    readonly receivedAt: string;
    readonly expiresAt: string;
  },
): Promise<boolean> {
  assertPositiveSafeInteger(input.installationId, "GitHub installation ID");
  assertPositiveSafeInteger(input.installerGithubUserId, "GitHub installer user ID");
  assertPositiveSafeInteger(input.accountGithubId, "GitHub installation account ID");
  assertCanonicalTimestamp(input.receivedAt, "GitHub installation proof receivedAt");
  assertCanonicalTimestamp(input.expiresAt, "GitHub installation proof expiresAt");
  if (input.expiresAt <= input.receivedAt) throw new TypeError("GitHub installation proof expiry is invalid.");

  const inserted = await database.prepare(
    `INSERT OR IGNORE INTO github_installation_claim_proofs
       (installation_id, installer_github_user_id, account_github_id, delivery_id, received_at, expires_at)
     SELECT ?, identities.github_user_id, ?, ?, ?, ?
       FROM github_identities AS identities
       JOIN users ON users.id=identities.user_id
      WHERE identities.github_user_id=?
        AND users.status='active'
        AND NOT EXISTS (
          SELECT 1 FROM account_erasure_jobs WHERE user_id=identities.user_id
        )
        AND EXISTS (
          SELECT 1
            FROM github_installation_states AS states
           WHERE states.user_id=identities.user_id
             AND states.created_at<=?
             AND states.expires_at>?
             AND states.consumed_at IS NULL
             AND (states.installation_id IS NULL OR states.installation_id=?)
        )`,
  ).bind(
    input.installationId,
    input.accountGithubId,
    input.deliveryId,
    input.receivedAt,
    input.expiresAt,
    input.installerGithubUserId,
    input.receivedAt,
    input.receivedAt,
    input.installationId,
  ).run();
  const persisted = await database.prepare(
    "SELECT installer_github_user_id, account_github_id FROM github_installation_claim_proofs WHERE installation_id=?",
  ).bind(input.installationId).first<{ readonly installer_github_user_id: number; readonly account_github_id: number }>();
  if (!persisted || persisted.installer_github_user_id !== input.installerGithubUserId || persisted.account_github_id !== input.accountGithubId) {
    if (!persisted && inserted.meta.changes === 0) return false;
    throw new ApiError(409, "github-installation-proof-conflict", "GitHub delivered conflicting ownership proof for an installation.");
  }
  return true;
}

export async function bindGithubInstallationClaim(
  database: D1Database,
  input: {
    readonly stateHash: string;
    readonly userId: string;
    readonly installationId: number;
    readonly now: string;
  },
): Promise<BoundGithubInstallationClaim> {
  assertClaimIdentity(input.stateHash, input.userId, input.installationId);
  assertCanonicalTimestamp(input.now, "GitHub installation claim time");
  await database.prepare(
    "UPDATE github_installation_states SET installation_id=COALESCE(installation_id, ?), bound_at=COALESCE(bound_at, ?) WHERE state_hash=? AND user_id=? AND consumed_at IS NULL AND expires_at>? AND (installation_id IS NULL OR installation_id=?)",
  ).bind(input.installationId, input.now, input.stateHash, input.userId, input.now, input.installationId).run();

  const row = await database.prepare(
    `SELECT states.user_id AS state_user_id,
            states.expires_at AS state_expires_at,
            states.installation_id AS state_installation_id,
            states.consumed_at AS state_consumed_at,
            identities.github_user_id AS session_github_user_id,
            proofs.installation_id AS proof_installation_id,
            proofs.installer_github_user_id,
            proofs.account_github_id,
            proofs.expires_at AS proof_expires_at,
            proofs.state_hash AS proof_state_hash,
            proofs.claimed_by_user_id AS proof_claimed_by_user_id,
            proofs.claimed_at AS proof_claimed_at,
            proofs.activated_at AS proof_activated_at,
            installations.installation_id AS existing_installation_id,
            installations.installed_by_user_id,
            installations.status AS installation_status
       FROM github_installation_states AS states
       JOIN github_identities AS identities ON identities.user_id=states.user_id
       LEFT JOIN github_installation_claim_proofs AS proofs ON proofs.installation_id=states.installation_id
       LEFT JOIN github_installations AS installations ON installations.installation_id=states.installation_id
      WHERE states.state_hash=?`,
  ).bind(input.stateHash).first<ClaimRow>();

  if (!row || row.state_user_id !== input.userId || row.state_expires_at <= input.now) {
    throw new ApiError(400, "github-install-state-invalid", "GitHub installation state is invalid or expired.");
  }
  if (row.state_installation_id !== input.installationId) {
    throw new ApiError(409, "github-installation-state-bound", "GitHub installation state is already bound to another installation.");
  }
  if (row.proof_installation_id === null) {
    throw new ApiError(409, "github-installation-proof-pending", "The signed GitHub installation event has not arrived yet; retry this callback.");
  }
  if (row.proof_expires_at === null || row.proof_expires_at <= input.now) {
    throw new ApiError(409, "github-installation-proof-expired", "The signed GitHub installation proof expired; start a new installation.");
  }
  if (row.installer_github_user_id !== row.session_github_user_id) {
    throw new ApiError(403, "github-installation-installer-mismatch", "The signed GitHub installer does not match the authenticated user.");
  }
  if (row.existing_installation_id !== null && row.installed_by_user_id !== input.userId) {
    throw new ApiError(409, "github-installation-owned", "This GitHub installation is already owned and cannot be transferred.");
  }
  if (row.proof_claimed_at !== null) {
    if (row.proof_state_hash !== input.stateHash || row.proof_claimed_by_user_id !== input.userId || row.installed_by_user_id !== input.userId) {
      throw new ApiError(409, "github-installation-claimed", "This GitHub installation proof was already claimed.");
    }
    return {
      installationId: input.installationId,
      accountGithubId: row.account_github_id!,
      installerGithubUserId: row.installer_github_user_id,
      alreadyClaimed: true,
      active: row.proof_activated_at !== null && row.installation_status === "active",
    };
  }
  if (row.state_consumed_at !== null) {
    throw new ApiError(409, "github-installation-state-consumed", "GitHub installation state was consumed without a matching claim.");
  }
  return {
    installationId: input.installationId,
    accountGithubId: row.account_github_id!,
    installerGithubUserId: row.installer_github_user_id,
    alreadyClaimed: false,
    active: false,
  };
}

export async function finalizeGithubInstallationClaim(
  database: D1Database,
  input: {
    readonly stateHash: string;
    readonly userId: string;
    readonly metadata: GithubInstallationMetadata;
    readonly now: string;
  },
): Promise<{ readonly newlyClaimed: boolean; readonly active: boolean }> {
  assertClaimIdentity(input.stateHash, input.userId, input.metadata.installationId);
  assertPositiveSafeInteger(input.metadata.accountGithubId, "GitHub installation account ID");
  assertCanonicalTimestamp(input.now, "GitHub installation claim time");
  if (input.metadata.accountLogin.length < 1 || input.metadata.permissionsJson.length < 2) {
    throw new TypeError("GitHub installation metadata is invalid.");
  }
  const { installationId, accountGithubId, accountLogin, permissionsJson, repositorySelection } = input.metadata;
  const statements = await database.batch([
    database.prepare(
      `INSERT INTO github_installations
         (installation_id, account_github_id, account_login, installed_by_user_id, status, permissions_json, repository_selection, created_at, updated_at)
       SELECT ?, ?, ?, ?, 'suspended', ?, ?, ?, ?
         FROM github_installation_states AS states
         JOIN github_identities AS identities ON identities.user_id=states.user_id
         JOIN github_installation_claim_proofs AS proofs ON proofs.installation_id=states.installation_id
        WHERE states.state_hash=? AND states.user_id=? AND states.installation_id=?
          AND states.consumed_at IS NULL AND states.expires_at>?
          AND identities.github_user_id=proofs.installer_github_user_id
          AND proofs.account_github_id=? AND proofs.claimed_at IS NULL AND proofs.expires_at>?
          AND NOT EXISTS (SELECT 1 FROM github_installations WHERE installation_id=?)`,
    ).bind(
      installationId,
      accountGithubId,
      accountLogin,
      input.userId,
      permissionsJson,
      repositorySelection,
      input.now,
      input.now,
      input.stateHash,
      input.userId,
      installationId,
      input.now,
      accountGithubId,
      input.now,
      installationId,
    ),
    database.prepare(
      `UPDATE github_installations
          SET account_github_id=?, account_login=?, permissions_json=?, repository_selection=?,
              status=CASE
                WHEN EXISTS (
                  SELECT 1 FROM github_installation_claim_proofs
                   WHERE installation_id=? AND state_hash=? AND claimed_by_user_id=? AND activated_at IS NOT NULL
                ) THEN 'active'
                ELSE 'suspended'
              END,
              authority_generation=authority_generation+1, updated_at=?
        WHERE installation_id=? AND installed_by_user_id=? AND status<>'removed'
          AND EXISTS (
            SELECT 1
              FROM github_installation_states AS states
              JOIN github_identities AS identities ON identities.user_id=states.user_id
              JOIN github_installation_claim_proofs AS proofs ON proofs.installation_id=states.installation_id
             WHERE states.state_hash=? AND states.user_id=? AND states.installation_id=? AND states.expires_at>?
               AND identities.github_user_id=proofs.installer_github_user_id
               AND proofs.account_github_id=? AND proofs.expires_at>?
               AND (proofs.claimed_at IS NULL OR (proofs.state_hash=? AND proofs.claimed_by_user_id=?))
          )`,
    ).bind(
      accountGithubId,
      accountLogin,
      permissionsJson,
      repositorySelection,
      installationId,
      input.stateHash,
      input.userId,
      input.now,
      installationId,
      input.userId,
      input.stateHash,
      input.userId,
      installationId,
      input.now,
      accountGithubId,
      input.now,
      input.stateHash,
      input.userId,
    ),
    database.prepare(
      `UPDATE github_installation_claim_proofs
          SET state_hash=?, claimed_by_user_id=?, claimed_at=?
        WHERE installation_id=? AND account_github_id=? AND claimed_at IS NULL AND expires_at>?
          AND EXISTS (
            SELECT 1
              FROM github_installation_states AS states
              JOIN github_identities AS identities ON identities.user_id=states.user_id
             WHERE states.state_hash=? AND states.user_id=? AND states.installation_id=?
               AND states.consumed_at IS NULL AND states.expires_at>?
               AND identities.github_user_id=github_installation_claim_proofs.installer_github_user_id
          )
          AND EXISTS (
            SELECT 1 FROM github_installations
             WHERE installation_id=? AND installed_by_user_id=? AND status='suspended'
          )`,
    ).bind(
      input.stateHash,
      input.userId,
      input.now,
      installationId,
      accountGithubId,
      input.now,
      input.stateHash,
      input.userId,
      installationId,
      input.now,
      installationId,
      input.userId,
    ),
    database.prepare(
      `UPDATE github_installation_states
          SET consumed_at=COALESCE(consumed_at, ?)
        WHERE state_hash=? AND user_id=? AND installation_id=? AND expires_at>?
          AND EXISTS (
            SELECT 1 FROM github_installation_claim_proofs
             WHERE installation_id=? AND state_hash=? AND claimed_by_user_id=? AND claimed_at IS NOT NULL
          )`,
    ).bind(
      input.now,
      input.stateHash,
      input.userId,
      installationId,
      input.now,
      installationId,
      input.stateHash,
      input.userId,
    ),
  ]);

  const persisted = await database.prepare(
    `SELECT installations.installed_by_user_id,
            installations.status,
            installations.account_github_id,
            proofs.state_hash,
            proofs.claimed_by_user_id,
            proofs.claimed_at,
            proofs.activated_at,
            states.consumed_at
       FROM github_installation_claim_proofs AS proofs
       JOIN github_installation_states AS states ON states.state_hash=proofs.state_hash
       JOIN github_installations AS installations ON installations.installation_id=proofs.installation_id
      WHERE proofs.installation_id=?`,
  ).bind(installationId).first<{
    readonly installed_by_user_id: string | null;
    readonly status: string;
    readonly account_github_id: number;
    readonly state_hash: string | null;
    readonly claimed_by_user_id: string | null;
    readonly claimed_at: string | null;
    readonly activated_at: string | null;
    readonly consumed_at: string | null;
  }>();
  if (persisted?.installed_by_user_id !== input.userId) {
    throw new ApiError(409, "github-installation-owned", "This GitHub installation is already owned and cannot be transferred.");
  }
  if (
    persisted.account_github_id !== accountGithubId
    || persisted.state_hash !== input.stateHash
    || persisted.claimed_by_user_id !== input.userId
    || persisted.claimed_at === null
    || persisted.consumed_at === null
  ) {
    throw new ApiError(409, "github-installation-claim-conflict", "GitHub installation ownership could not be claimed atomically.");
  }
  return {
    newlyClaimed: statements[2]?.meta.changes === 1,
    active: persisted.status === "active" && persisted.activated_at !== null,
  };
}

export async function activateGithubInstallationClaim(
  database: D1Database,
  input: {
    readonly stateHash: string;
    readonly userId: string;
    readonly installationId: number;
    readonly now: string;
  },
): Promise<void> {
  assertClaimIdentity(input.stateHash, input.userId, input.installationId);
  assertCanonicalTimestamp(input.now, "GitHub installation activation time");
  await database.batch([
    database.prepare(
      `UPDATE github_installation_claim_proofs
          SET activated_at=COALESCE(activated_at, ?)
        WHERE installation_id=? AND state_hash=? AND claimed_by_user_id=? AND claimed_at IS NOT NULL
          AND EXISTS (
            SELECT 1 FROM github_installations
             WHERE installation_id=? AND installed_by_user_id=? AND status='suspended'
          )`,
    ).bind(input.now, input.installationId, input.stateHash, input.userId, input.installationId, input.userId),
    database.prepare(
      `UPDATE github_installations
          SET status='active', authority_generation=authority_generation+1, updated_at=?
        WHERE installation_id=? AND installed_by_user_id=? AND status='suspended'
          AND EXISTS (
            SELECT 1 FROM github_installation_claim_proofs
             WHERE installation_id=? AND state_hash=? AND claimed_by_user_id=? AND claimed_at IS NOT NULL AND activated_at IS NOT NULL
          )`,
    ).bind(input.now, input.installationId, input.userId, input.installationId, input.stateHash, input.userId),
  ]);
  const active = await database.prepare(
    `SELECT 1 AS active
       FROM github_installations AS installations
       JOIN github_installation_claim_proofs AS proofs ON proofs.installation_id=installations.installation_id
      WHERE installations.installation_id=? AND installations.installed_by_user_id=? AND installations.status='active'
        AND proofs.state_hash=? AND proofs.claimed_by_user_id=? AND proofs.activated_at IS NOT NULL`,
  ).bind(input.installationId, input.userId, input.stateHash, input.userId).first<{ readonly active: number }>();
  if (!active) throw new ApiError(409, "github-installation-activation-conflict", "GitHub installation could not be activated from the exact ownership claim.");
}
