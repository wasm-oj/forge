import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { sourceTreeProvenanceAtCommit } from "../src/conformance/provenance.ts";
import { canonicalJsonBytes, parseCanonicalJsonBytes } from "../src/core/canonical-json.ts";
import {
  parseReleaseManifest,
  releaseManifestBytes,
} from "../src/release-manifest.ts";

const SHA256 = /^[0-9a-f]{64}$/;
const OCI_DIGEST = /^sha256:[0-9a-f]{64}$/;
const GIT_COMMIT = /^[0-9a-f]{40}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const IDENTITY_KEYS = [
  "compilerSha256",
  "contract",
  "executionRootSha256",
  "gitCommit",
  "protocol",
  "releaseId",
  "runnerSha256",
  "runtimeRootSha256",
  "schema",
  "toolchainRootSha256",
];

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function requireDigest(value, label) {
  if (typeof value !== "string" || !SHA256.test(value)) {
    throw new TypeError(`${label} must be a lowercase SHA-256 digest.`);
  }
  return value;
}

function requireObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object.`);
  }
  return value;
}

function requireExactKeys(value, expected, label) {
  if (JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...expected].sort())) {
    throw new TypeError(`${label} has an invalid shape.`);
  }
}

function parseContainerIdentity(bytes, expectedReleaseId, expectedGitCommit) {
  const identity = requireObject(parseCanonicalJsonBytes(bytes, "container identity"), "container identity");
  requireExactKeys(identity, IDENTITY_KEYS, "container identity");
  if (
    identity.schema !== "wasm-oj-platform/container-identity/v2"
    || identity.contract !== 2
    || identity.protocol !== "wasm-oj-container-v2"
    || identity.releaseId !== expectedReleaseId
    || identity.gitCommit !== expectedGitCommit
  ) {
    throw new TypeError("Container identity does not match the requested release coordinates.");
  }
  for (const key of [
    "compilerSha256",
    "executionRootSha256",
    "runnerSha256",
    "runtimeRootSha256",
    "toolchainRootSha256",
  ]) requireDigest(identity[key], `container identity.${key}`);
  return identity;
}

function parseArtifact(value, label) {
  const artifact = requireObject(value, label);
  requireExactKeys(artifact, ["bytes", "sha256"], label);
  if (!Number.isSafeInteger(artifact.bytes) || artifact.bytes < 1) {
    throw new TypeError(`${label}.bytes must be a positive safe integer.`);
  }
  return { bytes: artifact.bytes, sha256: requireDigest(artifact.sha256, `${label}.sha256`) };
}

/**
 * Prepare immutable release bytes and an authenticated atomic activation request.
 * This is deliberately offline: callers decide when and how to upload/execute.
 */
export function prepareProductionRelease({
  template,
  releaseId,
  version,
  gitCommit,
  sourceTreeSha256,
  containerIdentityBytes,
  containerImageDigest,
  databaseSha256,
  createdAt,
  expectedCurrentReleaseId = null,
  sourceTag,
  workerBundleArtifact,
  staticAssetsArtifact,
}) {
  if (!UUID.test(releaseId)) throw new TypeError("releaseId must be a UUID.");
  if (expectedCurrentReleaseId !== null && !UUID.test(expectedCurrentReleaseId)) {
    throw new TypeError("expectedCurrentReleaseId must be null or a UUID.");
  }
  if (!GIT_COMMIT.test(gitCommit)) throw new TypeError("gitCommit must be a full lowercase Git commit SHA.");
  if (!OCI_DIGEST.test(containerImageDigest)) {
    throw new TypeError("containerImageDigest must be an immutable sha256 OCI digest.");
  }
  requireDigest(sourceTreeSha256, "sourceTreeSha256");
  requireDigest(databaseSha256, "databaseSha256");
  const identity = parseContainerIdentity(containerIdentityBytes, releaseId, gitCommit);
  const source = requireObject(requireObject(template, "release template").source, "release template.source");
  const artifacts = requireObject(template.artifacts, "release template.artifacts");
  const runtime = requireObject(template.runtime, "release template.runtime");
  const toolchains = requireObject(template.toolchains, "release template.toolchains");

  const manifest = parseReleaseManifest({
    ...template,
    releaseId,
    version,
    createdAt,
    source: {
      repository: source.repository,
      commit: gitCommit,
      sourceTreeSha256,
      ...(sourceTag === undefined ? {} : { tag: sourceTag }),
    },
    artifacts: {
      ...artifacts,
      ...(workerBundleArtifact === undefined
        ? {}
        : { workerBundle: parseArtifact(workerBundleArtifact, "worker bundle artifact") }),
      ...(staticAssetsArtifact === undefined
        ? {}
        : { staticAssets: parseArtifact(staticAssetsArtifact, "static assets artifact") }),
      containerImage: {
        ...requireObject(artifacts.containerImage, "release template.artifacts.containerImage"),
        digest: containerImageDigest,
        identitySha256: sha256(containerIdentityBytes),
      },
    },
    runtime: {
      ...runtime,
      protocolVersion: identity.protocol,
      executionRootSha256: identity.executionRootSha256,
      rootSha256: identity.runtimeRootSha256,
      compilerSha256: identity.compilerSha256,
      runnerSha256: identity.runnerSha256,
    },
    toolchains: {
      ...toolchains,
      rootSha256: identity.toolchainRootSha256,
    },
    migrations: { databaseSha256 },
  });
  const manifestBytes = releaseManifestBytes(manifest);
  const manifestSha256 = sha256(manifestBytes);
  const activationRequest = { expectedCurrentReleaseId, manifest };
  return {
    manifest,
    manifestBytes,
    manifestSha256,
    activationRequest,
    activationRequestBytes: canonicalJsonBytes(activationRequest),
  };
}

async function readJson(pathname, label) {
  let value;
  try {
    value = JSON.parse(await readFile(pathname, "utf8"));
  } catch (error) {
    throw new TypeError(`${label} is not valid JSON.`, { cause: error });
  }
  return value;
}

function usage() {
  return `Usage: node scripts/prepare-production-release.mjs \\
  --template <canonical-manifest.json> \\
  --release-id <uuid> --version <semver> --git-commit <sha> \\
  --container-identity <container-identity.json> \\
  --container-image-digest <sha256:...> --database-sha256 <sha256> \\
  --output-dir <directory> [--created-at <ISO timestamp>] \\
  (--expected-current-release-id <uuid> | --expect-no-active-release) \\
  [--source-tag <tag>] \\
  [--worker-bundle-artifact <artifact.json>] \\
  [--static-assets-artifact <artifact.json>]

