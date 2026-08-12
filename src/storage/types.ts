export interface StorageEntry {
  key: string;
  byteLength: number;
  lastAccessedAt: number;
}

export interface StorageParticipant {
  /** Stable identifier used in reports and policy overrides. */
  readonly id: string;
  /** Lower values are evicted first. */
  readonly retentionPriority: number;
  list(): Promise<readonly StorageEntry[]>;
  delete(key: string): Promise<void>;
  clear(): Promise<void>;
}

export interface StorageParticipantReport {
  id: string;
  byteLength: number;
  entryCount: number;
  retentionPriority: number;
}

export interface StorageReport {
  usage: number;
  quota: number;
  logicalCacheBytes: number;
  logicalCacheBudget: number;
  minimumFreeBytes: number;
  participants: readonly StorageParticipantReport[];
}

export interface StorageMaintenanceResult {
  before: StorageReport;
  after: StorageReport;
  evicted: readonly { participantId: string; key: string; byteLength: number }[];
}
