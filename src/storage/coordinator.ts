import { clangBuildGraphStorageParticipant } from "../compiler/indexeddb-build-graph-cache.ts";
import { FORGE_STORAGE } from "../core/contract.ts";
import { IndexedDbDependencyCache } from "../dependencies/indexeddb-cache.ts";
import { artifactStorageParticipant } from "./database.ts";
import type {
  ForgeStorageEntry,
  ForgeStorageMaintenanceResult,
  ForgeStorageParticipant,
  ForgeStorageParticipantReport,
  ForgeStorageReport,
} from "./types.ts";

const DEFAULT_MAX_CACHE_BYTES = 2 * 1024 * 1024 * 1024;
const DEFAULT_MINIMUM_FREE_BYTES = 256 * 1024 * 1024;
const DEFAULT_QUOTA_FRACTION = 0.7;
const BYTE_LENGTH_HEADER = "X-WASM-OJ-Forge-Byte-Length";
const CACHED_AT_HEADER = "X-WASM-OJ-Forge-Cached-At";

export interface ForgeStorageCoordinatorOptions {
  storageManager?: StorageManager;
  lockManager?: LockManager;
  cacheStorage?: CacheStorage;
  participants?: readonly ForgeStorageParticipant[];
  maxCacheBytes?: number;
  minimumFreeBytes?: number;
  quotaFraction?: number;
}

interface ParticipantSnapshot {
  participant: ForgeStorageParticipant;
  entries: readonly ForgeStorageEntry[];
}

/**
 * One browser-wide admission and LRU eviction policy for Forge's independent
 * IndexedDB and Cache Storage backends. Web Locks serialize policy decisions
 * across tabs; cache payload integrity remains the responsibility of each store.
 */
export class ForgeStorageCoordinator {
  private readonly storageManager: StorageManager;
  private readonly lockManager: LockManager;
  private readonly participants: readonly ForgeStorageParticipant[];
  private readonly maxCacheBytes: number;
  private readonly minimumFreeBytes: number;
  private readonly quotaFraction: number;

  constructor(options: ForgeStorageCoordinatorOptions = {}) {
    const storageManager = options.storageManager ?? navigator.storage;
    const lockManager = options.lockManager ?? navigator.locks;
    if (!storageManager || typeof storageManager.estimate !== "function" || typeof storageManager.persist !== "function") {
      throw new Error("Forge storage coordination requires the StorageManager API.");
    }
    if (!lockManager || typeof lockManager.request !== "function") {
      throw new Error("Forge storage coordination requires the Web Locks API for cross-tab safety.");
    }
    this.storageManager = storageManager;
    this.lockManager = lockManager;
    this.participants = canonicalParticipants(options.participants ?? []);
    this.maxCacheBytes = nonNegativeInteger(options.maxCacheBytes ?? DEFAULT_MAX_CACHE_BYTES, "maximum cache bytes");
    this.minimumFreeBytes = nonNegativeInteger(options.minimumFreeBytes ?? DEFAULT_MINIMUM_FREE_BYTES, "minimum free bytes");
    this.quotaFraction = fraction(options.quotaFraction ?? DEFAULT_QUOTA_FRACTION);
  }

  async estimate(): Promise<ForgeStorageReport> {
    const [estimate, snapshots] = await Promise.all([
      this.storageManager.estimate(),
      this.snapshotParticipants(),
    ]);
    return report(estimate, snapshots, this.maxCacheBytes, this.minimumFreeBytes, this.quotaFraction);
  }

