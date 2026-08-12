import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import test from "node:test";
import {
  LEGACY_R2_INVENTORY_QUERIES,
  MINIMUM_CLEANUP_DELAY_MS,
  SOURCE_TOMBSTONE,
  assertCleanupDelayElapsed,
  assertErasureReceiptDigests,
  assertTombstoneReceipt,
  buildLegacyR2Inventory,
  buildTombstoneReceipt,
  collectLegacyR2InventoryRows,
  listRemoteR2Objects,
  parseLegacyR2Inventory,
  r2ObjectApiUrl,
} from "./architecture-reset-r2.mjs";

const generatedAt = "2026-08-12T00:00:00.000Z";

test("legacy inventory SQL executes against the immutable production schema", () => {
  const database = new DatabaseSync(":memory:");
  const migrations = readdirSync(path.join(process.cwd(), "migrations/core"))
    .filter((filename) => filename.endsWith(".sql") && filename < "0017_architecture_reset.sql")
    .sort();
  for (const migration of migrations) {
    database.exec(readFileSync(path.join(process.cwd(), "migrations/core", migration), "utf8"));
  }
  database.prepare(`INSERT INTO forge_releases (
    id, version, manifest_r2_key, manifest_sha256, source_git_commit, status, created_at
  ) VALUES ('release-1', 'v1', 'releases/v1.json', ?, ?, 'active', ?)`)
    .run("a".repeat(64), "b".repeat(40), generatedAt);

  assert.equal(LEGACY_R2_INVENTORY_QUERIES.length, 12);
  assert.equal(LEGACY_R2_INVENTORY_QUERIES.some((query) => /\bUNION\b/u.test(query)), false);
  const rows = LEGACY_R2_INVENTORY_QUERIES.flatMap((query) => (
    database.prepare(query).all().map((row) => ({ ...row }))
  ));
  assert.deepEqual(
    rows.filter((row) => row.role === "legacy-release-manifest"),
    [{ role: "legacy-release-manifest", object_key: "releases/v1.json" }],
  );
});

test("legacy inventory executes every bounded query and rejects a partial result", () => {
  const calls = [];
  const rows = collectLegacyR2InventoryRows((query, index) => {
    calls.push(query);
    return JSON.stringify([{
      results: [{ role: "legacy-release-manifest", object_key: `releases/${index}.json` }],
      success: true,
    }]);
  });
  assert.equal(calls.length, 12);
  assert.equal(rows.length, 12);
  assert.throws(
    () => collectLegacyR2InventoryRows((_query, index) => {
      if (index === 4) throw new Error("D1 query failed");
      return JSON.stringify([{ results: [], success: true }]);
    }),
    /D1 query failed/,
  );
});

test("inventory deduplicates exact keys, fixes a 24-hour fence, and rejects unknown prefixes", () => {
  const inventory = buildLegacyR2Inventory([
    { role: "legacy-canonical-source", object_key: `snapshots/objects/${"a".repeat(64)}` },
    { role: "legacy-canonical-object", object_key: `snapshots/objects/${"a".repeat(64)}` },
    { role: "legacy-submission-source", object_key: "sources/submission-1" },
  ], { bucket: "wasm-oj-judge-production", generatedAt });
  assert.equal(inventory.objects.length, 2);
  assert.equal(Date.parse(inventory.deleteNotBefore) - Date.parse(generatedAt), MINIMUM_CLEANUP_DELAY_MS);
  assert.deepEqual(
    inventory.objects.find((entry) => entry.key.startsWith("snapshots/"))?.roles,
    ["legacy-canonical-object", "legacy-canonical-source"],
  );
  assert.throws(
    () => buildLegacyR2Inventory([
      { role: "legacy-attempt-audit", object_key: "judge-packages/v1/unsafe" },
    ], { bucket: "wasm-oj-judge-production", generatedAt }),
    /rejected/,
  );
  assert.throws(
    () => buildLegacyR2Inventory([], {
      bucket: "wasm-oj-judge-production",
      generatedAt,
      observedObjects: [{ key: "unknown/object", size: 1 }],
    }),
    /unclassified bucket key/,
  );
});

