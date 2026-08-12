#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { assertArchitectureResetToken, rowsFromWranglerJson, sha256Hex } from "./architecture-reset-safety.mjs";
import { assertTombstoneReceipt, parseLegacyR2Inventory, r2ObjectApiUrl } from "./architecture-reset-r2.mjs";

export const LEGACY_ERASURE_RECEIPT_SCHEMA = "forge-account-erasure-receipt-v1";
export const MAXIMUM_LEGACY_ERASURE_RECEIPT_BYTES = 64 * 1_024;

export const LEGACY_ERASURE_RECEIPTS_SQL = `SELECT
  record_kind, record_id, anonymous_user_id, erased_at,
  receipt_r2_key, receipt_sha256
FROM (
  SELECT 'job' AS record_kind, id AS record_id, anonymous_user_id,
    requested_at AS erased_at, deletion_receipt_r2_key AS receipt_r2_key,
    deletion_receipt_sha256 AS receipt_sha256
  FROM account_erasure_jobs
  WHERE deletion_receipt_sha256 IS NOT NULL
  UNION ALL
  SELECT 'tombstone', anonymous_user_id, anonymous_user_id, erased_at,
    deletion_receipt_r2_key, deletion_receipt_sha256
  FROM erased_user_tombstones
) ORDER BY record_kind, record_id`;

export const STAGED_ERASURE_RECEIPTS_SQL = `SELECT
  record_kind, record_id, anonymous_user_id, erased_at, receipt_r2_key,
  receipt_json, receipt_sha256
FROM architecture_reset_erasure_receipts
ORDER BY record_kind, record_id`;

export const ARCHITECTURE_RESET_PREFLIGHT_SQL = `SELECT
  (SELECT COUNT(*) FROM formal_mutation_controls
    WHERE environment IN ('staging', 'production') AND formal_mutations_enabled <> 0)
    AS enabled_formal_environments,
  (2 - (SELECT COUNT(*) FROM formal_mutation_controls
    WHERE environment IN ('staging', 'production'))) AS missing_formal_controls,
  (SELECT COUNT(*) FROM account_erasure_jobs
    WHERE status NOT IN ('completed', 'failed')) AS nonterminal_account_erasures,
  (SELECT COUNT(*) FROM account_erasure_jobs
    WHERE (deletion_receipt_r2_key IS NULL) <> (deletion_receipt_sha256 IS NULL)
      OR (status = 'completed' AND (completed_at IS NULL OR deletion_receipt_sha256 IS NULL)))
    AS inconsistent_legacy_erasure_receipts,
  (SELECT COUNT(*) FROM collection_imports
    WHERE status IN ('queued', 'downloading', 'validating')) AS active_collection_imports,
  (SELECT COUNT(*) FROM submissions
    WHERE state IN ('admitting', 'queued', 'waiting-capacity', 'preparing', 'compiling', 'running', 'finalizing'))
    AS active_submissions,
  (SELECT COUNT(*) FROM rejudge_batches
    WHERE status IN ('queued', 'running', 'ready')) AS active_rejudge_batches,
  (SELECT COUNT(*) FROM outbox WHERE delivered_at IS NULL) AS pending_outbox`;

const COUNT_FIELDS = [
  "enabled_formal_environments",
  "missing_formal_controls",
  "nonterminal_account_erasures",
  "inconsistent_legacy_erasure_receipts",
  "active_collection_imports",
  "active_submissions",
  "active_rejudge_batches",
  "pending_outbox",
];

function sqlString(value) {
  return `'${value.replaceAll("'", "''")}'`;
}

