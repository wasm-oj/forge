#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import {
  RESET_MIGRATION,
  assertArchitectureResetToken,
  rowsFromWranglerJson,
} from "./architecture-reset-safety.mjs";

const MIGRATION_NAME = /^\d{4}_[a-z0-9_]+\.sql$/;
const SHA256 = /^[0-9a-f]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export const RETIRED_PRODUCTION_MIGRATIONS = Object.freeze([
  "0007_staging_acceptance.sql",
  "0008_staging_acceptance_controls.sql",
  "0009_release_drain_evidence.sql",
  "0011_release_transition_drain_nonce.sql",
  "0014_release_package_active_root.sql",
  "0015_release_package_mutation_lease.sql",
  "0016_staging_acceptance_fixture.sql",
]);

export function pendingMigrationNames(localNames, appliedNames) {
  const applied = new Set(appliedNames);
  return localNames.filter((name) => !applied.has(name));
}

export function assertNoUnknownAppliedMigrations(localNames, appliedNames) {
  const local = new Set(localNames);
  const retired = new Set(RETIRED_PRODUCTION_MIGRATIONS);
  const unknown = appliedNames.filter((name) => !local.has(name) && !retired.has(name));
  if (unknown.length !== 0) {
    throw new Error(`Production D1 contains migrations absent from this checkout: ${JSON.stringify(unknown)}.`);
  }
}

export function assertNormalProductionMigrationState(appliedNames) {
  if (!appliedNames.includes(RESET_MIGRATION)) {
    throw new Error(
      `Normal production deployment is blocked until ${RESET_MIGRATION} is applied by the guarded architecture-v2 cutover workflow.`,
    );
  }
}

export function configuredProductionRelease(configSource) {
  let config;
  try {
    config = JSON.parse(configSource);
  } catch (error) {
    throw new TypeError("Rendered production Worker config is not valid JSON.", { cause: error });
  }
  const releaseId = config.vars?.WASM_OJ_RELEASE_ID;
  const manifestSha256 = config.vars?.WASM_OJ_RELEASE_MANIFEST_SHA256;
  if (config.vars?.ENVIRONMENT !== "production" || !UUID.test(releaseId) || !SHA256.test(manifestSha256)) {
    throw new TypeError("Rendered production Worker config has invalid release coordinates.");
  }
  return { releaseId, manifestSha256 };
}

export function assertNormalProductionReleaseState(rows, expected) {
  if (
    !Array.isArray(rows)
    || rows.length !== 1
    || !rows[0]
    || Object.keys(rows[0]).sort().join("\0") !== ["manifest_sha256", "release_id"].join("\0")
    || rows[0].release_id !== expected.releaseId
    || rows[0].manifest_sha256 !== expected.manifestSha256
  ) {
    throw new Error("Normal production deployment release does not exactly match the active D1 release.");
  }
}

export function assertArchitectureResetMigrationState(localNames, appliedNames) {
  assertNoUnknownAppliedMigrations(localNames, appliedNames);
  const pending = pendingMigrationNames(localNames, appliedNames);
  if (pending.length !== 1 || pending[0] !== RESET_MIGRATION) {
    throw new Error(
      `Architecture reset requires ${RESET_MIGRATION} to be the only pending migration; found ${JSON.stringify(pending)}.`,
    );
  }
}

function run(executable, args, encoding = "utf8") {
  return execFileSync(executable, args, {
    encoding,
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "inherit"],
  });
}

function appliedMigrations(wrangler, database, config) {
  const stdout = run(wrangler, [
    "d1", "execute", database, "--remote", "--config", config, "--json",
    "--command", "SELECT name FROM d1_migrations ORDER BY id",
  ]);
  return rowsFromWranglerJson(stdout, "D1 migration inventory").map((row) => {
    if (!row || typeof row.name !== "string" || !MIGRATION_NAME.test(row.name)) {
      throw new TypeError("D1 migration inventory contains an invalid migration name.");
    }
    return row.name;
  });
}

function activeProductionRelease(wrangler, database, config) {
  const stdout = run(wrangler, [
    "d1", "execute", database, "--remote", "--config", config, "--json",
    "--command", `SELECT active.wasm_oj_release_id AS release_id,
      release.manifest_sha256 AS manifest_sha256
      FROM wasm_oj_active_releases AS active
      JOIN wasm_oj_releases AS release ON release.id=active.wasm_oj_release_id
      WHERE active.environment='production' AND release.revoked_at IS NULL`,
  ]);
  return rowsFromWranglerJson(stdout, "active production release");
}

function localMigrations() {
  return readdirSync(path.resolve(process.cwd(), "migrations/core"))
    .filter((name) => MIGRATION_NAME.test(name))
    .sort();
}

function applyMigrations(wrangler, database, config) {
  run(wrangler, [
    "d1", "migrations", "apply", database, "--remote", "--config", config,
  ]);
}

function usage() {
  return `Usage:
  node scripts/production-migrations.mjs normal --database DB --config <config>
  node scripts/production-migrations.mjs architecture-reset --database DB --config <config> \
    --inventory <cleanup-manifest.json> --tombstone-receipt <receipt.json> \
    --confirm-workflows-drained

The normal path refuses while 0017 is pending. The architecture-reset path
requires the protected reset token, exact R2 inventory, verified source
tombstones, D1 quiescence, and exactly one pending migration.
`;
}

function main() {
  const [command, ...args] = process.argv.slice(2);
  const { values } = parseArgs({
    args,
    options: {
      database: { type: "string", default: "DB" },
      config: { type: "string", default: "wrangler.quick-production.jsonc" },
      inventory: { type: "string" },
      "tombstone-receipt": { type: "string" },
      "confirm-workflows-drained": { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
    strict: true,
  });
  if (values.help) return process.stdout.write(usage());
  const wrangler = path.resolve(process.cwd(), "node_modules/.bin/wrangler");
  const applied = appliedMigrations(wrangler, values.database, values.config);
  const local = localMigrations();
  if (command === "normal") {
    assertNoUnknownAppliedMigrations(local, applied);
    assertNormalProductionMigrationState(applied);
    const configured = configuredProductionRelease(readFileSync(values.config, "utf8"));
    assertNormalProductionReleaseState(
      activeProductionRelease(wrangler, values.database, values.config),
      configured,
    );
    applyMigrations(wrangler, values.database, values.config);
    return;
  }
  if (command !== "architecture-reset" || !values.inventory || !values["tombstone-receipt"] || !values["confirm-workflows-drained"]) {
    throw new TypeError(usage());
  }
  assertArchitectureResetToken(
    process.env.WASM_OJ_ARCHITECTURE_RESET_TOKEN_PROVIDED,
    process.env.WASM_OJ_ARCHITECTURE_RESET_TOKEN,
  );
  assertArchitectureResetMigrationState(local, applied);
  run(process.execPath, [
    path.resolve(process.cwd(), "scripts/architecture-reset-preflight.mjs"),
    "--database", values.database,
    "--config", values.config,
    "--remote",
    "--confirm-workflows-drained",
    "--inventory", values.inventory,
    "--tombstone-receipt", values["tombstone-receipt"],
  ]);
  applyMigrations(wrangler, values.database, values.config);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
