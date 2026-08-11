import type { ForgeWorkerEnv } from "./env";

const DIGEST = /^[0-9a-f]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
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

function validateIdentity(importId: string, predecessorImportId: string, key: string, digest: string, expectedBytes?: number): void {
  if (!UUID.test(importId) || !UUID.test(predecessorImportId) || !DIGEST.test(digest) || key !== `snapshots/objects/${digest}`) {
    throw new TypeError("Canonical predecessor object identity is invalid.");
  }
  if (expectedBytes !== undefined && (!Number.isSafeInteger(expectedBytes) || expectedBytes < 1 || expectedBytes > 32 * 1024 * 1024)) {
    throw new TypeError("Canonical predecessor object length is invalid.");
  }
}

/**
 * Copy an exact retained-object claim from the published predecessor into a
 * validating successor before touching R2. This both authorizes the object and
 * supplies its trusted byte length without an unsafe pre-claim HEAD request.
 */
async function claimPredecessorObjectInternal(
  env: ForgeWorkerEnv,
  importId: string,
  predecessorImportId: string,
  key: string,
  digest: string,
  expectedBytes?: number,
  requireCanonicalRoot = false,
): Promise<ClaimedObject> {
  validateIdentity(importId, predecessorImportId, key, digest, expectedBytes);
  const now = new Date().toISOString();
  await env.CORE_DB.batch([
    env.CORE_DB.prepare("INSERT OR IGNORE INTO collection_import_objects (import_id, object_key, object_sha256, object_bytes, claimed_at) SELECT successor.id, predecessor_object.object_key, predecessor_object.object_sha256, predecessor_object.object_bytes, ? FROM collection_imports successor JOIN collection_imports predecessor ON predecessor.id=successor.predecessor_import_id JOIN collection_import_objects predecessor_object ON predecessor_object.import_id=predecessor.id JOIN managed_snapshots ON managed_snapshots.import_id=predecessor.id AND managed_snapshots.mode='official-practice' AND managed_snapshots.status='published' WHERE successor.id=? AND successor.status='validating' AND successor.source_kind='canonical-successor' AND successor.predecessor_import_id=? AND predecessor.id=? AND predecessor.status='valid' AND predecessor_object.object_key=? AND predecessor_object.object_sha256=? AND (? IS NULL OR predecessor_object.object_bytes=?) AND (?=0 OR (successor.canonical_source_r2_key=? AND successor.canonical_source_mirror_r2_key=? AND successor.canonical_source_sha256=? AND predecessor.canonical_source_r2_key=? AND predecessor.canonical_source_mirror_r2_key=? AND predecessor.canonical_source_sha256=?)) AND NOT EXISTS (SELECT 1 FROM canonical_object_gc WHERE object_key=predecessor_object.object_key AND state='deleting')")
      .bind(now, importId, predecessorImportId, predecessorImportId, key, digest, expectedBytes ?? null, expectedBytes ?? null, requireCanonicalRoot ? 1 : 0, key, key, digest, key, key, digest),
    env.CORE_DB.prepare("DELETE FROM canonical_object_gc WHERE object_key=? AND state='pending' AND EXISTS (SELECT 1 FROM collection_import_objects WHERE import_id=? AND object_key=? AND object_sha256=? AND (? IS NULL OR object_bytes=?))")
      .bind(key, importId, key, digest, expectedBytes ?? null, expectedBytes ?? null),
  ]);
  const claimed = await env.CORE_DB.prepare("SELECT successor_object.object_bytes FROM collection_import_objects successor_object JOIN collection_imports successor ON successor.id=successor_object.import_id JOIN collection_imports predecessor ON predecessor.id=successor.predecessor_import_id WHERE successor_object.import_id=? AND successor_object.object_key=? AND successor_object.object_sha256=? AND (? IS NULL OR successor_object.object_bytes=?) AND successor.status='validating' AND successor.source_kind='canonical-successor' AND successor.predecessor_import_id=? AND (?=0 OR (successor.canonical_source_r2_key=? AND successor.canonical_source_mirror_r2_key=? AND successor.canonical_source_sha256=? AND predecessor.canonical_source_r2_key=? AND predecessor.canonical_source_mirror_r2_key=? AND predecessor.canonical_source_sha256=?)) AND NOT EXISTS (SELECT 1 FROM canonical_object_gc WHERE object_key=successor_object.object_key AND state='deleting')")
    .bind(importId, key, digest, expectedBytes ?? null, expectedBytes ?? null, predecessorImportId, requireCanonicalRoot ? 1 : 0, key, key, digest, key, key, digest)
    .first<{ object_bytes: number }>();
  if (!claimed) throw new Error("Canonical predecessor object is not retained by the published predecessor.");
  const reference = { key, digest, bytes: claimed.object_bytes } satisfies ClaimedObject;
  validate(reference);
  return reference;
}

