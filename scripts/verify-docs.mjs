import { createHash } from "node:crypto";
import { access, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const markdownFiles = [
  "README.md",
  "CHANGELOG.md",
  "SECURITY.md",
  "crates/runtime-core/README.md",
  "public/toolchains/README.md",
  ...await markdownBelow("docs"),
  ...(await markdownBelow("experiments")).filter((file) => file.endsWith("/SPEC.md")),
].sort(compareCodePoints);
const historicalGeneratedDocs = new Set([
  "docs/architecture-report.md",
  "docs/conformance-report.md",
  "docs/problem-bank/independent-041-045.md",
]);
const currentProductDocs = markdownFiles.filter((relative) => (
  relative === "README.md"
  || relative === "SECURITY.md"
  || relative === "THIRD_PARTY_NOTICES.md"
  || relative === "public/toolchains/README.md"
  || (relative.startsWith("docs/") && !historicalGeneratedDocs.has(relative))
));
const immutableCommandRecords = new Set([
]);
// This is an external Cloudflare service identity, not a product name. Renaming it during the
// architecture cutover would detach the deployed Worker from its existing secrets and callbacks.
const preservedExternalServiceIdentifiers = ["wasm-oj-forge-production"];

for (const relative of markdownFiles) {
  const source = await readFile(path.join(root, relative), "utf8");
  if (!immutableCommandRecords.has(relative)) {
    const legacyCommand = source.match(/\bnpm\s+(?:ci|install|pack|run)\b/);
    if (legacyCommand) {
      throw new Error(`${relative} contains legacy repository command '${legacyCommand[0]}'.`);
    }
    const literalRunSeparator = source.match(/\bpnpm\b[^\r\n]*\brun\s+\S+[^\r\n]*\s--(?=\s|$)/);
    if (literalRunSeparator) {
      throw new Error(`${relative} passes a literal '--' through pnpm run; pnpm forwards script arguments directly.`);
    }
  }
  for (const match of source.matchAll(/!?\[[^\]]*\]\(([^)]+)\)/g)) {
    const raw = match[1].trim().replace(/^<|>$/g, "");
    if (!raw || raw.startsWith("#") || raw.startsWith("/") || /^[a-z][a-z0-9+.-]*:/i.test(raw)) continue;
    const target = decodeURIComponent(raw.split("#", 1)[0]);
    if (!target) continue;
    const absolute = path.resolve(path.dirname(path.join(root, relative)), target);
    const escaped = path.relative(root, absolute);
    if (escaped.startsWith("..") || path.isAbsolute(escaped)) {
      throw new Error(`${relative} links outside the package boundary: '${raw}'.`);
    }
    try {
      await access(absolute);
    } catch {
      throw new Error(`${relative} contains a missing local link target '${raw}'.`);
    }
  }
}

for (const relative of currentProductDocs) {
  const source = await readFile(path.join(root, relative), "utf8");
  for (const [label, pattern] of [
    ["retired npm package", /@wasm-oj\/forge\b/],
    ["retired contract schema", /wasm-oj-forge-v1\b/],
    ["retired binary magic", /\b(?:FORGEFS1|FORGJDG1|FORGRPL1)\b/],
    ["retired collection CLI", /\bforge-collection\b/],
    ["retired environment variable", /\bFORGE_[A-Z0-9_]+\b/],
    ["retired HTTP header", /\bX-Forge-[A-Za-z0-9-]+\b/i],
    ["retired cookie", /\bforge_(?:session|csrf)\b/],
    ["retired global hook", /(?:forgeContract|__FORGE_[A-Z0-9_]+)/],
    ["retired schema or executable", /\bforge-(?:managed|browser|cost|contract|judge|runtime|replay|compiler|runner)[a-z0-9-]*\b/i],
    ["retired public API", /\b(?:create[A-Za-z0-9]*Forge|Forge(?:Engine|Compiler|Runner|Storage|Error)[A-Za-z0-9]*)\b/],
    ["retired toolchain option", /\b(?:assetBaseUrl|toolchainDirectory)\b/],
  ]) {
    const match = source.match(pattern);
    if (match) throw new Error(`${relative} contains ${label} '${match[0]}'.`);
  }

  const productScan = preservedExternalServiceIdentifiers.reduce(
    (scan, identifier) => scan.replaceAll(identifier, ""),
    source.replaceAll("wasm-oj/forge", ""),
  );
  const retiredProductName = productScan.match(/\bforge\b/i);
  if (retiredProductName) {
    throw new Error(`${relative} contains retired product name '${retiredProductName[0]}'.`);
  }
}