function validateLegacyErasureReceiptRows(rows) {
  if (!Array.isArray(rows)) throw new TypeError("Legacy erasure receipt query did not return rows.");
  const validated = [];
  const identities = new Set();
  for (const row of rows) {
    if (!row || typeof row !== "object" || Array.isArray(row)) {
      throw new TypeError("Legacy erasure receipt row is invalid.");
    }
    if (row.record_kind !== "job" && row.record_kind !== "tombstone") {
      throw new TypeError("Legacy erasure receipt row has an invalid record kind.");
    }
    if (
      typeof row.record_id !== "string"
      || row.record_id.length < 1
      || row.record_id.length > 1_024
      || /[\u0000-\u001f\u007f]/.test(row.record_id)
    ) throw new TypeError("Legacy erasure receipt row has an invalid record ID.");
    if (
      typeof row.anonymous_user_id !== "string"
      || row.anonymous_user_id.length < 1
      || row.anonymous_user_id.length > 1_024
      || /[\u0000-\u001f\u007f]/.test(row.anonymous_user_id)
    ) throw new TypeError("Legacy erasure receipt row has an invalid anonymous user ID.");
    if (typeof row.erased_at !== "string" || !Number.isFinite(Date.parse(row.erased_at))) {
      throw new TypeError("Legacy erasure receipt row has an invalid erasure timestamp.");
    }
    if (
      typeof row.receipt_r2_key !== "string"
      || row.receipt_r2_key.length < 1
      || row.receipt_r2_key.length > 1_024
      || /[\\\u0000-\u001f\u007f]/.test(row.receipt_r2_key)
    ) throw new TypeError("Legacy erasure receipt row has an invalid exact R2 key.");
    if (typeof row.receipt_sha256 !== "string" || !/^[0-9a-f]{64}$/.test(row.receipt_sha256)) {
      throw new TypeError("Legacy erasure receipt row has an invalid digest.");
    }
    const identity = `${row.record_kind}\0${row.record_id}`;
    if (identities.has(identity)) throw new Error("Legacy erasure receipt query returned a duplicate identity.");
    identities.add(identity);
    validated.push(Object.freeze({
      record_kind: row.record_kind,
      record_id: row.record_id,
      anonymous_user_id: row.anonymous_user_id,
      erased_at: row.erased_at,
      receipt_r2_key: row.receipt_r2_key,
      receipt_sha256: row.receipt_sha256,
    }));
  }
  validated.sort((left, right) => {
    const leftIdentity = `${left.record_kind}\0${left.record_id}`;
    const rightIdentity = `${right.record_kind}\0${right.record_id}`;
    return leftIdentity < rightIdentity ? -1 : leftIdentity > rightIdentity ? 1 : 0;
  });
  return Object.freeze(validated);
}

function exactReceiptKeys(value) {
  return Object.keys(value).join("\0") === [
    "schema",
    "jobId",
    "anonymousUserId",
    "erasedAt",
    "deletedSourceObjects",
    "affectedProblems",
    "affectedContests",
  ].join("\0");
}

export function parseExactLegacyErasureReceipt(rowValue, bytesValue) {
  const [row] = validateLegacyErasureReceiptRows([rowValue]);
  const bytes = Buffer.from(bytesValue);
  if (bytes.length < 2 || bytes.length > MAXIMUM_LEGACY_ERASURE_RECEIPT_BYTES) {
    throw new Error("Legacy erasure receipt exceeds its exact byte bounds.");
  }
  if (sha256Hex(bytes) !== row.receipt_sha256) {
    throw new Error("Legacy erasure receipt bytes do not match the D1 SHA-256.");
  }
  let receiptJson;
  let receipt;
  try {
    receiptJson = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    if (!Buffer.from(receiptJson, "utf8").equals(bytes)) {
      throw new TypeError("Legacy erasure receipt UTF-8 did not round-trip exactly.");
    }
    receipt = JSON.parse(receiptJson);
  } catch (error) {
    throw new TypeError("Legacy erasure receipt is not fatal UTF-8 JSON.", { cause: error });
  }
  if (
    !receipt
    || typeof receipt !== "object"
    || Array.isArray(receipt)
    || !exactReceiptKeys(receipt)
    || receipt.schema !== LEGACY_ERASURE_RECEIPT_SCHEMA
    || typeof receipt.jobId !== "string"
    || receipt.jobId.length < 1
    || receipt.jobId.length > 1_024
    || /[\u0000-\u001f\u007f]/.test(receipt.jobId)
    || receipt.anonymousUserId !== row.anonymous_user_id
    || receipt.erasedAt !== row.erased_at
    || (row.record_kind === "job" && receipt.jobId !== row.record_id)
    || ![receipt.deletedSourceObjects, receipt.affectedProblems, receipt.affectedContests]
      .every((count) => Number.isSafeInteger(count) && count >= 0)
    || receiptJson !== `${JSON.stringify(receipt)}\n`
  ) throw new Error("Legacy erasure receipt is not the canonical v1 shape for its D1 identity.");
  return Object.freeze({ ...row, receipt_json: receiptJson });
}

async function readBoundedResponse(response, expectedBytes) {
  const declaredLength = response.headers.get("content-length");
  if (declaredLength !== null) {
    const parsed = Number(declaredLength);
    if (!Number.isSafeInteger(parsed) || parsed !== expectedBytes) {
      throw new Error("Legacy erasure receipt Content-Length does not match the exact inventory.");
    }
  }
  if (!response.body) {
    if (expectedBytes !== 0) throw new Error("Legacy erasure receipt response has no body.");
    return Buffer.alloc(0);
  }
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAXIMUM_LEGACY_ERASURE_RECEIPT_BYTES || total > expectedBytes) {
      await reader.cancel();
      throw new Error("Legacy erasure receipt GET exceeded the bounded inventory size.");
    }
    chunks.push(Buffer.from(value));
  }
  if (total !== expectedBytes) throw new Error("Legacy erasure receipt GET was truncated.");
  return Buffer.concat(chunks, total);
}

