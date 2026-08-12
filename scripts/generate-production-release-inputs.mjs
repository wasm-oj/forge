import { readFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { sourceTreeProvenanceAtCommit } from "../src/conformance/provenance.ts";
import { runtimeIdentityBytes } from "../src/core/runtime-identity.ts";
import { verifyOciTagVerificationFile } from "./oci-release-image.mjs";
import {
  copyReleaseInput,
  describeReleaseInput,
  parseDockerfileBaseImages,
  productionReleaseInputBytes,
  releaseCheckEvidenceBytes,
  verifyProductionReleaseInputs,
} from "./production-release-inputs.mjs";

const FILE_DESTINATIONS = Object.freeze({
  audit: "bytes/build/audit",
  conformance: "bytes/evidence/conformance",
  containerIdentity: "bytes/container/container-identity.json",
  costBaseline: "bytes/evidence/cost-baseline",
  costCalibration: "bytes/evidence/cost-calibration",
  costProfiles: "bytes/evidence/cost-profiles",
  dockerfile: "bytes/container/Dockerfile",
  lock: "bytes/build/pnpm-lock.yaml",
  npmPackage: "bytes/artifacts/npm-package.tgz",
  runtimeCore: "bytes/runtime/runtime-core.wasm",
  runtimeIdentity: "bytes/runtime/runtime-identity.json",
  sbom: "bytes/build/sbom",
  tests: "bytes/evidence/tests",
  wasmer: "bytes/runtime/wasmer.wasm",
});
const TREE_DESTINATIONS = Object.freeze({
  licenses: "bytes/build/licenses",
  migrations: "bytes/migrations",
  ociEvidence: "bytes/container/oci",
  staticAssets: "bytes/artifacts/static-assets",
  toolchains: "bytes/runtime/toolchains",
  workerBundle: "bytes/artifacts/worker-bundle",
});

function repositoryUrl(manifest) {
  const value = manifest.repository?.url;
  if (typeof value !== "string" || !value.startsWith("git+https://github.com/") || !value.endsWith(".git")) {
    throw new TypeError("Root package repository must be one canonical GitHub git+https URL.");
  }
  return value.slice("git+".length, -".git".length);
}

function exactVersion(source, pattern, label) {
  const match = pattern.exec(source);
  if (!match || typeof match[1] !== "string") throw new TypeError(`${label} version could not be derived.`);
  return match[1];
}

export async function deriveProductionBuildIdentity(root = process.cwd()) {
  const [packageBytes, rustToolchain, cargoLock] = await Promise.all([
    readFile(path.join(root, "package.json")),
    readFile(path.join(root, "rust-toolchain.toml"), "utf8"),
    readFile(path.join(root, "crates/runtime-core/Cargo.lock"), "utf8"),
  ]);
  const manifest = JSON.parse(packageBytes);
  return Object.freeze({
    nodeVersion: process.versions.node,
    pnpmVersion: exactVersion(manifest.packageManager ?? "", /^pnpm@([^\s]+)$/u, "pnpm"),
    repository: repositoryUrl(manifest),
    rustVersion: exactVersion(rustToolchain, /^channel = "([^"]+)"$/mu, "Rust"),
    wasmerVersion: exactVersion(cargoLock, /^name = "wasmer"\nversion = "([^"]+)"$/mu, "Wasmer"),
  });
}

async function writeStatusEvidence(outputRoot, role, check) {
  const relative = FILE_DESTINATIONS[role];
  const target = path.join(outputRoot, ...relative.split("/"));
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, releaseCheckEvidenceBytes(check), { flag: "wx" });
  return describeReleaseInput(outputRoot, relative, "file");
}

