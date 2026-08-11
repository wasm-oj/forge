import { sha256Hex } from "../core/hash.ts";
import type {
  DependencyNetworkAccess,
  DependencyNetworkAuthorizer,
  DependencyNetworkScope,
} from "./types.ts";
import { assertBoundedCount, DEPENDENCY_RESOLUTION_LIMITS } from "./limits.ts";
import { dependencyPublicHostname } from "./url-policy.ts";

const STORAGE_PREFIX = "forge:dependency-network-consent:v1:";
const DIGEST = /^[0-9a-f]{64}$/;

export interface DependencyNetworkConsentPrompt {
  (access: DependencyNetworkAccess): Promise<boolean>;
}

export interface DependencyConsentStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

interface StoredConsent {
  schema: 1;
  sourceKey: string;
  bundleDigest: string;
  hosts: string[];
  grantedAt: string;
}

/**
 * Browser consent authorizer isolated by repository source, immutable bundle,
 * and the complete requested host set. A newly introduced host always prompts.
 */
export class BrowserDependencyNetworkConsent implements DependencyNetworkAuthorizer {
  readonly #storage: DependencyConsentStorage;
  readonly #prompt: DependencyNetworkConsentPrompt;
  readonly #now: () => Date;

  constructor(
    storage: DependencyConsentStorage,
    prompt: DependencyNetworkConsentPrompt,
    now: () => Date = () => new Date(),
  ) {
    this.#storage = storage;
    this.#prompt = prompt;
    this.#now = now;
  }

  async authorize(rawAccess: DependencyNetworkAccess): Promise<void> {
    const access = normalizeDependencyNetworkAccess(rawAccess);
    const key = await consentStorageKey(access.sourceKey, access.bundleDigest);
    const existing = this.#read(key, access);
    if (existing && isSubset(access.hosts, existing.hosts)) return;

    const hosts = normalizedHosts([...(existing?.hosts ?? []), ...access.hosts]);
    const request = Object.freeze({ ...access, hosts });
    if (!await this.#prompt(request)) {
      throw new Error("Dependency network access was not approved for the complete host set.");
    }

    const concurrent = this.#read(key, access);
    const approvedHosts = normalizedHosts([...(concurrent?.hosts ?? []), ...hosts]);
    this.#storage.setItem(key, JSON.stringify({
      schema: 1,
      sourceKey: access.sourceKey,
      bundleDigest: access.bundleDigest,
      hosts: approvedHosts,
      grantedAt: this.#now().toISOString(),
    } satisfies StoredConsent));
  }

  async revoke(sourceKey: string, bundleDigest: string): Promise<void> {
    const scope = normalizeDependencyNetworkScope({ sourceKey, bundleDigest });
    this.#storage.removeItem(await consentStorageKey(scope.sourceKey, scope.bundleDigest));
  }

  #read(key: string, expected: DependencyNetworkAccess): StoredConsent | undefined {
    const raw = this.#storage.getItem(key);
    if (raw === null) return undefined;
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (!isStoredConsent(parsed)
        || parsed.sourceKey !== expected.sourceKey
        || parsed.bundleDigest !== expected.bundleDigest) {
        throw new Error("mismatch");
      }
      return { ...parsed, hosts: normalizedHosts(parsed.hosts) };
    } catch {
      this.#storage.removeItem(key);
      return undefined;
    }
  }
}

export function normalizeDependencyNetworkAccess(access: DependencyNetworkAccess): DependencyNetworkAccess {
  if (!access || typeof access !== "object") throw new TypeError("Dependency network access is required.");
  const scope = normalizeDependencyNetworkScope(access);
  if (!Array.isArray(access.hosts) || access.hosts.length === 0) {
    throw new TypeError("Dependency network access must declare the complete non-empty host set.");
  }
  assertBoundedCount(access.hosts.length, DEPENDENCY_RESOLUTION_LIMITS.hosts, "Dependency network hosts");
  return Object.freeze({
    sourceKey: scope.sourceKey,
    bundleDigest: scope.bundleDigest,
    hosts: normalizedHosts(access.hosts),
  });
}

export function normalizeDependencyNetworkScope(scope: DependencyNetworkScope): DependencyNetworkScope {
  if (!scope || typeof scope !== "object") throw new TypeError("Dependency network scope is required.");
  const { sourceKey, bundleDigest } = scope;
  if (typeof sourceKey !== "string" || !sourceKey || sourceKey.length > 2048
    || sourceKey !== sourceKey.trim() || sourceKey.includes("\0")) {
    throw new TypeError("Dependency network source key is invalid.");
  }
  if (typeof bundleDigest !== "string" || !DIGEST.test(bundleDigest)) {
    throw new TypeError("Dependency network bundle digest must be lowercase SHA-256 hexadecimal.");
  }
  return Object.freeze({ sourceKey, bundleDigest });
}

async function consentStorageKey(sourceKey: string, bundleDigest: string): Promise<string> {
  const payload = new TextEncoder().encode(`${sourceKey}\0${bundleDigest}`);
  return `${STORAGE_PREFIX}${await sha256Hex(payload)}`;
}

function normalizedHosts(values: readonly string[]): string[] {
  const hosts = [...new Set(values.map((host) => {
    if (typeof host !== "string") throw new TypeError("Dependency network hosts must be strings.");
    return dependencyPublicHostname(host);
  }))].sort();
  assertBoundedCount(hosts.length, DEPENDENCY_RESOLUTION_LIMITS.hosts, "Dependency network hosts");
  return hosts;
}

function isSubset(required: readonly string[], approved: readonly string[]): boolean {
  const allowed = new Set(approved);
  return required.every((host) => allowed.has(host));
}

function isStoredConsent(value: unknown): value is StoredConsent {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Partial<StoredConsent>;
  return Object.keys(value).sort().join(",") === "bundleDigest,grantedAt,hosts,schema,sourceKey"
    && record.schema === 1
    && typeof record.sourceKey === "string"
    && typeof record.bundleDigest === "string"
    && Array.isArray(record.hosts)
    && record.hosts.length <= DEPENDENCY_RESOLUTION_LIMITS.hosts
    && record.hosts.every((host) => typeof host === "string")
    && typeof record.grantedAt === "string"
    && !Number.isNaN(Date.parse(record.grantedAt));
}
