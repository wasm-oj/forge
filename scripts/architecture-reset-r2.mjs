#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import {
  assertArchitectureResetToken,
  rowsFromWranglerJson,
  sha256Hex,
} from "./architecture-reset-safety.mjs";

export const INVENTORY_SCHEMA = "wasm-oj-platform/architecture-v2/r2-cleanup-manifest/v1";
export const TOMBSTONE_RECEIPT_SCHEMA = "wasm-oj-platform/architecture-v2/source-tombstone-receipt/v1";
export const SOURCE_TOMBSTONE = Buffer.from("WASM_OJ_SUBMISSION_SOURCE_ERASED_V2\n", "utf8");
export const MINIMUM_CLEANUP_DELAY_MS = 24 * 60 * 60 * 1_000;

const ROLE_PREFIXES = Object.freeze({
  "legacy-attempt-audit": ["audits/"],
  "legacy-canonical-object": ["snapshots/"],
  "legacy-canonical-source": ["snapshots/"],
  "legacy-erasure-receipt": ["account-erasure/", "receipts/", "erasure-receipts/"],
  "legacy-import-archive": ["imports/"],
  "legacy-judge-projection": ["snapshots/", "judge-projections/"],
  "legacy-public-projection": ["snapshots/", "public-projections/"],
  "legacy-release-manifest": ["releases/"],
  "legacy-submission-source": ["erased-source-tombstones/", "sources/", "submissions/", "submission-sources/"],
  "legacy-validation-report": ["reports/", "snapshots/", "validation-reports/"],
});
const OBSERVED_LEGACY_PREFIX_ROLES = Object.freeze([
  ["audits/", "legacy-attempt-audit"],
  ["account-erasure/", "legacy-erasure-receipt"],
  ["erased-source-tombstones/", "legacy-submission-source"],
  ["erasure-receipts/", "legacy-erasure-receipt"],
  ["imports/", "legacy-import-archive"],
  ["judge-projections/", "legacy-judge-projection"],
  ["public-projections/", "legacy-public-projection"],
  ["receipts/", "legacy-erasure-receipt"],
  ["releases/", "legacy-release-manifest"],
  ["reports/", "legacy-validation-report"],
  ["snapshots/", "legacy-canonical-object"],
  ["sources/", "legacy-submission-source"],
  ["submission-sources/", "legacy-submission-source"],
  ["submissions/", "legacy-submission-source"],
  ["validation-reports/", "legacy-validation-report"],
]);
const CONDITIONAL_JUDGE_PACKAGE_PREFIX = "judge-packages/v1/";

export const LEGACY_R2_INVENTORY_SQL = `SELECT role, object_key FROM (
  SELECT 'legacy-release-manifest' AS role, manifest_r2_key AS object_key FROM forge_releases
  UNION ALL SELECT 'legacy-import-archive', archive_r2_key FROM collection_imports
  UNION ALL SELECT 'legacy-validation-report', validation_report_r2_key FROM collection_imports
  UNION ALL SELECT 'legacy-canonical-source', canonical_source_r2_key FROM collection_imports
  UNION ALL SELECT 'legacy-canonical-object', object_key FROM collection_import_objects
  UNION ALL SELECT 'legacy-canonical-object', object_key FROM canonical_object_gc
  UNION ALL SELECT 'legacy-public-projection', public_projection_r2_key FROM managed_problem_versions
  UNION ALL SELECT 'legacy-judge-projection', judge_projection_r2_key FROM managed_problem_versions
  UNION ALL SELECT 'legacy-submission-source', source_r2_key FROM submissions
  UNION ALL SELECT 'legacy-attempt-audit', audit_r2_key FROM submission_attempts
  UNION ALL SELECT 'legacy-erasure-receipt', deletion_receipt_r2_key FROM account_erasure_jobs
  UNION ALL SELECT 'legacy-erasure-receipt', deletion_receipt_r2_key FROM erased_user_tombstones
) WHERE object_key IS NOT NULL ORDER BY object_key, role`;

