import { WASM_OJ_CONTRACT_VERSION, WASM_OJ_SCHEMAS } from "../core/contract.ts";
import { sha256Hex } from "../core/hash.ts";
import {
  assertValidDependencyManifest,
  assertValidDependencyLock,
  createDependencyLock,
  dependencyManifestSha256,
} from "./lock.ts";
import {
  assertBoundedCount,
  createDependencyDownloadBudget,
  DEPENDENCY_RESOLUTION_LIMITS,
} from "./limits.ts";
import {
  createDefaultDependencyResolvers,
  DependencyNetworkError,
  type DependencyResolverOptions,
} from "./resolvers.ts";
import {
  normalizeDependencyNetworkAccess,
  normalizeDependencyNetworkScope,
} from "./network-consent.ts";
import type {
  DependencyEcosystem,
  DependencyLock,
  DependencyManifest,
  DependencyOfflineBundle,
  DependencyCache,
  DependencyResolver,
  ResolveDependencyOptions,
} from "./types.ts";
import {
  createDefaultDependencyBuildAdapters,
  createDependencyBuildBundle,
  type DependencyBuildAdapter,
  type DependencyBuildBundle,
} from "./build.ts";

export class MemoryDependencyCache implements DependencyCache {
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
export class DependencyManager {
  private readonly cache: DependencyCache;
  private readonly resolvers = new Map<DependencyEcosystem, DependencyResolver>();

  constructor(
    cache: DependencyCache,
    resolvers: readonly DependencyResolver[] = [],
  ) {
    this.cache = cache;
    for (const resolver of resolvers) this.registerResolver(resolver);
  }

  registerResolver(resolver: DependencyResolver): void {
    if (!resolver || typeof resolver !== "object" || typeof resolver.resolve !== "function") {
      throw new TypeError("Dependency resolvers must be objects implementing resolve().");
    }
    if (this.resolvers.has(resolver.ecosystem)) {
      throw new Error(`A dependency resolver is already registered for '${resolver.ecosystem}'.`);
    }
    this.resolvers.set(resolver.ecosystem, resolver);
  }

  async resolve(manifest: DependencyManifest, options: ResolveDependencyOptions = {}): Promise<DependencyLock> {
    assertValidDependencyManifest(manifest);
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
    try {
      return await this.resolveOnline(manifest, manifestSha256, options);
    } catch (error) {
      if (!(error instanceof DependencyNetworkError)
        || !options.previousLock
        || !options.previousLockNetworkScope
        || !options.networkAccess
        || options.previousLock.manifestSha256 !== manifestSha256) {
        throw error;
      }
      const previousScope = normalizeDependencyNetworkScope(options.previousLockNetworkScope);
      const currentScope = normalizeDependencyNetworkAccess(options.networkAccess);
      if (previousScope.sourceKey !== currentScope.sourceKey
        || previousScope.bundleDigest !== currentScope.bundleDigest) {
        throw error;
      }
      await this.verifyCached(options.previousLock);
      return structuredClone(options.previousLock);
    }
  }