export async function fetchExactLegacyErasureReceiptRecords(
  rows,
  inventory,
  { accountId, apiToken, fetchImpl = fetch },
) {
  if (typeof accountId !== "string" || !/^[0-9a-f]{32}$/.test(accountId)) {
    throw new TypeError("Cloudflare account ID is invalid for legacy receipt migration.");
  }
  if (typeof apiToken !== "string" || apiToken.length < 20) {
    throw new TypeError("Cloudflare API token is required for legacy receipt migration.");
  }
  if (
    !inventory
    || typeof inventory !== "object"
    || typeof inventory.bucket !== "string"
    || !Array.isArray(inventory.objects)
  ) throw new TypeError("Legacy receipt migration requires a parsed R2 inventory.");
  const validatedRows = validateLegacyErasureReceiptRows(rows);
  const entries = new Map(inventory.objects.map((entry) => [entry.key, entry]));
  const downloads = new Map();
  for (const row of validatedRows) {
    const entry = entries.get(row.receipt_r2_key);
    if (
      !entry
      || !Array.isArray(entry.roles)
      || !entry.roles.includes("legacy-erasure-receipt")
      || entry.observed !== true
      || !Number.isSafeInteger(entry.bytes)
      || entry.bytes < 2
      || entry.bytes > MAXIMUM_LEGACY_ERASURE_RECEIPT_BYTES
    ) throw new Error("Legacy erasure receipt is missing an observed, bounded inventory entry.");
    if (!downloads.has(row.receipt_r2_key)) downloads.set(row.receipt_r2_key, { entry });
  }
  const downloadEntries = [...downloads.entries()];
  let nextDownload = 0;
  await Promise.all(Array.from({ length: Math.min(8, downloadEntries.length) }, async () => {
    while (nextDownload < downloadEntries.length) {
      const index = nextDownload;
      nextDownload += 1;
      const [key, download] = downloadEntries[index];
      const response = await fetchImpl(r2ObjectApiUrl(accountId, inventory.bucket, key), {
        headers: { accept: "application/json", authorization: `Bearer ${apiToken}` },
      });
      if (!response.ok) {
        throw new Error(`Legacy erasure receipt GET failed with HTTP ${response.status}.`);
      }
      download.bytes = await readBoundedResponse(response, download.entry.bytes);
    }
  }));
  return Object.freeze(await Promise.all(validatedRows.map(async (row) => (
    parseExactLegacyErasureReceipt(row, downloads.get(row.receipt_r2_key).bytes)
  ))));
}

export function buildLegacyErasureReceiptStageSql(records) {
  const verified = records.map((record) => parseExactLegacyErasureReceipt(
    record,
    Buffer.from(record.receipt_json, "utf8"),
  ));
  if (JSON.stringify(verified) !== JSON.stringify(records)) {
    throw new Error("Legacy erasure receipt records are not exact canonical R2 records.");
  }
  return `DROP TABLE IF EXISTS architecture_reset_erasure_receipts;
CREATE TABLE architecture_reset_erasure_receipts (
  record_kind TEXT NOT NULL CHECK (record_kind IN ('job', 'tombstone')),
  record_id TEXT NOT NULL CHECK (length(record_id) BETWEEN 1 AND 1024),
  anonymous_user_id TEXT NOT NULL CHECK (length(anonymous_user_id) BETWEEN 1 AND 1024),
  erased_at TEXT NOT NULL,
  receipt_r2_key TEXT NOT NULL CHECK (length(receipt_r2_key) BETWEEN 1 AND 1024),
  receipt_json TEXT NOT NULL CHECK (
    json_valid(receipt_json)
    AND length(CAST(receipt_json AS BLOB)) BETWEEN 2 AND 65536
    AND substr(receipt_json, -1) = char(10)
    AND json_extract(receipt_json, '$.schema') IS 'forge-account-erasure-receipt-v1'
    AND json_extract(receipt_json, '$.anonymousUserId') IS anonymous_user_id
    AND json_extract(receipt_json, '$.erasedAt') IS erased_at
    AND (record_kind <> 'job' OR json_extract(receipt_json, '$.jobId') IS record_id)
  ),
  receipt_sha256 TEXT NOT NULL
    CHECK (length(receipt_sha256) = 64 AND receipt_sha256 NOT GLOB '*[^0-9a-f]*'),
  PRIMARY KEY (record_kind, record_id)
) STRICT;
${verified.map((record) => `INSERT INTO architecture_reset_erasure_receipts (
  record_kind, record_id, anonymous_user_id, erased_at, receipt_r2_key,
  receipt_json, receipt_sha256
) VALUES (${sqlString(record.record_kind)}, ${sqlString(record.record_id)},
  ${sqlString(record.anonymous_user_id)}, ${sqlString(record.erased_at)},
  ${sqlString(record.receipt_r2_key)}, ${sqlString(record.receipt_json)},
  ${sqlString(record.receipt_sha256)});`).join("\n")}`;
}