The helper only writes local files. artifact.json is {"bytes":123,"sha256":"..."}.
`;
}

async function main() {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      template: { type: "string" },
      "release-id": { type: "string" },
      version: { type: "string" },
      "git-commit": { type: "string" },
      "container-identity": { type: "string" },
      "container-image-digest": { type: "string" },
      "database-sha256": { type: "string" },
      "output-dir": { type: "string" },
      "created-at": { type: "string" },
      "expected-current-release-id": { type: "string" },
      "expect-no-active-release": { type: "boolean" },
      "source-tag": { type: "string" },
      "worker-bundle-artifact": { type: "string" },
      "static-assets-artifact": { type: "string" },
      help: { type: "boolean", short: "h" },
    },
    strict: true,
  });
  if (values.help) {
    process.stdout.write(usage());
    return;
  }
  const required = [
    "template",
    "release-id",
    "version",
    "git-commit",
    "container-identity",
    "container-image-digest",
    "database-sha256",
    "output-dir",
  ];
  for (const key of required) {
    if (!values[key]) throw new TypeError(`--${key} is required.\n\n${usage()}`);
  }
  if (Boolean(values["expected-current-release-id"]) === Boolean(values["expect-no-active-release"])) {
    throw new TypeError(`Exactly one release activation precondition is required.\n\n${usage()}`);
  }

  const [templateBytes, containerIdentityBytes, sourceTree, workerBundleArtifact, staticAssetsArtifact] = await Promise.all([
    readFile(values.template),
    readFile(values["container-identity"]),
    sourceTreeProvenanceAtCommit(process.cwd(), values["git-commit"]),
    values["worker-bundle-artifact"]
      ? readJson(values["worker-bundle-artifact"], "worker bundle artifact")
      : undefined,
    values["static-assets-artifact"]
      ? readJson(values["static-assets-artifact"], "static assets artifact")
      : undefined,
  ]);
  const template = parseCanonicalJsonBytes(templateBytes, "release template");
  const prepared = prepareProductionRelease({
    template,
    releaseId: values["release-id"],
    version: values.version,
    gitCommit: values["git-commit"],
    sourceTreeSha256: sourceTree.sha256,
    containerIdentityBytes,
    containerImageDigest: values["container-image-digest"],
    databaseSha256: values["database-sha256"],
    createdAt: values["created-at"] ?? new Date().toISOString(),
    expectedCurrentReleaseId: values["expected-current-release-id"] ?? null,
    sourceTag: values["source-tag"],
    workerBundleArtifact,
    staticAssetsArtifact,
  });

  await mkdir(values["output-dir"], { recursive: true });
  const manifestPath = path.join(values["output-dir"], "manifest.json");
  const activationRequestPath = path.join(values["output-dir"], "activation-request.json");
  await Promise.all([
    writeFile(manifestPath, prepared.manifestBytes, { flag: "wx" }),
    writeFile(activationRequestPath, prepared.activationRequestBytes, { flag: "wx" }),
  ]);
  process.stdout.write(`${JSON.stringify({
    releaseId: prepared.manifest.releaseId,
    manifestSha256: prepared.manifestSha256,
    manifestPath,
    activationRequestPath,
  }, null, 2)}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
