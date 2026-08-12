import { WASM_OJ_CONTRACT_VERSION, WASM_OJ_SCHEMAS } from "./contract.ts";
import { assertSafeRelativePath } from "./project-files.ts";
import { sha256Hex } from "./sha256.ts";
import {
  DEPENDENCY_ECOSYSTEMS,
  type DependencyBuildBundle,
  type DependencyLock,
  type DependencyManifest,
  type DependencyRequirement,
  type LockedDependencyPackage,
} from "./types.ts";

const MIB = 1024 * 1024;
const SHA256 = /^[0-9a-f]{64}$/;

/** Contract-level admission limits shared by dependency hosts and compilers. */
export const DEPENDENCY_RESOLUTION_LIMITS = Object.freeze({
  requirements: 128,
  sourceFiles: 128,
  sourceTextBytes: 8 * MIB,
  hosts: 32,
  roots: 512,
  packages: 512,
  referencesPerPackage: 512,
  concurrency: 16,
  metadataBytes: 8 * MIB,
  packageBytes: 256 * MIB,
  totalDownloadBytes: 512 * MIB,
  archiveFiles: 16_384,
  unpackedBytes: 512 * MIB,
});

export const DEPENDENCY_BUILD_LIMITS = Object.freeze({
  packages: DEPENDENCY_RESOLUTION_LIMITS.packages,
  filesPerPackage: DEPENDENCY_RESOLUTION_LIMITS.archiveFiles,
  bytesPerFile: 64 * MIB,
  totalBytes: DEPENDENCY_RESOLUTION_LIMITS.unpackedBytes,
});

export function assertBoundedCount(count: number, maximum: number, label: string): void {
  if (!Number.isSafeInteger(count) || count < 0 || count > maximum) {
    throw new RangeError(`${label} exceeds the ${maximum}-item limit.`);
  }
}

export function createDependencyLock(
  manifestSha256: string,
  roots: readonly string[],
  packages: readonly LockedDependencyPackage[],
): DependencyLock {
  requireSha256(manifestSha256, "Dependency manifest");
  assertBoundedCount(roots.length, DEPENDENCY_RESOLUTION_LIMITS.roots, "Dependency roots");
  assertBoundedCount(packages.length, DEPENDENCY_RESOLUTION_LIMITS.packages, "Dependency packages");
  const lock: DependencyLock = {
    schema: WASM_OJ_SCHEMAS.dependencyLock,
    wasmOjContract: WASM_OJ_CONTRACT_VERSION,
    manifestSha256,
    roots: canonicalStrings(roots, "dependency root"),
    packages: packages.map(canonicalPackage).sort((left, right) => left.id.localeCompare(right.id)),
  };
  assertValidDependencyLock(lock);
  return lock;
}

export function assertValidDependencyLock(value: unknown): asserts value is DependencyLock {
  if (!isRecord(value)) throw new TypeError("Dependency lock must be an object.");
  if (value.schema !== WASM_OJ_SCHEMAS.dependencyLock || value.wasmOjContract !== WASM_OJ_CONTRACT_VERSION) {
    throw new Error("Dependency lock does not use the active WASM-OJ contract.");
  }
  if (!Array.isArray(value.roots) || !Array.isArray(value.packages)) {
    throw new TypeError("Dependency lock roots and packages must be arrays.");
  }
  assertBoundedCount(value.roots.length, DEPENDENCY_RESOLUTION_LIMITS.roots, "Dependency lock roots");
  assertBoundedCount(value.packages.length, DEPENDENCY_RESOLUTION_LIMITS.packages, "Dependency lock packages");
  requireSha256(value.manifestSha256, "Dependency manifest");
  const roots = canonicalStrings(value.roots, "dependency root");
  const packages = value.packages.map(canonicalPackage);
  assertSortedUnique(roots, "dependency roots");
  assertSortedUnique(packages.map((item) => item.id), "dependency packages");
  const ids = new Set(packages.map((item) => item.id));
  for (const root of roots) {
    if (!ids.has(root)) throw new Error(`Dependency root '${root}' is not present in the package graph.`);
  }
  for (const item of packages) {
    for (const dependency of item.dependencies) {
      if (!ids.has(dependency)) {
        throw new Error(`Dependency package '${item.id}' refers to missing package '${dependency}'.`);
      }
    }
  }
}

export async function dependencyLockSha256(lock: DependencyLock): Promise<string> {
  assertValidDependencyLock(lock);
  return sha256Hex(JSON.stringify(lock));
}

