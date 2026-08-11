import { sha256Hex } from "./crypto";
import { verifyForgeReleaseManifestBytes, type ForgeReleaseManifest } from "../src/release-manifest";

export type ReleaseEnvironment = "development" | "staging" | "production";

export interface ActiveRelease {
  readonly releaseId: string;
  readonly manifestR2Key: string;
  readonly manifestSha256: string;
  readonly manifest: ForgeReleaseManifest;
}

interface ActiveReleaseRow {
  readonly release_id: string;
  readonly manifest_r2_key: string;
  readonly manifest_sha256: string;
  readonly status: string;
}

async function manifestBytes(bucket: R2Bucket, key: string, expectedSha256: string): Promise<Uint8Array> {
  const object = await bucket.get(key);
  if (!object || object.size < 1 || object.size > 8 * 1024 * 1024) throw new Error("Active release manifest is unavailable.");
  const bytes = new Uint8Array(await object.arrayBuffer());
  if (await sha256Hex(bytes) !== expectedSha256) throw new Error("Active release manifest digest does not match.");
  return bytes;
}

export async function readActiveRelease(coreDb: D1Database, bucket: R2Bucket, environment: ReleaseEnvironment): Promise<ActiveRelease> {
  const row = await coreDb.prepare(
    "SELECT active.forge_release_id AS release_id, release.manifest_r2_key, release.manifest_sha256, release.status FROM forge_active_releases active JOIN forge_releases release ON release.id=active.forge_release_id WHERE active.environment=?",
  ).bind(environment).first<ActiveReleaseRow>();
  if (!row || row.status !== "active") throw new Error(`No active Forge release exists for '${environment}'.`);
  const manifest = await verifyForgeReleaseManifestBytes(await manifestBytes(bucket, row.manifest_r2_key, row.manifest_sha256), row.manifest_sha256);
  if (manifest.releaseId !== row.release_id) throw new Error("Active release manifest has the wrong release ID.");
  return { releaseId: row.release_id, manifestR2Key: row.manifest_r2_key, manifestSha256: row.manifest_sha256, manifest };
}

export async function assertActiveRelease(
  coreDb: D1Database,
  bucket: R2Bucket,
  environment: ReleaseEnvironment,
  expectedReleaseId: string,
  expectedManifestSha256?: string,
): Promise<ActiveRelease> {
  const active = await readActiveRelease(coreDb, bucket, environment);
  if (active.releaseId !== expectedReleaseId || (expectedManifestSha256 && active.manifestSha256 !== expectedManifestSha256)) {
    throw new Error("Requested Forge release is not active.");
  }
  return active;
}
