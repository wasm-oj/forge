import { beforeEach, describe, expect, it, vi } from "vitest";
import { sha256Hex } from "./crypto";
import type { WasmOjWorkerEnv } from "./env";

const releaseMocks = vi.hoisted(() => ({ assertActiveRelease: vi.fn() }));
vi.mock("./release", async (importOriginal) => ({
  ...await importOriginal<typeof import("./release")>(),
  assertActiveRelease: releaseMocks.assertActiveRelease,
}));

import { updateFormalMutationControl } from "./admin";

const USER_ID = "11111111-1111-4111-8111-111111111111";
const RELEASE_ID = "22222222-2222-4222-8222-222222222222";
const MANIFEST_SHA256 = "a".repeat(64);

async function fixture() {
  const sessionHash = await sha256Hex("session-token");
  const csrfHash = await sha256Hex("csrf-token");
  const update = vi.fn(async () => ({ meta: { changes: 1 } }));
  const prepare = vi.fn((sql: string) => ({
    bind: (...values: unknown[]) => ({
      first: async () => {
        if (sql.includes("FROM sessions JOIN users")) {
          expect(values[0]).toBe(sessionHash);
          return { user_id: USER_ID, expires_at: "2099-01-01T00:00:00.000Z", csrf_hash: csrfHash, login: "admin", avatar_url: "https://example.test/admin.png" };
        }
        if (sql === "SELECT csrf_hash FROM sessions WHERE token_hash = ?") return { csrf_hash: csrfHash };
        throw new Error(`Unexpected first query: ${sql}`);
      },
      all: async () => {
        if (sql === "SELECT role FROM user_roles WHERE user_id = ? ORDER BY role") return { results: [{ role: "admin" }] };
        throw new Error(`Unexpected all query: ${sql}`);
      },
      run: update,
    }),
  }));
  const env = {
    DB: { prepare } as unknown as D1Database,
    PUBLIC_ORIGIN: "https://wasm-oj.test",
    ENVIRONMENT: "production",
    WASM_OJ_RELEASE_ID: RELEASE_ID,
    WASM_OJ_RELEASE_MANIFEST_SHA256: MANIFEST_SHA256,
  } as WasmOjWorkerEnv;
  const request = new Request("https://wasm-oj.test/api/admin/formal-mutations/resume", {
    method: "POST",
    headers: {
      origin: "https://wasm-oj.test",
      cookie: "wasm_oj_session=session-token; wasm_oj_csrf=csrf-token",
      "x-wasm-oj-csrf": "csrf-token",
      "content-type": "application/json",
    },
    body: JSON.stringify({ reason: "architecture-v2-production-smoke-passed" }),
  });
  return { env, request, update };
}

describe("formal mutation resume release fence", () => {
  beforeEach(() => releaseMocks.assertActiveRelease.mockReset());

  it("refuses to reopen when D1 does not identify the deployed release", async () => {
    const { env, request, update } = await fixture();
    releaseMocks.assertActiveRelease.mockRejectedValueOnce(new Error("release mismatch"));
    await expect(updateFormalMutationControl(request, env, true)).rejects.toMatchObject({
      status: 503,
      code: "active-release-mismatch",
    });
    expect(update).not.toHaveBeenCalled();
  });

  it("checks the exact release ID and manifest digest before reopening", async () => {
    const { env, request, update } = await fixture();
    releaseMocks.assertActiveRelease.mockResolvedValueOnce({
      releaseId: RELEASE_ID,
      manifestSha256: MANIFEST_SHA256,
      manifest: {},
    });
    const response = await updateFormalMutationControl(request, env, true);
    expect(releaseMocks.assertActiveRelease).toHaveBeenCalledWith(env.DB, "production", RELEASE_ID, MANIFEST_SHA256);
    expect(update).toHaveBeenCalledOnce();
    expect(await response.json()).toMatchObject({
      enabled: true,
      reason: "architecture-v2-production-smoke-passed",
    });
  });
});
