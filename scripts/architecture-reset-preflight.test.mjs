import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  ARCHITECTURE_RESET_PREFLIGHT_SQL,
  LEGACY_ERASURE_RECEIPT_SCHEMA,
  MAXIMUM_LEGACY_ERASURE_RECEIPT_BYTES,
  assertArchitectureResetPreflight,
  assertArchitectureResetQuiescence,
  assertStagedLegacyErasureReceipts,
  buildLegacyErasureReceiptStageSql,
  fetchExactLegacyErasureReceiptRecords,
  parseExactLegacyErasureReceipt,
} from "./architecture-reset-preflight.mjs";
import { buildLegacyR2Inventory } from "./architecture-reset-r2.mjs";

const zeroCounts = () => ({
  enabled_formal_environments: 0,
  missing_formal_controls: 0,
  nonterminal_account_erasures: 0,
  inconsistent_legacy_erasure_receipts: 0,
  active_collection_imports: 0,
  active_submissions: 0,
  active_rejudge_batches: 0,
  pending_outbox: 0,
});

test("architecture reset preflight requires D1 quiescence, inventory, and source tombstones", () => {
  assert.deepEqual(assertArchitectureResetPreflight(zeroCounts(), {
    workflowsDrained: true,
    inventoryRecorded: true,
    legacySourcesTombstoned: true,
  }), zeroCounts());
  assert.throws(
    () => assertArchitectureResetPreflight(zeroCounts(), { workflowsDrained: true, inventoryRecorded: true }),
    /legacy_sources_not_confirmed_tombstoned/,
  );
  assert.throws(
    () => assertArchitectureResetPreflight({ ...zeroCounts(), active_submissions: 2 }, {
      workflowsDrained: true,
      inventoryRecorded: true,
      legacySourcesTombstoned: true,
    }),
    /active_submissions=2/,
  );
});

test("architecture reset preflight rejects malformed Wrangler counts", () => {
  assert.throws(
    () => assertArchitectureResetPreflight({ ...zeroCounts(), pending_outbox: "0" }, {
      workflowsDrained: true,
      inventoryRecorded: true,
      legacySourcesTombstoned: true,
    }),
    /invalid pending_outbox count/,
  );
  assert.match(ARCHITECTURE_RESET_PREFLIGHT_SQL, /status NOT IN \('completed', 'failed'\)/);
  assert.match(ARCHITECTURE_RESET_PREFLIGHT_SQL, /formal_mutations_enabled <> 0/);
  assert.match(ARCHITECTURE_RESET_PREFLIGHT_SQL, /AS missing_formal_controls/);
  assert.match(ARCHITECTURE_RESET_PREFLIGHT_SQL, /AS inconsistent_legacy_erasure_receipts/);
});

test("pre-tombstone quiescence rejects active D1 work without reset artifacts", () => {
  assert.deepEqual(assertArchitectureResetQuiescence(zeroCounts(), { workflowsDrained: true }), zeroCounts());
  assert.throws(
    () => assertArchitectureResetQuiescence({ ...zeroCounts(), active_rejudge_batches: 1 }, { workflowsDrained: true }),
    /active_rejudge_batches=1/,
  );
  assert.throws(() => assertArchitectureResetQuiescence(zeroCounts()), /external_workflows_not_confirmed_drained/);
});

function legacyReceiptBytes({
  jobId = "job-1",
  anonymousUserId = "anonymous-1",
  erasedAt = "2026-08-12T00:00:00.000Z",
} = {}) {
  return Buffer.from(`${JSON.stringify({
    schema: LEGACY_ERASURE_RECEIPT_SCHEMA,
    jobId,
    anonymousUserId,
    erasedAt,
    deletedSourceObjects: 2,
    affectedProblems: 1,
    affectedContests: 0,
  })}\n`, "utf8");
}

function receiptRow(bytes, overrides = {}) {
  return {
    record_kind: "job",
    record_id: "job-1",
    anonymous_user_id: "anonymous-1",
    erased_at: "2026-08-12T00:00:00.000Z",
    receipt_r2_key: "receipts/job-1.json",
    receipt_sha256: createHash("sha256").update(bytes).digest("hex"),
    ...overrides,
  };
}

