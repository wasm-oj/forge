import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { FORGE_RUNTIME_IDENTITY_SHA256 } from "../src/core/runtime-identity.ts";
import { verifyForgeReleaseManifestBytes } from "../src/release-manifest.ts";
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
    contract: 1,
    executionRootSha256: digest("b"),
    gitCommit,
    protocol: "forge-container-v1",
    releaseId,
    runnerSha256: digest("c"),
    runtimeRootSha256: digest("d"),
    schema: "forge-container-identity-v1",
    toolchainRootSha256: digest("e"),
    ...overrides,
  });
}

function template() {
  return {
    schema: "wasm-oj-forge-v1/release-manifest",
    releaseId: "01988dc1-5c00-7000-8000-000000000000",
    version: "0.1.0-production.1",
    forgeContract: 1,
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
      protocolVersion: "forge-container-v1",
      executionRootSha256: digest("8"),
      rootSha256: digest("9"),
      runtimeIdentitySha256: FORGE_RUNTIME_IDENTITY_SHA256,
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
    provenance: { issuer: "owner-fast-hotfix", subject: "wasm-oj-forge-production" },
  };
}

function prepare(overrides = {}) {
  return prepareProductionRelease({
    template: template(),
    releaseId,
    version: "0.1.0-production.2",
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
  const manifest = await verifyForgeReleaseManifestBytes(prepared.manifestBytes, prepared.manifestSha256);
  assert.equal(manifest.releaseId, releaseId);
  assert.equal(manifest.version, "0.1.0-production.2");
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
  assert.equal(prepared.manifestKey, `releases/${releaseId}/manifest-${prepared.manifestSha256}.json`);
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

test("emits direct 0016 activation SQL without qualification machinery", () => {
  const sql = prepare().activationSql;
  const candidate = sql.indexOf("'candidate'");
  const retired = sql.indexOf("status='retired'");
  const active = sql.indexOf("status='active'", retired + 1);
  const pointer = sql.indexOf("INSERT INTO forge_active_releases");
  assert.ok(candidate >= 0 && candidate < retired && retired < active && active < pointer);
  assert.doesNotMatch(sql, /qualification/i);
  assert.match(sql, new RegExp(releaseId, "g"));
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
