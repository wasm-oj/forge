#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { rowsFromWranglerJson } from "./architecture-reset-safety.mjs";

const MIGRATION_NAME = /^\d{4}_[a-z0-9_]+\.sql$/;
export const HISTORICAL_PRODUCTION_MIGRATIONS = Object.freeze([
  "0007_staging_acceptance.sql",
  "0008_staging_acceptance_controls.sql",
  "0009_release_drain_evidence.sql",
  "0011_release_transition_drain_nonce.sql",
  "0014_release_package_active_root.sql",
  "0015_release_package_mutation_lease.sql",
  "0016_staging_acceptance_fixture.sql",
]);
export const REPOSITORY_CUTOVER_MIGRATION = "0019_repository_source_truth.sql";
export const PAUSE_REPOSITORY_CUTOVER_SQL = `UPDATE formal_mutation_controls
  SET formal_mutations_enabled=0, reason='repository-source-truth-cutover',
      updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
  WHERE environment='production'`;
export const REPOSITORY_CUTOVER_PREFLIGHT_SQL = `SELECT
  (SELECT formal_mutations_enabled FROM formal_mutation_controls WHERE environment='production') AS formal_enabled,
  (SELECT COUNT(*) FROM contests) AS contests,
  (SELECT COUNT(*) FROM workflow_outbox WHERE state='pending') AS outbox,
  (SELECT COUNT(*) FROM catalog_validation_jobs WHERE state IN ('queued','running'))
    + (SELECT COUNT(*) FROM catalog_publish_jobs WHERE state IN ('queued','materializing'))
    + (SELECT COUNT(*) FROM submissions WHERE state NOT IN ('completed','compile-error','judge-error','infrastructure-error','cancelled'))
    + (SELECT COUNT(*) FROM rejudge_batches WHERE state IN ('queued','running','ready'))
    + (SELECT COUNT(*) FROM rejudge_jobs WHERE state IN ('pending','dispatched')) AS mutations`;
export const RESUME_REPOSITORY_CUTOVER_SQL = `UPDATE formal_mutation_controls
  SET formal_mutations_enabled=1, reason='repository-source-truth-production-smoke-passed',
      updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
  WHERE environment='production' AND formal_mutations_enabled=0
    AND reason='repository-source-truth-cutover'
  RETURNING formal_mutations_enabled AS enabled, reason`;

export function pendingMigrationNames(localNames, appliedNames) {
  const applied = new Set(appliedNames);
  return localNames.filter((name) => !applied.has(name));
}

export function assertNoUnknownAppliedMigrations(localNames, appliedNames) {
  const local = new Set(localNames);
  const historical = new Set(HISTORICAL_PRODUCTION_MIGRATIONS);
  const unknown = appliedNames.filter((name) => !local.has(name) && !historical.has(name));
  if (unknown.length !== 0) throw new Error(`Production D1 contains migrations absent from this checkout: ${JSON.stringify(unknown)}.`);
}

export function cutoverPreflightCounts(rows) {
  if (!Array.isArray(rows) || rows.length !== 1) throw new TypeError("Repository cutover preflight returned no exact row.");
  const row = rows[0];
  const keys = ["contests", "formal_enabled", "mutations", "outbox"];
  if (!row || keys.some((key) => !Number.isSafeInteger(row[key]) || row[key] < 0)) {
    throw new TypeError("Repository cutover preflight returned invalid counts.");
  }
  return row;
}

export function assertRepositoryCutoverReady(row) {
  if (row.formal_enabled !== 0 || row.contests !== 0 || row.mutations !== 0 || row.outbox !== 0) {
    throw new Error(`Repository cutover is not drained: ${JSON.stringify(row)}.`);
  }
}

function run(executable, args) {
  return execFileSync(executable, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "inherit"] });
}

function wranglerJson(wrangler, database, config, command) {
  return rowsFromWranglerJson(run(wrangler, [
    "d1", "execute", database, "--remote", "--config", config, "--json", "--command", command,
  ]), "production D1 query");
}

function appliedMigrations(wrangler, database, config) {
  return wranglerJson(wrangler, database, config, "SELECT name FROM d1_migrations ORDER BY id").map((row) => {
    if (!row || typeof row.name !== "string" || !MIGRATION_NAME.test(row.name)) throw new TypeError("D1 migration inventory contains an invalid migration name.");
    return row.name;
  });
}

function localMigrations() {
  return readdirSync(path.resolve(process.cwd(), "migrations/core")).filter((name) => MIGRATION_NAME.test(name)).sort();
}

function pauseAndVerifyCutover(wrangler, database, config) {
  wranglerJson(wrangler, database, config, PAUSE_REPOSITORY_CUTOVER_SQL);
  const rows = wranglerJson(wrangler, database, config, REPOSITORY_CUTOVER_PREFLIGHT_SQL);
  assertRepositoryCutoverReady(cutoverPreflightCounts(rows));
}

function apply(wrangler, database, config) {
  const local = localMigrations();
  const applied = appliedMigrations(wrangler, database, config);
  assertNoUnknownAppliedMigrations(local, applied);
  if (pendingMigrationNames(local, applied).includes(REPOSITORY_CUTOVER_MIGRATION)) {
    pauseAndVerifyCutover(wrangler, database, config);
  }
  run(wrangler, ["d1", "migrations", "apply", database, "--remote", "--config", config]);
}

function resume(wrangler, database, config) {
  const results = wranglerJson(wrangler, database, config, RESUME_REPOSITORY_CUTOVER_SQL);
  if (results.length !== 1 || results[0]?.enabled !== 1
    || results[0]?.reason !== "repository-source-truth-production-smoke-passed") {
    throw new Error("Repository cutover is not paused at the smoke-confirmation fence.");
  }
}

function usage() {
  return "Usage: node scripts/production-migrations.mjs apply --database DB --config <config>\n       node scripts/production-migrations.mjs resume --cutover-smoke-confirmed --database DB --config <config>\n";
}

function main() {
  const [command, ...args] = process.argv.slice(2);
  const { values } = parseArgs({
    args,
    options: {
      database: { type: "string", default: "DB" },
      config: { type: "string", default: "wrangler.quick-production.jsonc" },
      "cutover-smoke-confirmed": { type: "boolean", default: false },
    },
    strict: true,
  });
  const wrangler = path.resolve(process.cwd(), "node_modules/.bin/wrangler");
  if (command === "apply") return apply(wrangler, values.database, values.config);
  if (command === "resume" && values["cutover-smoke-confirmed"]) return resume(wrangler, values.database, values.config);
  throw new TypeError(usage());
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
