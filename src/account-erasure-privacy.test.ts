import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { eraseAccount } from "../worker/account-erasure";
import type { WasmOjWorkerEnv } from "../worker/env";
import { submissionSourceKey } from "../worker/submissions";

const SOURCE_ID = "0198dbd3-5c00-7000-8000-000000000003";

describe("account erasure privacy boundaries", () => {
  it("requires a browser-confirmed session rather than a CLI bearer", async () => {
    const request = new Request("https://wasm-oj.test/api/settings/account", {
      method: "DELETE",
      headers: {
        authorization: `Bearer ${"b".repeat(43)}`,
        origin: "https://wasm-oj.test",
      },
    });
    await expect(eraseAccount(request, {
      PUBLIC_ORIGIN: "https://wasm-oj.test",
    } as WasmOjWorkerEnv)).rejects.toMatchObject({
      status: 401,
      code: "browser-authentication-required",
    });
  });

  it("keeps the permanent tombstone at the exact opaque source key", () => {
    expect(submissionSourceKey(SOURCE_ID)).toBe(`submission-sources/v2/${SOURCE_ID}`);
  });

  it("uses a same-key R2 persistence barrier and stores only the bounded receipt in D1", async () => {
    const [erasure, submissions] = await Promise.all([
      readFile(new URL("../worker/account-erasure.ts", import.meta.url), "utf8"),
      readFile(new URL("../worker/submissions.ts", import.meta.url), "utf8"),
    ]);
    expect(erasure).toContain("receipt_json");
    expect(erasure).toContain("receipt_sha256");
    expect(erasure).toMatch(/eraseAccount[\s\S]*requireBrowserMutationSession[\s\S]*requireFormalMutationsEnabled[\s\S]*env\.DB\.batch/);
    expect(erasure).toContain("content_sha256=NULL, bytes=NULL");
    expect(erasure).toContain("UPDATE catalog_sync_jobs");
    expect(erasure).toContain("catalog_sync_job_id IN");
    expect(erasure).toContain("UPDATE catalog_sync_jobs SET requested_by=? WHERE requested_by=?");
    expect(erasure).not.toContain("catalog_validation_jobs");
    expect(erasure).not.toContain("catalog_publish_jobs");
    expect(erasure).not.toContain("deletion_receipt_r2_key");
    expect(erasure).not.toContain("account-erasure/");
    expect(submissions).toContain("JUDGE_BUCKET.put(key, SOURCE_TOMBSTONE");
    expect(submissions).toContain("JUDGE_BUCKET.head(key)");
    expect(submissions).not.toContain("erased-source-tombstones/");
  });
});