export const CURRENT_ERASURE_RECEIPTS_SQL = `SELECT record_kind, record_id, receipt_json, receipt_sha256 FROM (
  SELECT 'job' AS record_kind, id AS record_id, receipt_json, receipt_sha256
  FROM account_erasure_jobs WHERE receipt_json IS NOT NULL
  UNION ALL
  SELECT 'tombstone', anonymous_user_id, receipt_json, receipt_sha256
  FROM erased_user_tombstones
) ORDER BY record_kind, record_id`;

function plainRecord(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object.`);
  }
  return value;
}

function exactKeys(value, expected) {
  return Object.keys(value).sort().join("\0") === [...expected].sort().join("\0");
}

function validKeyForRole(key, role) {
  const prefixes = ROLE_PREFIXES[role];
  return Array.isArray(prefixes)
    && typeof key === "string"
    && key.length > 1
    && key.length <= 1_024
    && !key.startsWith("/")
    && !key.includes("//")
    && !key.split("/").some((part) => part === "." || part === "..")
    && !/[\\\u0000-\u001f\u007f]/.test(key)
    && prefixes.some((prefix) => key.startsWith(prefix));
}

function observedObject(value) {
  const object = plainRecord(value, "Observed R2 object");
  if (
    typeof object.key !== "string"
    || !Number.isSafeInteger(object.size)
    || object.size < 0
    || (object.etag !== undefined && (typeof object.etag !== "string" || object.etag.length > 256))
  ) throw new TypeError("Observed R2 object metadata is invalid.");
  return object;
}

function observedLegacyRole(key) {
  return OBSERVED_LEGACY_PREFIX_ROLES.find(([prefix]) => key.startsWith(prefix))?.[1];
}

export function buildLegacyR2Inventory(rows, { bucket, generatedAt, observedObjects = [] }) {
  if (typeof bucket !== "string" || !/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(bucket)) {
    throw new TypeError("R2 inventory bucket name is invalid.");
  }
  if (!Number.isFinite(Date.parse(generatedAt))) throw new TypeError("R2 inventory timestamp is invalid.");
  const rolesByKey = new Map();
  for (const rowValue of rows) {
    const row = plainRecord(rowValue, "R2 inventory row");
    if (!validKeyForRole(row.object_key, row.role)) {
      throw new Error(`R2 inventory rejected ${JSON.stringify(row.role)} key ${JSON.stringify(row.object_key)}.`);
    }
    const roles = rolesByKey.get(row.object_key) ?? new Set();
    roles.add(row.role);
    rolesByKey.set(row.object_key, roles);
  }
  const observedByKey = new Map();
  const judgePackageCandidates = [];
  for (const value of observedObjects) {
    const object = observedObject(value);
    if (observedByKey.has(object.key)) throw new Error(`R2 listed duplicate key ${JSON.stringify(object.key)}.`);
    if (object.key.startsWith(CONDITIONAL_JUDGE_PACKAGE_PREFIX)) {
      const digest = object.key.slice(CONDITIONAL_JUDGE_PACKAGE_PREFIX.length);
      if (!/^[0-9a-f]{64}$/.test(digest)) {
        throw new Error(`R2 inventory rejected malformed judge package key ${JSON.stringify(object.key)}.`);
      }
      judgePackageCandidates.push({ key: object.key, sha256: digest, bytes: object.size, ...(object.etag === undefined ? {} : { etag: object.etag }) });
      observedByKey.set(object.key, object);
      continue;
    }
    const role = observedLegacyRole(object.key);
    if (!role || !validKeyForRole(object.key, role)) {
      throw new Error(`R2 inventory rejected unclassified bucket key ${JSON.stringify(object.key)}.`);
    }
    const roles = rolesByKey.get(object.key) ?? new Set();
    roles.add(role);
    rolesByKey.set(object.key, roles);
    observedByKey.set(object.key, object);
  }
  const objects = [...rolesByKey]
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([key, roles]) => {
      const observed = observedByKey.get(key);
      return {
        key,
        roles: [...roles].sort(),
        observed: observed !== undefined,
        ...(observed === undefined ? {} : { bytes: observed.size, ...(observed.etag === undefined ? {} : { etag: observed.etag }) }),
      };
    });
  judgePackageCandidates.sort((left, right) => left.key < right.key ? -1 : left.key > right.key ? 1 : 0);
  return Object.freeze({
    schema: INVENTORY_SCHEMA,
    bucket,
    generatedAt,
    deleteNotBefore: new Date(Date.parse(generatedAt) + MINIMUM_CLEANUP_DELAY_MS).toISOString(),
    objects,
    judgePackageCandidates,
  });
}

export function parseLegacyR2Inventory(bytes, expectedBucket) {
  let value;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch (error) {
    throw new TypeError("R2 cleanup manifest is not valid UTF-8 JSON.", { cause: error });
  }
  const manifest = plainRecord(value, "R2 cleanup manifest");
  if (
    !exactKeys(manifest, ["schema", "bucket", "generatedAt", "deleteNotBefore", "objects", "judgePackageCandidates"])
    || manifest.schema !== INVENTORY_SCHEMA
    || typeof manifest.bucket !== "string"
    || !/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(manifest.bucket)
    || (expectedBucket !== undefined && manifest.bucket !== expectedBucket)
    || !Number.isFinite(Date.parse(manifest.generatedAt))
    || !Number.isFinite(Date.parse(manifest.deleteNotBefore))
    || Date.parse(manifest.deleteNotBefore) - Date.parse(manifest.generatedAt) < MINIMUM_CLEANUP_DELAY_MS
    || !Array.isArray(manifest.objects)
    || !Array.isArray(manifest.judgePackageCandidates)
  ) throw new TypeError("R2 cleanup manifest header is invalid.");
  let previous = "";
  for (const entryValue of manifest.objects) {
    const entry = plainRecord(entryValue, "R2 cleanup manifest entry");
    if (
      typeof entry.key !== "string"
      || entry.key <= previous
      || !Array.isArray(entry.roles)
      || entry.roles.length === 0
      || typeof entry.observed !== "boolean"
      || !exactKeys(entry, entry.observed ? ["key", "roles", "observed", "bytes", ...(entry.etag === undefined ? [] : ["etag"])] : ["key", "roles", "observed"])
      || (entry.observed && (!Number.isSafeInteger(entry.bytes) || entry.bytes < 0))
      || (!entry.observed && (entry.bytes !== undefined || entry.etag !== undefined))
      || entry.roles.some((role, index) => !validKeyForRole(entry.key, role) || (index > 0 && role <= entry.roles[index - 1]))
    ) throw new TypeError("R2 cleanup manifest entries are invalid or non-canonical.");
    previous = entry.key;
  }
  previous = "";
  for (const entryValue of manifest.judgePackageCandidates) {
    const entry = plainRecord(entryValue, "R2 judge-package candidate entry");
    if (
      typeof entry.key !== "string"
      || entry.key <= previous
      || !/^[0-9a-f]{64}$/.test(entry.sha256)
      || entry.key !== `${CONDITIONAL_JUDGE_PACKAGE_PREFIX}${entry.sha256}`
      || !exactKeys(entry, ["key", "sha256", "bytes", ...(entry.etag === undefined ? [] : ["etag"])])
      || !Number.isSafeInteger(entry.bytes)
      || entry.bytes < 0
      || (entry.etag !== undefined && (typeof entry.etag !== "string" || entry.etag.length > 256))
    ) {
      throw new TypeError("R2 judge-package candidate inventory is invalid or non-canonical.");
    }
    previous = entry.key;
  }
  return manifest;
}

export async function listRemoteR2Objects({
  accountId,
  bucket,
  apiToken,
  fetchImpl = fetch,
  maximumObjects = 250_000,
}) {
  if (typeof accountId !== "string" || !/^[0-9a-f]{32}$/.test(accountId)) {
    throw new TypeError("Cloudflare account ID is invalid.");
  }
  if (typeof bucket !== "string" || !/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(bucket)) {
    throw new TypeError("R2 bucket name is invalid.");
  }
  if (typeof apiToken !== "string" || apiToken.length < 20) {
    throw new TypeError("Cloudflare API token is required to inventory R2.");
  }
  if (!Number.isSafeInteger(maximumObjects) || maximumObjects < 1) {
    throw new TypeError("R2 inventory object limit is invalid.");
  }
  const objects = [];
  const cursors = new Set();
  let cursor;
  do {
    const url = new URL(`https://api.cloudflare.com/client/v4/accounts/${accountId}/r2/buckets/${encodeURIComponent(bucket)}/objects`);
    url.searchParams.set("per_page", "1000");
    if (cursor) url.searchParams.set("cursor", cursor);
    const response = await fetchImpl(url, {
      headers: { accept: "application/json", authorization: `Bearer ${apiToken}` },
    });
    if (!response.ok) throw new Error(`Cloudflare R2 inventory returned HTTP ${response.status}.`);
    const page = await response.json();
    if (!page || page.success !== true || !Array.isArray(page.result) || !page.result_info) {
      throw new TypeError("Cloudflare R2 inventory returned an invalid response.");
    }
    for (const value of page.result) {
      const object = observedObject(value);
      objects.push({ key: object.key, size: object.size, ...(object.etag === undefined ? {} : { etag: object.etag }) });
      if (objects.length > maximumObjects) throw new Error(`R2 inventory exceeds ${maximumObjects} objects.`);
    }
    const next = page.result_info.cursor;
    if (page.result_info.is_truncated === true || (typeof next === "string" && next.length > 0)) {
      if (typeof next !== "string" || next.length === 0 || cursors.has(next)) {
        throw new Error("Cloudflare R2 inventory pagination cursor is invalid or repeated.");
      }
      cursors.add(next);
      cursor = next;
    } else {
      cursor = undefined;
    }
  } while (cursor);
  return objects;
}

