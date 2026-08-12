import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const REQUIRED_PACKAGE_INPUTS = [
  "!packages/",
  "!packages/*/",
  "packages/*/*",
  "!packages/*/package.json",
  "!packages/sdk/src/",
  "!packages/sdk/src/**",
  "!packages/organizer/bin/",
  "!packages/organizer/bin/wasm-oj-collection.js",
];

test("judge Docker context uses an explicit package source allowlist", async () => {
  const rules = (await readFile(new URL("../.dockerignore", import.meta.url), "utf8"))
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));
  assert.equal(rules.includes("!packages/**"), false);
  for (const input of REQUIRED_PACKAGE_INPUTS) {
    assert.ok(rules.includes(input), `${input} must be present in the package source allowlist`);
  }
  const packageParents = rules.indexOf("!packages/*/");
  const packageContentsDeny = rules.indexOf("packages/*/*");
  const packageManifest = rules.indexOf("!packages/*/package.json");
  assert.ok(packageParents < packageContentsDeny && packageContentsDeny < packageManifest);
});

test("judge Dockerfile fails closed if generated state still enters the context", async () => {
  const dockerfile = await readFile(new URL("../Dockerfile", import.meta.url), "utf8");
  const copyIndex = dockerfile.indexOf("COPY . .");
  const buildIndex = dockerfile.indexOf("RUN pnpm run library:build");
  const audit = dockerfile.slice(copyIndex, buildIndex);
  assert.ok(copyIndex >= 0 && buildIndex > copyIndex);
  assert.match(audit, /Generated package state entered the judge build context/u);
  assert.match(audit, /Host-temporary package symlink entered the judge build context/u);
  assert.match(audit, /-name dist/u);
  assert.match(audit, /-name tmp/u);
  assert.match(audit, /-name '\.wasm-oj-build-\*'/u);
  assert.match(audit, /-lname '\*\/tmp\/\*'/u);
});
