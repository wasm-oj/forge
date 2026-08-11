import type { FORGE_CONTRACT_VERSION, FORGE_SCHEMAS } from "../core/contract.ts";

export const DEPENDENCY_ECOSYSTEMS = Object.freeze([
  "cargo",
  "npm",
  "pypi",
  "go",
  "cpp",
] as const);

export type DependencyEcosystem = (typeof DEPENDENCY_ECOSYSTEMS)[number];

export interface DependencyRequirement {
  ecosystem: DependencyEcosystem;
  name: string;
  requirement: string;
  features?: readonly string[];
}

/** Native ecosystem inputs are opaque to Forge and owned by one resolver. */
export interface DependencySourceFile {
  ecosystem: DependencyEcosystem;
  role: "manifest" | "lockfile" | "source";
  path: string;
  contents: string;
}

export interface DependencyManifest {
  requirements: readonly DependencyRequirement[];
  sourceFiles?: readonly DependencySourceFile[];
}

export interface LockedDependencyPackage {
  /** Stable ecosystem-qualified ID, for example `cargo:serde@1.0.228`. */
  id: string;
  ecosystem: DependencyEcosystem;
  name: string;
  version: string;
  source: string;
  integritySha256: string;
  dependencies: readonly string[];
  features?: readonly string[];
}

export interface DependencyLock {
  schema: typeof FORGE_SCHEMAS.dependencyLock;
  forgeContract: typeof FORGE_CONTRACT_VERSION;
  /** SHA-256 of Forge's canonical cross-ecosystem manifest representation. */
  manifestSha256: string;
  roots: readonly string[];
  packages: readonly LockedDependencyPackage[];
}

export interface ResolvedDependencyGraph {
  roots: readonly string[];
  packages: readonly LockedDependencyPackage[];
  /** One canonical archive/blob per package ID. */
  payloads: Readonly<Record<string, Uint8Array>>;
}

/** @internal Shared by all adapters participating in one bounded resolution. */
export interface DependencyDownloadBudget {
  readonly limitBytes: number;
  readonly usedBytes: number;
  reserve(bytes: number): void;
  consume(bytes: number): void;
  release(bytes: number): void;
}

export interface DependencyResolutionContext {
  previousLock?: DependencyLock;
  /** Explicit browser/network consent scope. Omit only for offline resolution. */
  networkAccess?: DependencyNetworkAccess;
  /** @internal Forge-owned aggregate budget; custom resolvers must pass it through to network transports. */
  downloadBudget?: DependencyDownloadBudget;
}

/** Repository and immutable problem-bundle identity used to isolate cached locks. */
export interface DependencyNetworkScope {
  sourceKey: string;
  bundleDigest: string;
}

/** Complete host set approved for one repository source and immutable problem bundle. */
export interface DependencyNetworkAccess extends DependencyNetworkScope {
  hosts: readonly string[];
}

/** Performs the user- or host-owned authorization step before any dependency request. */
export interface DependencyNetworkAuthorizer {
  authorize(access: DependencyNetworkAccess): Promise<void>;
}

export interface ForgeDependencyResolver {
  readonly ecosystem: DependencyEcosystem;
  resolve(
    manifest: DependencyManifest,
    context: DependencyResolutionContext,
  ): Promise<ResolvedDependencyGraph>;
}

export interface ForgeDependencyCache {
  load(integritySha256: string): Promise<Uint8Array | undefined>;
  save(integritySha256: string, payload: Uint8Array): Promise<void>;
  delete(integritySha256: string): Promise<void>;
  clear(): Promise<void>;
}

export interface DependencyOfflineBundle {
  schema: typeof FORGE_SCHEMAS.dependencyOfflineBundle;
  forgeContract: typeof FORGE_CONTRACT_VERSION;
  lock: DependencyLock;
  payloads: Readonly<Record<string, Uint8Array>>;
}

export interface ResolveDependencyOptions {
  offline?: boolean;
  previousLock?: DependencyLock;
  /** Required to use `previousLock` after a genuine network transport failure. */
  previousLockNetworkScope?: DependencyNetworkScope;
  networkAccess?: DependencyNetworkAccess;
}
