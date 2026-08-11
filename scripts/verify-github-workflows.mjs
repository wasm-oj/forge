import { readFile } from "node:fs/promises";

const paths = {
  ci: ".github/workflows/ci.yml",
  production: ".github/workflows/cloudflare-production.yml",
  release: ".github/workflows/release.yml",
};

const sources = Object.fromEntries(
  await Promise.all(Object.entries(paths).map(async ([name, path]) => [name, await readFile(path, "utf8")])),
);
const workerConfigs = Object.fromEntries(await Promise.all([
  ["development", "wrangler.jsonc"],
  ["production", "wrangler.quick-production.jsonc"],
].map(async ([name, path]) => [name, JSON.parse(await readFile(path, "utf8"))])));

function requireText(source, text, label) {
  if (!source.includes(text)) throw new Error(`${label} must include ${JSON.stringify(text)}.`);
}

function forbidText(source, text, label) {
  if (source.includes(text)) throw new Error(`${label} still contains removed mechanism ${JSON.stringify(text)}.`);
}

requireText(sources.production, "environment: production", "Production deployment");
requireText(sources.production, "workflow_dispatch:", "Production deployment");
forbidText(sources.production, "branches: [main]", "Production deployment");
requireText(sources.production, "wrangler d1 migrations apply DB", "Production deployment");
requireText(sources.production, "backfill-problem-catalog-metadata.mjs", "Production deployment");
requireText(sources.production, "wrangler deploy --config wrangler.quick-production.jsonc", "Production deployment");
requireText(sources.production, "/api/health/live", "Production deployment");
requireText(sources.production, "/api/health/ready", "Production deployment");
requireText(sources.production, "verify-production-catalog.mjs", "Production deployment");
forbidText(sources.production, "CORE_DB", "Production deployment");
forbidText(sources.production, "SUBMISSIONS_DB", "Production deployment");
for (const destructiveCutoverStep of [
  "wrangler.maintenance-production.jsonc",
  "wait-for-validation-cutover.mjs",
  "cleanup-production-r2.mjs",
  "delete-retired-submissions-d1.mjs",
  "formal_mutations_enabled",
]) forbidText(sources.production, destructiveCutoverStep, "Production deployment");

const orderedProductionSteps = [
  "wrangler d1 migrations apply DB",
  "backfill-problem-catalog-metadata.mjs",
  "wrangler deploy --config wrangler.quick-production.jsonc",
  "/api/health/live",
  "/api/health/ready",
  "verify-production-catalog.mjs",
];
let previousProductionIndex = -1;
for (const step of orderedProductionSteps) {
  const index = sources.production.indexOf(step);
  if (index <= previousProductionIndex) throw new Error(`Production cutover step ${JSON.stringify(step)} is out of order.`);
  previousProductionIndex = index;
}

for (const [name, source] of Object.entries(sources)) {
  requireText(source, "24.18.0", `${name} workflow`);
  requireText(source, "10.34.5", `${name} workflow`);
  for (const removed of [
    "staging-acceptance",
    "attest-build-provenance",
    "artifact-qualification",
    "bootstrap-recovery",
    "cost-baseline",
    "external-drain",
    "release-package-store",
    "release-qualification",
    "calibration:chain",
  ]) forbidText(source, removed, `${name} workflow`);
}

const containerBindings = [
  ["SUBMISSION_CONTAINER", "SubmissionJudgeContainer"],
  ["VALIDATION_CONTAINER", "ValidationJudgeContainer"],
];
const deletedProductClasses = [
  "SubmissionDO",
  "ProblemLeaderboardDO",
  "ContestDO",
  "UserQuotaDO",
  "AdmissionControlDO",
];
for (const [name, config] of Object.entries(workerConfigs)) {
  const databases = config.d1_databases?.map((database) => [database.binding, database.migrations_dir]);
  if (JSON.stringify(databases) !== JSON.stringify([["DB", "migrations/core"]])) {
    throw new Error(`${name} Worker must bind the existing core database once as DB.`);
  }
  const buckets = config.r2_buckets?.map((bucket) => bucket.binding);
  if (JSON.stringify(buckets) !== JSON.stringify(["JUDGE_BUCKET"])) {
    throw new Error(`${name} Worker must bind only the authoritative judge bucket.`);
  }
  const bindings = config.durable_objects?.bindings?.map((binding) => [binding.name, binding.class_name]);
  if (JSON.stringify(bindings) !== JSON.stringify(containerBindings)) {
    throw new Error(`${name} Worker must bind only the two Cloudflare Container adapters.`);
  }
  const deletion = config.migrations?.at(-1)?.deleted_classes;
  if (JSON.stringify(deletion) !== JSON.stringify(deletedProductClasses)) {
    throw new Error(`${name} Worker must delete the five product-state Durable Object classes in one migration.`);
  }
}

console.log("Verified minimal workflows and Container-only Durable Object bindings.");
