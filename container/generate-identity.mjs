import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { computeFileTreeIdentity } from "./tree-digest.mjs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function required(name, pattern) {
  const value = process.env[name];
  if (!value || !pattern.test(value)) throw new Error(`${name} is required and invalid.`);
  return value;
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

const [compiler, runner, runtimeTree, toolchainTree, executionTree] = await Promise.all([
  readFile("/app/runtime/forge-compiler"),
  readFile("/app/runtime/forge-runner"),
  computeFileTreeIdentity("/app/runtime"),
  computeFileTreeIdentity("/app/public/toolchains"),
  computeFileTreeIdentity("/app", { excludedRelativePaths: ["release"], allowInternalSymlinks: true }),
]);
// Keys are intentionally inserted in lexical order. identity.mjs independently
// re-canonicalizes and rejects any byte-level disagreement at container start.
const identity = {
  compilerSha256: sha256(compiler),
  contract: 1,
  executionRootSha256: executionTree.rootSha256,
  gitCommit: required("FORGE_GIT_COMMIT", /^[0-9a-f]{40}$/),
  protocol: "forge-container-v1",
  releaseId: required("FORGE_RELEASE_ID", UUID),
  runnerSha256: sha256(runner),
  runtimeRootSha256: runtimeTree.rootSha256,
  schema: "forge-container-identity-v1",
  toolchainRootSha256: toolchainTree.rootSha256,
};
await mkdir("/app/release", { recursive: true });
await writeFile("/app/release/container-identity.json", `${JSON.stringify(identity)}\n`, { flag: "wx", mode: 0o444 });
process.stdout.write(`${sha256(Buffer.from(`${JSON.stringify(identity)}\n`))}\n`);
