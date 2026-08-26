import { readFile } from "node:fs/promises";

const production = await readFile(".github/workflows/cloudflare-production.yml", "utf8");
const developmentConfig = JSON.parse(await readFile("wrangler.jsonc", "utf8"));
const productionSource = await readFile("wrangler.quick-production.jsonc", "utf8");
const productionConfig = JSON.parse(productionSource);
const dockerfile = await readFile("Dockerfile", "utf8");

function requireText(source, value, label) {
  if (!source.includes(value)) throw new Error(`${label} must include ${JSON.stringify(value)}.`);
}

function forbidText(source, value, label) {
  if (source.includes(value)) throw new Error(`${label} still contains removed mechanism ${JSON.stringify(value)}.`);
}

for (const value of [
  "workflow_dispatch:",
  "environment: production",
  "node-version: 24.18.0",
  "version: 10.34.5",
  "render-production-config.mjs",
  'production-migrations.mjs apply',
  'wrangler deploy --config wrangler.quick-production.jsonc --tag "$GITHUB_SHA"',
  "wait-container-rollout.mjs",
  "--capture-baseline",
  "--baseline",
  "/api/health/container",
  "/api/health/live",
  "/api/health/ready",
  "production-migrations.mjs resume",
  "resume_formal_mutations:",
  "--cutover-smoke-confirmed",
]) requireText(production, value, "Production deployment");

for (const removed of [
  "RELEASE_REQUEST",
  "release-manifest",
  "verify-oci-release-image",
  "configure-production-release",
  "release-evidence",
  "/api/admin/releases/activate",
]) forbidText(production, removed, "Production deployment");

const ordered = [
  "render-production-config.mjs",
  "production-migrations.mjs apply",
  "--capture-baseline",
  'wrangler deploy --config wrangler.quick-production.jsonc --tag "$GITHUB_SHA"',
  "--baseline",
  "/api/health/container",
  "/api/health/live",
  "/api/health/ready",
  "production-migrations.mjs resume",
];
let previous = -1;
for (const value of ordered) {
  const index = production.indexOf(value);
  if (index <= previous) throw new Error(`Production deployment step ${JSON.stringify(value)} is out of order.`);
  previous = index;
}

if (productionSource.split("__WASM_OJ_BUILD_ID__").length - 1 !== 1
  || productionConfig.vars?.WASM_OJ_BUILD_ID !== "__WASM_OJ_BUILD_ID__"
  || productionConfig.containers?.length !== 1
  || productionConfig.containers[0]?.image !== "./Dockerfile") {
  throw new Error("Production config must contain one Worker build placeholder and a repository Dockerfile Container.");
}
if (developmentConfig.vars?.WASM_OJ_BUILD_ID !== "0".repeat(40)
  || developmentConfig.containers?.[0]?.image !== "./Dockerfile") {
  throw new Error("Development config must use the local build ID and repository Dockerfile.");
}
if ((dockerfile.match(/^ARG WASM_OJ_BUILD_ID=/gmu) ?? []).length !== 1) {
  throw new Error("Dockerfile must accept exactly one WASM_OJ_BUILD_ID argument.");
}

for (const [name, config] of [["development", developmentConfig], ["production", productionConfig]]) {
  const databases = config.d1_databases?.map((database) => [database.binding, database.migrations_dir]);
  if (JSON.stringify(databases) !== JSON.stringify([["DB", "migrations/core"]])) throw new Error(`${name} must bind one D1 database.`);
  if (JSON.stringify(config.r2_buckets?.map((bucket) => bucket.binding)) !== JSON.stringify(["JUDGE_BUCKET"])) throw new Error(`${name} must bind one judge bucket.`);
  if (JSON.stringify(config.workflows?.map((workflow) => [workflow.binding, workflow.class_name])) !== JSON.stringify([
    ["SUBMISSION_WORKFLOW", "SubmissionWorkflow"], ["CATALOG_WORKFLOW", "CatalogWorkflow"],
  ])) throw new Error(`${name} must bind only submission and catalog workflows.`);
}

console.log("Verified repository-source production deployment workflow.");
