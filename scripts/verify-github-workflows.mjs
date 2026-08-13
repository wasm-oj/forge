import { readFile } from "node:fs/promises";

const paths = {
  ci: ".github/workflows/ci.yml",
  cleanup: ".github/workflows/cloudflare-architecture-v2-cleanup.yml",
  cutover: ".github/workflows/cloudflare-architecture-v2-cutover.yml",
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
requireText(sources.production, "WASM_OJ_PRODUCTION_RELEASE_REQUEST_BASE64", "Production deployment");
requireText(sources.production, "verify-oci-release-image.mjs", "Production deployment");
requireText(sources.production, "configure-production-release.mjs", "Production deployment");
requireText(sources.production, '--expected-git-commit "$GITHUB_SHA"', "Production deployment");
requireText(sources.production, "--oci-evidence release-evidence/oci/evidence.json", "Production deployment");
requireText(sources.production, "production-release-oci-${{ github.run_id }}", "Production deployment");
requireText(sources.production, "production-migrations.mjs normal", "Production deployment");
requireText(sources.production, "wrangler deploy --config wrangler.quick-production.jsonc", "Production deployment");
requireText(sources.production, "wait-container-rollout.mjs", "Production deployment");
requireText(sources.production, "release-evidence/container-rollout.json", "Production deployment");
requireText(sources.production, "/api/health/live", "Production deployment");
requireText(sources.production, "/api/health/ready", "Production deployment");
forbidText(sources.production, "wrangler d1 migrations apply", "Production deployment");
forbidText(sources.production, "backfill-problem-catalog-metadata.mjs", "Production deployment");
forbidText(sources.production, "verify-production-catalog.mjs", "Production deployment");
forbidText(sources.production, "CORE_DB", "Production deployment");
forbidText(sources.production, "SUBMISSIONS_DB", "Production deployment");
forbidText(sources.production, "formal_mutations_enabled", "Production deployment");

const orderedProductionSteps = [
  "verify-oci-release-image.mjs",
  "configure-production-release.mjs",
  "production-migrations.mjs normal",
  "wrangler deploy --config wrangler.quick-production.jsonc",
  "wait-container-rollout.mjs",
  "/api/health/live",
  "/api/health/ready",
];
let previousProductionIndex = -1;
for (const step of orderedProductionSteps) {
  const index = sources.production.indexOf(step);
  if (index <= previousProductionIndex) throw new Error(`Production deployment step ${JSON.stringify(step)} is out of order.`);
  previousProductionIndex = index;
}

for (const [source, label] of [
  [sources.cutover, "Architecture v2 cutover"],
  [sources.cleanup, "Architecture v2 cleanup"],
]) {
  requireText(source, "workflow_dispatch:", label);
  requireText(source, "environment: production", label);
  requireText(source, "WASM_OJ_ARCHITECTURE_RESET_TOKEN", label);
  forbidText(source, "rm -rf", label);
  forbidText(source, "r2 bucket delete", label);
}

const orderedCutoverSteps = [
  "verify-oci-release-image.mjs",
  "configure-production-release.mjs",
  "formal_mutations_enabled=0",
  "--quiescence-only",
  "architecture-reset-r2.mjs inventory",
  "architecture-reset-r2.mjs tombstone",
  "production-migrations.mjs architecture-reset",
  "wrangler secret put MAINTENANCE_SMOKE_TOKEN",
  "wrangler deploy --config wrangler.quick-production.jsonc",
  "wait-container-rollout.mjs",
  "/api/admin/releases/activate",
  "/api/health/live",
  "/api/health/ready",
];
let previousCutoverIndex = -1;
for (const step of orderedCutoverSteps) {
  const index = sources.cutover.indexOf(step);
  if (index <= previousCutoverIndex) throw new Error(`Architecture v2 cutover step ${JSON.stringify(step)} is out of order.`);
  previousCutoverIndex = index;
}
requireText(sources.cutover, "RESET-PRODUCTION-ARCHITECTURE-V2", "Architecture v2 cutover");
requireText(sources.cutover, "WASM_OJ_V2_ACTIVATION_REQUEST_BASE64", "Architecture v2 cutover");
requireText(sources.cutover, "--activation-request-output cutover-evidence/activation-request.json", "Architecture v2 cutover");
requireText(sources.cutover, "--oci-evidence cutover-evidence/oci/evidence.json", "Architecture v2 cutover");
requireText(sources.cutover, '--expected-git-commit "$GITHUB_SHA"', "Architecture v2 cutover");
requireText(sources.cutover, "--expect-no-active-release", "Architecture v2 cutover");
requireText(sources.cutover, "--confirm-workflows-drained", "Architecture v2 cutover");
requireText(sources.cutover, "architecture-reset-preflight.mjs", "Architecture v2 cutover");
requireText(sources.cutover, "source-tombstone-receipt.json", "Architecture v2 cutover");
requireText(sources.cutover, "wrangler secret put MAINTENANCE_SMOKE_TOKEN", "Architecture v2 cutover");
requireText(sources.cutover, "cutover-evidence/container-rollout.json", "Architecture v2 cutover");
forbidText(sources.cutover, "architecture-reset-r2.mjs cleanup", "Architecture v2 cutover");

requireText(sources.cleanup, "actions/download-artifact@", "Architecture v2 cleanup");
requireText(sources.cleanup, "DELETE-EXACT-LEGACY-R2-KEYS", "Architecture v2 cleanup");
requireText(sources.cleanup, "architecture-reset-r2.mjs cleanup", "Architecture v2 cleanup");
requireText(sources.cleanup, "r2-cleanup-manifest.json", "Architecture v2 cleanup");
forbidText(sources.cleanup, "r2 object delete", "Architecture v2 cleanup");

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

const productionTemplate = await readFile("wrangler.quick-production.jsonc", "utf8");
const productionReleaseIdPlaceholder = "__WASM_OJ_RELEASE_ID__";
const productionManifestPlaceholder = "__WASM_OJ_RELEASE_MANIFEST_SHA256__";
const productionContainerDigestPlaceholder = "__WASM_OJ_CONTAINER_IMAGE_DIGEST__";
if (productionTemplate.split(productionReleaseIdPlaceholder).length - 1 !== 2) {
  throw new Error("Production Worker config must commit exactly two release-ID placeholders.");
}
if (productionTemplate.split(productionManifestPlaceholder).length - 1 !== 1) {
  throw new Error("Production Worker config must commit exactly one release-manifest placeholder.");
}
if (productionTemplate.split(productionContainerDigestPlaceholder).length - 1 !== 1) {
  throw new Error("Production Worker config must commit exactly one Container digest placeholder.");
}
if (
  workerConfigs.production.vars?.WASM_OJ_RELEASE_ID !== productionReleaseIdPlaceholder
  || workerConfigs.production.vars?.WASM_OJ_RELEASE_MANIFEST_SHA256 !== productionManifestPlaceholder
  || workerConfigs.production.containers?.find(
    (container) => container.class_name === "SubmissionJudgeContainer",
  )?.image !== `registry.cloudflare.com/b1c3d1b89f9131a84a0f1f6a973232f1/wasm-oj-judge-production:${productionReleaseIdPlaceholder}@${productionContainerDigestPlaceholder}`
) {
  throw new Error("Production Worker config must retain only the explicit release-coordinate template.");
}

const containerBindings = [
  ["SUBMISSION_CONTAINER", "SubmissionJudgeContainer"],
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
    throw new Error(`${name} Worker must bind only the Submission Cloudflare Container adapter.`);
  }
  const productDeletion = config.migrations?.find((migration) => migration.tag === "v2")?.deleted_classes;
  if (JSON.stringify(productDeletion) !== JSON.stringify(deletedProductClasses)) {
    throw new Error(`${name} Worker must delete the five product-state Durable Object classes in one migration.`);
  }
  const validationDeletion = config.migrations?.at(-1)?.deleted_classes;
  if (JSON.stringify(validationDeletion) !== JSON.stringify(["ValidationJudgeContainer"])) {
    throw new Error(`${name} Worker must delete the legacy ValidationJudgeContainer.`);
  }
  const workflows = config.workflows?.map((workflow) => [workflow.binding, workflow.class_name]);
  if (JSON.stringify(workflows) !== JSON.stringify([
    ["SUBMISSION_WORKFLOW", "SubmissionWorkflow"],
    ["CATALOG_WORKFLOW", "CatalogWorkflow"],
  ])) {
    throw new Error(`${name} Worker must bind only Submission and Catalog Workflows.`);
  }
}

console.log("Verified v2 workflows and the single Submission Container binding.");