export async function dependencyManifestSha256(manifest: DependencyManifest): Promise<string> {
  assertValidDependencyManifest(manifest);
  const requirements = manifest.requirements.map((requirement) => ({
    ecosystem: requirement.ecosystem,
    name: requirement.name,
    requirement: requirement.requirement,
    features: [...(requirement.features ?? [])],
  })).sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
  const sourceFiles = [...(manifest.sourceFiles ?? [])].map((file) => ({ ...file }))
    .sort((left, right) => `${left.ecosystem}:${left.role}:${left.path}`.localeCompare(`${right.ecosystem}:${right.role}:${right.path}`));
  return sha256Hex(JSON.stringify({ requirements, sourceFiles }));
}

export function assertValidDependencyManifest(value: unknown): asserts value is DependencyManifest {
  if (!isRecord(value) || !Array.isArray(value.requirements)) {
    throw new TypeError("Dependency manifest requirements must be an array.");
  }
  assertBoundedCount(value.requirements.length, DEPENDENCY_RESOLUTION_LIMITS.requirements, "Dependency requirements");
  const requirementIds = new Set<string>();
  for (const requirement of value.requirements) {
    assertDependencyRequirement(requirement);
    const identity = JSON.stringify(requirement);
    if (requirementIds.has(identity)) throw new Error(`Duplicate dependency requirement '${requirement.name}'.`);
    requirementIds.add(identity);
  }
  if (value.sourceFiles !== undefined && !Array.isArray(value.sourceFiles)) {
    throw new TypeError("Dependency source files must be an array.");
  }
  const sourceFiles = value.sourceFiles ?? [];
  assertBoundedCount(sourceFiles.length, DEPENDENCY_RESOLUTION_LIMITS.sourceFiles, "Dependency source files");
  const sourceIds = new Set<string>();
  const encoder = new TextEncoder();
  let sourceTextBytes = 0;
  for (const candidate of sourceFiles) {
    if (!isRecord(candidate) || !DEPENDENCY_ECOSYSTEMS.includes(candidate.ecosystem as never)
      || !("manifest lockfile source".split(" ") as readonly string[]).includes(candidate.role as string)) {
      throw new Error("Dependency source files require a supported ecosystem and role.");
    }
    assertSafeRelativePath(candidate.path, "Dependency source path");
    if (typeof candidate.contents !== "string" || candidate.contents.includes("\0")) {
      throw new Error(`Dependency source file '${String(candidate.path)}' must contain NUL-free text.`);
    }
    sourceTextBytes += encoder.encode(candidate.contents).byteLength;
    if (sourceTextBytes > DEPENDENCY_RESOLUTION_LIMITS.sourceTextBytes) {
      throw new RangeError(`Dependency source text exceeds the ${DEPENDENCY_RESOLUTION_LIMITS.sourceTextBytes}-byte aggregate limit.`);
    }
    const identity = `${candidate.ecosystem as string}:${candidate.role as string}:${candidate.path as string}`;
    if (sourceIds.has(identity)) throw new Error(`Duplicate dependency source file '${candidate.path as string}'.`);
    sourceIds.add(identity);
  }
}

export function assertDependencyRequirement(value: unknown): asserts value is DependencyRequirement {
  if (!isRecord(value)) throw new TypeError("Dependency requirement must be an object.");
  if (!DEPENDENCY_ECOSYSTEMS.includes(value.ecosystem as never)) {
    throw new Error(`Unsupported dependency ecosystem '${String(value.ecosystem)}'.`);
  }
  canonicalText(value.name, "dependency name", 512);
  canonicalText(value.requirement, "dependency requirement", 2_048);
  if (value.features !== undefined) {
    if (!Array.isArray(value.features)) throw new TypeError("Dependency features must be an array.");
    assertBoundedCount(value.features.length, DEPENDENCY_RESOLUTION_LIMITS.referencesPerPackage, "Dependency features");
    assertSortedUnique(canonicalStrings(value.features, "dependency feature"), "dependency features");
  }
}

export function assertValidDependencyBuildBundle(value: unknown): asserts value is DependencyBuildBundle {
  if (!isRecord(value)) throw new TypeError("Dependency build bundle must be an object.");
  assertValidDependencyLock(value.lock);
  requireSha256(value.lockSha256, "Dependency build lock");
  if (!Array.isArray(value.packages) || value.packages.length !== value.lock.packages.length) {
    throw new Error("Dependency build packages must exactly match the dependency lock.");
  }
  let totalBytes = 0;
  for (const [index, candidate] of value.packages.entries()) {
    if (!isRecord(candidate) || !isRecord(candidate.package)
      || candidate.package.id !== value.lock.packages[index]?.id) {
      throw new Error("Dependency build packages must use canonical lock order.");
    }
    requireSha256(candidate.filesSha256, `Dependency package '${candidate.package.id as string}' file tree`);
    const files = canonicalDependencyFiles(candidate.files, candidate.package.id as string, false);
    totalBytes += Object.values(files).reduce((sum, bytes) => sum + bytes.byteLength, 0);
  }
  if (totalBytes > DEPENDENCY_BUILD_LIMITS.totalBytes) {
    throw new RangeError(`Dependency build exceeds ${DEPENDENCY_BUILD_LIMITS.totalBytes} extracted bytes.`);
  }
}

