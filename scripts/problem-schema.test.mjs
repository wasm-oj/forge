import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function fixture() {
  const [schema, manifest] = await Promise.all([
    readFile(path.join(ROOT, "schemas/problem.schema.json"), "utf8").then(JSON.parse),
    readFile(
      path.join(ROOT, "problems/001-weighted-opcode-scale/problem.json"),
      "utf8",
    ).then(JSON.parse),
  ]);
  const validate = new Ajv2020({ allErrors: true, strict: true }).compile(schema);
  return { manifest, validate };
}

describe("problem manifest scoring schema", () => {
  it("requires baseline, efficient, optimal in relaxed-to-strict order", async () => {
    const { manifest, validate } = await fixture();
    assert.equal(validate(manifest), true, JSON.stringify(validate.errors));

    const reversed = structuredClone(manifest);
    reversed.scoring.policies.reverse();
    assert.equal(validate(reversed), false);

    const missing = structuredClone(manifest);
    missing.scoring.policies.splice(1, 1);
    assert.equal(validate(missing), false);
  });
});