/** Build a self-contained release-input directory from exact source bytes. */
export async function generateProductionReleaseInputs({
  outputDirectory,
  release,
  source,
  build,
  containerRegistry,
  provenance,
  paths,
}) {
  await mkdir(outputDirectory, { recursive: false });
  const records = {};
  const files = {
    audit: paths.audit,
    containerIdentity: paths.containerIdentity,
    dockerfile: paths.dockerfile,
    lock: paths.lock,
    npmPackage: paths.npmPackage,
    runtimeCore: paths.runtimeCore,
    sbom: paths.sbom,
    tests: paths.tests,
    wasmer: paths.wasmer,
    ...(paths.conformance ? { conformance: paths.conformance } : {}),
    ...(paths.costBaseline ? { costBaseline: paths.costBaseline } : {}),
    ...(paths.costCalibration ? { costCalibration: paths.costCalibration } : {}),
    ...(paths.costProfiles ? { costProfiles: paths.costProfiles } : {}),
  };
  for (const role of Object.keys(files).sort()) {
    records[role] = await copyReleaseInput(files[role], outputDirectory, FILE_DESTINATIONS[role], "file");
  }
  const trees = {
    licenses: paths.licenses,
    migrations: paths.migrations,
    ociEvidence: path.dirname(paths.ociEvidence),
    staticAssets: paths.staticAssets,
    toolchains: paths.toolchains,
    workerBundle: paths.workerBundle,
  };
  for (const role of Object.keys(trees).sort()) {
    records[role] = await copyReleaseInput(trees[role], outputDirectory, TREE_DESTINATIONS[role], "tree");
  }
  if (!records.conformance) records.conformance = await writeStatusEvidence(outputDirectory, "conformance", "conformance");
  if (!records.costBaseline) records.costBaseline = await writeStatusEvidence(outputDirectory, "costBaseline", "cost-baseline");
  if (!records.costCalibration) records.costCalibration = await writeStatusEvidence(outputDirectory, "costCalibration", "cost-calibration");
  if (!records.costProfiles) records.costProfiles = await writeStatusEvidence(outputDirectory, "costProfiles", "cost-profiles");

  const runtimeIdentityPath = path.join(outputDirectory, ...FILE_DESTINATIONS.runtimeIdentity.split("/"));
  await mkdir(path.dirname(runtimeIdentityPath), { recursive: true });
  await writeFile(runtimeIdentityPath, runtimeIdentityBytes(), { flag: "wx" });
  records.runtimeIdentity = await describeReleaseInput(outputDirectory, FILE_DESTINATIONS.runtimeIdentity, "file");

  const ociEvidence = await verifyOciTagVerificationFile(
    path.join(outputDirectory, TREE_DESTINATIONS.ociEvidence, "evidence.json"),
    { reference: `${containerRegistry}:${release.releaseId}` },
  );
  const dockerfileBytes = await readFile(path.join(outputDirectory, FILE_DESTINATIONS.dockerfile));
  const inputs = {
    schema: "wasm-oj-v2/production-release-inputs",
    release,
    source,
    build: {
      nodeVersion: build.nodeVersion,
      pnpmVersion: build.pnpmVersion,
      rustVersion: build.rustVersion,
      wasmerVersion: build.wasmerVersion,
    },
    container: {
      baseImages: parseDockerfileBaseImages(dockerfileBytes),
      digest: ociEvidence.digest,
      platform: "linux/amd64",
      registry: containerRegistry,
      tag: release.releaseId,
    },
    provenance,
    records,
  };
  const inputPath = path.join(outputDirectory, "release-inputs.json");
  await writeFile(inputPath, productionReleaseInputBytes(inputs), { flag: "wx" });
  await verifyProductionReleaseInputs(inputPath);
  return Object.freeze({ inputPath, inputs });
}

function usage() {
  return `Usage: node scripts/generate-production-release-inputs.mjs \\
  --release-id <uuid> --version <semver> --git-commit <sha> --created-at <ISO timestamp> \\
  --container-registry <registry/repository> --container-identity <file> --oci-evidence <evidence.json> \\
  --npm-package <tgz> --sbom <file> --audit <file> --tests-evidence <file> --output-dir <new-directory> \\
  (--expected-current-release-id <uuid> | --expect-no-active-release) \\
  --provenance-issuer <identity> --provenance-subject <identity> [--source-tag <tag>] \\
  [--conformance-evidence <file>] [--cost-profiles-evidence <file>] \\
  [--cost-baseline-evidence <file>] [--cost-calibration-evidence <file>]

Build/tree inputs default to this checkout's pinned files and dist outputs. Omitted conformance/cost
evidence becomes canonical status=not-run evidence; it is never represented as a passing run.
`;
}

