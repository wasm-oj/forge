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
  assert.match(dockerfile, /COPY packages\/cli\/package\.json \.\/packages\/cli\/package\.json/u);
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

test("judge image caches runtime validation before its commit-specific identity layer", async () => {
  const dockerfile = await readFile(new URL("../Dockerfile", import.meta.url), "utf8");
  const grantReadIndex = dockerfile.indexOf("chmod -R a+rX /app");
  const removeWriteIndex = dockerfile.indexOf("chmod -R a-w /app");
  const runtimeSmokeIndex = dockerfile.indexOf("runuser -u wasmoj -- env HOME=/tmp NODE_ENV=production node --input-type=module");
  const executionSmokeIndex = dockerfile.indexOf("runuser -u wasmoj -- env HOME=/tmp NODE_ENV=production node /app/container/runtime-smoke.mjs");
  const buildIdArgumentIndex = dockerfile.indexOf("ARG WASM_OJ_BUILD_ID=");
  const generateIdentityIndex = dockerfile.indexOf("node /app/container/generate-identity.mjs");
  const loadIdentityIndex = dockerfile.indexOf("loadEmbeddedContainerIdentity");
  const finalUserIndex = dockerfile.indexOf("USER wasmoj");

  assert.ok(grantReadIndex >= 0, "the copied runtime tree must be readable and traversable by wasmoj");
  assert.ok(removeWriteIndex > grantReadIndex, "read/traverse repair must happen before the immutable write fence");
  assert.ok(runtimeSmokeIndex > removeWriteIndex, "runtime imports must execute after permission hardening");
  assert.ok(executionSmokeIndex > runtimeSmokeIndex, "the real runtime smoke must follow runtime imports");
  assert.ok(buildIdArgumentIndex > executionSmokeIndex, "the expensive runtime smoke must be cached before the build ID invalidates a layer");
  assert.ok(generateIdentityIndex > buildIdArgumentIndex, "the exact identity must be generated in the commit-specific layer");
  assert.ok(loadIdentityIndex > generateIdentityIndex, "the generated identity must be loaded before the image is committed");
  assert.ok(finalUserIndex > loadIdentityIndex, "identity verification must execute during the image build");

  const runtimeSmoke = dockerfile.slice(runtimeSmokeIndex, buildIdArgumentIndex);
  for (const packageName of [
    "@wasm-oj/core",
    "@wasm-oj/server",
    "@wasm-oj/toolchain-clang",
    "@wasm-oj/toolchain-go",
    "@wasm-oj/toolchain-javascript",
    "@wasm-oj/toolchain-java",
    "@wasm-oj/toolchain-python",
    "@wasm-oj/toolchain-rust",
  ]) {
    assert.ok(runtimeSmoke.includes(`'${packageName}'`), `${packageName} must be imported as wasmoj`);
  }
  assert.doesNotMatch(runtimeSmoke, /loadEmbeddedContainerIdentity/u);
  assert.doesNotMatch(runtimeSmoke, /container\/server\.mjs/u);

  const identityLayer = dockerfile.slice(buildIdArgumentIndex, finalUserIndex);
  assert.match(identityLayer, /loadEmbeddedContainerIdentity\(\)/u);
  assert.doesNotMatch(identityLayer, /runtime-smoke\.mjs/u);
});

test("judge image compiles and runs Python through packaged server stages as wasmoj", async () => {
  const [dockerfile, smoke] = await Promise.all([
    readFile(new URL("../Dockerfile", import.meta.url), "utf8"),
    readFile(new URL("../container/runtime-smoke.mjs", import.meta.url), "utf8"),
  ]);
  assert.match(dockerfile, /COPY --from=build \/src\/container\/runtime-smoke\.mjs \.\/container\/runtime-smoke\.mjs/u);
  assert.match(dockerfile, /runuser -u wasmoj -- env HOME=\/tmp NODE_ENV=production node \/app\/container\/runtime-smoke\.mjs/u);
  assert.doesNotMatch(smoke, /loadEmbeddedContainerIdentity|verifiedDistribution/u);
  assert.match(smoke, /language: "python"/u);
  assert.match(smoke, /createServerEngine/u);
  assert.match(smoke, /engine\.execute/u);
  assert.match(smoke, /execution\.build\.success/u);
  assert.match(smoke, /execution\.build\.artifact/u);
  assert.match(smoke, /execution\.run\.code !== 0/u);
  assert.match(smoke, /execution\.run\.termination !== "exited"/u);
  assert.match(smoke, /execution\.run\.stdout !== EXPECTED_STDOUT/u);
  assert.match(smoke, /engine\.dispose\(\)/u);
  assert.match(smoke, /rm\(CACHE_DIRECTORY, \{ recursive: true, force: true \}\)/u);
});
