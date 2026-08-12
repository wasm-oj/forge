import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { parseCanonicalJsonBytes, canonicalJsonBytes } from "../src/core/canonical-json.ts";
import { WASM_OJ_RUNTIME_IDENTITY_SHA256 } from "../src/core/runtime-identity.ts";
import { WEIGHTED_METER_MODEL } from "../src/core/resources.ts";
import { parseReleaseManifest, releaseManifestBytes } from "../src/release-manifest.ts";
import { verifyProductionReleaseInputs } from "./production-release-inputs.mjs";

const SHA256 = /^[0-9a-f]{64}$/;
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

function object(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${label} must be an object.`);
  return value;
}

function exactKeys(value, expected, label) {
  if (JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...expected].sort())) {
    throw new TypeError(`${label} has an invalid shape.`);
  }
}

function requireDigest(value, label) {
  if (typeof value !== "string" || !SHA256.test(value)) throw new TypeError(`${label} must be a lowercase SHA-256 digest.`);
  return value;
}

export function parseContainerIdentity(bytes, expectedReleaseId, expectedGitCommit) {
  const identity = object(parseCanonicalJsonBytes(bytes, "container identity"), "container identity");
  exactKeys(identity, IDENTITY_KEYS, "container identity");
  if (
    identity.schema !== "wasm-oj-platform/container-identity/v2"
    || identity.contract !== 2
    || identity.protocol !== "wasm-oj-container-v2"
    || identity.releaseId !== expectedReleaseId
    || identity.gitCommit !== expectedGitCommit
  ) throw new TypeError("Container identity does not match the release-input coordinates.");
  for (const key of [
    "compilerSha256", "executionRootSha256", "runnerSha256", "runtimeRootSha256", "toolchainRootSha256",
  ]) requireDigest(identity[key], `container identity.${key}`);
  return identity;
}

function inputPath(root, record) {
  return path.join(root, ...record.path.split("/"));
}

/** Re-hash the complete input bundle, then derive one immutable release manifest. */
export async function prepareProductionRelease(inputManifestPath) {
  const { inputs, root } = await verifyProductionReleaseInputs(inputManifestPath);
  const identityBytes = await readFile(inputPath(root, inputs.records.containerIdentity));
  const identity = parseContainerIdentity(identityBytes, inputs.release.releaseId, inputs.source.commit);
  if (identity.toolchainRootSha256 !== inputs.records.toolchains.sha256) {
    throw new Error("Container identity toolchain root does not match the preserved toolchain bytes.");
  }
  const manifest = parseReleaseManifest({
    schema: "wasm-oj-v2/release-manifest",
    releaseId: inputs.release.releaseId,
    version: inputs.release.version,
    wasmOjContract: 2,
    createdAt: inputs.release.createdAt,
    source: inputs.source,
    build: {
      nodeVersion: inputs.build.nodeVersion,
      pnpmVersion: inputs.build.pnpmVersion,
      rustVersion: inputs.build.rustVersion,
      lockSha256: inputs.records.lock.sha256,
      sbomSha256: inputs.records.sbom.sha256,
      licensesSha256: inputs.records.licenses.sha256,
      auditSha256: inputs.records.audit.sha256,
    },
    artifacts: {
      npmPackage: { bytes: inputs.records.npmPackage.bytes, sha256: inputs.records.npmPackage.sha256 },
      workerBundle: { bytes: inputs.records.workerBundle.bytes, sha256: inputs.records.workerBundle.sha256 },
      staticAssets: { bytes: inputs.records.staticAssets.bytes, sha256: inputs.records.staticAssets.sha256 },
      containerImage: {
        registry: inputs.container.registry,
        digest: inputs.container.digest,
        identitySha256: inputs.records.containerIdentity.sha256,
        platform: "linux/amd64",
        dockerfileSha256: inputs.records.dockerfile.sha256,
        baseImages: inputs.container.baseImages,
      },
    },
    runtime: {
      protocolVersion: identity.protocol,
      executionRootSha256: identity.executionRootSha256,
      rootSha256: identity.runtimeRootSha256,
      runtimeIdentitySha256: WASM_OJ_RUNTIME_IDENTITY_SHA256,
      runtimeCoreSha256: inputs.records.runtimeCore.sha256,
      wasmerVersion: inputs.build.wasmerVersion,
      wasmerSha256: inputs.records.wasmer.sha256,
      compilerSha256: identity.compilerSha256,
      runnerSha256: identity.runnerSha256,
    },
    toolchains: {
      rootSha256: identity.toolchainRootSha256,
      manifestSha256: inputs.records.toolchains.sha256,
    },
    cost: {
      model: WEIGHTED_METER_MODEL,
      profileRootSha256: inputs.records.costProfiles.sha256,
      baselineSha256: inputs.records.costBaseline.sha256,
    },
    evidence: {
      conformanceSha256: inputs.records.conformance.sha256,
      testsSha256: inputs.records.tests.sha256,
      costCalibrationSha256: inputs.records.costCalibration.sha256,
    },
    migrations: { databaseSha256: inputs.records.migrations.sha256 },
    provenance: inputs.provenance,
  });
  const manifestBytes = releaseManifestBytes(manifest);
  const manifestSha256 = sha256(manifestBytes);
  const activationRequest = {
    expectedCurrentReleaseId: inputs.release.expectedCurrentReleaseId,
    manifest,
  };
  return Object.freeze({
    activationRequest,
    activationRequestBytes: canonicalJsonBytes(activationRequest),
    manifest,
    manifestBytes,
    manifestSha256,
  });
}

function usage() {
  return `Usage: node scripts/prepare-production-release.mjs \\
  --inputs <release-inputs/release-inputs.json> --output-dir <new-directory>

Every release digest is re-derived from the preserved bytes in the generated input bundle.
`;
}

async function main() {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      inputs: { type: "string" },
      "output-dir": { type: "string" },
      help: { type: "boolean", short: "h" },
    },
    strict: true,
  });
  if (values.help) {
    process.stdout.write(usage());
    return;
  }
  if (!values.inputs || !values["output-dir"]) throw new TypeError(`--inputs and --output-dir are required.\n\n${usage()}`);
  const prepared = await prepareProductionRelease(values.inputs);
  await mkdir(values["output-dir"], { recursive: false });
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
  })}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
