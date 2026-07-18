import { FORGE_CONTRACT_VERSION, FORGE_SCHEMAS } from "../core/contract.ts";
import { sha256Hex } from "../core/hash.ts";
import { assertSafeRelativePath } from "../core/project-files.ts";
import {
  assertDependencyRequirement,
  assertValidDependencyLock,
  createDependencyLock,
  dependencyManifestSha256,
} from "./lock.ts";
import { createDefaultDependencyResolvers, type DependencyResolverOptions } from "./resolvers.ts";
import type {
  DependencyEcosystem,
  DependencyLock,
  DependencyManifest,
  DependencyOfflineBundle,
  ForgeDependencyCache,
  ForgeDependencyResolver,
  ResolveDependencyOptions,
} from "./types.ts";

export class MemoryDependencyCache implements ForgeDependencyCache {
  private readonly payloads = new Map<string, Uint8Array>();

  async load(integritySha256: string): Promise<Uint8Array | undefined> {
    return this.payloads.get(integritySha256)?.slice();
  }

  async save(integritySha256: string, payload: Uint8Array): Promise<void> {
    requireSha256(integritySha256);
    if (await sha256Hex(payload) !== integritySha256) throw new Error("Dependency cache payload digest mismatch.");
    this.payloads.set(integritySha256, payload.slice());
  }

  async delete(integritySha256: string): Promise<void> {
    requireSha256(integritySha256);
    this.payloads.delete(integritySha256);
  }

  async clear(): Promise<void> {
    this.payloads.clear();
  }
}

/** Host-neutral dependency resolution, locking, cache, and offline transport. */
export class ForgeDependencyManager {
  private readonly cache: ForgeDependencyCache;
  private readonly resolvers = new Map<DependencyEcosystem, ForgeDependencyResolver>();

  constructor(
    cache: ForgeDependencyCache,
    resolvers: readonly ForgeDependencyResolver[] = [],
  ) {
    this.cache = cache;
    for (const resolver of resolvers) this.registerResolver(resolver);
  }

  registerResolver(resolver: ForgeDependencyResolver): void {
    if (!resolver || typeof resolver !== "object" || typeof resolver.resolve !== "function") {
      throw new TypeError("Dependency resolvers must be objects implementing resolve().");
    }
    if (this.resolvers.has(resolver.ecosystem)) {
      throw new Error(`A dependency resolver is already registered for '${resolver.ecosystem}'.`);
    }
    this.resolvers.set(resolver.ecosystem, resolver);
  }

  async resolve(manifest: DependencyManifest, options: ResolveDependencyOptions = {}): Promise<DependencyLock> {
    validateManifest(manifest);
    if (options.previousLock) assertValidDependencyLock(options.previousLock);
    const manifestSha256 = await dependencyManifestSha256(manifest);
    if (options.offline) {
      if (!options.previousLock) throw new Error("Offline dependency resolution requires a previous lock.");
      if (options.previousLock.manifestSha256 !== manifestSha256) {
        throw new Error("Offline dependency lock does not match the requested manifest.");
      }
      await this.verifyCached(options.previousLock);
      return structuredClone(options.previousLock);
    }
    const groups = new Map<DependencyEcosystem, typeof manifest.requirements[number][]>();
    for (const requirement of manifest.requirements) {
      const group = groups.get(requirement.ecosystem) ?? [];
      group.push(requirement);
      groups.set(requirement.ecosystem, group);
    }
    const roots: string[] = [];
    const packages = new Map<string, Awaited<ReturnType<ForgeDependencyResolver["resolve"]>>["packages"][number]>();
    for (const [ecosystem, requirements] of groups) {
      const resolver = this.resolvers.get(ecosystem);
      if (!resolver) throw new Error(`No dependency resolver is registered for '${ecosystem}'.`);
      const graph = await resolver.resolve(
        {
          requirements,
          sourceFiles: manifest.sourceFiles?.filter((file) => file.ecosystem === ecosystem),
        },
        { previousLock: options.previousLock },
      );
      for (const root of graph.roots) roots.push(root);
      for (const item of graph.packages) {
        const existing = packages.get(item.id);
        if (existing && JSON.stringify(existing) !== JSON.stringify(item)) {
          throw new Error(`Resolvers returned conflicting records for dependency '${item.id}'.`);
        }
        packages.set(item.id, item);
        const payload = graph.payloads[item.id];
        if (!payload) throw new Error(`Resolver omitted payload for dependency '${item.id}'.`);
        if (await sha256Hex(payload) !== item.integritySha256) {
          throw new Error(`Resolver returned corrupt payload for dependency '${item.id}'.`);
        }
        await this.cache.save(item.integritySha256, payload);
      }
      const unexpected = Object.keys(graph.payloads).filter((id) => !graph.packages.some((item) => item.id === id));
      if (unexpected.length) throw new Error(`Resolver returned payloads for unknown packages: ${unexpected.sort().join(", ")}.`);
    }
    return createDependencyLock(manifestSha256, roots.sort(), [...packages.values()]);
  }

