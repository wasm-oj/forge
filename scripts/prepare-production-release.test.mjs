import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { parseCanonicalJsonBytes } from "../src/core/canonical-json.ts";
import { verifyReleaseManifestBytes } from "../src/release-manifest.ts";
import { prepareProductionRelease } from "./prepare-production-release.mjs";
import {
  createProductionReleaseFixture,
  TEST_GIT_COMMIT,
  TEST_RELEASE_ID,
} from "./production-release-test-fixture.mjs";

const run = promisify(execFile);

test("derives every release digest from the generated input bundle", async () => {
  const fixture = await createProductionReleaseFixture();
  try {
    const { prepared, inputs } = fixture;
    const manifest = await verifyReleaseManifestBytes(prepared.manifestBytes, prepared.manifestSha256);
    assert.equal(manifest.releaseId, TEST_RELEASE_ID);
    assert.equal(manifest.source.commit, TEST_GIT_COMMIT);
    assert.equal(manifest.build.auditSha256, inputs.records.audit.sha256);
    assert.deepEqual(manifest.artifacts.workerBundle, {
      bytes: inputs.records.workerBundle.bytes,
      sha256: inputs.records.workerBundle.sha256,
    });
    assert.equal(manifest.artifacts.containerImage.digest, inputs.container.digest);
    assert.equal(manifest.artifacts.containerImage.identitySha256, inputs.records.containerIdentity.sha256);
    assert.equal(manifest.runtime.runtimeCoreSha256, inputs.records.runtimeCore.sha256);
    assert.equal(manifest.runtime.wasmerSha256, inputs.records.wasmer.sha256);
    assert.equal(manifest.toolchains.rootSha256, inputs.records.toolchains.sha256);
    assert.equal(manifest.evidence.testsSha256, inputs.records.tests.sha256);
    assert.deepEqual(parseCanonicalJsonBytes(prepared.activationRequestBytes, "activation request"), {
      expectedCurrentReleaseId: null,
      manifest,
    });
  } finally {
    await fixture.cleanup();
  }
});

test("fails closed when any preserved artifact/evidence bytes change", async () => {
  const fixture = await createProductionReleaseFixture();
  try {
    const audit = path.join(fixture.bundle, ...fixture.inputs.records.audit.path.split("/"));
    await writeFile(audit, '{"status":"tampered"}\n');
    await assert.rejects(prepareProductionRelease(fixture.inputPath), /audit.*does not match its saved bytes/u);
  } finally {
    await fixture.cleanup();
  }
});

test("represents omitted conformance and cost checks as canonical not-run evidence", async () => {
  const fixture = await createProductionReleaseFixture();
  try {
    for (const [role, check] of [
      ["conformance", "conformance"],
      ["costBaseline", "cost-baseline"],
      ["costCalibration", "cost-calibration"],
      ["costProfiles", "cost-profiles"],
    ]) {
      const record = fixture.inputs.records[role];
      const bytes = await readFile(path.join(fixture.bundle, ...record.path.split("/")));
      assert.deepEqual(parseCanonicalJsonBytes(bytes, `${role} evidence`), {
        check,
        schema: "wasm-oj-v2/release-check-evidence",
        status: "not-run",
      });
    }
  } finally {
    await fixture.cleanup();
  }
});

test("CLI re-verifies the bundle and writes only canonical manifest/request bytes", async () => {
  const fixture = await createProductionReleaseFixture();
  const output = await mkdtemp(path.join(os.tmpdir(), "wasm-oj-prepared-release-parent-"));
  const destination = path.join(output, "prepared");
  try {
    const { stdout } = await run(process.execPath, [
      new URL("./prepare-production-release.mjs", import.meta.url).pathname,
      "--inputs", fixture.inputPath,
      "--output-dir", destination,
    ], { maxBuffer: 1024 * 1024 });
    const result = JSON.parse(stdout);
    assert.equal(result.releaseId, TEST_RELEASE_ID);
    const manifestBytes = await readFile(path.join(destination, "manifest.json"));
    const manifest = await verifyReleaseManifestBytes(manifestBytes, result.manifestSha256);
    assert.equal(manifest.releaseId, TEST_RELEASE_ID);
    assert.deepEqual(
      parseCanonicalJsonBytes(await readFile(path.join(destination, "activation-request.json")), "activation request"),
      fixture.prepared.activationRequest,
    );
  } finally {
    await Promise.all([fixture.cleanup(), rm(output, { recursive: true, force: true })]);
  }
});
