import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { WASM_OJ_RUNTIME_IDENTITY_SHA256 } from "../src/core/runtime-identity.ts";
import { prepareProductionRelease } from "./prepare-production-release.mjs";
import {
  decodeCanonicalBase64,
  productionReleaseCoordinates,
  renderProductionReleaseConfig,
} from "./configure-production-release.mjs";

const execFileAsync = promisify(execFile);
const digest = (character) => character.repeat(64);
const releaseId = "018f0f2e-7b3c-7f51-8b36-df6ec12f8d31";
const gitCommit = "a".repeat(40);
const registry = "registry.cloudflare.com/example/wasm-oj-judge-production";

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

function preparedRelease(expectedCurrentReleaseId = null) {
  const template = {
    schema: "wasm-oj-v2/release-manifest",
    releaseId,
    version: "0.2.0-production.1",
    wasmOjContract: 2,
    createdAt: "2026-08-12T00:00:00.000Z",
    source: {
      repository: "https://github.com/wasm-oj/forge",
      commit: gitCommit,
      sourceTreeSha256: digest("0"),
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
        registry,
        digest: `sha256:${digest("8")}`,
        identitySha256: digest("9"),
        platform: "linux/amd64",
        dockerfileSha256: digest("0"),
        baseImages: [
          { stage: "node-build", image: "node:24.18.0-bookworm", digest: `sha256:${digest("a")}` },
          { stage: "rust-build", image: "rust:1.97.1-bookworm", digest: `sha256:${digest("b")}` },
          { stage: "judge", image: "node:24.18.0-bookworm-slim", digest: `sha256:${digest("c")}` },
        ],
      },
    },
    runtime: {
      protocolVersion: "wasm-oj-container-v2",
      executionRootSha256: digest("1"),
      rootSha256: digest("2"),
      runtimeIdentitySha256: WASM_OJ_RUNTIME_IDENTITY_SHA256,
      runtimeCoreSha256: digest("3"),
      wasmerVersion: "7.2.1",
      wasmerSha256: digest("4"),
      compilerSha256: digest("5"),
      runnerSha256: digest("6"),
    },
    toolchains: { rootSha256: digest("7"), manifestSha256: digest("8") },
    cost: { model: "weighted", profileRootSha256: digest("9"), baselineSha256: digest("0") },
    evidence: {
      conformanceSha256: digest("1"),
      testsSha256: digest("2"),
      costCalibrationSha256: digest("3"),
    },
    migrations: { databaseSha256: digest("4") },
    provenance: { issuer: "release-test", subject: "wasm-oj-production" },
  };
  const containerIdentityBytes = canonical({
    compilerSha256: digest("5"),
    contract: 2,
    executionRootSha256: digest("1"),
    gitCommit,
    protocol: "wasm-oj-container-v2",
    releaseId,
    runnerSha256: digest("6"),
    runtimeRootSha256: digest("2"),
    schema: "wasm-oj-platform/container-identity/v2",
    toolchainRootSha256: digest("7"),
  });
  return prepareProductionRelease({
    template,
    releaseId,
    version: template.version,
    gitCommit,
    sourceTreeSha256: template.source.sourceTreeSha256,
    containerIdentityBytes,
    containerImageDigest: template.artifacts.containerImage.digest,
    databaseSha256: template.migrations.databaseSha256,
    createdAt: template.createdAt,
    expectedCurrentReleaseId,
  });
}

function configTemplate() {
  return `${JSON.stringify({
    vars: {
      ENVIRONMENT: "production",
      WASM_OJ_RELEASE_ID: "__WASM_OJ_RELEASE_ID__",
      WASM_OJ_RELEASE_MANIFEST_SHA256: "__WASM_OJ_RELEASE_MANIFEST_SHA256__",
    },
    containers: [{
      class_name: "SubmissionJudgeContainer",
      image: `${registry}:__WASM_OJ_RELEASE_ID__`,
    }],
  }, null, 2)}\n`;
}