const readme = await readFile(path.join(root, "README.md"), "utf8");
for (const required of [
  "docs/integration-guide.md",
  "docs/releasing.md",
  "@wasm-oj/contracts",
  "@wasm-oj/core",
  "@wasm-oj/browser",
  "@wasm-oj/server",
  "@wasm-oj/organizer",
  "@wasm-oj/sdk",
  "@wasm-oj/toolchain-clang",
  "@wasm-oj/toolchain-rust",
  "@wasm-oj/toolchain-go",
  "@wasm-oj/toolchain-python",
  "@wasm-oj/toolchain-javascript",
  "createBrowserEngine",
  "createServerEngine",
  "browserSource",
  "serverSource",
  "WasmOjError",
  "wasm-oj-collection",
  "WOJRPL02",
  "WOJJDG02",
  "WOJFS002",
  "WOJGO002",
  "pnpm install --frozen-lockfile",
]) {
  if (!readme.includes(required)) throw new Error(`README.md does not document '${required}'.`);
}

const integrationGuide = await readFile(path.join(root, "docs/integration-guide.md"), "utf8");
for (const required of [
  "BrowserDependencyNetworkConsent",
  "dependencyNetworkAuthorizer: dependencyConsent",
  "repositorySourceKey",
  "problemBundleSha256",
  "completeDependencyHosts",
  "networkAccess:",
  "runtimeDriverPlugins",
  "prepareDependencies",
  "WasmOjError",
]) {
  if (!integrationGuide.includes(required)) {
    throw new Error(`docs/integration-guide.md does not bind browser dependency resolution to '${required}'.`);
  }
}
if (integrationGuide.includes("resolveDependencies(manifest);")) {
  throw new Error("docs/integration-guide.md resolves online dependencies without an explicit network scope.");
}

const libraryContract = await readFile(path.join(root, "docs/library-contract.md"), "utf8");
for (const required of [
  "networkAuthorizer: dependencyNetworkAuthorizer",
  "repositorySourceKey",
  "problemBundleSha256",
  "completeDependencyHosts",
  "networkAccess:",
]) {
  if (!libraryContract.includes(required)) {
    throw new Error(`docs/library-contract.md does not bind dependency resolution to '${required}'.`);
  }
}
if (libraryContract.includes("manager.resolve(manifest);")) {
  throw new Error("docs/library-contract.md resolves online dependencies without an explicit network scope.");
}

const toolchainDocs = await readFile(path.join(root, "public/toolchains/README.md"), "utf8");
for (const required of [
  "@wasm-oj/toolchain-clang",
  "@wasm-oj/toolchain-rust",
  "@wasm-oj/toolchain-go",
  "@wasm-oj/toolchain-python",
  "@wasm-oj/toolchain-javascript",
  "browserSource(baseUrl)",
  "serverSource()",
  "there is no",
  "WOJFS002",
]) {
  if (!toolchainDocs.includes(required)) {
    throw new Error(`public/toolchains/README.md does not document '${required}'.`);
  }
}
for (const entry of await readdir(path.join(root, "public/toolchains"), { withFileTypes: true })) {
  if (!entry.isFile() || entry.name === "README.md") continue;
  const bytes = await readFile(path.join(root, "public/toolchains", entry.name));
  const digest = createHash("sha256").update(bytes).digest("hex");
  const expectedLine = `${digest}  ${entry.name}`;
  if (!toolchainDocs.includes(expectedLine)) {
    throw new Error(`public/toolchains/README.md does not pin current asset '${expectedLine}'.`);
  }
}