  /**
   * Evicts the least valuable, least recently used entries until both the
   * logical Forge budget and the browser quota headroom admit `incomingBytes`.
   */
  async maintain(incomingBytes = 0): Promise<ForgeStorageMaintenanceResult> {
    incomingBytes = nonNegativeInteger(incomingBytes, "incoming bytes");
    return this.exclusive(async () => {
      const [estimate, snapshots] = await Promise.all([
        this.storageManager.estimate(),
        this.snapshotParticipants(),
      ]);
      const before = report(estimate, snapshots, this.maxCacheBytes, this.minimumFreeBytes, this.quotaFraction);
      const required = requiredEviction(before, incomingBytes);
      const candidates = snapshots.flatMap(({ participant, entries }) => entries.map((entry) => ({ participant, entry })))
        .sort((left, right) => left.participant.retentionPriority - right.participant.retentionPriority
          || left.entry.lastAccessedAt - right.entry.lastAccessedAt
          || left.participant.id.localeCompare(right.participant.id)
          || left.entry.key.localeCompare(right.entry.key));
      const evicted: Array<{ participantId: string; key: string; byteLength: number }> = [];
      let released = 0;
      for (const candidate of candidates) {
        if (released >= required) break;
        await candidate.participant.delete(candidate.entry.key);
        released += candidate.entry.byteLength;
        evicted.push({
          participantId: candidate.participant.id,
          key: candidate.entry.key,
          byteLength: candidate.entry.byteLength,
        });
      }
      const after = await this.estimateUnlocked();
      return { before, after, evicted };
    });
  }

  /** Fails before a write when all coordinated caches cannot free enough room. */
  async admit(incomingBytes: number): Promise<ForgeStorageMaintenanceResult> {
    const result = await this.maintain(incomingBytes);
    const released = result.evicted.reduce((total, item) => total + item.byteLength, 0);
    if (released < requiredEviction(result.before, incomingBytes)) {
      throw new DOMException("Forge browser storage cannot admit the requested payload within its configured budget.", "QuotaExceededError");
    }
    return result;
  }

  async clear(): Promise<void> {
    await this.exclusive(async () => {
      for (const participant of this.participants) await participant.clear();
    });
  }

  requestPersistence(): Promise<boolean> {
    return this.storageManager.persist();
  }

  private async estimateUnlocked(): Promise<ForgeStorageReport> {
    const [estimate, snapshots] = await Promise.all([
      this.storageManager.estimate(),
      this.snapshotParticipants(),
    ]);
    return report(estimate, snapshots, this.maxCacheBytes, this.minimumFreeBytes, this.quotaFraction);
  }

  private async snapshotParticipants(): Promise<ParticipantSnapshot[]> {
    return Promise.all(this.participants.map(async (participant) => {
      const entries = [...await participant.list()].map(validateEntry);
      const keys = entries.map((entry) => entry.key);
      if (new Set(keys).size !== keys.length) throw new Error(`Storage participant '${participant.id}' returned duplicate keys.`);
      return { participant, entries };
    }));
  }

  private async exclusive<T>(operation: () => Promise<T>): Promise<T> {
    return await this.lockManager.request(
      `${FORGE_STORAGE.database}:coordinator`,
      { mode: "exclusive" },
      async () => await operation(),
    );
  }
}

export function createDefaultBrowserStorageCoordinator(
  options: Omit<ForgeStorageCoordinatorOptions, "participants"> = {},
): ForgeStorageCoordinator {
  const cacheStorage = options.cacheStorage ?? caches;
  const dependencyCache = new IndexedDbDependencyCache();
  return new ForgeStorageCoordinator({
    ...options,
    cacheStorage,
    participants: [
      clangBuildGraphStorageParticipant(),
      artifactStorageParticipant(),
      dependencyCache.storageParticipant(),
      cacheStorageParticipant(cacheStorage, FORGE_STORAGE.runtimeFilesCache, "runtime-files", 50),
      cacheStorageParticipant(cacheStorage, FORGE_STORAGE.toolchainCache, "toolchains", 100),
    ],
  });
}

export function cacheStorageParticipant(
  storage: CacheStorage,
  cacheName: string,
  id: string,
  retentionPriority: number,
): ForgeStorageParticipant {
  requireParticipantIdentity(id, retentionPriority);
  return {
    id,
    retentionPriority,
    async list() {
      const cache = await storage.open(cacheName);
      const requests = await cache.keys();
      const entries: ForgeStorageEntry[] = [];
      for (const request of requests) {
        const response = await cache.match(request);
        if (!response) continue;
        const byteLength = parseStorageInteger(response.headers.get(BYTE_LENGTH_HEADER));
        const lastAccessedAt = parseStorageInteger(response.headers.get(CACHED_AT_HEADER));
        if (byteLength === undefined || lastAccessedAt === undefined) {
          await cache.delete(request);
          continue;
        }
        entries.push({ key: request.url, byteLength, lastAccessedAt });
      }
      return entries;
    },
    async delete(key) {
      const cache = await storage.open(cacheName);
      await cache.delete(key);
    },
    async clear() {
      await storage.delete(cacheName);
    },
  };
}

