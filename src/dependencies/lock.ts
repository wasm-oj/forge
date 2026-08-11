import { FORGE_CONTRACT_VERSION, FORGE_SCHEMAS } from "../core/contract.ts";
import { sha256Hex } from "../core/hash.ts";
import { assertSafeRelativePath } from "../core/project-files.ts";
import { assertBoundedCount, DEPENDENCY_RESOLUTION_LIMITS } from "./limits.ts";
import {
  DEPENDENCY_ECOSYSTEMS,
  type DependencyLock,
  type DependencyManifest,
  type DependencyRequirement,
  type LockedDependencyPackage,
} from "./types.ts";

const SHA256 = /^[0-9a-f]{64}$/;

export function createDependencyLock(
  manifestSha256: string,
  roots: readonly string[],
  packages: readonly LockedDependencyPackage[],
): DependencyLock {
  requireSha256(manifestSha256, "Dependency manifest");
  assertBoundedCount(roots.length, DEPENDENCY_RESOLUTION_LIMITS.roots, "Dependency roots");
  assertBoundedCount(packages.length, DEPENDENCY_RESOLUTION_LIMITS.packages, "Dependency packages");
  const lock: DependencyLock = {
    schema: FORGE_SCHEMAS.dependencyLock,
    forgeContract: FORGE_CONTRACT_VERSION,
    manifestSha256,
    roots: canonicalStrings(roots, "dependency root"),
    packages: packages.map(canonicalPackage).sort((left, right) => left.id.localeCompare(right.id)),
  };
  assertValidDependencyLock(lock);
  return lock;
}

export function assertValidDependencyLock(value: unknown): asserts value is DependencyLock {
  if (!isRecord(value)) throw new TypeError("Dependency lock must be an object.");
  if (value.schema !== FORGE_SCHEMAS.dependencyLock || value.forgeContract !== FORGE_CONTRACT_VERSION) {
    throw new Error("Dependency lock does not use the active Forge contract.");
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
  const requirementIds = new Set<string>();
  for (const requirement of manifest.requirements) {
    assertDependencyRequirement(requirement);
    const id = JSON.stringify(requirement);
    if (requirementIds.has(id)) throw new Error(`Duplicate dependency requirement '${requirement.name}'.`);
    requirementIds.add(id);
  }
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
      || !(["manifest", "lockfile", "source"] as const).includes(candidate.role as never)) {
      throw new Error("Dependency source files require a supported ecosystem and role.");
    }
    assertSafeRelativePath(candidate.path, "Dependency source path");
    if (typeof candidate.contents !== "string" || candidate.contents.includes("\0")) {
      throw new Error(`Dependency source file '${String(candidate.path)}' must contain NUL-free text.`);
    }
    const remainingBytes = DEPENDENCY_RESOLUTION_LIMITS.sourceTextBytes - sourceTextBytes;
    if (candidate.contents.length > remainingBytes) {
      throw new RangeError(`Dependency source text exceeds the ${DEPENDENCY_RESOLUTION_LIMITS.sourceTextBytes}-byte aggregate limit.`);
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
  if (typeof value.integritySha256 !== "string" || !SHA256.test(value.integritySha256)) {
    throw new Error(`Dependency package '${value.id as string}' has an invalid SHA-256 integrity.`);
  }
  if (!Array.isArray(value.dependencies)) throw new TypeError("Package dependencies must be an array.");
  assertBoundedCount(value.dependencies.length, DEPENDENCY_RESOLUTION_LIMITS.referencesPerPackage, "Package dependency references");
  const dependencies = canonicalStrings(value.dependencies, "dependency package reference");
  assertSortedUnique(dependencies, `dependencies of '${value.id as string}'`);
  let features: string[] | undefined;
  if (value.features !== undefined) {
    if (!Array.isArray(value.features)) throw new TypeError("Locked package features must be an array.");
    assertBoundedCount(value.features.length, DEPENDENCY_RESOLUTION_LIMITS.referencesPerPackage, "Locked package features");
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
  for (let index = 0; index < values.length; index += 1) {
    if (index > 0 && values[index - 1]! >= values[index]!) {
      throw new Error(`${label} must be sorted and unique.`);
    }
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