export function assertStagedLegacyErasureReceipts(expectedRecords, stagedRows) {
  const expected = expectedRecords.map((record) => parseExactLegacyErasureReceipt(
    record,
    Buffer.from(record.receipt_json, "utf8"),
  ));
  if (!Array.isArray(stagedRows) || stagedRows.length !== expected.length) {
    throw new Error("Staged erasure receipt count does not match the legacy records.");
  }
  for (let index = 0; index < expected.length; index += 1) {
    const actual = stagedRows[index];
    const wanted = expected[index];
    if (!actual || typeof actual !== "object" || Array.isArray(actual)) {
      throw new TypeError("Staged erasure receipt row is invalid.");
    }
    let verified;
    try {
      verified = parseExactLegacyErasureReceipt(actual, Buffer.from(actual.receipt_json, "utf8"));
    } catch (error) {
      throw new Error("Staged erasure receipt is not the exact canonical R2 record.", { cause: error });
    }
    if (JSON.stringify(verified) !== JSON.stringify(wanted)) {
      throw new Error("Staged erasure receipt does not match the exact R2 record.");
    }
  }
  return expected;
}

function validatedCounts(row) {
  if (!row || typeof row !== "object" || Array.isArray(row)) {
    throw new TypeError("Architecture reset preflight returned no count row.");
  }
  const violations = [];
  for (const field of COUNT_FIELDS) {
    const count = row[field];
    if (!Number.isSafeInteger(count) || count < 0) {
      throw new TypeError(`Architecture reset preflight returned an invalid ${field} count.`);
    }
    if (count !== 0) violations.push(`${field}=${count}`);
  }
  return {
    violations,
    counts: Object.freeze(Object.fromEntries(COUNT_FIELDS.map((field) => [field, row[field]]))),
  };
}

export function assertArchitectureResetQuiescence(row, { workflowsDrained = false } = {}) {
  const { violations, counts } = validatedCounts(row);
  if (!workflowsDrained) violations.push("external_workflows_not_confirmed_drained");
  if (violations.length !== 0) {
    throw new Error(`Architecture reset quiescence blocked: ${violations.join(", ")}.`);
  }
  return counts;
}

export function assertArchitectureResetPreflight(
  row,
  { workflowsDrained = false, inventoryRecorded = false, legacySourcesTombstoned = false } = {},
) {
  const counts = assertArchitectureResetQuiescence(row, { workflowsDrained });
  const violations = [];
  if (!inventoryRecorded) violations.push("legacy_r2_inventory_not_recorded");
  if (!legacySourcesTombstoned) violations.push("legacy_sources_not_confirmed_tombstoned");
  if (violations.length !== 0) {
    throw new Error(`Architecture reset preflight blocked: ${violations.join(", ")}.`);
  }
  return counts;
}

function extractCountRow(rows) {
  if (rows.length !== 1) {
    throw new Error(`Architecture reset preflight expected one D1 row, received ${rows.length}.`);
  }
  return rows[0];
}

function runD1Query(wrangler, values, command, label) {
  const stdout = execFileSync(wrangler, [
    "d1",
    "execute",
    values.database,
    values.remote ? "--remote" : "--local",
    "--config",
    values.config,
    "--json",
    "--command",
    command,
  ], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "inherit"] });
  return rowsFromWranglerJson(stdout, label);
}

