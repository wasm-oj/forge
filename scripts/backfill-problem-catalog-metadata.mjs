#!/usr/bin/env node

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    config: { type: "string", default: "wrangler.quick-production.jsonc" },
    database: { type: "string", default: "DB" },
    primary: { type: "string", default: "wasm-oj-judge-production" },
  },
  strict: true,
});
const wrangler = resolve(process.cwd(), "node_modules/.bin/wrangler");

function run(args, encoding) {
  return execFileSync(wrangler, args, { encoding, maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "inherit"] });
}

function sqlString(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function metadata(bytes, expectedBundleDigest) {
  const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  if (!value || typeof value !== "object" || Array.isArray(value) || value.schema !== "forge-practice-problem-projection-v1" || value.digest !== expectedBundleDigest) {
    throw new Error("Published practice projection has the wrong role or bundle binding.");
  }
  const problem = value.problem;
  if (!problem || typeof problem !== "object" || Array.isArray(problem)) throw new Error("Published practice projection has no problem.");
  if (!["easy", "medium", "hard"].includes(problem.difficulty)) throw new Error("Published problem difficulty is invalid.");
  if (!Array.isArray(problem.tags) || problem.tags.length > 16 || problem.tags.some((tag) => typeof tag !== "string" || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(tag))) throw new Error("Published problem tags are invalid.");
  if (typeof problem.trackId !== "string" || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(problem.trackId)) throw new Error("Published problem track ID is invalid.");
  if (!problem.track || typeof problem.track !== "object" || Array.isArray(problem.track) || typeof problem.track.en !== "string" || typeof problem.track["zh-TW"] !== "string") throw new Error("Published problem track is invalid.");
  return { difficulty: problem.difficulty, tags: problem.tags, trackId: problem.trackId, track: { "zh-TW": problem.track["zh-TW"], en: problem.track.en } };
}

const query = "SELECT managed_problem_versions.id, managed_problem_versions.public_projection_r2_key, managed_problem_versions.bundle_digest FROM managed_problem_versions JOIN managed_snapshots ON managed_snapshots.id=managed_problem_versions.snapshot_id WHERE managed_snapshots.mode='official-practice' AND managed_snapshots.status='published' AND (managed_problem_versions.difficulty IS NULL OR managed_problem_versions.tags_json IS NULL OR managed_problem_versions.track_id IS NULL OR managed_problem_versions.track_json IS NULL) ORDER BY managed_problem_versions.id";
const raw = run(["d1", "execute", values.database, "--remote", "--config", values.config, "--json", "--command", query], "utf8");
const batches = JSON.parse(raw);
const rows = Array.isArray(batches) ? batches.flatMap((batch) => Array.isArray(batch.results) ? batch.results : []) : [];
if (rows.length === 0) {
  process.stdout.write("Problem catalog metadata is already current.\n");
  process.exit(0);
}

const statements = [];
for (const row of rows) {
  if (typeof row.id !== "string" || typeof row.public_projection_r2_key !== "string" || typeof row.bundle_digest !== "string") throw new Error("Catalog backfill row is invalid.");
  const keyDigest = /^snapshots\/objects\/([0-9a-f]{64})$/.exec(row.public_projection_r2_key)?.[1];
  if (!keyDigest) throw new Error(`Problem ${row.id} has an invalid projection key.`);
  const primary = run(["r2", "object", "get", `${values.primary}/${row.public_projection_r2_key}`, "--remote", "--pipe", "--config", values.config]);
  if (!Buffer.isBuffer(primary) || primary.length === 0 || sha256(primary) !== keyDigest) throw new Error(`Problem ${row.id} projection failed authoritative object verification.`);
  const item = metadata(primary, row.bundle_digest);
  statements.push(`UPDATE managed_problem_versions SET difficulty=${sqlString(item.difficulty)}, tags_json=${sqlString(JSON.stringify(item.tags))}, track_id=${sqlString(item.trackId)}, track_json=${sqlString(JSON.stringify(item.track))} WHERE id=${sqlString(row.id)} AND public_projection_r2_key=${sqlString(row.public_projection_r2_key)} AND bundle_digest=${sqlString(row.bundle_digest)} AND difficulty IS NULL AND tags_json IS NULL AND track_id IS NULL AND track_json IS NULL`);
}
run(["d1", "execute", values.database, "--remote", "--config", values.config, "--yes", "--command", `${statements.join(";")};`], "utf8");
const remainingRaw = run(["d1", "execute", values.database, "--remote", "--config", values.config, "--json", "--command", `SELECT COUNT(*) AS count FROM managed_problem_versions JOIN managed_snapshots ON managed_snapshots.id=managed_problem_versions.snapshot_id WHERE managed_snapshots.mode='official-practice' AND managed_snapshots.status='published' AND (managed_problem_versions.difficulty IS NULL OR managed_problem_versions.tags_json IS NULL OR managed_problem_versions.track_id IS NULL OR managed_problem_versions.track_json IS NULL)`], "utf8");
const remaining = JSON.parse(remainingRaw)?.[0]?.results?.[0]?.count;
if (remaining !== 0) throw new Error(`Catalog metadata backfill left ${remaining} incomplete rows.`);
process.stdout.write(`Backfilled ${rows.length} published problem catalog rows from verified authoritative projections.\n`);
