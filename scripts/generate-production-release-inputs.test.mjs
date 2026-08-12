import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { parseCanonicalJsonBytes } from "../src/core/canonical-json.ts";
import { createProductionReleaseFixture } from "./production-release-test-fixture.mjs";
import { verifyProductionReleaseInputs } from "./production-release-inputs.mjs";

test("identical exact bytes generate identical canonical release inputs", async () => {
  const first = await createProductionReleaseFixture();
  const second = await createProductionReleaseFixture();
  try {
    assert.deepEqual(await readFile(first.inputPath), await readFile(second.inputPath));
    assert.deepEqual(first.inputs, second.inputs);
  } finally {
    await Promise.all([first.cleanup(), second.cleanup()]);
  }
});

test("release inputs contain fixed byte-backed roles and no caller-supplied digest template", async () => {
  const fixture = await createProductionReleaseFixture();
  try {
    const value = parseCanonicalJsonBytes(await readFile(fixture.inputPath), "release inputs");
    assert.equal(Object.hasOwn(value, "template"), false);
    assert.deepEqual(Object.keys(value.records).sort(), [
      "audit", "conformance", "containerIdentity", "costBaseline", "costCalibration", "costProfiles",
      "dockerfile", "licenses", "lock", "migrations", "npmPackage", "ociEvidence", "runtimeCore",
      "runtimeIdentity", "sbom", "staticAssets", "tests", "toolchains", "wasmer", "workerBundle",
    ]);
    await verifyProductionReleaseInputs(fixture.inputPath);
  } finally {
    await fixture.cleanup();
  }
});
