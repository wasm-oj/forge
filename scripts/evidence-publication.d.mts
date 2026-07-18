export interface EvidencePublication {
  path: string;
  bytes: string | Uint8Array;
}

export function publishEvidenceFiles(entries: readonly EvidencePublication[]): Promise<void>;
