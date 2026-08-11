import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { computeFileTreeIdentity } from "./tree-digest.mjs";

const SHA256 = /^[0-9a-f]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export const CONTAINER_IDENTITY_PATH = "/app/release/container-identity.json";

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
}

function bytes(value) {
  return Buffer.from(`${JSON.stringify(canonical(value))}\n`);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export async function loadEmbeddedContainerIdentity(options = {}) {
  const identityPath = options.identityPath ?? CONTAINER_IDENTITY_PATH;
  const compilerPath = options.compilerPath ?? "/app/runtime/forge-compiler";
  const runnerPath = options.runnerPath ?? "/app/runtime/forge-runner";
  const runtimePath = options.runtimePath ?? "/app/runtime";
  const toolchainPath = options.toolchainPath ?? "/app/public/toolchains";
  const executionPath = options.executionPath ?? "/app";
  const executionExcludedRelativePaths = options.executionExcludedRelativePaths ?? ["release"];
  const executionAllowInternalSymlinks = options.executionAllowInternalSymlinks ?? true;
  const raw = await readFile(identityPath);
  const value = JSON.parse(raw.toString("utf8"));
  if (!raw.equals(bytes(value))) throw new Error("Embedded container identity is not canonical JSON.");
  const keys = ["compilerSha256", "contract", "executionRootSha256", "gitCommit", "protocol", "releaseId", "runnerSha256", "runtimeRootSha256", "schema", "toolchainRootSha256"];
  if (!value || typeof value !== "object" || Array.isArray(value) || JSON.stringify(Object.keys(value).sort()) !== JSON.stringify(keys)) throw new Error("Embedded container identity has an invalid shape.");
  if (value.schema !== "forge-container-identity-v1" || value.contract !== 1 || value.protocol !== "forge-container-v1" || !UUID.test(value.releaseId) || !/^[0-9a-f]{40}$/.test(value.gitCommit)) throw new Error("Embedded container identity has invalid release coordinates.");
  for (const key of ["compilerSha256", "executionRootSha256", "runnerSha256", "runtimeRootSha256", "toolchainRootSha256"]) {
    if (!SHA256.test(value[key])) throw new Error(`Embedded container identity '${key}' is invalid.`);
  }
  const [compiler, runner, runtimeTree, toolchainTree, executionTree] = await Promise.all([
    readFile(compilerPath),
    readFile(runnerPath),
    computeFileTreeIdentity(runtimePath),
    computeFileTreeIdentity(toolchainPath),
    computeFileTreeIdentity(executionPath, { excludedRelativePaths: executionExcludedRelativePaths, allowInternalSymlinks: executionAllowInternalSymlinks }),
  ]);
  if (sha256(compiler) !== value.compilerSha256 || sha256(runner) !== value.runnerSha256) throw new Error("Embedded container executable digest mismatch.");
  if (runtimeTree.rootSha256 !== value.runtimeRootSha256 || toolchainTree.rootSha256 !== value.toolchainRootSha256) {
    throw new Error("Embedded container runtime or toolchain tree digest mismatch.");
  }
  if (executionTree.rootSha256 !== value.executionRootSha256) throw new Error("Embedded container execution tree digest mismatch.");
  return Object.freeze({ ...value, identitySha256: sha256(raw) });
}

export function assertExpectedContainerIdentity(job, identity) {
  if (!job || job.expectedReleaseId !== identity.releaseId || job.expectedContainerIdentitySha256 !== identity.identitySha256) {
    throw new Error("Container image identity does not match the expected immutable release.");
  }
}