  private async resolveOnline(
    manifest: DependencyManifest,
    manifestSha256: string,
    options: ResolveDependencyOptions,
  ): Promise<DependencyLock> {
    const downloadBudget = createDependencyDownloadBudget();
    const groups = new Map<DependencyEcosystem, typeof manifest.requirements[number][]>();
    for (const requirement of manifest.requirements) {
      const group = groups.get(requirement.ecosystem) ?? [];
      group.push(requirement);
      groups.set(requirement.ecosystem, group);
    }
    const roots: string[] = [];
    const packages = new Map<string, Awaited<ReturnType<DependencyResolver["resolve"]>>["packages"][number]>();
    let payloadBytes = 0;
    for (const [ecosystem, requirements] of groups) {
      const resolver = this.resolvers.get(ecosystem);
      if (!resolver) throw new Error(`No dependency resolver is registered for '${ecosystem}'.`);
      const graph = await resolver.resolve(
        {
          requirements,
          sourceFiles: manifest.sourceFiles?.filter((file) => file.ecosystem === ecosystem),
        },
        {
          previousLock: options.previousLock,
          ...(options.networkAccess === undefined ? {} : { networkAccess: options.networkAccess }),
          downloadBudget,
        },
      );
      if (!Array.isArray(graph.roots) || !Array.isArray(graph.packages) || !graph.payloads
        || typeof graph.payloads !== "object" || Array.isArray(graph.payloads)) {
        throw new TypeError(`Resolver '${ecosystem}' returned an invalid graph.`);
      }
      assertBoundedCount(graph.roots.length, DEPENDENCY_RESOLUTION_LIMITS.roots, `Resolver '${ecosystem}' roots`);
      assertBoundedCount(graph.packages.length, DEPENDENCY_RESOLUTION_LIMITS.packages, `Resolver '${ecosystem}' packages`);
      assertBoundedCount(roots.length + graph.roots.length, DEPENDENCY_RESOLUTION_LIMITS.roots, "Resolved dependency roots");
      const graphIds = new Set(graph.packages.map((item) => item.id));
      if (graphIds.size !== graph.packages.length) throw new Error(`Resolver '${ecosystem}' returned duplicate dependency packages.`);
      const newPackageIds = [...graphIds].filter((id) => !packages.has(id));
      assertBoundedCount(packages.size + newPackageIds.length, DEPENDENCY_RESOLUTION_LIMITS.packages, "Resolved dependency packages");
      const payloadIds = boundedOwnKeys(graph.payloads, DEPENDENCY_RESOLUTION_LIMITS.packages, "Resolved dependency payloads");
      const unexpected = payloadIds.filter((id) => !graphIds.has(id));
      if (unexpected.length) throw new Error(`Resolver returned payloads for unknown packages: ${unexpected.sort().join(", ")}.`);
      for (const item of graph.packages) {
        const payload = graph.payloads[item.id];
        if (!(payload instanceof Uint8Array)) throw new Error(`Resolver omitted payload for dependency '${item.id}'.`);
        payloadBytes = admitPayloadBytes(payloadBytes, payload, `Resolved dependency '${item.id}'`);
      }
      for (const root of graph.roots) roots.push(root);
      for (const item of graph.packages) {
        const existing = packages.get(item.id);
        if (existing && JSON.stringify(existing) !== JSON.stringify(item)) {
          throw new Error(`Resolvers returned conflicting records for dependency '${item.id}'.`);
        }
        packages.set(item.id, item);
        const payload = graph.payloads[item.id];
        if (!(payload instanceof Uint8Array)) throw new Error(`Resolver omitted payload for dependency '${item.id}'.`);
        if (await sha256Hex(payload) !== item.integritySha256) {
          throw new Error(`Resolver returned corrupt payload for dependency '${item.id}'.`);
        }
        await this.cache.save(item.integritySha256, payload);
      }
    }
    return createDependencyLock(manifestSha256, roots.sort(), [...packages.values()]);
  }

  async verifyCached(lock: DependencyLock): Promise<void> {
    assertValidDependencyLock(lock);
    let payloadBytes = 0;
    for (const item of lock.packages) {
      const payload = await this.cache.load(item.integritySha256);
      if (!payload) throw new Error(`Dependency '${item.id}' is absent from the content cache.`);
      payloadBytes = admitPayloadBytes(payloadBytes, payload, `Cached dependency '${item.id}'`);
      if (await sha256Hex(payload) !== item.integritySha256) {
        await this.cache.delete(item.integritySha256);
        throw new Error(`Cached dependency '${item.id}' failed integrity verification.`);
      }
    }
  }

  clearCache(): Promise<void> {
    return this.cache.clear();
  }

  /** Returns package-ID keyed payloads after re-verifying the content-addressed cache. */
  async materialize(lock: DependencyLock): Promise<ReadonlyMap<string, Uint8Array>> {
    assertValidDependencyLock(lock);
    const payloads = new Map<string, Uint8Array>();
    let payloadBytes = 0;
    for (const item of lock.packages) {
      const payload = await this.cache.load(item.integritySha256);
      if (!payload) throw new Error(`Dependency '${item.id}' is absent from the content cache.`);
      payloadBytes = admitPayloadBytes(payloadBytes, payload, `Cached dependency '${item.id}'`);
      if (await sha256Hex(payload) !== item.integritySha256) {
        await this.cache.delete(item.integritySha256);
        throw new Error(`Cached dependency '${item.id}' failed integrity verification.`);
      }
      payloads.set(item.id, payload);
    }
    return payloads;
  }

  /** Resolve cached archives into the verified, compiler-facing file-tree contract. */
  async prepareBuild(
    lock: DependencyLock,
    adapters: readonly DependencyBuildAdapter[] = createDefaultDependencyBuildAdapters(),
  ): Promise<DependencyBuildBundle> {
    return createDependencyBuildBundle(lock, await this.materialize(lock), adapters);
  }

