import { verifyReleaseManifestBytes, type ReleaseManifest } from "../src/release-manifest";

export type ReleaseEnvironment = "development" | "staging" | "production";

export interface ActiveRelease {
  readonly releaseId: string;
  readonly manifestSha256: string;
  readonly manifest: ReleaseManifest;
}

export interface ReleaseActivation {
  readonly releaseId: string;
  readonly version: string;
  readonly manifestJson: string;
  readonly manifestBytes: number;
  readonly manifestSha256: string;
  readonly sourceGitCommit: string;
  readonly createdAt: string;
  readonly activatedBy: string;
  readonly environment: ReleaseEnvironment;
  readonly expectedCurrentReleaseId: string | null;
}

interface ActiveReleaseRow {
  readonly release_id: string;
  readonly manifest_json: string;
  readonly manifest_bytes: number;
  readonly manifest_sha256: string;
}

export async function readActiveRelease(coreDb: D1Database, environment: ReleaseEnvironment): Promise<ActiveRelease> {
  const row = await coreDb.prepare(
    `SELECT active.wasm_oj_release_id AS release_id, release.manifest_json,
      release.manifest_bytes, release.manifest_sha256
    FROM wasm_oj_active_releases AS active
    JOIN wasm_oj_releases AS release ON release.id=active.wasm_oj_release_id
    WHERE active.environment=? AND release.revoked_at IS NULL`,
  ).bind(environment).first<ActiveReleaseRow>();
  if (!row) throw new Error(`No active WASM-OJ release exists for '${environment}'.`);
  const bytes = new TextEncoder().encode(row.manifest_json);
  if (bytes.byteLength !== row.manifest_bytes || bytes.byteLength < 2 || bytes.byteLength > 256 * 1024) {
    throw new Error("Active release manifest is unavailable or has an invalid length.");
  }
  const manifest = await verifyReleaseManifestBytes(bytes, row.manifest_sha256);
  if (manifest.releaseId !== row.release_id) throw new Error("Active release manifest has the wrong release ID.");
  return { releaseId: row.release_id, manifestSha256: row.manifest_sha256, manifest };
}

export async function assertActiveRelease(
  coreDb: D1Database,
  environment: ReleaseEnvironment,
  expectedReleaseId: string,
  expectedManifestSha256?: string,
): Promise<ActiveRelease> {
  const active = await readActiveRelease(coreDb, environment);
  if (active.releaseId !== expectedReleaseId || (expectedManifestSha256 && active.manifestSha256 !== expectedManifestSha256)) {
    throw new Error("Requested WASM-OJ release is not active.");
  }
  return active;
}

/** Atomically install and activate one canonical release while mutations are paused. */
export async function activateRelease(
  database: D1Database,
  input: ReleaseActivation,
): Promise<void> {
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
  if (
    !uuid.test(input.releaseId)
    || (input.expectedCurrentReleaseId !== null && !uuid.test(input.expectedCurrentReleaseId))
    || !/^[0-9a-f]{64}$/.test(input.manifestSha256)
    || !/^[0-9a-f]{40}$/.test(input.sourceGitCommit)
    || new TextEncoder().encode(input.manifestJson).byteLength !== input.manifestBytes
    || input.manifestBytes < 2
    || input.manifestBytes > 256 * 1024
  ) throw new TypeError("WASM-OJ release activation identity is invalid.");
  const timestamp = new Date().toISOString();
  const expected = input.expectedCurrentReleaseId;
  const maintenanceGateGuard = database.prepare(`INSERT INTO formal_mutation_controls
      (environment, formal_mutations_enabled, reason, updated_at)
    SELECT ?, 2, 'release-activation-gate-invalid', ?
    WHERE NOT EXISTS (
      SELECT 1 FROM formal_mutation_controls
      WHERE environment=? AND formal_mutations_enabled=0
    )`)
    .bind(input.environment, timestamp, input.environment);
  const currentReleaseGuard = database.prepare(`UPDATE formal_mutation_controls
      SET formal_mutations_enabled=CASE WHEN formal_mutations_enabled=0 AND (
        (? IS NULL AND NOT EXISTS (
          SELECT 1 FROM wasm_oj_active_releases WHERE environment=?
        )) OR (? IS NOT NULL AND EXISTS (
          SELECT 1 FROM wasm_oj_active_releases WHERE environment=? AND wasm_oj_release_id=?
        ))
      ) THEN formal_mutations_enabled ELSE 2 END
    WHERE environment=?`)
    .bind(expected, input.environment, expected, input.environment, expected, input.environment);
  const exactCandidateGuard = database.prepare(`UPDATE formal_mutation_controls
      SET formal_mutations_enabled=CASE WHEN EXISTS (
        SELECT 1 FROM wasm_oj_releases
        WHERE id=? AND version=? AND manifest_json=? AND manifest_bytes=?
          AND manifest_sha256=? AND source_git_commit=? AND created_at=?
          AND revoked_at IS NULL
      ) THEN formal_mutations_enabled ELSE 2 END
    WHERE environment=? AND formal_mutations_enabled=0`)
    .bind(
      input.releaseId,
      input.version,
      input.manifestJson,
      input.manifestBytes,
      input.manifestSha256,
      input.sourceGitCommit,
      input.createdAt,
      input.environment,
    );
  const finalGuard = database.prepare(`UPDATE formal_mutation_controls
      SET formal_mutations_enabled=CASE WHEN EXISTS (
        SELECT 1 FROM wasm_oj_active_releases AS active
        JOIN wasm_oj_releases AS release ON release.id=active.wasm_oj_release_id
        WHERE active.environment=? AND active.wasm_oj_release_id=?
          AND release.manifest_sha256=? AND release.revoked_at IS NULL
      ) THEN formal_mutations_enabled ELSE 2 END
    WHERE environment=? AND formal_mutations_enabled=0`)
    .bind(input.environment, input.releaseId, input.manifestSha256, input.environment);
  await database.batch([
    maintenanceGateGuard,
    currentReleaseGuard,
    database.prepare(`INSERT INTO wasm_oj_releases
        (id, version, manifest_json, manifest_bytes, manifest_sha256,
         source_git_commit, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO NOTHING`)
      .bind(
        input.releaseId,
        input.version,
        input.manifestJson,
        input.manifestBytes,
        input.manifestSha256,
        input.sourceGitCommit,
        input.createdAt,
      ),
    exactCandidateGuard,
    database.prepare(`INSERT INTO wasm_oj_active_releases
        (environment, wasm_oj_release_id, activated_by, activated_at)
      SELECT ?, id, ?, ? FROM wasm_oj_releases
       WHERE id=? AND manifest_sha256=? AND revoked_at IS NULL
      ON CONFLICT(environment) DO UPDATE SET
        wasm_oj_release_id=excluded.wasm_oj_release_id,
        activated_by=excluded.activated_by,
        activated_at=excluded.activated_at`)
      .bind(
        input.environment,
        input.activatedBy,
        timestamp,
        input.releaseId,
        input.manifestSha256,
      ),
    finalGuard,
  ]);
}