test("derives the exact Worker and Container coordinates from a canonical v2 activation request", () => {
  const prepared = preparedRelease();
  assert.deepEqual(
    productionReleaseCoordinates(prepared.activationRequestBytes, { expectedGitCommit: gitCommit }),
    {
      releaseId,
      manifestSha256: prepared.manifestSha256,
      sourceGitCommit: gitCommit,
      containerImage: `${registry}:${releaseId}`,
    },
  );
});

test("rejects noncanonical requests, invalid preconditions, and another source commit", () => {
  const prepared = preparedRelease();
  assert.throws(
    () => productionReleaseCoordinates(Buffer.from(JSON.stringify(prepared.activationRequest))),
    /canonical JSON/,
  );
  assert.throws(
    () => productionReleaseCoordinates(canonical({ ...prepared.activationRequest, expectedCurrentReleaseId: "release" })),
    /null or a UUID/,
  );
  assert.throws(
    () => productionReleaseCoordinates(prepared.activationRequestBytes, { expectedGitCommit: "b".repeat(40) }),
    /does not match the checked-out Git commit/,
  );
  assert.throws(
    () => productionReleaseCoordinates(
      preparedRelease("01988dc1-5c00-7000-8000-000000000000").activationRequestBytes,
      { expectNoActiveRelease: true },
    ),
    /must expect no active release/,
  );
});

test("replaces only explicit placeholders and binds all three deployment identities", () => {
  const prepared = preparedRelease();
  const coordinates = productionReleaseCoordinates(prepared.activationRequestBytes);
  const rendered = renderProductionReleaseConfig(configTemplate(), coordinates);
  const config = JSON.parse(rendered);
  assert.equal(config.vars.WASM_OJ_RELEASE_ID, releaseId);
  assert.equal(config.vars.WASM_OJ_RELEASE_MANIFEST_SHA256, prepared.manifestSha256);
  assert.equal(config.containers[0].image, `${registry}:${releaseId}`);
  assert.throws(() => renderProductionReleaseConfig(rendered, coordinates), /exactly two/);
  assert.throws(
    () => renderProductionReleaseConfig(configTemplate().replace(registry, "registry.cloudflare.com/wrong"), coordinates),
    /Container image does not match/,
  );
});

test("accepts only canonical standard Base64", () => {
  const bytes = preparedRelease().activationRequestBytes;
  assert.deepEqual(decodeCanonicalBase64(Buffer.from(bytes).toString("base64")), Buffer.from(bytes));
  assert.throws(() => decodeCanonicalBase64(`${Buffer.from(bytes).toString("base64")}\n`), /without whitespace/);
  assert.throws(() => decodeCanonicalBase64("ZE=="), /canonical standard Base64/);
});

test("CLI preserves validated activation bytes and atomically renders the production config", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "wasm-oj-release-config-"));
  try {
    const prepared = preparedRelease("01988dc1-5c00-7000-8000-000000000000");
    const configPath = path.join(directory, "wrangler.production.jsonc");
    const requestPath = path.join(directory, "activation-request.json");
    await writeFile(configPath, configTemplate());
    const { stdout } = await execFileAsync(process.execPath, [
      "--experimental-strip-types",
      "--disable-warning=ExperimentalWarning",
      new URL("./configure-production-release.mjs", import.meta.url).pathname,
      "--activation-request-base64-env", "RELEASE_REQUEST_BASE64",
      "--activation-request-output", requestPath,
      "--config", configPath,
      "--expected-git-commit", gitCommit,
    ], {
      env: {
        ...process.env,
        RELEASE_REQUEST_BASE64: Buffer.from(prepared.activationRequestBytes).toString("base64"),
      },
    });
    assert.equal(JSON.parse(stdout).manifestSha256, prepared.manifestSha256);
    assert.deepEqual(await readFile(requestPath), Buffer.from(prepared.activationRequestBytes));
    assert.equal(JSON.parse(await readFile(configPath, "utf8")).vars.WASM_OJ_RELEASE_ID, releaseId);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
