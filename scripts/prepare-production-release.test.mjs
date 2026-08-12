import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { parseCanonicalJsonBytes } from "../src/core/canonical-json.ts";
import { WASM_OJ_RUNTIME_IDENTITY_SHA256 } from "../src/core/runtime-identity.ts";
import { verifyReleaseManifestBytes } from "../src/release-manifest.ts";
import { prepareProductionRelease } from "./prepare-production-release.mjs";

const digest = (character) => character.repeat(64);
const releaseId = "018f0f2e-7b3c-7f51-8b36-df6ec12f8d31";
const gitCommit = "a".repeat(40);

function canonical(value) {
  const sorted = (item) => {
    if (Array.isArray(item)) return item.map(sorted);
    if (item && typeof item === "object") {
      return Object.fromEntries(Object.keys(item).sort().map((key) => [key, sorted(item[key])]));
    }
    return item;
  };
  return Buffer.from(`${JSON.stringify(sorted(value))}\n`);
}

function identityBytes(overrides = {}) {
  return canonical({
    compilerSha256: digest("a"),
    contract: 2,
    executionRootSha256: digest("b"),
    gitCommit,
    protocol: "wasm-oj-container-v2",
    releaseId,
    runnerSha256: digest("c"),
    runtimeRootSha256: digest("d"),
    schema: "wasm-oj-platform/container-identity/v2",
    toolchainRootSha256: digest("e"),
    ...overrides,
  });
}

function template() {
  return {
    schema: "wasm-oj-v2/release-manifest",
    releaseId: "01988dc1-5c00-7000-8000-000000000000",
    version: "0.2.0-production.1",
    wasmOjContract: 2,
    createdAt: "2026-08-01T00:00:00.000Z",
    source: {
      repository: "https://github.com/wasm-oj/forge",
      commit: "f".repeat(40),
      sourceTreeSha256: digest("f"),
      tag: "old-tag",
    },
    build: {
      nodeVersion: "24.18.0",
      pnpmVersion: "10.34.5",
      rustVersion: "1.97.1",
      lockSha256: digest("1"),
      sbomSha256: digest("2"),
      licensesSha256: digest("3"),
      auditSha256: digest("4"),
    },
    artifacts: {
      npmPackage: { bytes: 1, sha256: digest("5") },
      workerBundle: { bytes: 2, sha256: digest("6") },
      staticAssets: { bytes: 3, sha256: digest("7") },
      containerImage: {
        registry: "registry.cloudflare.com/wasm-oj/forge",
        digest: `sha256:${digest("8")}`,
        identitySha256: digest("8"),
        platform: "linux/amd64",
        dockerfileSha256: digest("9"),
        baseImages: [
          { stage: "node-build", image: "node:24.18.0-bookworm", digest: `sha256:${digest("a")}` },
          { stage: "rust-build", image: "rust:1.97.1-bookworm", digest: `sha256:${digest("b")}` },
          { stage: "judge", image: "node:24.18.0-bookworm-slim", digest: `sha256:${digest("c")}` },
        ],
      },
    },
    runtime: {
      protocolVersion: "wasm-oj-container-v2",
      executionRootSha256: digest("8"),
      rootSha256: digest("9"),
      runtimeIdentitySha256: WASM_OJ_RUNTIME_IDENTITY_SHA256,
      runtimeCoreSha256: digest("0"),
      wasmerVersion: "7.2.1",
      wasmerSha256: digest("1"),
      compilerSha256: digest("2"),
      runnerSha256: digest("3"),
    },
    toolchains: { rootSha256: digest("4"), manifestSha256: digest("5") },
    cost: { model: "weighted", profileRootSha256: digest("6"), baselineSha256: digest("7") },
    evidence: {
      conformanceSha256: digest("8"),
      testsSha256: digest("9"),
      costCalibrationSha256: digest("0"),
    },
    migrations: { databaseSha256: digest("1") },
    provenance: { issuer: "owner-fast-hotfix", subject: "wasm-oj-production" },
  };
}