function cloudflareCredentials() {
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  const apiToken = process.env.CLOUDFLARE_API_TOKEN;
  if (typeof accountId !== "string" || !/^[0-9a-f]{32}$/.test(accountId)) {
    throw new TypeError("CLOUDFLARE_ACCOUNT_ID is invalid.");
  }
  if (typeof apiToken !== "string" || apiToken.length < 20) {
    throw new TypeError("CLOUDFLARE_API_TOKEN is required for R2 operations.");
  }
  return { accountId, apiToken };
}

export function r2ObjectApiUrl(accountId, bucket, key) {
  const encodedKey = key.split("/").map((part) => encodeURIComponent(part)).join("/");
  return `https://api.cloudflare.com/client/v4/accounts/${accountId}/r2/buckets/${encodeURIComponent(bucket)}/objects/${encodedKey}`;
}

async function mapConcurrent(values, concurrency, operation) {
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (next < values.length) {
      const index = next;
      next += 1;
      await operation(values[index]);
    }
  });
  await Promise.all(workers);
}

async function overwriteAndVerifySource(bucket, key, credentials) {
  const url = r2ObjectApiUrl(credentials.accountId, bucket, key);
  const authorization = `Bearer ${credentials.apiToken}`;
  const put = await fetch(url, {
    method: "PUT",
    headers: { authorization, "content-type": "application/octet-stream" },
    body: SOURCE_TOMBSTONE,
  });
  if (!put.ok) throw new Error(`Source tombstone PUT failed for ${JSON.stringify(key)} with HTTP ${put.status}.`);
  const get = await fetch(url, { headers: { authorization } });
  if (!get.ok) throw new Error(`Source tombstone verification failed for ${JSON.stringify(key)} with HTTP ${get.status}.`);
  const verified = Buffer.from(await get.arrayBuffer());
  if (!verified.equals(SOURCE_TOMBSTONE)) {
    throw new Error(`Source tombstone verification returned different bytes for ${JSON.stringify(key)}.`);
  }
}