test("R2 inventory paginates the bucket and separates conditional judge-package cleanup", async () => {
  const requested = [];
  const observed = await listRemoteR2Objects({
    accountId: "a".repeat(32),
    bucket: "wasm-oj-judge-production",
    apiToken: "token".repeat(8),
    fetchImpl: async (url) => {
      requested.push(url.toString());
      const second = url.searchParams.get("cursor") === "next-page";
      return Response.json({
        success: true,
        result: second
          ? [{ key: `judge-packages/v1/${"b".repeat(64)}`, size: 20, etag: "etag-2" }]
          : [{ key: "imports/orphan", size: 10, etag: "etag-1" }],
        result_info: second
          ? { is_truncated: false, per_page: 1000 }
          : { is_truncated: true, cursor: "next-page", per_page: 1000 },
      });
    },
  });
  assert.equal(requested.length, 2);
  assert.match(requested[1], /cursor=next-page/);
  const inventory = buildLegacyR2Inventory([], {
    bucket: "wasm-oj-judge-production",
    generatedAt,
    observedObjects: observed,
  });
  assert.deepEqual(inventory.objects, [{
    key: "imports/orphan",
    roles: ["legacy-import-archive"],
    observed: true,
    bytes: 10,
    etag: "etag-1",
  }]);
  assert.deepEqual(inventory.judgePackageCandidates, [{
    key: `judge-packages/v1/${"b".repeat(64)}`,
    sha256: "b".repeat(64),
    bytes: 20,
    etag: "etag-2",
  }]);
});

test("inventory accepts the exact legacy validation and erasure key families", () => {
  const digest = "c".repeat(64);
  const inventory = buildLegacyR2Inventory([
    { role: "legacy-validation-report", object_key: `snapshots/objects/${digest}` },
    { role: "legacy-erasure-receipt", object_key: `account-erasure/anonymous/${digest}.json` },
  ], {
    bucket: "wasm-oj-judge-production",
    generatedAt,
    observedObjects: [{ key: `erased-source-tombstones/v1/${digest}`, size: 32 }],
  });
  assert.equal(inventory.objects.length, 3);
  assert.deepEqual(
    inventory.objects.find((entry) => entry.key.startsWith("erased-source"))?.roles,
    ["legacy-submission-source"],
  );
});

test("tombstone receipt binds the inventory and every legacy source key", () => {
  const inventory = buildLegacyR2Inventory([
    { role: "legacy-submission-source", object_key: "sources/a" },
    { role: "legacy-release-manifest", object_key: "releases/a" },
  ], { bucket: "wasm-oj-judge-production", generatedAt });
  const bytes = Buffer.from(`${JSON.stringify(inventory, null, 2)}\n`);
  const parsed = parseLegacyR2Inventory(bytes, "wasm-oj-judge-production");
  assert.throws(() => parseLegacyR2Inventory(bytes, "another-production-bucket"), /header is invalid/);
  const receipt = buildTombstoneReceipt(bytes, parsed, "2026-08-12T00:01:00.000Z");
  assert.deepEqual(receipt.keys, ["sources/a"]);
  assert.equal(SOURCE_TOMBSTONE.includes(Buffer.from("submission")), false);
  assert.deepEqual(assertTombstoneReceipt(bytes, parsed, receipt), receipt);
  assert.throws(() => assertTombstoneReceipt(bytes, parsed, { ...receipt, keys: [] }), /exact inventory/);
});

test("cleanup refuses before the manifest's 24-hour fence", () => {
  const inventory = buildLegacyR2Inventory([], { bucket: "wasm-oj-judge-production", generatedAt });
  assert.throws(() => assertCleanupDelayElapsed(inventory, new Date("2026-08-12T23:59:59.999Z")), /blocked/);
  assert.doesNotThrow(() => assertCleanupDelayElapsed(inventory, new Date("2026-08-13T00:00:00.000Z")));
});

test("cleanup requires every retained D1 erasure receipt digest to cover its exact JSON", () => {
  const receiptJson = '{"schema":"unsupported-account-erasure-receipt-v2"}';
  const receiptSha256 = createHash("sha256").update(Buffer.from(receiptJson, "utf8")).digest("hex");
  const rows = [{
    record_kind: "tombstone",
    record_id: "anonymous-1",
    receipt_json: receiptJson,
    receipt_sha256: receiptSha256,
  }];
  assert.equal(assertErasureReceiptDigests(rows), 1);
  assert.throws(
    () => assertErasureReceiptDigests([{ ...rows[0], receipt_sha256: "d".repeat(64) }]),
    /cleanup is blocked/,
  );
});

test("R2 object API URL keeps path separators while encoding key components", () => {
  assert.equal(
    r2ObjectApiUrl("a".repeat(32), "wasm-oj-judge-production", "sources/a file+#"),
    `https://api.cloudflare.com/client/v4/accounts/${"a".repeat(32)}/r2/buckets/wasm-oj-judge-production/objects/sources/a%20file%2B%23`,
  );
});
