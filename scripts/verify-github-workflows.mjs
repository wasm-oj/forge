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
  "timeout-minutes: 60",
  "node-version: 24.18.0",
  "version: 10.34.5",
  'CONTAINER_IMAGE: wasm-oj-submission-production:${{ github.sha }}',
  'DOCKER_BUILD_RECORD_UPLOAD: "false"',
  "render-production-config.mjs",
  "docker/setup-buildx-action@d7f5e7f509e45cec5c76c4d5afdd7de93d0b3df5",
  "driver: docker-container",
  "docker/build-push-action@f9f3042f7e2789586610d6e8b85c8f03e5195baf",
  "platforms: linux/amd64",
  "load: true",
  "provenance: false",
  "tags: ${{ env.CONTAINER_IMAGE }}",
  "build-args: WASM_OJ_BUILD_ID=${{ github.sha }}",
  "cache-from: type=gha,scope=wasm-oj-submission-production",
  "cache-to: type=gha,scope=wasm-oj-submission-production,mode=max",
  'production-migrations.mjs apply',
  'wrangler containers push "$CONTAINER_IMAGE" --config wrangler.quick-production.jsonc',
  'wrangler deploy --config wrangler.quick-production.jsonc --tag "$GITHUB_SHA"',
  "wait-container-rollout.mjs",
  "--capture-baseline",
  "--baseline",
  "--timeout-seconds 1800",
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
  "--dockerfile Dockerfile",
]) forbidText(production, removed, "Production deployment");

const ordered = [
  "render-production-config.mjs",
  "docker/setup-buildx-action@d7f5e7f509e45cec5c76c4d5afdd7de93d0b3df5",
  "docker/build-push-action@f9f3042f7e2789586610d6e8b85c8f03e5195baf",
  "production-migrations.mjs apply",
  "--capture-baseline",
  'wrangler containers push "$CONTAINER_IMAGE" --config wrangler.quick-production.jsonc',
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

if (productionSource.split("__WASM_OJ_BUILD_ID__").length - 1 !== 2
  || productionConfig.vars?.WASM_OJ_BUILD_ID !== "__WASM_OJ_BUILD_ID__"
  || productionConfig.containers?.length !== 1
  || productionConfig.containers[0]?.image !== "registry.cloudflare.com/b1c3d1b89f9131a84a0f1f6a973232f1/wasm-oj-submission-production:__WASM_OJ_BUILD_ID__"
  || productionConfig.containers[0]?.rollout_step_percentage !== 100) {
  throw new Error("Production config must bind one exact Git commit to the Worker and prebuilt Container with one-step rollout.");
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
    ["PROMPT_ATTEMPT_WORKFLOW", "PromptAttemptWorkflow"],
  ])) throw new Error(`${name} must bind the submission, catalog, and Prompt Program workflows.`);
}

console.log("Verified repository-source production deployment workflow.");