function prepare(overrides = {}) {
  return prepareProductionRelease({
    template: template(),
    releaseId,
    version: "0.2.0-production.2",
    gitCommit,
    sourceTreeSha256: digest("2"),
    containerIdentityBytes: identityBytes(),
    containerImageDigest: `sha256:${digest("3")}`,
    databaseSha256: digest("4"),
    createdAt: "2026-08-12T00:00:00.000Z",
    ...overrides,
  });
}

test("prepares one canonical manifest from actual release coordinates and Container identity", async () => {
  const prepared = prepare();
  const manifest = await verifyReleaseManifestBytes(prepared.manifestBytes, prepared.manifestSha256);
  assert.equal(manifest.releaseId, releaseId);
  assert.equal(manifest.version, "0.2.0-production.2");
  assert.deepEqual(manifest.source, {
    repository: "https://github.com/wasm-oj/forge",
    commit: gitCommit,
    sourceTreeSha256: digest("2"),
  });
  assert.equal(manifest.artifacts.containerImage.digest, `sha256:${digest("3")}`);
  assert.equal(
    manifest.artifacts.containerImage.identitySha256,
    createHash("sha256").update(identityBytes()).digest("hex"),
  );
  assert.equal(manifest.runtime.executionRootSha256, digest("b"));
  assert.equal(manifest.runtime.rootSha256, digest("d"));
  assert.equal(manifest.runtime.compilerSha256, digest("a"));
  assert.equal(manifest.runtime.runnerSha256, digest("c"));
  assert.equal(manifest.toolchains.rootSha256, digest("e"));
  assert.deepEqual(manifest.migrations, { databaseSha256: digest("4") });
  assert.deepEqual(manifest.cost, template().cost);
  assert.deepEqual(manifest.evidence, template().evidence);
  assert.deepEqual(manifest.artifacts.workerBundle, template().artifacts.workerBundle);
  assert.deepEqual(manifest.artifacts.staticAssets, template().artifacts.staticAssets);
  assert.deepEqual(parseCanonicalJsonBytes(prepared.activationRequestBytes, "activation request"), {
    expectedCurrentReleaseId: null,
    manifest,
  });
});

test("updates only explicitly supplied Worker and static artifact records", () => {
  const prepared = prepare({
    workerBundleArtifact: { bytes: 101, sha256: digest("a") },
    staticAssetsArtifact: { bytes: 202, sha256: digest("b") },
  });
  assert.deepEqual(prepared.manifest.artifacts.workerBundle, { bytes: 101, sha256: digest("a") });
  assert.deepEqual(prepared.manifest.artifacts.staticAssets, { bytes: 202, sha256: digest("b") });
  assert.deepEqual(prepared.manifest.evidence, template().evidence);
});

test("emits a canonical activation request with an explicit current-release precondition", () => {
  const expectedCurrentReleaseId = "01988dc1-5c00-7000-8000-000000000000";
  const prepared = prepare({ expectedCurrentReleaseId });
  assert.deepEqual(prepared.activationRequest, {
    expectedCurrentReleaseId,
    manifest: prepared.manifest,
  });
  assert.deepEqual(
    parseCanonicalJsonBytes(prepared.activationRequestBytes, "activation request"),
    prepared.activationRequest,
  );
  assert.equal("activationSql" in prepared, false);
});

test("rejects a Container identity from another release or noncanonical bytes", () => {
  assert.throws(
    () => prepare({ containerIdentityBytes: identityBytes({ releaseId: "01988dc1-5c00-7000-8000-000000000000" }) }),
    /does not match the requested release coordinates/,
  );
  assert.throws(
    () => prepare({ containerIdentityBytes: Buffer.from(JSON.stringify(JSON.parse(identityBytes()))) }),
    /canonical JSON/,
  );
});
