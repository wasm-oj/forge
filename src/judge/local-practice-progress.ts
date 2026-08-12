import { WASM_OJ_CONTRACT_ID } from "../core/contract";

export const LOCAL_SAMPLES_PASSED_KEY = `${WASM_OJ_CONTRACT_ID}:local-samples-passed`;

export interface LocalSamplesPassedRecord {
  readonly bundleDigest: string;
  readonly samplesPassedAt: string;
}

interface StoredLocalSamplesProgress {
  readonly version: 1;
  readonly problems: Readonly<Record<string, LocalSamplesPassedRecord>>;
}

const SHA256 = /^[0-9a-f]{64}$/;

export function readLocalSamplesPassed(storage: Pick<Storage, "getItem">): ReadonlyMap<string, LocalSamplesPassedRecord> {
  const raw = storage.getItem(LOCAL_SAMPLES_PASSED_KEY);
  if (raw === null) return new Map();
  try {
    const value = JSON.parse(raw) as Partial<StoredLocalSamplesProgress>;
    if (value.version !== 1 || !value.problems || typeof value.problems !== "object" || Array.isArray(value.problems)) return new Map();
    const records = new Map<string, LocalSamplesPassedRecord>();
    for (const [problemVersionId, candidate] of Object.entries(value.problems)) {
      if (
        !candidate
        || typeof candidate !== "object"
        || Array.isArray(candidate)
        || !SHA256.test(candidate.bundleDigest)
        || typeof candidate.samplesPassedAt !== "string"
        || Number.isNaN(Date.parse(candidate.samplesPassedAt))
      ) return new Map();
      records.set(problemVersionId, {
        bundleDigest: candidate.bundleDigest,
        samplesPassedAt: candidate.samplesPassedAt,
      });
    }
    return records;
  } catch {
    return new Map();
  }
}

export function recordLocalSamplesPassed(
  storage: Pick<Storage, "getItem" | "setItem">,
  problemVersionId: string,
  bundleDigest: string,
  samplesPassedAt = new Date().toISOString(),
): void {
  if (!SHA256.test(bundleDigest) || Number.isNaN(Date.parse(samplesPassedAt))) throw new TypeError("Local sample progress identity is invalid.");
  const records = Object.fromEntries(readLocalSamplesPassed(storage));
  records[problemVersionId] = { bundleDigest, samplesPassedAt };
  storage.setItem(LOCAL_SAMPLES_PASSED_KEY, JSON.stringify({ version: 1, problems: records }));
}

export function hasMatchingLocalSamplesPassed(
  records: ReadonlyMap<string, LocalSamplesPassedRecord>,
  problemVersionId: string,
  bundleDigest: string,
): boolean {
  return records.get(problemVersionId)?.bundleDigest === bundleDigest;
}
