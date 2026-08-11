import type { ForgeWorkerEnv } from "./env";

const DIGEST = /^[0-9a-f]{64}$/;
const GC_GRACE_MS = 24 * 60 * 60 * 1_000;

export interface ClaimedObject {
  readonly key: string;
  readonly digest: string;
  readonly bytes: number;
}

function validate(reference: ClaimedObject): void {
  if (
    !DIGEST.test(reference.digest)
    || reference.key !== `snapshots/objects/${reference.digest}`
    || !Number.isSafeInteger(reference.bytes)
    || reference.bytes < 1
    || reference.bytes > 32 * 1024 * 1024
  ) throw new TypeError("Canonical object claim is invalid.");
}

/**
 * Claim a content-addressed object before any validation job reads or writes it.
 * A deleting tombstone rejects the claim; a pending tombstone is atomically
 * cancelled. This is the cross-service fence that prevents GC from deleting a
 * newly reused object between R2 and D1 operations.
 */
export async function claimImportObject(env: ForgeWorkerEnv, importId: string, reference: ClaimedObject): Promise<void> {
  validate(reference);
  const now = new Date().toISOString();
  const [inserted] = await env.DB.batch([
    env.DB.prepare("INSERT OR IGNORE INTO collection_import_objects (import_id, object_key, object_sha256, object_bytes, claimed_at) SELECT ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM collection_imports WHERE id=? AND status='validating') AND NOT EXISTS (SELECT 1 FROM canonical_object_gc WHERE object_key=? AND state='deleting')")
      .bind(importId, reference.key, reference.digest, reference.bytes, now, importId, reference.key),
    env.DB.prepare("DELETE FROM canonical_object_gc WHERE object_key=? AND state='pending' AND EXISTS (SELECT 1 FROM collection_import_objects WHERE import_id=? AND object_key=? AND object_sha256=? AND object_bytes=?)")
      .bind(reference.key, importId, reference.key, reference.digest, reference.bytes),
  ]);
  if (inserted?.meta.changes === 1) return;
  const existing = await env.DB.prepare("SELECT 1 AS valid FROM collection_import_objects JOIN collection_imports ON collection_imports.id=collection_import_objects.import_id WHERE collection_import_objects.import_id=? AND collection_import_objects.object_key=? AND collection_import_objects.object_sha256=? AND collection_import_objects.object_bytes=? AND collection_imports.status='validating' AND NOT EXISTS (SELECT 1 FROM canonical_object_gc WHERE object_key=collection_import_objects.object_key AND state='deleting')")
    .bind(importId, reference.key, reference.digest, reference.bytes).first<{ valid: number }>();
  if (!existing) throw new Error("Canonical object claim lost its import or GC fence.");
}

function gcNotBefore(now: Date): string {
  return new Date(now.getTime() + GC_GRACE_MS).toISOString();
}

/** Release one failed upload/read claim and start a conservative GC grace. */
export async function releaseImportObjectClaim(env: ForgeWorkerEnv, importId: string, reference: ClaimedObject, now = new Date()): Promise<void> {
  validate(reference);
  const notBefore = gcNotBefore(now);
  await env.DB.batch([
    env.DB.prepare("INSERT INTO canonical_object_gc (object_key, object_sha256, object_bytes, not_before, created_at) SELECT object_key, object_sha256, object_bytes, ?, ? FROM collection_import_objects WHERE import_id=? AND object_key=? AND object_sha256=? AND object_bytes=? ON CONFLICT(object_key) DO UPDATE SET not_before=MAX(canonical_object_gc.not_before, excluded.not_before), last_error=NULL WHERE canonical_object_gc.state='pending' AND canonical_object_gc.object_sha256=excluded.object_sha256 AND canonical_object_gc.object_bytes=excluded.object_bytes")
      .bind(notBefore, now.toISOString(), importId, reference.key, reference.digest, reference.bytes),
    env.DB.prepare("DELETE FROM collection_import_objects WHERE import_id=? AND object_key=? AND object_sha256=? AND object_bytes=?")
      .bind(importId, reference.key, reference.digest, reference.bytes),
  ]);
}

/** Release an entire terminal/unpublished import inventory into grace-period GC. */
export async function releaseImportObjectClaims(env: ForgeWorkerEnv, importId: string, now = new Date()): Promise<number> {
  const count = await env.DB.prepare("SELECT COUNT(*) AS count FROM collection_import_objects WHERE import_id=?")
    .bind(importId).first<{ count: number }>();
  if (!count || count.count === 0) return 0;
  const notBefore = gcNotBefore(now);
  await env.DB.batch([
    env.DB.prepare("INSERT INTO canonical_object_gc (object_key, object_sha256, object_bytes, not_before, created_at) SELECT object_key, object_sha256, object_bytes, ?, ? FROM collection_import_objects WHERE import_id=? ON CONFLICT(object_key) DO UPDATE SET not_before=MAX(canonical_object_gc.not_before, excluded.not_before), last_error=NULL WHERE canonical_object_gc.state='pending' AND canonical_object_gc.object_sha256=excluded.object_sha256 AND canonical_object_gc.object_bytes=excluded.object_bytes")
      .bind(notBefore, now.toISOString(), importId),
    env.DB.prepare("DELETE FROM collection_import_objects WHERE import_id=?").bind(importId),
  ]);
  return count.count;
}

export const CANONICAL_OBJECT_GC_GRACE_MS = GC_GRACE_MS;