function stageLegacyErasureReceipts(wrangler, values, records) {
  const directory = mkdtempSync(path.join(tmpdir(), "wasm-oj-architecture-reset-"));
  const filename = path.join(directory, "legacy-erasure-receipts.sql");
  try {
    writeFileSync(filename, buildLegacyErasureReceiptStageSql(records), { encoding: "utf8", flag: "wx" });
    execFileSync(wrangler, [
      "d1",
      "execute",
      values.database,
      values.remote ? "--remote" : "--local",
      "--config",
      values.config,
      "--yes",
      "--file",
      filename,
    ], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "inherit"] });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function usage() {
  return `Usage: node scripts/architecture-reset-preflight.mjs \\
  --database <binding-or-name> --config <wrangler.jsonc> (--remote | --local) \\
  --confirm-workflows-drained --inventory <cleanup-manifest.json> \\
  --tombstone-receipt <source-tombstone-receipt.json>

For the mandatory read-only check before any R2 write, replace the inventory
and receipt arguments with --quiescence-only.

The Workflow confirmation attests external state that D1 cannot inspect. The
manifest and receipt prove that every legacy R2 key was inventoried and every
legacy source key was overwritten and verified. A full preflight also stages
the exact canonical v1 JSON bytes from every referenced legacy R2 erasure
receipt, reads them back from D1, and verifies SHA-256 again. Quiescence-only
mode performs no R2 request and remains read-only.
The command requires an explicit reset token through
WASM_OJ_ARCHITECTURE_RESET_TOKEN_PROVIDED matching the protected
WASM_OJ_ARCHITECTURE_RESET_TOKEN value and must pass immediately before applying
0017_architecture_reset.
`;
}

async function main() {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      database: { type: "string" },
      config: { type: "string", default: "wrangler.quick-production.jsonc" },
      remote: { type: "boolean" },
      local: { type: "boolean" },
      "confirm-workflows-drained": { type: "boolean" },
      "quiescence-only": { type: "boolean" },
      inventory: { type: "string" },
      "tombstone-receipt": { type: "string" },
      help: { type: "boolean", short: "h" },
    },
    strict: true,
  });
  if (values.help) {
    process.stdout.write(usage());
    return;
  }
  if (Boolean(values.remote) === Boolean(values.local)) {
    throw new TypeError(`Choose exactly one of --remote or --local.\n\n${usage()}`);
  }
  if (!values.database) {
    throw new TypeError(`--database is required; use the immutable D1 database name.\n\n${usage()}`);
  }
  if (!values["quiescence-only"] && (!values.inventory || !values["tombstone-receipt"])) {
    throw new TypeError(`--inventory and --tombstone-receipt are required.\n\n${usage()}`);
  }
  assertArchitectureResetToken(
    process.env.WASM_OJ_ARCHITECTURE_RESET_TOKEN_PROVIDED,
    process.env.WASM_OJ_ARCHITECTURE_RESET_TOKEN,
  );
  let inventoryBytes;
  let inventory;
  if (!values["quiescence-only"]) {
    inventoryBytes = readFileSync(values.inventory);
    inventory = parseLegacyR2Inventory(inventoryBytes);
    const receipt = JSON.parse(readFileSync(values["tombstone-receipt"], "utf8"));
    assertTombstoneReceipt(inventoryBytes, inventory, receipt);
  }
  const wrangler = path.resolve(process.cwd(), "node_modules/.bin/wrangler");
  const countRows = runD1Query(
    wrangler,
    values,
    ARCHITECTURE_RESET_PREFLIGHT_SQL,
    "Architecture reset preflight",
  );
  const row = extractCountRow(countRows);
  if (values["quiescence-only"]) {
    const counts = assertArchitectureResetQuiescence(row, {
      workflowsDrained: values["confirm-workflows-drained"] === true,
    });
    process.stdout.write(`${JSON.stringify({ quiescentBeforeR2Writes: true, counts }, null, 2)}\n`);
    return;
  }
  const counts = assertArchitectureResetPreflight(row, {
    workflowsDrained: values["confirm-workflows-drained"] === true,
    inventoryRecorded: true,
    legacySourcesTombstoned: true,
  });
  const legacyReceiptRows = runD1Query(
    wrangler, values, LEGACY_ERASURE_RECEIPTS_SQL, "Legacy erasure receipt inventory",
  );
  const legacyReceiptRecords = await fetchExactLegacyErasureReceiptRecords(
    legacyReceiptRows,
    inventory,
    {
      accountId: process.env.CLOUDFLARE_ACCOUNT_ID,
      apiToken: process.env.CLOUDFLARE_API_TOKEN,
    },
  );
  stageLegacyErasureReceipts(wrangler, values, legacyReceiptRecords);
  assertStagedLegacyErasureReceipts(legacyReceiptRecords, runD1Query(
    wrangler,
    values,
    STAGED_ERASURE_RECEIPTS_SQL,
    "Staged erasure receipt verification",
  ));
  process.stdout.write(`${JSON.stringify({
    safeToApply: "0017_architecture_reset.sql",
    inventorySha256: sha256Hex(inventoryBytes),
    stagedErasureReceipts: legacyReceiptRecords.length,
    counts,
  }, null, 2)}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
