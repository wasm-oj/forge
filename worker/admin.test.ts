import { describe, expect, it, vi } from "vitest";
import { revokeOrganizerRole } from "./admin";
import { sha256Hex } from "./crypto";
import type { WasmOjWorkerEnv } from "./env";

const ADMIN_USER_ID = "11111111-1111-4111-8111-111111111111";
const TARGET_USER_ID = "22222222-2222-4222-8222-222222222222";

async function revocationEnvironment(targetIsAdmin: boolean) {
  const sessionHash = await sha256Hex("session-token");
  const csrfHash = await sha256Hex("csrf-token");
  const deletion = vi.fn(async () => ({ meta: { changes: 1 } }));
  const prepare = vi.fn((sql: string) => ({
    bind: (...values: unknown[]) => ({
      first: async () => {
        if (sql.includes("FROM sessions JOIN users")) {
          expect(values[0]).toBe(sessionHash);
          return { user_id: ADMIN_USER_ID, expires_at: "2099-01-01T00:00:00.000Z", csrf_hash: csrfHash, login: "admin", avatar_url: "https://example.test/admin.png" };
        }
        if (sql === "SELECT csrf_hash FROM sessions WHERE token_hash = ?") return { csrf_hash: csrfHash };
        if (sql.includes("role='admin'")) return targetIsAdmin ? { active: 1 } : null;
        throw new Error(`Unexpected first query: ${sql}`);
      },
      all: async () => {
        if (sql === "SELECT role FROM user_roles WHERE user_id = ? ORDER BY role") return { results: [{ role: "admin" }] };
        throw new Error(`Unexpected all query: ${sql}`);
      },
      run: deletion,
    }),
  }));
  return {
    env: { DB: { prepare } as unknown as D1Database, PUBLIC_ORIGIN: "https://wasm-oj.test" } as WasmOjWorkerEnv,
    deletion,
  };
}

function revocationRequest(): Request {
  return new Request(`https://wasm-oj.test/api/admin/organizers/${TARGET_USER_ID}/revoke`, {
    method: "POST",
    headers: {
      origin: "https://wasm-oj.test",
      cookie: "wasm_oj_session=session-token; wasm_oj_csrf=csrf-token",
      "x-wasm-oj-csrf": "csrf-token",
      "content-type": "application/json",
    },
    body: "{}",
  });
}

describe("Organizer role revocation", () => {
  it("rejects an Admin target before deleting any role", async () => {
    const { env, deletion } = await revocationEnvironment(true);
    await expect(revokeOrganizerRole(revocationRequest(), env, TARGET_USER_ID))
      .rejects.toMatchObject({ status: 409, code: "organizer-revoke-admin" });
    expect(deletion).not.toHaveBeenCalled();
  });

  it("deletes only the Organizer role for a non-Admin target", async () => {
    const { env, deletion } = await revocationEnvironment(false);
    const response = await revokeOrganizerRole(revocationRequest(), env, TARGET_USER_ID);
    expect(await response.json()).toMatchObject({ userId: TARGET_USER_ID, effectiveOrganizerAccess: "revoked", changed: true });
    expect(deletion).toHaveBeenCalledOnce();
  });
});