async function deleteExactObject(bucket, key, credentials) {
  const response = await fetch(r2ObjectApiUrl(credentials.accountId, bucket, key), {
    method: "DELETE",
    headers: { authorization: `Bearer ${credentials.apiToken}` },
  });
  if (!response.ok && response.status !== 404) {
    throw new Error(`Exact R2 delete failed for ${JSON.stringify(key)} with HTTP ${response.status}.`);
  }
}

function currentJudgePackageDigests(database, config) {
  const stdout = runWrangler([
    "d1", "execute", database, "--remote", "--config", config,
    "--json", "--command", "SELECT sha256 FROM judge_packages ORDER BY sha256",
  ]);
  return new Set(rowsFromWranglerJson(stdout, "Current judge package inventory").map((row) => {
    if (!row || typeof row.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(row.sha256)) {
      throw new TypeError("Current judge package inventory contains an invalid digest.");
    }
    return row.sha256;
  }));
}

export function assertErasureReceiptDigests(rows) {
  if (!Array.isArray(rows)) throw new TypeError("Current erasure receipt query did not return rows.");
  for (const row of rows) {
    if (
      !row
      || typeof row !== "object"
      || Array.isArray(row)
      || (row.record_kind !== "job" && row.record_kind !== "tombstone")
      || typeof row.record_id !== "string"
      || row.record_id.length === 0
      || typeof row.receipt_json !== "string"
      || typeof row.receipt_sha256 !== "string"
      || !/^[0-9a-f]{64}$/.test(row.receipt_sha256)
      || sha256Hex(Buffer.from(row.receipt_json, "utf8")) !== row.receipt_sha256
    ) throw new Error("D1 erasure receipt JSON does not match its stored SHA-256; legacy R2 cleanup is blocked.");
  }
  return rows.length;
}

