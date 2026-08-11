import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { erasedSourceTombstoneKey } from "../worker/account-erasure";

const SECRET = "account-erasure-test-secret-with-32-bytes-minimum";
const USER_ID = "0198dbd3-5c00-7000-8000-000000000001";
const OTHER_USER_ID = "0198dbd3-5c00-7000-8000-000000000002";
const SUBMISSION_ID = "0198dbd3-5c00-7000-8000-000000000003";

describe("account erasure privacy boundaries", () => {
  it("uses a stable irreversible source tombstone independent of the deleted R2 key", async () => {
    const key = await erasedSourceTombstoneKey(SECRET, SUBMISSION_ID);
    expect(key).toMatch(/^erased-source-tombstones\/v1\/[0-9a-f]{64}$/);
    expect(key).not.toContain(SUBMISSION_ID);
    expect(key).not.toContain(USER_ID);
    await expect(erasedSourceTombstoneKey(SECRET, SUBMISSION_ID)).resolves.toBe(key);
    await expect(erasedSourceTombstoneKey(SECRET, OTHER_USER_ID)).resolves.not.toBe(key);
  });

  it("anonymizes D1 rows and removes short-lived risk state without a product Durable Object", async () => {
    const erasure = await readFile(new URL("../worker/account-erasure.ts", import.meta.url), "utf8");
    expect(erasure).toContain("source_r2_key=?");
    expect(erasure).toContain("source_erased_at=COALESCE(source_erased_at, ?)");
    expect(erasure).toContain("visibility='private'");
    expect(erasure).toContain("DELETE FROM formal_risk_allowances");
    expect(erasure).not.toMatch(/(?:SUBMISSION|USER_QUOTA|ADMISSION_CONTROL|PROBLEM_LEADERBOARD|CONTEST)_DO/);
  });
});