export function claimPredecessorCanonicalManifest(
  env: ForgeWorkerEnv,
  importId: string,
  predecessorImportId: string,
  key: string,
  digest: string,
): Promise<ClaimedObject> {
  return claimPredecessorObjectInternal(env, importId, predecessorImportId, key, digest, undefined, true);
}

export function claimPredecessorObject(
  env: ForgeWorkerEnv,
  importId: string,
  predecessorImportId: string,
  key: string,
  digest: string,
  expectedBytes: number,
): Promise<ClaimedObject> {
  return claimPredecessorObjectInternal(env, importId, predecessorImportId, key, digest, expectedBytes);
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
  const [inserted] = await env.CORE_DB.batch([
    env.CORE_DB.prepare("INSERT OR IGNORE INTO collection_import_objects (import_id, object_key, object_sha256, object_bytes, claimed_at) SELECT ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM collection_imports WHERE id=? AND status='validating') AND NOT EXISTS (SELECT 1 FROM canonical_object_gc WHERE object_key=? AND state='deleting')")
      .bind(importId, reference.key, reference.digest, reference.bytes, now, importId, reference.key),
    env.CORE_DB.prepare("DELETE FROM canonical_object_gc WHERE object_key=? AND state='pending' AND EXISTS (SELECT 1 FROM collection_import_objects WHERE import_id=? AND object_key=? AND object_sha256=? AND object_bytes=?)")
      .bind(reference.key, importId, reference.key, reference.digest, reference.bytes),
  ]);
  if (inserted?.meta.changes === 1) return;
  const existing = await env.CORE_DB.prepare("SELECT 1 AS valid FROM collection_import_objects JOIN collection_imports ON collection_imports.id=collection_import_objects.import_id WHERE collection_import_objects.import_id=? AND collection_import_objects.object_key=? AND collection_import_objects.object_sha256=? AND collection_import_objects.object_bytes=? AND collection_imports.status='validating' AND NOT EXISTS (SELECT 1 FROM canonical_object_gc WHERE object_key=collection_import_objects.object_key AND state='deleting')")
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
  await env.CORE_DB.batch([
    env.CORE_DB.prepare("INSERT INTO canonical_object_gc (object_key, object_sha256, object_bytes, not_before, created_at) SELECT object_key, object_sha256, object_bytes, ?, ? FROM collection_import_objects WHERE import_id=? AND object_key=? AND object_sha256=? AND object_bytes=? ON CONFLICT(object_key) DO UPDATE SET not_before=MAX(canonical_object_gc.not_before, excluded.not_before), last_error=NULL WHERE canonical_object_gc.state='pending' AND canonical_object_gc.object_sha256=excluded.object_sha256 AND canonical_object_gc.object_bytes=excluded.object_bytes")
      .bind(notBefore, now.toISOString(), importId, reference.key, reference.digest, reference.bytes),
    env.CORE_DB.prepare("DELETE FROM collection_import_objects WHERE import_id=? AND object_key=? AND object_sha256=? AND object_bytes=?")
      .bind(importId, reference.key, reference.digest, reference.bytes),
  ]);
}

/** Release an entire terminal/unpublished import inventory into grace-period GC. */
export async function releaseImportObjectClaims(env: ForgeWorkerEnv, importId: string, now = new Date()): Promise<number> {
  const count = await env.CORE_DB.prepare("SELECT COUNT(*) AS count FROM collection_import_objects WHERE import_id=?")
    .bind(importId).first<{ count: number }>();
  if (!count || count.count === 0) return 0;
  const notBefore = gcNotBefore(now);
  await env.CORE_DB.batch([
    env.CORE_DB.prepare("INSERT INTO canonical_object_gc (object_key, object_sha256, object_bytes, not_before, created_at) SELECT object_key, object_sha256, object_bytes, ?, ? FROM collection_import_objects WHERE import_id=? ON CONFLICT(object_key) DO UPDATE SET not_before=MAX(canonical_object_gc.not_before, excluded.not_before), last_error=NULL WHERE canonical_object_gc.state='pending' AND canonical_object_gc.object_sha256=excluded.object_sha256 AND canonical_object_gc.object_bytes=excluded.object_bytes")
      .bind(notBefore, now.toISOString(), importId),
    env.CORE_DB.prepare("DELETE FROM collection_import_objects WHERE import_id=?").bind(importId),
  ]);
  return count.count;
}

export const CANONICAL_OBJECT_GC_GRACE_MS = GC_GRACE_MS;
