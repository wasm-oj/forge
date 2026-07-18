import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { load } from "js-yaml";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const workflowPaths = [
  ".github/workflows/ci.yml",
  ".github/workflows/release.yml",
];
const pinnedActions = new Map([
  ["actions/checkout", "de0fac2e4500dabe0009e67214ff5f5447ce83dd"],
  ["actions/setup-node", "6044e13b5dc448c55e2357c09f80417699197238"],
  ["pnpm/action-setup", "8912a9102ac27614460f54aedde9e1e7f9aec20d"],
  ["actions/attest-build-provenance", "977bb373ede98d70efdf65b84cb5f73e068dcc2a"],
]);

const workflows = new Map();
for (const relative of workflowPaths) {
  const source = await readFile(path.join(root, relative), "utf8");
  if (/\bpull_request_target\s*:/.test(source)) {
    throw new Error(`${relative} must not execute repository code through pull_request_target.`);
  }
  if (/\bnpm\s+(?:ci|install|pack|publish|run)\b/.test(source) || /\bnpx\s/.test(source)) {
    throw new Error(`${relative} bypasses the pinned pnpm package manager.`);
  }
  const document = load(source);
  if (!document || typeof document !== "object" || Array.isArray(document)) {
    throw new Error(`${relative} must contain one workflow mapping.`);
  }
  assertActionPins(document, relative);
  workflows.set(relative, { source, document });
}

const ci = workflows.get(".github/workflows/ci.yml");
assertTrigger(ci.document, "push", "CI");
assertTrigger(ci.document, "pull_request", "CI");
assertTrigger(ci.document, "workflow_dispatch", "CI");
assertPermission(ci.document.permissions, "contents", "read", "CI workflow");
const ciJob = requiredJob(ci.document, "verify", "CI workflow");
if (ciJob.permissions !== undefined) throw new Error("CI verify job must inherit the read-only workflow permissions.");
assertRunContains(ciJob, "pnpm install --frozen-lockfile", "CI verify job");
assertRunContains(ciJob, "pnpm run ci:verify", "CI verify job");
assertCheckoutPolicy(ciJob, "CI verify job", false);

const release = workflows.get(".github/workflows/release.yml");
assertTrigger(release.document, "push", "Release");
if (Object.keys(release.document.on).some((key) => key !== "push")) {
  throw new Error("Release workflow must have the version-tag push as its only trigger.");
}
const tagPatterns = release.document.on.push?.tags;
if (!Array.isArray(tagPatterns) || tagPatterns.length !== 1 || tagPatterns[0] !== "v*.*.*") {
  throw new Error("Release workflow must accept only vMAJOR.MINOR.PATCH-shaped tags.");
}
assertPermission(release.document.permissions, "contents", "read", "Release workflow");
const publishJob = requiredJob(release.document, "publish", "Release workflow");
if (publishJob.environment !== "npm") throw new Error("Release publish job must use the npm environment.");
for (const [permission, value] of [
  ["contents", "write"],
  ["id-token", "write"],
  ["attestations", "write"],
]) assertPermission(publishJob.permissions, permission, value, "Release publish job");
assertRunContains(publishJob, "pnpm run ci:verify", "Release publish job");
assertRunContains(publishJob, "pnpm run release:verify", "Release publish job");
assertRunContains(publishJob, "pnpm publish", "Release publish job");
assertRunContains(publishJob, "gh release edit", "Release publish job");
assertCheckoutPolicy(publishJob, "Release publish job", true);

const packageJson = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
if (packageJson.repository?.url !== "git+https://github.com/wasm-oj/forge.git") {
  throw new Error("package.json repository must bind npm provenance to wasm-oj/forge.");
}
if (packageJson.publishConfig?.registry !== "https://registry.npmjs.org/") {
  throw new Error("package.json must publish only to the public npm registry.");
}

process.stdout.write("Verified pinned, least-privilege GitHub CI and release workflows.\n");

function assertActionPins(document, relative) {
  for (const job of Object.values(document.jobs ?? {})) {
    for (const step of job?.steps ?? []) {
      if (typeof step?.uses !== "string") continue;
      const match = /^([^@]+)@([0-9a-f]{40})$/.exec(step.uses);
      if (!match) throw new Error(`${relative} action '${step.uses}' is not pinned to a full commit SHA.`);
      const expected = pinnedActions.get(match[1]);
      if (!expected) throw new Error(`${relative} uses unadmitted action '${match[1]}'.`);
      if (match[2] !== expected) throw new Error(`${relative} action '${match[1]}' has an unverified commit SHA.`);
    }
  }
}

function assertTrigger(document, trigger, label) {
  if (!document.on || typeof document.on !== "object" || !(trigger in document.on)) {
    throw new Error(`${label} workflow is missing '${trigger}'.`);
  }
}

function assertPermission(permissions, key, expected, label) {
  if (!permissions || permissions[key] !== expected) {
    throw new Error(`${label} must grant '${key}: ${expected}'.`);
  }
}

function requiredJob(document, name, label) {
  const job = document.jobs?.[name];
  if (!job || typeof job !== "object") throw new Error(`${label} is missing job '${name}'.`);
  if (job["runs-on"] !== "ubuntu-24.04") throw new Error(`${label} job '${name}' must pin ubuntu-24.04.`);
  if (!Number.isSafeInteger(job["timeout-minutes"]) || job["timeout-minutes"] <= 0) {
    throw new Error(`${label} job '${name}' must have a finite timeout.`);
  }
  return job;
}

function assertRunContains(job, expected, label) {
  const commands = (job.steps ?? []).map((step) => step?.run).filter((run) => typeof run === "string").join("\n");
  if (!commands.includes(expected)) throw new Error(`${label} does not execute '${expected}'.`);
}

function assertCheckoutPolicy(job, label, requireHistory) {
  const checkout = (job.steps ?? []).find((step) => String(step?.uses ?? "").startsWith("actions/checkout@"));
  if (checkout?.with?.lfs !== true || checkout.with["persist-credentials"] !== false) {
    throw new Error(`${label} must materialize LFS and remove checkout credentials.`);
  }
  if (requireHistory && checkout.with["fetch-depth"] !== 0) {
    throw new Error(`${label} must fetch tag and main ancestry.`);
  }
}
