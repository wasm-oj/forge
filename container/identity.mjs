import { readFile } from "node:fs/promises";
import path from "node:path";
import { serverSource as clangToolchain } from "@wasm-oj/toolchain-clang";
import { serverSource as goToolchain } from "@wasm-oj/toolchain-go";
import { serverSource as javascriptToolchain } from "@wasm-oj/toolchain-javascript";
import { serverSource as javaToolchain } from "@wasm-oj/toolchain-java";
import { serverSource as pythonToolchain } from "@wasm-oj/toolchain-python";
import { serverSource as rustToolchain } from "@wasm-oj/toolchain-rust";
import { computeFileTreeInventory, deriveFileTreeInventory } from "./tree-digest.mjs";

export const CONTAINER_IDENTITY_PATH = "/app/release/container-identity.json";
function containerToolchainSource(source) {
  return Object.freeze({ ...source, directory: new URL("file:///app/public/toolchains/") });
}
const TOOLCHAINS = Object.freeze([
  clangToolchain(), rustToolchain(), pythonToolchain(), javascriptToolchain(), goToolchain(), javaToolchain(),
].map(containerToolchainSource));

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
}

function bytes(value) {
  return Buffer.from(`${JSON.stringify(canonical(value))}\n`);
}

export async function loadEmbeddedContainerIdentity(options = {}) {
  const identityPath = options.identityPath ?? CONTAINER_IDENTITY_PATH;
  const compilerPath = options.compilerPath ?? "/app/runtime/wasm-oj-compiler";
  const runnerPath = options.runnerPath ?? "/app/runtime/wasm-oj-runner";
  const toolchainPath = options.toolchainPath ?? "/app/public/toolchains";
  const executionPath = options.executionPath ?? "/app";
  const executionExcludedRelativePaths = options.executionExcludedRelativePaths ?? ["release"];
  const executionAllowInternalSymlinks = options.executionAllowInternalSymlinks ?? true;
  const toolchains = options.toolchains ?? TOOLCHAINS;
  const createDistribution = options.createVerifiedServerDistribution
    ?? (await import("@wasm-oj/server")).createVerifiedServerDistribution;
  if (typeof createDistribution !== "function") {
    throw new Error("WASM-OJ server package does not expose verified distribution admission.");
  }
  const raw = await readFile(identityPath);
  const value = JSON.parse(raw.toString("utf8"));
  if (!raw.equals(bytes(value))) throw new Error("Embedded container identity is not canonical JSON.");
  const keys = ["buildId", "contract", "protocol", "schema"];
  if (!value || typeof value !== "object" || Array.isArray(value) || JSON.stringify(Object.keys(value).sort()) !== JSON.stringify(keys)) throw new Error("Embedded container identity has an invalid shape.");
  if (value.schema !== "wasm-oj-platform/container-identity/v3" || value.contract !== 2 || value.protocol !== "wasm-oj-container-v2" || !/^[0-9a-f]{40}$/.test(value.buildId)) throw new Error("Embedded container identity has invalid build coordinates.");
  const executionTree = await computeFileTreeInventory(executionPath, {
    excludedRelativePaths: executionExcludedRelativePaths,
    allowInternalSymlinks: executionAllowInternalSymlinks,
  });
  const toolchainRelativePath = inventoryRelativePath(executionPath, toolchainPath, "toolchain");
  const compilerRelativePath = inventoryRelativePath(executionPath, compilerPath, "compiler executable");
  const runnerRelativePath = inventoryRelativePath(executionPath, runnerPath, "runner executable");
  const toolchainTree = deriveFileTreeInventory(executionTree, toolchainRelativePath);
  const compiler = regularInventoryFile(executionTree, compilerRelativePath, "compiler executable");
  const runner = regularInventoryFile(executionTree, runnerRelativePath, "runner executable");
  if (!compiler.executable || !runner.executable) throw new Error("Embedded container executables are not executable.");
  const toolchainAssets = Object.fromEntries(toolchains.flatMap((source) => (
    source.descriptor.assets.map((asset) => {
      const entry = toolchainTree.entries.find((candidate) => candidate.path === asset.path.slice("/toolchains/".length));
      if (!entry || !("sha256" in entry)) {
        throw new Error(`Embedded container toolchain inventory is missing '${asset.path}'.`);
      }
      return [asset.path, entry.sha256];
    })
  )));
  const verifiedDistribution = createDistribution({
    compilerExecutable: compilerPath,
    compilerSha256: compiler.sha256,
    runtimeExecutable: runnerPath,
    runnerSha256: runner.sha256,
    toolchains,
    toolchainAssets,
    toolchainRootSha256: toolchainTree.rootSha256,
  });
  const identity = { ...value };
  Object.defineProperty(identity, "verifiedDistribution", {
    configurable: false,
    enumerable: false,
    value: verifiedDistribution,
    writable: false,
  });
  return Object.freeze(identity);
}

export function assertExpectedContainerIdentity(job, identity) {
  if (!job || job.expectedBuildId !== identity.buildId) {
    throw new Error("Container image identity does not match the expected build.");
  }
}

function inventoryRelativePath(root, target, label) {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`Embedded container ${label} path is outside the execution root.`);
  }
  return relative.split(path.sep).join("/");
}

function regularInventoryFile(inventory, relativePath, label) {
  const entry = inventory.entries.find((candidate) => candidate.path === relativePath);
  if (!entry || !("sha256" in entry)) throw new Error(`Embedded container ${label} is not a regular file.`);
  return entry;
}
