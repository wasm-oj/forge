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
  ["actions/checkout", "9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0"],
  ["actions/setup-node", "820762786026740c76f36085b0efc47a31fe5020"],
  ["pnpm/action-setup", "0ebf47130e4866e96fce0953f49152a61190b271"],
  ["actions/attest-build-provenance", "0f67c3f4856b2e3261c31976d6725780e5e4c373"],
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
assertTrigger(release.document, "workflow_dispatch", "Release");
if (Object.keys(release.document.on).some((key) => !["push", "workflow_dispatch"].includes(key))) {
  throw new Error("Release workflow may only use version-tag pushes and explicit recovery dispatches.");
}
const tagPatterns = release.document.on.push?.tags;
if (!Array.isArray(tagPatterns) || tagPatterns.length !== 1 || tagPatterns[0] !== "v*.*.*") {
  throw new Error("Release workflow must accept only vMAJOR.MINOR.PATCH-shaped tags.");
}
const recoveryTag = release.document.on.workflow_dispatch?.inputs?.tag;
if (recoveryTag?.required !== true || recoveryTag?.type !== "string") {
  throw new Error("Release recovery dispatch must require one explicit tag string.");
}
assertPermission(release.document.permissions, "contents", "read", "Release workflow");
const publishJob = requiredJob(release.document, "publish", "Release workflow");
if (publishJob.environment !== "npm") throw new Error("Release publish job must use the npm environment.");
if (publishJob.env?.RELEASE_TAG !== "${{ inputs.tag || github.ref_name }}") {
  throw new Error("Release publish job must bind all operations to the requested or pushed tag.");
}
if (publishJob.defaults?.run?.["working-directory"] !== "source") {
  throw new Error("Release commands must execute against the separately checked-out release source.");
}
for (const [permission, value] of [
  ["contents", "write"],
  ["id-token", "write"],
  ["attestations", "write"],
]) assertPermission(publishJob.permissions, permission, value, "Release publish job");
assertRunContains(publishJob, "pnpm run ci:verify", "Release publish job");
assertRunContains(publishJob, "pnpm run release:verify", "Release publish job");
assertRunContains(publishJob, "pnpm publish", "Release publish job");
assertRunContains(publishJob, "download-registry-artifact.mjs", "Release publish job");
assertRunContains(publishJob, "verify-release-artifacts.mjs", "Release publish job");
assertRunContains(publishJob, "verify-github-release-assets.mjs", "Release publish job");
assertRunContains(publishJob, "gh release edit", "Release publish job");
if (release.source.includes("secrets.NPM_TOKEN") || release.source.includes("NODE_AUTH_TOKEN")) {
  throw new Error("Release workflow must use only the npm trusted publisher identity.");
}
if (release.source.includes('pnpm pack "$package_spec"')) {
  throw new Error("Release workflow must download registry bytes instead of repacking the source tree.");
}
if (!release.source.includes('test "$status" -eq 10')) {
  throw new Error("Release asset reuse must distinguish an expected mismatch from invalid metadata.");
}
assertAutomationCheckout(publishJob);
assertCheckoutPolicy(publishJob, "Release publish job", true, "Check out the release tag and LFS assets");
assertReleaseStepOrder(publishJob);

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

function assertCheckoutPolicy(job, label, requireHistory, stepName) {
  const checkout = (job.steps ?? []).find((step) => (
    String(step?.uses ?? "").startsWith("actions/checkout@")
    && (stepName === undefined || step.name === stepName)
  ));
  if (checkout?.with?.lfs !== true || checkout.with["persist-credentials"] !== false) {
    throw new Error(`${label} must materialize LFS and remove checkout credentials.`);
  }
  if (requireHistory && checkout.with["fetch-depth"] !== 0) {
    throw new Error(`${label} must fetch tag and main ancestry.`);
  }
}

function assertAutomationCheckout(job) {
  const checkout = (job.steps ?? []).find((step) => step?.name === "Check out release automation");
  if (
    !String(checkout?.uses ?? "").startsWith("actions/checkout@")
    || checkout.with?.path !== ".release-automation"
    || checkout.with?.["persist-credentials"] !== false
  ) {
    throw new Error("Release workflow must isolate current automation from the immutable release source.");
  }
}

function assertReleaseStepOrder(job) {
  const names = (job.steps ?? []).map((step) => step?.name);
  const required = [
    "Pack and verify the release candidate",
    "Publish candidate and resolve canonical registry artifact",
    "Attest the canonical registry artifact",
    "Create or update the draft GitHub Release",
    "Publish the GitHub Release",
  ];
  const positions = required.map((name) => names.indexOf(name));
  if (positions.some((position) => position < 0) || positions.some((position, index) => index > 0 && position <= positions[index - 1])) {
    throw new Error("Release workflow must publish, resolve, attest, and expose the canonical artifact in that order.");
  }
  const attestation = (job.steps ?? [])[positions[2]];
  if (attestation?.with?.["subject-path"] !== "${{ steps.registry.outputs.tarball }}") {
    throw new Error("Release attestation must bind the canonical registry bytes.");
  }
}
