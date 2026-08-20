import assert from "node:assert/strict";
import test from "node:test";
import {
  assertArchitectureResetMigrationState,
  assertNoUnknownAppliedMigrations,
  assertNormalProductionMigrationState,
  assertNormalProductionReleaseState,
  configuredProductionRelease,
  pendingMigrationNames,
  RETIRED_PRODUCTION_MIGRATIONS,
} from "./production-migrations.mjs";
import { assertArchitectureResetToken } from "./architecture-reset-safety.mjs";

const migrations = [
  "0001_initial.sql",
  "0016_single_store.sql",
  "0017_architecture_reset.sql",
  "0018_cli_auth.sql",
];

test("normal production migrations fail closed until the architecture reset is recorded", () => {
  assert.throws(
    () => assertNormalProductionMigrationState(["0001_initial.sql", "0016_single_store.sql"]),
    /guarded architecture-v2 cutover/,
  );
  assert.doesNotThrow(() => assertNormalProductionMigrationState(migrations));
});

test("normal production migrations require the rendered release to be the exact active D1 release", () => {
  const expected = {
    releaseId: "018f0f2e-7b3c-7f51-8b36-df6ec12f8d31",
    manifestSha256: "a".repeat(64),
  };
  assert.deepEqual(configuredProductionRelease(JSON.stringify({
    vars: {
      ENVIRONMENT: "production",
      WASM_OJ_RELEASE_ID: expected.releaseId,
      WASM_OJ_RELEASE_MANIFEST_SHA256: expected.manifestSha256,
    },
  })), expected);
  assert.doesNotThrow(() => assertNormalProductionReleaseState([{
    release_id: expected.releaseId,
    manifest_sha256: expected.manifestSha256,
  }], expected));
  assert.throws(
    () => configuredProductionRelease(JSON.stringify({
      vars: {
        ENVIRONMENT: "production",
        WASM_OJ_RELEASE_ID: "__WASM_OJ_RELEASE_ID__",
        WASM_OJ_RELEASE_MANIFEST_SHA256: "__WASM_OJ_RELEASE_MANIFEST_SHA256__",
      },
    })),
    /invalid release coordinates/,
  );
  assert.throws(
    () => assertNormalProductionReleaseState([], expected),
    /does not exactly match/,
  );
  assert.throws(
    () => assertNormalProductionReleaseState([{
      release_id: expected.releaseId,
      manifest_sha256: "b".repeat(64),
    }], expected),
    /does not exactly match/,
  );
});

test("architecture reset must be the first pending migration", () => {
  assert.deepEqual(
    pendingMigrationNames(migrations, ["0001_initial.sql", "0016_single_store.sql"]),
    ["0017_architecture_reset.sql", "0018_cli_auth.sql"],
  );
  assert.doesNotThrow(() => assertArchitectureResetMigrationState(
    migrations,
    ["0001_initial.sql", ...RETIRED_PRODUCTION_MIGRATIONS, "0016_single_store.sql"],
  ));
  assert.doesNotThrow(() => assertArchitectureResetMigrationState(
    [...migrations, "0019_future.sql"],
    ["0001_initial.sql", "0016_single_store.sql"],
  ));
  assert.throws(() => assertArchitectureResetMigrationState(migrations, migrations), /found \[\]/);
  assert.throws(
    () => assertNoUnknownAppliedMigrations(migrations, [...migrations, "0018_unknown.sql"]),
    /absent from this checkout/,
  );
});

test("architecture reset token requires a protected high-entropy exact match", () => {
  const token = "architecture-v2-reset-token-0123456789abcdef";
  assert.doesNotThrow(() => assertArchitectureResetToken(token, token));
  assert.throws(() => assertArchitectureResetToken(undefined, token), /PROVIDED is required/);
  assert.throws(() => assertArchitectureResetToken(`${token}x`, token), /does not match/);
  assert.throws(() => assertArchitectureResetToken("short", "short"), /at least 32 bytes/);
});
