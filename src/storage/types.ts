export interface ForgeStorageEntry {
  key: string;
  byteLength: number;
  lastAccessedAt: number;
}

export interface ForgeStorageParticipant {
  /** Stable identifier used in reports and policy overrides. */
  readonly id: string;
  /** Lower values are evicted first. */
  readonly retentionPriority: number;
  list(): Promise<readonly ForgeStorageEntry[]>;
  delete(key: string): Promise<void>;
  clear(): Promise<void>;
}

export interface ForgeStorageParticipantReport {
  id: string;
  byteLength: number;
  entryCount: number;
  retentionPriority: number;
}

export interface ForgeStorageReport {
  usage: number;
  quota: number;
  logicalCacheBytes: number;
  logicalCacheBudget: number;
  minimumFreeBytes: number;
  participants: readonly ForgeStorageParticipantReport[];
}

export interface ForgeStorageMaintenanceResult {
  before: ForgeStorageReport;
  after: ForgeStorageReport;
  evicted: readonly { participantId: string; key: string; byteLength: number }[];
}