async function main() {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      audit: { type: "string" },
      "container-identity": { type: "string" },
      "container-registry": { type: "string" },
      "conformance-evidence": { type: "string" },
      "cost-baseline-evidence": { type: "string" },
      "cost-calibration-evidence": { type: "string" },
      "cost-profiles-evidence": { type: "string" },
      "created-at": { type: "string" },
      "expected-current-release-id": { type: "string" },
      "expect-no-active-release": { type: "boolean" },
      "git-commit": { type: "string" },
      "npm-package": { type: "string" },
      "oci-evidence": { type: "string" },
      "output-dir": { type: "string" },
      "provenance-issuer": { type: "string" },
      "provenance-subject": { type: "string" },
      "release-id": { type: "string" },
      sbom: { type: "string" },
      "source-tag": { type: "string" },
      "tests-evidence": { type: "string" },
      version: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
    strict: true,
  });
  if (values.help) {
    process.stdout.write(usage());
    return;
  }
  for (const key of [
    "audit", "container-identity", "container-registry", "created-at", "git-commit", "npm-package",
    "oci-evidence", "output-dir", "provenance-issuer", "provenance-subject", "release-id", "sbom",
    "tests-evidence", "version",
  ]) if (!values[key]) throw new TypeError(`--${key} is required.\n\n${usage()}`);
  if (Boolean(values["expected-current-release-id"]) === Boolean(values["expect-no-active-release"])) {
    throw new TypeError(`Exactly one release activation precondition is required.\n\n${usage()}`);
  }

  const root = process.cwd();
  const [build, sourceTree] = await Promise.all([
    deriveProductionBuildIdentity(root),
    sourceTreeProvenanceAtCommit(root, values["git-commit"]),
  ]);
  const generated = await generateProductionReleaseInputs({
    outputDirectory: values["output-dir"],
    release: {
      createdAt: values["created-at"],
      expectedCurrentReleaseId: values["expected-current-release-id"] ?? null,
      releaseId: values["release-id"],
      version: values.version,
    },
    source: {
      commit: values["git-commit"],
      repository: build.repository,
      sourceTreeSha256: sourceTree.sha256,
      ...(values["source-tag"] ? { tag: values["source-tag"] } : {}),
    },
    build,
    containerRegistry: values["container-registry"],
    provenance: { issuer: values["provenance-issuer"], subject: values["provenance-subject"] },
    paths: {
      audit: values.audit,
      containerIdentity: values["container-identity"],
      conformance: values["conformance-evidence"],
      costBaseline: values["cost-baseline-evidence"],
      costCalibration: values["cost-calibration-evidence"],
      costProfiles: values["cost-profiles-evidence"],
      dockerfile: path.join(root, "Dockerfile"),
      licenses: path.join(root, "licenses"),
      lock: path.join(root, "pnpm-lock.yaml"),
      migrations: path.join(root, "migrations/core"),
      npmPackage: values["npm-package"],
      ociEvidence: values["oci-evidence"],
      runtimeCore: path.join(root, "src/runner/generated/runtime-core_bg.wasm"),
      sbom: values.sbom,
      staticAssets: path.join(root, "dist/client"),
      tests: values["tests-evidence"],
      toolchains: path.join(root, "public/toolchains"),
      wasmer: path.join(root, "node_modules/@wasmer/sdk/dist/wasmer_js_bg.wasm"),
      workerBundle: path.join(root, "dist/server"),
    },
  });
  process.stdout.write(`${JSON.stringify({ inputPath: generated.inputPath })}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