function verifyCurrentErasureReceipts(database, config) {
  const stdout = runWrangler([
    "d1", "execute", database, "--remote", "--config", config,
    "--json", "--command", CURRENT_ERASURE_RECEIPTS_SQL,
  ]);
  return assertErasureReceiptDigests(rowsFromWranglerJson(stdout, "Current erasure receipt verification"));
}

export function buildTombstoneReceipt(manifestBytes, manifest, tombstonedAt) {
  if (!Number.isFinite(Date.parse(tombstonedAt))) throw new TypeError("Tombstone timestamp is invalid.");
  return {
    schema: TOMBSTONE_RECEIPT_SCHEMA,
    inventorySha256: sha256Hex(manifestBytes),
    tombstoneSha256: sha256Hex(SOURCE_TOMBSTONE),
    tombstonedAt,
    keys: manifest.objects
      .filter((entry) => entry.roles.includes("legacy-submission-source"))
      .map((entry) => entry.key),
  };
}

export function assertTombstoneReceipt(manifestBytes, manifest, receiptValue) {
  const receipt = plainRecord(receiptValue, "Source tombstone receipt");
  const expected = buildTombstoneReceipt(manifestBytes, manifest, receipt.tombstonedAt);
  if (JSON.stringify(receipt) !== JSON.stringify(expected)) {
    throw new Error("Source tombstone receipt does not cover the exact inventory source keys.");
  }
  return receipt;
}

export function assertCleanupDelayElapsed(manifest, now = new Date()) {
  const nowMs = now instanceof Date ? now.getTime() : Number.NaN;
  if (!Number.isFinite(nowMs) || nowMs < Date.parse(manifest.deleteNotBefore)) {
    throw new Error(`R2 cleanup is blocked until ${manifest.deleteNotBefore}.`);
  }
}

function wranglerExecutable() {
  return path.resolve(process.cwd(), "node_modules/.bin/wrangler");
}

function runWrangler(args, encoding = "utf8") {
  return execFileSync(wranglerExecutable(), args, {
    encoding,
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "inherit"],
  });
}

function requireResetToken() {
  assertArchitectureResetToken(
    process.env.WASM_OJ_ARCHITECTURE_RESET_TOKEN_PROVIDED,
    process.env.WASM_OJ_ARCHITECTURE_RESET_TOKEN,
  );
}

