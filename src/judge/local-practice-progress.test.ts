import { describe, expect, it } from "vitest";
import { hasMatchingLocalSamplesPassed, LOCAL_SAMPLES_PASSED_KEY, readLocalSamplesPassed, recordLocalSamplesPassed } from "./local-practice-progress";

describe("browser-local samples progress", () => {
  it("records sample success separately from server-verified solved progress", () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    };
    const digestA = "a".repeat(64);
    const digestB = "b".repeat(64);
    recordLocalSamplesPassed(storage, "problem-b", digestB, "2026-08-12T00:00:00.000Z");
    recordLocalSamplesPassed(storage, "problem-a", digestA, "2026-08-12T00:01:00.000Z");
    const records = readLocalSamplesPassed(storage);
    expect(JSON.parse(values.get(LOCAL_SAMPLES_PASSED_KEY) ?? "null")).toEqual({
      version: 1,
      problems: {
        "problem-b": { bundleDigest: digestB, samplesPassedAt: "2026-08-12T00:00:00.000Z" },
        "problem-a": { bundleDigest: digestA, samplesPassedAt: "2026-08-12T00:01:00.000Z" },
      },
    });
    expect(hasMatchingLocalSamplesPassed(records, "problem-a", digestA)).toBe(true);
    expect(hasMatchingLocalSamplesPassed(records, "problem-a", digestB)).toBe(false);
  });

  it("ignores malformed local data instead of claiming progress", () => {
    expect(readLocalSamplesPassed({ getItem: () => '{"solved":true}' }).size).toBe(0);
  });
});