const problemCatalog = await readFile(path.join(root, "docs/problem-catalog.md"), "utf8");
for (const required of [
  "wasm-oj-collection",
  ".github/actions/wasm-oj-collection/action.yml",
  "@wasm-oj/organizer@0.2.0",
  "wasm-oj-platform/managed-collection-source/v1",
  "wasm-oj-platform/managed-collection/v2",
  "WOJJDG02",
]) {
  if (!problemCatalog.includes(required)) {
    throw new Error(`docs/problem-catalog.md does not document '${required}'.`);
  }
}

const onlineJudgeDocs = [
  "docs/cloudflare-online-judge.md",
  "docs/cloudflare-deployment-plan.md",
];
for (const relative of onlineJudgeDocs) {
  const source = await readFile(path.join(root, relative), "utf8");
  for (const removed of [
    "SubmissionDO",
    "UserQuotaDO",
    "AdmissionControlDO",
    "ProblemLeaderboardDO",
    "ContestDO",
    "WebSocket",
    "lease TTL",
  ]) {
    if (source.includes(removed)) {
      throw new Error(`${relative} still documents removed product state '${removed}'.`);
    }
  }
}

const onlineJudge = await readFile(path.join(root, "docs/cloudflare-online-judge.md"), "utf8");
for (const required of [
  "submission_events",
  "events?after=<cursor>",
  "formal_mutations_enabled",
  "SubmissionJudgeContainer",
  "Catalog Workflow",
]) {
  if (!onlineJudge.includes(required)) {
    throw new Error(`docs/cloudflare-online-judge.md does not document '${required}'.`);
  }
}
if (onlineJudge.includes("ValidationJudgeContainer")) {
  throw new Error("docs/cloudflare-online-judge.md still documents the removed ValidationJudgeContainer.");
}

const deploymentPlan = await readFile(path.join(root, "docs/cloudflare-deployment-plan.md"), "utf8");
for (const required of [
  "/api/admin/formal-mutations/resume",
  "Origin: $WASM_OJ_ORIGIN",
  "Content-Type: application/json",
  "X-WASM-OJ-CSRF: $WASM_OJ_CUTOVER_ADMIN_CSRF",
  "wasm_oj_session=$WASM_OJ_CUTOVER_ADMIN_SESSION",
  "wasm_oj_csrf=$WASM_OJ_CUTOVER_ADMIN_CSRF",
  "X-WASM-OJ-Maintenance-Smoke-Token",
  "WASM_OJ_ARCHITECTURE_RESET_TOKEN",
  "WASM_OJ_PRODUCTION_RELEASE_REQUEST_BASE64",
  "WASM_OJ_V2_ACTIVATION_REQUEST_BASE64",
  "scripts/generate-production-release-inputs.mjs",
  "scripts/prepare-production-release.mjs",
  "scripts/verify-oci-release-image.mjs",
  "scripts/configure-production-release.mjs",
  "scripts/wait-container-rollout.mjs",
  "wasm_oj_active_releases",
  "architecture-v2-production-smoke-passed",
  "enabled: true",
]) {
  if (!deploymentPlan.includes(required)) {
    throw new Error(`docs/cloudflare-deployment-plan.md does not document the executable cutover contract '${required}'.`);
  }
}

await access(path.join(root, "pnpm-lock.yaml"));
try {
  await access(path.join(root, "package-lock.json"));
  throw new Error("package-lock.json must not coexist with the pnpm lockfile.");
} catch (error) {
  if (error?.code !== "ENOENT") throw error;
}

process.stdout.write(
  `Verified ${markdownFiles.length} documentation files, ${currentProductDocs.length} current WASM-OJ documents, and pnpm-only commands.\n`,
);

async function markdownBelow(relativeDirectory) {
  const directory = path.join(root, relativeDirectory);
  const output = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const relative = path.posix.join(relativeDirectory, entry.name);
    if (entry.isDirectory()) output.push(...await markdownBelow(relative));
    else if (entry.isFile() && entry.name.endsWith(".md")) output.push(relative);
    else if (!entry.isFile()) throw new Error(`Documentation boundary contains unsupported entry '${relative}'.`);
  }
  return output;
}

function compareCodePoints(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}