export async function verifyDependencyBuildBundle(bundle: DependencyBuildBundle): Promise<void> {
  assertValidDependencyBuildBundle(bundle);
  if (await dependencyLockSha256(bundle.lock) !== bundle.lockSha256) {
    throw new Error("Dependency build lock digest does not match its canonical lock.");
  }
  for (const item of bundle.packages) {
    if (await dependencyFileTreeSha256(item.files) !== item.filesSha256) {
      throw new Error(`Dependency package '${item.package.id}' file-tree digest mismatch.`);
    }
  }
}

export async function dependencyFileTreeSha256(files: Readonly<Record<string, Uint8Array>>): Promise<string> {
  const entries: Array<{ path: string; bytes: number; sha256: string }> = [];
  for (const [path, bytes] of Object.entries(files).sort(([left], [right]) => left.localeCompare(right))) {
    entries.push({ path, bytes: bytes.byteLength, sha256: await sha256Hex(bytes) });
  }
  return sha256Hex(JSON.stringify(entries));
}

export function canonicalDependencyFiles(
  value: unknown,
  id: string,
  clone = true,
): Record<string, Uint8Array> {
  if (!isRecord(value)) throw new TypeError(`Dependency '${id}' materializer must return a file record.`);
  const entries = Object.entries(value).sort(([left], [right]) => left.localeCompare(right));
  if (entries.length === 0 || entries.length > DEPENDENCY_BUILD_LIMITS.filesPerPackage) {
    throw new RangeError(`Dependency '${id}' must contain 1-${DEPENDENCY_BUILD_LIMITS.filesPerPackage} files.`);
  }
  const result: Record<string, Uint8Array> = {};
  for (const [path, bytes] of entries) {
    assertSafeRelativePath(path, `Dependency '${id}' file path`);
    if (!(bytes instanceof Uint8Array) || bytes.byteLength > DEPENDENCY_BUILD_LIMITS.bytesPerFile) {
      throw new RangeError(`Dependency '${id}' file '${path}' exceeds its byte limit.`);
    }
    result[path] = clone ? bytes.slice() : bytes;
  }
  return result;
}

function canonicalPackage(value: unknown): LockedDependencyPackage {
  if (!isRecord(value)) throw new TypeError("Locked dependency package must be an object.");
  canonicalText(value.id, "dependency package ID", 2_048);
  if (!DEPENDENCY_ECOSYSTEMS.includes(value.ecosystem as never)) {
    throw new Error(`Unsupported dependency ecosystem '${String(value.ecosystem)}'.`);
  }
  const ecosystem = value.ecosystem as LockedDependencyPackage["ecosystem"];
  canonicalText(value.name, "dependency package name", 512);
  canonicalText(value.version, "dependency package version", 512);
  canonicalText(value.source, "dependency package source", 4_096);
  if (value.id !== `${ecosystem}:${value.name as string}@${value.version as string}`) {
    throw new Error(`Dependency package ID '${value.id as string}' does not match its ecosystem, name, and version.`);
  }
  requireSha256(value.integritySha256, `Dependency package '${value.id as string}'`);
  if (!Array.isArray(value.dependencies)) throw new TypeError("Package dependencies must be an array.");
  const dependencies = canonicalStrings(value.dependencies, "dependency package reference");
  assertSortedUnique(dependencies, `dependencies of '${value.id as string}'`);
  let features: string[] | undefined;
  if (value.features !== undefined) {
    if (!Array.isArray(value.features)) throw new TypeError("Locked package features must be an array.");
    features = canonicalStrings(value.features, "locked package feature");
    assertSortedUnique(features, `features of '${value.id as string}'`);
  }
  return {
    id: value.id as string,
    ecosystem,
    name: value.name as string,
    version: value.version as string,
    source: value.source as string,
    integritySha256: value.integritySha256,
    dependencies,
    ...(features ? { features } : {}),
  };
}

function canonicalStrings(values: readonly unknown[], label: string): string[] {
  return values.map((value) => canonicalText(value, label, 4_096));
}

function canonicalText(value: unknown, label: string, maximum: number): string {
  if (typeof value !== "string" || !value || value !== value.trim() || value.length > maximum || value.includes("\0")) {
    throw new Error(`${label} must be a non-empty, trimmed, NUL-free string of at most ${maximum} characters.`);
  }
  return value;
}

function assertSortedUnique(values: readonly string[], label: string): void {
  for (let index = 1; index < values.length; index += 1) {
    if (values[index - 1]! >= values[index]!) throw new Error(`${label} must be sorted and unique.`);
  }
}

function requireSha256(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !SHA256.test(value)) {
    throw new Error(`${label} SHA-256 must be lowercase hexadecimal.`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
