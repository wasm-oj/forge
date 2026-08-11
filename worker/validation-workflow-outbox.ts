import type { ForgeWorkerEnv } from "./env";
import {
  parseValidationWorkflowParameters,
  type ValidationWorkflowParameters,
} from "./validation-contract";
import { releaseImportObjectClaims } from "./canonical-object-claims";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const DIGEST = /^[0-9a-f]{64}$/;
const MAX_OUTBOX_BYTES = 2 * 1024;
const LIVE_WORKFLOW_STATUSES = new Set(["queued", "running", "paused", "waiting", "waitingForPause"]);
const FAILED_WORKFLOW_STATUSES = new Set(["errored", "terminated"]);
const TERMINAL_IMPORT_STATUSES = new Set(["valid", "invalid", "infrastructure-error"]);
const NONTERMINAL_IMPORT_STATUSES = new Set(["queued", "downloading", "validating"]);
const QUARANTINE_MILLISECONDS = 24 * 60 * 60 * 1_000;

interface ValidationImportDeliveryRow {
  readonly status: string;
  readonly error_code: string | null;
  readonly source_kind: string;
  readonly commit_sha: string;
  readonly archive_r2_key: string | null;
  readonly archive_disposition: string;
  readonly archive_delete_after: string | null;
  readonly validation_report_r2_key: string | null;
  readonly canonical_source_r2_key: string | null;
  readonly canonical_source_mirror_r2_key: string | null;
  readonly canonical_source_sha256: string | null;
  readonly manifest_sha256: string;
}

function parseJson(value: string, label: string): unknown {
  if (new TextEncoder().encode(value).byteLength > MAX_OUTBOX_BYTES) throw new TypeError(`${label} exceeds its size limit.`);
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw new TypeError(`${label} is not valid JSON.`);
  }
}

export function validationWorkflowOutboxJson(parameters: unknown): string {
  return JSON.stringify(parseValidationWorkflowParameters(parameters));
}

export function parseValidationWorkflowOutboxJson(value: string, aggregateId: string): ValidationWorkflowParameters {
  const parameters = parseValidationWorkflowParameters(parseJson(value, "Validation Workflow outbox payload"));
  if (parameters.importId !== aggregateId) throw new TypeError("Validation Workflow outbox aggregate identity is invalid.");
  return parameters;
}

function exactArchiveKey(importId: string, commitSha: string, key: string): boolean {
  return key === `imports/${importId}/${commitSha}.tar.gz`;
}

async function importDeliveryRow(env: ForgeWorkerEnv, parameters: ValidationWorkflowParameters): Promise<ValidationImportDeliveryRow> {
  const row = await env.CORE_DB.prepare(`SELECT
      imports.status, imports.error_code, imports.source_kind, imports.commit_sha,
      imports.archive_r2_key, imports.archive_disposition, imports.archive_delete_after,
      imports.validation_report_r2_key, imports.canonical_source_r2_key,
      imports.canonical_source_mirror_r2_key, imports.canonical_source_sha256,
      releases.manifest_sha256
    FROM collection_imports AS imports
    JOIN forge_releases AS releases ON releases.id=imports.forge_release_id
    WHERE imports.id=? AND imports.forge_release_id=?`)
    .bind(parameters.importId, parameters.expectedReleaseId).first<ValidationImportDeliveryRow>();
  if (!row || row.manifest_sha256 !== parameters.expectedManifestSha256) {
    throw new Error("Terminal Validation Workflow does not match its immutable import release.");
  }
  if (row.source_kind !== "github-archive" && row.source_kind !== "canonical-successor") {
    throw new Error("Terminal Validation Workflow import has an invalid source kind.");
  }
  if (row.archive_r2_key !== null && (row.source_kind !== "github-archive" || !exactArchiveKey(parameters.importId, row.commit_sha, row.archive_r2_key))) {
    throw new Error("Terminal Validation Workflow archive is not bound to its import.");
  }
  if (row.source_kind === "canonical-successor" && (row.archive_r2_key !== null || row.archive_disposition !== "deleted")) {
    throw new Error("Terminal canonical successor unexpectedly owns a GitHub archive.");
  }
  return row;
}

async function ensureArchiveCleanup(
  env: ForgeWorkerEnv,
  parameters: ValidationWorkflowParameters,
  row: ValidationImportDeliveryRow,
  now: string,
): Promise<void> {
  if (row.archive_r2_key === null) {
    if (row.archive_disposition !== "deleted") throw new Error("Terminal Validation Workflow has an invalid empty archive disposition.");
    return;
  }
  if (row.archive_disposition === "quarantined") {
    const deleteAfter = row.archive_delete_after === null ? Number.NaN : Date.parse(row.archive_delete_after);
    if (
      row.status !== "infrastructure-error"
      || !Number.isFinite(deleteAfter)
      || deleteAfter > Date.parse(now) + QUARANTINE_MILLISECONDS + 1_000
    ) {
      throw new Error("Terminal Validation Workflow archive quarantine is invalid.");
    }
    return;
  }
  if (row.archive_disposition !== "pending") throw new Error("Terminal Validation Workflow archive has no cleanup or quarantine fence.");
  await env.CORE_DB.prepare("INSERT OR IGNORE INTO core_outbox (id, kind, aggregate_id, payload_json, created_at) SELECT ?, 'cleanup-import-archive', ?, ?, ? WHERE EXISTS (SELECT 1 FROM collection_imports WHERE id=? AND archive_r2_key=? AND archive_disposition='pending')")
    .bind(crypto.randomUUID(), parameters.importId, archiveCleanupOutboxJson(parameters.importId), now, parameters.importId, row.archive_r2_key).run();
  const cleanup = await env.CORE_DB.prepare("SELECT 1 AS valid FROM core_outbox WHERE kind='cleanup-import-archive' AND aggregate_id=? AND delivered_at IS NULL")
    .bind(parameters.importId).first<{ readonly valid: number }>();
  if (!cleanup) throw new Error("Terminal Validation Workflow lost its archive cleanup outbox.");
}