  async exportOffline(lock: DependencyLock): Promise<DependencyOfflineBundle> {
    assertValidDependencyLock(lock);
    const payloads: Record<string, Uint8Array> = {};
    let payloadBytes = 0;
    for (const item of lock.packages) {
      const payload = await this.cache.load(item.integritySha256);
      if (!payload) throw new Error(`Dependency '${item.id}' is absent from the content cache.`);
      payloadBytes = admitPayloadBytes(payloadBytes, payload, `Cached dependency '${item.id}'`);
      if (await sha256Hex(payload) !== item.integritySha256) {
        await this.cache.delete(item.integritySha256);
        throw new Error(`Cached dependency '${item.id}' failed integrity verification.`);
      }
      payloads[item.integritySha256] = payload;
    }
    return {
      schema: WASM_OJ_SCHEMAS.dependencyOfflineBundle,
      wasmOjContract: WASM_OJ_CONTRACT_VERSION,
      lock: structuredClone(lock),
      payloads,
    };
  }

  async importOffline(bundle: DependencyOfflineBundle): Promise<DependencyLock> {
    if (!bundle || typeof bundle !== "object" || bundle.schema !== WASM_OJ_SCHEMAS.dependencyOfflineBundle
      || bundle.wasmOjContract !== WASM_OJ_CONTRACT_VERSION) {
      throw new Error("Offline dependency bundle does not use the active WASM-OJ contract.");
    }
    assertValidDependencyLock(bundle.lock);
    if (!bundle.payloads || typeof bundle.payloads !== "object" || Array.isArray(bundle.payloads)) {
      throw new TypeError("Offline dependency bundle payloads must be a digest-keyed object.");
    }
    const expected = new Set(bundle.lock.packages.map((item) => item.integritySha256));
    const actual = boundedOwnKeys(bundle.payloads, DEPENDENCY_RESOLUTION_LIMITS.packages, "Offline dependency payloads").sort();
    if (actual.length !== expected.size || actual.some((digest) => !expected.has(digest))) {
      throw new Error("Offline dependency bundle payload set does not match its lock.");
    }
    const verified: Array<[string, Uint8Array]> = [];
    let payloadBytes = 0;
    for (const [digest, payload] of Object.entries(bundle.payloads)) {
      requireSha256(digest);
      if (!(payload instanceof Uint8Array)) throw new Error(`Offline dependency payload '${digest}' is invalid.`);
      payloadBytes = admitPayloadBytes(payloadBytes, payload, `Offline dependency '${digest}'`);
      if (await sha256Hex(payload) !== digest) {
        throw new Error(`Offline dependency payload '${digest}' failed integrity verification.`);
      }
      verified.push([digest, payload]);
    }
    for (const [digest, payload] of verified) await this.cache.save(digest, payload);
    return structuredClone(bundle.lock);
  }
}

export function createDefaultDependencyManager(
  cache: DependencyCache,
  options: DependencyResolverOptions = {},
): DependencyManager {
  return new DependencyManager(cache, createDefaultDependencyResolvers(options));
}

function admitPayloadBytes(current: number, payload: Uint8Array, label: string): number {
  if (payload.byteLength > DEPENDENCY_RESOLUTION_LIMITS.packageBytes) {
    throw new RangeError(`${label} exceeds the ${DEPENDENCY_RESOLUTION_LIMITS.packageBytes}-byte package limit.`);
  }
  const next = current + payload.byteLength;
  if (!Number.isSafeInteger(next) || next > DEPENDENCY_RESOLUTION_LIMITS.totalDownloadBytes) {
    throw new RangeError(`Dependency payloads exceed the ${DEPENDENCY_RESOLUTION_LIMITS.totalDownloadBytes}-byte aggregate limit.`);
  }
  return next;
}

function boundedOwnKeys(value: object, maximum: number, label: string): string[] {
  const keys: string[] = [];
  for (const key in value) {
    if (!Object.hasOwn(value, key)) continue;
    keys.push(key);
    if (keys.length > maximum) {
      throw new RangeError(`${label} exceeds the ${maximum}-item limit.`);
    }
  }
  return keys;
}

function requireSha256(value: string): void {
  if (!/^[0-9a-f]{64}$/.test(value)) throw new Error("Dependency integrity must be lowercase SHA-256 hexadecimal.");
}