function report(
  estimate: StorageEstimate,
  snapshots: readonly ParticipantSnapshot[],
  maximum: number,
  minimumFreeBytes: number,
  quotaFraction: number,
): ForgeStorageReport {
  const usage = nonNegativeInteger(estimate.usage ?? 0, "browser storage usage");
  const quota = nonNegativeInteger(estimate.quota ?? 0, "browser storage quota");
  const participants: ForgeStorageParticipantReport[] = snapshots.map(({ participant, entries }) => ({
    id: participant.id,
    byteLength: entries.reduce(addEntryBytes, 0),
    entryCount: entries.length,
    retentionPriority: participant.retentionPriority,
  }));
  const quotaBudget = quota > 0 ? Math.floor(quota * quotaFraction) : maximum;
  return {
    usage,
    quota,
    logicalCacheBytes: participants.reduce((total, item) => total + item.byteLength, 0),
    logicalCacheBudget: Math.min(maximum, quotaBudget),
    minimumFreeBytes,
    participants,
  };
}

function requiredEviction(reportValue: ForgeStorageReport, incomingBytes: number): number {
  const logical = Math.max(0, reportValue.logicalCacheBytes + incomingBytes - reportValue.logicalCacheBudget);
  const quota = reportValue.quota > 0
    ? Math.max(0, reportValue.usage + incomingBytes + reportValue.minimumFreeBytes - reportValue.quota)
    : 0;
  return Math.max(logical, quota);
}

function canonicalParticipants(participants: readonly ForgeStorageParticipant[]): ForgeStorageParticipant[] {
  const result = participants.map((participant) => {
    if (!participant || typeof participant.list !== "function" || typeof participant.delete !== "function"
      || typeof participant.clear !== "function") {
      throw new Error("Storage participants must implement list(), delete(), and clear().");
    }
    requireParticipantIdentity(participant.id, participant.retentionPriority);
    return participant;
  });
  const ids = result.map((participant) => participant.id);
  if (new Set(ids).size !== ids.length) throw new Error("Storage participant IDs must be unique.");
  return result.sort((left, right) => left.id.localeCompare(right.id));
}

function requireParticipantIdentity(id: string, priority: number): void {
  if (!id || id !== id.trim() || id.includes("\0")) throw new Error("Storage participant IDs must be non-empty and canonical.");
  nonNegativeInteger(priority, `storage participant '${id}' retention priority`);
}

function validateEntry(value: ForgeStorageEntry): ForgeStorageEntry {
  if (!value || typeof value.key !== "string" || !value.key || value.key !== value.key.trim() || value.key.includes("\0")) {
    throw new Error("Storage entry keys must be non-empty and canonical.");
  }
  return {
    key: value.key,
    byteLength: nonNegativeInteger(value.byteLength, `storage entry '${value.key}' byte length`),
    lastAccessedAt: nonNegativeInteger(value.lastAccessedAt, `storage entry '${value.key}' access time`),
  };
}

function addEntryBytes(total: number, entry: ForgeStorageEntry): number {
  const next = total + entry.byteLength;
  if (!Number.isSafeInteger(next)) throw new Error("Coordinated storage size exceeds the safe integer range.");
  return next;
}

function parseStorageInteger(value: string | null): number | undefined {
  if (value === null || !/^\d+$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

function nonNegativeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label} must be a non-negative safe integer.`);
  return value;
}

function fraction(value: number): number {
  if (!Number.isFinite(value) || value <= 0 || value > 1) throw new Error("Storage quota fraction must be in (0, 1].");
  return value;
}