async function inventory(values) {
  const stdout = runWrangler([
    "d1", "execute", values.database, "--remote", "--config", values.config,
    "--json", "--command", LEGACY_R2_INVENTORY_SQL,
  ]);
  const observedObjects = await listRemoteR2Objects({
    accountId: process.env.CLOUDFLARE_ACCOUNT_ID,
    bucket: values.bucket,
    apiToken: process.env.CLOUDFLARE_API_TOKEN,
  });
  const manifest = buildLegacyR2Inventory(rowsFromWranglerJson(stdout, "R2 inventory query"), {
    bucket: values.bucket,
    generatedAt: new Date().toISOString(),
    observedObjects,
  });
  await writeFile(values.output, `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx" });
  process.stdout.write(`${JSON.stringify({
    inventory: values.output,
    legacyObjects: manifest.objects.length,
    judgePackageCandidates: manifest.judgePackageCandidates.length,
  })}\n`);
}

async function tombstone(values) {
  requireResetToken();
  const manifestBytes = await readFile(values.manifest);
  const manifest = parseLegacyR2Inventory(manifestBytes, values.bucket);
  const credentials = cloudflareCredentials();
  const keys = manifest.objects
    .filter((entry) => entry.roles.includes("legacy-submission-source"))
    .map((entry) => entry.key);
  await mapConcurrent(keys, 16, (key) => overwriteAndVerifySource(manifest.bucket, key, credentials));
  const receipt = buildTombstoneReceipt(manifestBytes, manifest, new Date().toISOString());
  await writeFile(values.receipt, `${JSON.stringify(receipt, null, 2)}\n`, { flag: "wx" });
  process.stdout.write(`${JSON.stringify({ receipt: values.receipt, tombstonedSources: keys.length })}\n`);
}

async function cleanup(values) {
  requireResetToken();
  const manifestBytes = await readFile(values.manifest);
  const manifest = parseLegacyR2Inventory(manifestBytes, values.bucket);
  const receipt = JSON.parse(await readFile(values.receipt, "utf8"));
  assertTombstoneReceipt(manifestBytes, manifest, receipt);
  assertCleanupDelayElapsed(manifest);
  const verifiedErasureReceipts = verifyCurrentErasureReceipts(values.database, values.config);
  const credentials = cloudflareCredentials();
  const currentPackages = currentJudgePackageDigests(values.database, values.config);
  const unreferencedPackages = manifest.judgePackageCandidates
    .filter((entry) => !currentPackages.has(entry.sha256));
  const deletions = [...manifest.objects, ...unreferencedPackages];
  await mapConcurrent(deletions, 16, ({ key }) => deleteExactObject(manifest.bucket, key, credentials));
  process.stdout.write(`${JSON.stringify({
    deletedExactKeys: deletions.length,
    retainedCurrentJudgePackages: manifest.judgePackageCandidates.length - unreferencedPackages.length,
    verifiedErasureReceipts,
    bucket: manifest.bucket,
  })}\n`);
}

function usage() {
  return `Usage:
  node scripts/architecture-reset-r2.mjs inventory --database DB --bucket <bucket> --config <config> --output <manifest>
  node scripts/architecture-reset-r2.mjs tombstone --bucket <bucket> --config <config> --manifest <manifest> --receipt <receipt>
  node scripts/architecture-reset-r2.mjs cleanup --database DB --bucket <bucket> --config <config> --manifest <manifest> --receipt <receipt>

Tombstone and cleanup require matching WASM_OJ_ARCHITECTURE_RESET_TOKEN and
WASM_OJ_ARCHITECTURE_RESET_TOKEN_PROVIDED environment values. Cleanup deletes
only exact manifest keys and refuses to run until 24 hours after inventory.
`;
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  const { values } = parseArgs({
    args,
    options: {
      database: { type: "string", default: "DB" },
      bucket: { type: "string" },
      config: { type: "string", default: "wrangler.quick-production.jsonc" },
      output: { type: "string" },
      manifest: { type: "string" },
      receipt: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
    strict: true,
  });
  if (values.help) return process.stdout.write(usage());
  if (command === "inventory" && values.bucket && values.output) return inventory(values);
  if (command === "tombstone" && values.bucket && values.manifest && values.receipt) return tombstone(values);
  if (command === "cleanup" && values.bucket && values.manifest && values.receipt) return cleanup(values);
  throw new TypeError(usage());
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
