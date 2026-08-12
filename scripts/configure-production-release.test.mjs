import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import {
  decodeCanonicalBase64,
  productionReleaseCoordinates,
  renderProductionReleaseConfig,
} from "./configure-production-release.mjs";
import {
  createProductionReleaseFixture,
  TEST_GIT_COMMIT,
  TEST_REGISTRY,
  TEST_RELEASE_ID,
} from "./production-release-test-fixture.mjs";

const run = promisify(execFile);

function configTemplate() {
  return `${JSON.stringify({
    vars: {
      ENVIRONMENT: "production",
      WASM_OJ_RELEASE_ID: "__WASM_OJ_RELEASE_ID__",
      WASM_OJ_RELEASE_MANIFEST_SHA256: "__WASM_OJ_RELEASE_MANIFEST_SHA256__",
    },
    containers: [{
      class_name: "SubmissionJudgeContainer",
      image: `${TEST_REGISTRY}:__WASM_OJ_RELEASE_ID__@__WASM_OJ_CONTAINER_IMAGE_DIGEST__`,
    }],
  }, null, 2)}\n`;
}

test("derives digest-pinned Worker and Container coordinates", async () => {
  const fixture = await createProductionReleaseFixture();
  try {
    assert.deepEqual(
      productionReleaseCoordinates(fixture.prepared.activationRequestBytes, { expectedGitCommit: TEST_GIT_COMMIT }),
      {
        releaseId: TEST_RELEASE_ID,
        manifestSha256: fixture.prepared.manifestSha256,
        sourceGitCommit: TEST_GIT_COMMIT,
        containerDigest: fixture.inputs.container.digest,
        containerImage: `${TEST_REGISTRY}:${TEST_RELEASE_ID}@${fixture.inputs.container.digest}`,
        containerTag: `${TEST_REGISTRY}:${TEST_RELEASE_ID}`,
      },
    );
  } finally {
    await fixture.cleanup();
  }
});

test("renders only explicit placeholders and requires the immutable image digest", async () => {
  const fixture = await createProductionReleaseFixture();
  try {
    const coordinates = productionReleaseCoordinates(fixture.prepared.activationRequestBytes);
    const rendered = renderProductionReleaseConfig(configTemplate(), coordinates);
    const config = JSON.parse(rendered);
    assert.equal(config.vars.WASM_OJ_RELEASE_ID, TEST_RELEASE_ID);
    assert.equal(config.vars.WASM_OJ_RELEASE_MANIFEST_SHA256, fixture.prepared.manifestSha256);
    assert.equal(config.containers[0].image, coordinates.containerImage);
    assert.throws(
      () => renderProductionReleaseConfig(configTemplate().replace("@__WASM_OJ_CONTAINER_IMAGE_DIGEST__", ""), coordinates),
      /exactly one __WASM_OJ_CONTAINER_IMAGE_DIGEST__/u,
    );
  } finally {
    await fixture.cleanup();
  }
});

test("rejects another source commit and accepts only canonical standard Base64", async () => {
  const fixture = await createProductionReleaseFixture();
  try {
    assert.throws(
      () => productionReleaseCoordinates(fixture.prepared.activationRequestBytes, { expectedGitCommit: "b".repeat(40) }),
      /does not match the checked-out Git commit/u,
    );
    const encoded = Buffer.from(fixture.prepared.activationRequestBytes).toString("base64");
    assert.deepEqual(decodeCanonicalBase64(encoded), Buffer.from(fixture.prepared.activationRequestBytes));
    assert.throws(() => decodeCanonicalBase64(`${encoded}\n`), /without whitespace/u);
  } finally {
    await fixture.cleanup();
  }
});

test("CLI verifies saved OCI bytes before atomically rendering production config", async () => {
  const fixture = await createProductionReleaseFixture("01988dc1-5c00-7000-8000-000000000000");
  const directory = await mkdtemp(path.join(os.tmpdir(), "wasm-oj-release-config-"));
  try {
    const configPath = path.join(directory, "wrangler.production.jsonc");
    const requestPath = path.join(directory, "activation-request.json");
    await writeFile(configPath, configTemplate());
    const { stdout } = await run(process.execPath, [
      new URL("./configure-production-release.mjs", import.meta.url).pathname,
      "--activation-request-base64-env", "RELEASE_REQUEST_BASE64",
      "--activation-request-output", requestPath,
      "--config", configPath,
      "--expected-git-commit", TEST_GIT_COMMIT,
      "--oci-evidence", fixture.oci.evidencePath,
    ], {
      env: {
        ...process.env,
        RELEASE_REQUEST_BASE64: Buffer.from(fixture.prepared.activationRequestBytes).toString("base64"),
      },
    });
    assert.equal(JSON.parse(stdout).manifestSha256, fixture.prepared.manifestSha256);
    assert.deepEqual(await readFile(requestPath), Buffer.from(fixture.prepared.activationRequestBytes));
    assert.equal(JSON.parse(await readFile(configPath, "utf8")).containers[0].image,
      `${TEST_REGISTRY}:${TEST_RELEASE_ID}@${fixture.inputs.container.digest}`);
  } finally {
    await Promise.all([fixture.cleanup(), rm(directory, { recursive: true, force: true })]);
  }
});
