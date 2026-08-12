import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { computeFileTreeInventory, deriveFileTreeInventory } from "./tree-digest.mjs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function required(name, pattern) {
  const value = process.env[name];
  if (!value || !pattern.test(value)) throw new Error(`${name} is required and invalid.`);
  return value;
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

const executionTree = await computeFileTreeInventory("/app", {
  excludedRelativePaths: ["release"],
  allowInternalSymlinks: true,
});
const runtimeTree = deriveFileTreeInventory(executionTree, "runtime");
const toolchainTree = deriveFileTreeInventory(executionTree, "public/toolchains");
const compiler = executionTree.entries.find((entry) => entry.path === "runtime/wasm-oj-compiler");
const runner = executionTree.entries.find((entry) => entry.path === "runtime/wasm-oj-runner");
if (!compiler || !("sha256" in compiler) || !compiler.executable
  || !runner || !("sha256" in runner) || !runner.executable) {
  throw new Error("Container execution inventory is missing its native executables.");
}
// Keys are intentionally inserted in lexical order. identity.mjs independently
// re-canonicalizes and rejects any byte-level disagreement at container start.
const identity = {
  compilerSha256: compiler.sha256,
  contract: 2,
  executionRootSha256: executionTree.rootSha256,
  gitCommit: required("WASM_OJ_GIT_COMMIT", /^[0-9a-f]{40}$/),
  protocol: "wasm-oj-container-v2",
  releaseId: required("WASM_OJ_RELEASE_ID", UUID),
  runnerSha256: runner.sha256,
  runtimeRootSha256: runtimeTree.rootSha256,
  schema: "wasm-oj-platform/container-identity/v2",
  toolchainRootSha256: toolchainTree.rootSha256,
};
await mkdir("/app/release", { recursive: true });
await writeFile("/app/release/container-identity.json", `${JSON.stringify(identity)}\n`, { flag: "wx", mode: 0o444 });
process.stdout.write(`${sha256(Buffer.from(`${JSON.stringify(identity)}\n`))}\n`);