  async verifyCached(lock: DependencyLock): Promise<void> {
    assertValidDependencyLock(lock);
    for (const item of lock.packages) {
      const payload = await this.cache.load(item.integritySha256);
      if (!payload) throw new Error(`Dependency '${item.id}' is absent from the content cache.`);
      if (await sha256Hex(payload) !== item.integritySha256) {
        await this.cache.delete(item.integritySha256);
        throw new Error(`Cached dependency '${item.id}' failed integrity verification.`);
      }
    }
  }

  /** Returns package-ID keyed payloads after re-verifying the content-addressed cache. */
  async materialize(lock: DependencyLock): Promise<ReadonlyMap<string, Uint8Array>> {
    await this.verifyCached(lock);
    const payloads = new Map<string, Uint8Array>();
    for (const item of lock.packages) {
      payloads.set(item.id, (await this.cache.load(item.integritySha256))!);
    }
    return payloads;
  }

  async exportOffline(lock: DependencyLock): Promise<DependencyOfflineBundle> {
    await this.verifyCached(lock);
    const payloads: Record<string, Uint8Array> = {};
    for (const item of lock.packages) payloads[item.integritySha256] = (await this.cache.load(item.integritySha256))!;
    return {
      schema: FORGE_SCHEMAS.dependencyOfflineBundle,
      forgeContract: FORGE_CONTRACT_VERSION,
      lock: structuredClone(lock),
      payloads,
    };
  }

  async importOffline(bundle: DependencyOfflineBundle): Promise<DependencyLock> {
    if (!bundle || typeof bundle !== "object" || bundle.schema !== FORGE_SCHEMAS.dependencyOfflineBundle
      || bundle.forgeContract !== FORGE_CONTRACT_VERSION) {
      throw new Error("Offline dependency bundle does not use the active Forge contract.");
    }
    assertValidDependencyLock(bundle.lock);
    const expected = new Set(bundle.lock.packages.map((item) => item.integritySha256));
    const actual = Object.keys(bundle.payloads).sort();
    if (actual.length !== expected.size || actual.some((digest) => !expected.has(digest))) {
      throw new Error("Offline dependency bundle payload set does not match its lock.");
    }
    const verified: Array<[string, Uint8Array]> = [];
    for (const [digest, payload] of Object.entries(bundle.payloads)) {
      requireSha256(digest);
      if (!(payload instanceof Uint8Array) || await sha256Hex(payload) !== digest) {
        throw new Error(`Offline dependency payload '${digest}' failed integrity verification.`);
      }
      verified.push([digest, payload]);
    }
    for (const [digest, payload] of verified) await this.cache.save(digest, payload);
    return structuredClone(bundle.lock);
  }
}

export function createDefaultDependencyManager(
  cache: ForgeDependencyCache,
  options: DependencyResolverOptions = {},
): ForgeDependencyManager {
  return new ForgeDependencyManager(cache, createDefaultDependencyResolvers(options));
}

function validateManifest(manifest: DependencyManifest): void {
  if (!manifest || typeof manifest !== "object" || !Array.isArray(manifest.requirements)) {
    throw new TypeError("Dependency manifest requirements must be an array.");
  }
  for (const requirement of manifest.requirements) assertDependencyRequirement(requirement);
  if (manifest.sourceFiles !== undefined) {
    if (!Array.isArray(manifest.sourceFiles)) throw new TypeError("Dependency source files must be an array.");
    const paths = new Set<string>();
    for (const file of manifest.sourceFiles) {
      if (!file || typeof file !== "object" || !(["manifest", "lockfile", "source"] as const).includes(file.role)) {
        throw new Error("Dependency source file role must be 'manifest', 'lockfile', or 'source'.");
      }
      if (!(["cargo", "npm", "pypi", "go", "cpp"] as const).includes(file.ecosystem)) {
        throw new Error(`Unsupported dependency source ecosystem '${String(file.ecosystem)}'.`);
      }
      assertSafeRelativePath(file.path, "Dependency source path");
      const identity = `${file.ecosystem}:${file.role}:${file.path}`;
      if (paths.has(identity)) throw new Error(`Duplicate dependency source file '${file.path}'.`);
      if (typeof file.contents !== "string" || file.contents.includes("\0")) {
        throw new Error(`Dependency source file '${file.path}' must contain NUL-free text.`);
      }
      paths.add(identity);
    }
  }
}

function requireSha256(value: string): void {
  if (!/^[0-9a-f]{64}$/.test(value)) throw new Error("Dependency integrity must be lowercase SHA-256 hexadecimal.");
}