async function settleFailedValidationWorkflow(
  env: ForgeWorkerEnv,
  parameters: ValidationWorkflowParameters,
  workflowStatus: "errored" | "terminated",
): Promise<void> {
  const nowDate = new Date();
  const now = nowDate.toISOString();
  let row = await importDeliveryRow(env, parameters);
  if (NONTERMINAL_IMPORT_STATUSES.has(row.status)) {
    const archiveDisposition = row.archive_r2_key === null ? "deleted" : "quarantined";
    const archiveDeleteAfter = row.archive_r2_key === null
      ? null
      : new Date(nowDate.getTime() + QUARANTINE_MILLISECONDS).toISOString();
    const terminalized = await env.CORE_DB.prepare(`UPDATE collection_imports
      SET status='infrastructure-error', error_code=?, archive_disposition=?, archive_delete_after=?, updated_at=?
      WHERE id=? AND forge_release_id=? AND status IN ('queued','downloading','validating')
        AND source_kind=? AND commit_sha=? AND archive_r2_key IS ?`)
      .bind(
        `validation-workflow-${workflowStatus}`,
        archiveDisposition,
        archiveDeleteAfter,
        now,
        parameters.importId,
        parameters.expectedReleaseId,
        row.source_kind,
        row.commit_sha,
        row.archive_r2_key,
      ).run();
    if (terminalized.meta.changes !== 1) {
      row = await importDeliveryRow(env, parameters);
      if (!TERMINAL_IMPORT_STATUSES.has(row.status)) throw new Error("Terminal Validation Workflow lost its import transition fence.");
    } else {
      row = await importDeliveryRow(env, parameters);
    }
  }
  if (!TERMINAL_IMPORT_STATUSES.has(row.status)) {
    throw new Error("Terminal Validation Workflow import has an unsupported state.");
  }
  if (row.status === "valid") {
    const reportDigest = row.validation_report_r2_key === null
      ? null
      : /^snapshots\/objects\/([0-9a-f]{64})$/.exec(row.validation_report_r2_key)?.[1] ?? null;
    if (
      reportDigest === null
      || row.canonical_source_r2_key === null
      || row.canonical_source_mirror_r2_key !== row.canonical_source_r2_key
      || row.canonical_source_sha256 === null
      || !DIGEST.test(row.canonical_source_sha256)
      || row.canonical_source_r2_key !== `snapshots/objects/${row.canonical_source_sha256}`
    ) throw new Error("Terminal Validation Workflow cannot observe an incomplete valid import.");
  } else {
    if (row.error_code === null) throw new Error("Terminal Validation Workflow failure has no durable error code.");
    await releaseImportObjectClaims(env, parameters.importId, nowDate);
  }
  await ensureArchiveCleanup(env, parameters, row, now);
}

/**
 * Create-or-observe provides lost-ack replay without manufacturing a second
 * Workflow identity. The only durable payload accepted here is the exact
 * four-field opaque reference parsed above.
 */
export async function deliverValidationWorkflowOutbox(
  env: ForgeWorkerEnv,
  aggregateId: string,
  payloadJson: string,
): Promise<ValidationWorkflowParameters> {
  const parameters = parseValidationWorkflowOutboxJson(payloadJson, aggregateId);
  try {
    await env.VALIDATION_WORKFLOW.create({ id: aggregateId, params: parameters });
  } catch (error) {
    const status = await (await env.VALIDATION_WORKFLOW.get(aggregateId)).status();
    if (status.status === "unknown") throw error;
    if (LIVE_WORKFLOW_STATUSES.has(status.status) || status.status === "complete") return parameters;
    if (FAILED_WORKFLOW_STATUSES.has(status.status)) {
      await settleFailedValidationWorkflow(env, parameters, status.status as "errored" | "terminated");
      return parameters;
    }
    throw new Error("Validation Workflow returned an unsupported status after create failure.");
  }
  return parameters;
}

export interface ArchiveCleanupOutboxParameters {
  readonly importId: string;
}

export function archiveCleanupOutboxJson(importId: string): string {
  if (!UUID.test(importId)) throw new TypeError("Archive cleanup import identity is invalid.");
  return JSON.stringify({ importId });
}

export function parseArchiveCleanupOutboxJson(value: string, aggregateId: string): ArchiveCleanupOutboxParameters {
  const payload = parseJson(value, "Archive cleanup outbox payload");
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new TypeError("Archive cleanup outbox payload is invalid.");
  const record = payload as Record<string, unknown>;
  if (Object.keys(record).length !== 1 || record.importId !== aggregateId || !UUID.test(aggregateId)) {
    throw new TypeError("Archive cleanup outbox payload is invalid.");
  }
  return { importId: aggregateId };
}