test("full preflight fetches and stages exact canonical v1 receipt bytes", async () => {
  const bytes = legacyReceiptBytes();
  const row = receiptRow(bytes);
  const inventory = buildLegacyR2Inventory([
    { role: "legacy-erasure-receipt", object_key: row.receipt_r2_key },
  ], {
    bucket: "wasm-oj-judge-production",
    generatedAt: "2026-08-12T00:00:00.000Z",
    observedObjects: [{ key: row.receipt_r2_key, size: bytes.length }],
  });
  let request;
  const records = await fetchExactLegacyErasureReceiptRecords([row], inventory, {
    accountId: "a".repeat(32),
    apiToken: "token".repeat(8),
    fetchImpl: async (url, init) => {
      request = { url, init };
      return new Response(bytes);
    },
  });
  assert.equal(records[0].receipt_json, bytes.toString("utf8"));
  assert.equal(records[0].receipt_sha256, row.receipt_sha256);
  assert.match(request.url, /wasm-oj-judge-production\/objects\/receipts\/job-1\.json$/);
  assert.match(request.init.headers.authorization, /^Bearer /);
  assert.deepEqual(assertStagedLegacyErasureReceipts(records, records), records);
  assert.match(buildLegacyErasureReceiptStageSql(records), /forge-account-erasure-receipt-v1/);
  assert.throws(
    () => assertStagedLegacyErasureReceipts(records, [{ ...records[0], receipt_json: records[0].receipt_json.trim() }]),
    /exact canonical R2 record/,
  );
});

test("legacy receipt loading rejects missing inventory bytes, digest drift, invalid UTF-8, and identity drift", async () => {
  const bytes = legacyReceiptBytes();
  const row = receiptRow(bytes);
  const missing = buildLegacyR2Inventory([
    { role: "legacy-erasure-receipt", object_key: row.receipt_r2_key },
  ], { bucket: "wasm-oj-judge-production", generatedAt: "2026-08-12T00:00:00.000Z" });
  await assert.rejects(
    fetchExactLegacyErasureReceiptRecords([row], missing, {
      accountId: "a".repeat(32), apiToken: "token".repeat(8), fetchImpl: async () => new Response(bytes),
    }),
    /observed, bounded inventory entry/,
  );
  const exactInventory = buildLegacyR2Inventory([
    { role: "legacy-erasure-receipt", object_key: row.receipt_r2_key },
  ], {
    bucket: "wasm-oj-judge-production",
    generatedAt: "2026-08-12T00:00:00.000Z",
    observedObjects: [{ key: row.receipt_r2_key, size: bytes.length }],
  });
  await assert.rejects(
    fetchExactLegacyErasureReceiptRecords([row], exactInventory, {
      accountId: "a".repeat(32),
      apiToken: "token".repeat(8),
      fetchImpl: async () => new Response(Buffer.concat([bytes, Buffer.from("x")])),
    }),
    /exceeded the bounded inventory size|Content-Length does not match/,
  );
  assert.throws(
    () => parseExactLegacyErasureReceipt({ ...row, receipt_sha256: "b".repeat(64) }, bytes),
    /do not match the D1 SHA-256/,
  );
  const invalidUtf8 = Buffer.from([0xc3, 0x28]);
  assert.throws(
    () => parseExactLegacyErasureReceipt(receiptRow(invalidUtf8), invalidUtf8),
    /fatal UTF-8 JSON/,
  );
  const otherIdentity = legacyReceiptBytes({ anonymousUserId: "anonymous-2" });
  assert.throws(
    () => parseExactLegacyErasureReceipt(receiptRow(otherIdentity), otherIdentity),
    /canonical v1 shape/,
  );
  const pretty = Buffer.from(`${JSON.stringify(JSON.parse(bytes.toString("utf8")), null, 2)}\n`, "utf8");
  assert.throws(
    () => parseExactLegacyErasureReceipt(receiptRow(pretty), pretty),
    /canonical v1 shape/,
  );
  const oversized = buildLegacyR2Inventory([
    { role: "legacy-erasure-receipt", object_key: row.receipt_r2_key },
  ], {
    bucket: "wasm-oj-judge-production",
    generatedAt: "2026-08-12T00:00:00.000Z",
    observedObjects: [{ key: row.receipt_r2_key, size: MAXIMUM_LEGACY_ERASURE_RECEIPT_BYTES + 1 }],
  });
  await assert.rejects(
    fetchExactLegacyErasureReceiptRecords([row], oversized, {
      accountId: "a".repeat(32), apiToken: "token".repeat(8), fetchImpl: async () => new Response(bytes),
    }),
    /observed, bounded inventory entry/,
  );
  const tombstoneBytes = legacyReceiptBytes({ jobId: "historic-job" });
  const tombstone = receiptRow(tombstoneBytes, {
    record_kind: "tombstone",
    record_id: "anonymous-1",
    receipt_r2_key: "receipts/tombstone.json",
  });
  assert.equal(parseExactLegacyErasureReceipt(tombstone, tombstoneBytes).record_id, "anonymous-1");
  assert.throws(
    () => parseExactLegacyErasureReceipt({ ...tombstone, erased_at: "2026-08-13T00:00:00.000Z" }, tombstoneBytes),
    /canonical v1 shape/,
  );
});
