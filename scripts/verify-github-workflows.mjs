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
const maintenanceConfig = JSON.parse(await readFile("wrangler.maintenance-production.jsonc", "utf8"));

function requireText(source, text, label) {
  if (!source.includes(text)) throw new Error(`${label} must include ${JSON.stringify(text)}.`);
}

function forbidText(source, text, label) {
  if (source.includes(text)) throw new Error(`${label} still contains removed mechanism ${JSON.stringify(text)}.`);
}

requireText(sources.production, "environment: production", "Production deployment");
requireText(sources.production, "branches: [main]", "Production deployment");
requireText(sources.production, "wrangler d1 migrations apply CORE_DB", "Production deployment");
requireText(sources.production, "wrangler d1 migrations apply SUBMISSIONS_DB", "Production deployment");
requireText(sources.production, "wrangler deploy --config wrangler.maintenance-production.jsonc", "Production deployment");
requireText(sources.production, "wait-for-product-do-cutover.mjs", "Production deployment");
requireText(sources.production, "formal_mutations_enabled=0", "Production deployment");
requireText(sources.production, "wrangler deploy --config wrangler.quick-production.jsonc", "Production deployment");
requireText(sources.production, "/api/health/ready", "Production deployment");
requireText(sources.production, "formal_mutations_enabled=1", "Production deployment");

const orderedProductionSteps = [
  "wrangler deploy --config wrangler.maintenance-production.jsonc",
  "wait-for-product-do-cutover.mjs",
  "wrangler d1 migrations apply CORE_DB",
  "formal_mutations_enabled=0",
  "wrangler d1 migrations apply SUBMISSIONS_DB",
  "wrangler deploy --config wrangler.quick-production.jsonc",
  "/api/health/ready",
  "formal_mutations_enabled=1",
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
  const bindings = config.durable_objects?.bindings?.map((binding) => [binding.name, binding.class_name]);
  if (JSON.stringify(bindings) !== JSON.stringify(containerBindings)) {
    throw new Error(`${name} Worker must bind only the two Cloudflare Container adapters.`);
  }
  const deletion = config.migrations?.at(-1)?.deleted_classes;
  if (JSON.stringify(deletion) !== JSON.stringify(deletedProductClasses)) {
    throw new Error(`${name} Worker must delete the five product-state Durable Object classes in one migration.`);
  }
}
if (maintenanceConfig.name !== workerConfigs.production.name || maintenanceConfig.durable_objects || maintenanceConfig.migrations) {
  throw new Error("Production maintenance mode must replace the app without binding or deleting Durable Objects.");
}

console.log("Verified minimal workflows and Container-only Durable Object bindings.");
