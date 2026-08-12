import type {
  DependencyEcosystem,
  DependencyLock,
  DependencyManifest,
  DependencyRequirement,
  DependencySourceFile,
  LockedDependencyPackage,
} from "../core/types.ts";
import { DEPENDENCY_ECOSYSTEMS } from "../core/types.ts";

export { DEPENDENCY_ECOSYSTEMS };
export type {
  DependencyEcosystem,
  DependencyLock,
  DependencyManifest,
  DependencyRequirement,
  DependencySourceFile,
  LockedDependencyPackage,
};

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
  /** @internal WASM-OJ-owned aggregate budget; custom resolvers must pass it through to network transports. */
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

export interface DependencyResolver {
  readonly ecosystem: DependencyEcosystem;
  resolve(
    manifest: DependencyManifest,
    context: DependencyResolutionContext,
  ): Promise<ResolvedDependencyGraph>;
}

export interface DependencyCache {
  load(integritySha256: string): Promise<Uint8Array | undefined>;
  save(integritySha256: string, payload: Uint8Array): Promise<void>;
  delete(integritySha256: string): Promise<void>;
  clear(): Promise<void>;
}

export interface DependencyOfflineBundle {
  schema: typeof import("../core/contract.ts").WASM_OJ_SCHEMAS.dependencyOfflineBundle;
  wasmOjContract: typeof import("../core/contract.ts").WASM_OJ_CONTRACT_VERSION;
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
