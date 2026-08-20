import { describe, expect, it, vi } from "vitest";
import type { WasmOjWorkerEnv } from "./env";
import {
  addOrganizerContestProblem,
  archiveOrganizerContest,
  listOrganizerContestParticipants,
  removeOrganizerContestProblem,
} from "./product";
import { sha256Hex } from "./crypto";

const CONTEST_ID = "11111111-1111-4111-8111-111111111111";
const USER_ID = "22222222-2222-4222-8222-222222222222";
const PARTICIPANT_ID = "33333333-3333-4333-8333-333333333333";
const PROBLEM_VERSION_ID = "44444444-4444-4444-8444-444444444444";
const PROBLEM_SERIES_ID = "55555555-5555-4555-8555-555555555555";

function authenticatedRequest(path: string, init: RequestInit = {}): Request {
  return new Request(`https://wasm-oj.test${path}`, {
    ...init,
    headers: {
      cookie: "wasm_oj_session=session-token; wasm_oj_csrf=csrf-token",
      origin: "https://wasm-oj.test",
      "x-wasm-oj-csrf": "csrf-token",
      ...(init.headers ?? {}),
    },
  });
}

async function sessionRow(sql: string, values: readonly unknown[]): Promise<Record<string, unknown> | undefined> {
  if (sql.includes("FROM sessions JOIN users")) {
    expect(values[0]).toBe(await sha256Hex("session-token"));
    return {
      user_id: USER_ID,
      expires_at: "2099-01-01T00:00:00.000Z",
      csrf_hash: await sha256Hex("csrf-token"),
      login: "organizer",
      avatar_url: "https://example.test/avatar.png",
    };
  }
  if (sql === "SELECT csrf_hash FROM sessions WHERE token_hash = ?") {
    return { csrf_hash: await sha256Hex("csrf-token") };
  }
  return undefined;
}

describe("Organizer contest terminal operations", () => {
  it("adds and removes an exact problem through atomic draft operations", async () => {
    let present = false;
    const prepare = vi.fn((sql: string) => ({ bind: (...values: unknown[]) => ({
      first: async () => {
        const session = await sessionRow(sql, values);
        if (session) return session;
        if (sql.includes("SELECT formal_mutations_enabled")) return {
          formal_mutations_enabled: 1,
          reason: "tests-enabled",
          updated_at: "2026-08-13T00:00:00.000Z",
        };
        if (sql === "SELECT ordinal FROM contest_problems WHERE contest_id=? AND problem_version_id=?") {
          return present ? { ordinal: 1 } : null;
        }
        if (sql === "SELECT status FROM contests WHERE id=? AND organizer_user_id=?") return { status: "draft" };
        throw new Error(`Unexpected first query: ${sql}`);
      },
      all: async () => {
        if (sql === "SELECT role FROM user_roles WHERE user_id = ? ORDER BY role") {
          return { results: [{ role: "organizer" }] };
        }
        if (sql.includes("FROM problem_version_details AS versions")) return { results: [{
          id: PROBLEM_VERSION_ID,
          problem_series_id: PROBLEM_SERIES_ID,
          catalog_publication_id: "66666666-6666-4666-8666-666666666666",
        }] };
        throw new Error(`Unexpected all query: ${sql}`);
      },
      run: async () => {
        if (sql.includes("INSERT OR IGNORE INTO contest_problems")) {
          present = true;
          return { meta: { changes: 1 } };
        }
        if (sql.includes("DELETE FROM contest_problems")) {
          const changes = present ? 1 : 0;
          present = false;
          return { meta: { changes } };
        }
        throw new Error(`Unexpected run query: ${sql}`);
      },
    }) }));
    const env = {
      DB: { prepare } as unknown as D1Database,
      PUBLIC_ORIGIN: "https://wasm-oj.test",
      ENVIRONMENT: "development",
    } as WasmOjWorkerEnv;
    const add = await addOrganizerContestProblem(authenticatedRequest(
      `/api/organizer/contests/${CONTEST_ID}/problems/${PROBLEM_VERSION_ID}`,
      { method: "POST", body: "{}", headers: { "content-type": "application/json" } },
    ), env, CONTEST_ID, PROBLEM_VERSION_ID);
    expect(await add.json()).toEqual({ contestId: CONTEST_ID, problemVersionId: PROBLEM_VERSION_ID, ordinal: 1, changed: true });
    const remove = await removeOrganizerContestProblem(authenticatedRequest(
      `/api/organizer/contests/${CONTEST_ID}/problems/${PROBLEM_VERSION_ID}`,
      { method: "DELETE", body: "{}", headers: { "content-type": "application/json" } },
    ), env, CONTEST_ID, PROBLEM_VERSION_ID);
    expect(await remove.json()).toEqual({ contestId: CONTEST_ID, problemVersionId: PROBLEM_VERSION_ID, changed: true });
  });

  it("archives an ended owned contest through an explicit state transition", async () => {
    const prepare = vi.fn((sql: string) => ({ bind: (...values: unknown[]) => ({
      first: async () => {
        const session = await sessionRow(sql, values);
        if (session) return session;
        if (sql.includes("SELECT formal_mutations_enabled")) return {
          formal_mutations_enabled: 1,
          reason: "tests-enabled",
          updated_at: "2026-08-13T00:00:00.000Z",
        };
        throw new Error(`Unexpected first query: ${sql}`);
      },
      all: async () => {
        if (sql === "SELECT role FROM user_roles WHERE user_id = ? ORDER BY role") {
          return { results: [{ role: "organizer" }] };
        }
        throw new Error(`Unexpected all query: ${sql}`);
      },
      run: async () => {
        if (sql.includes("UPDATE contests SET status='archived'")) return { meta: { changes: 1 } };
        throw new Error(`Unexpected run query: ${sql}`);
      },
    }) }));
    const response = await archiveOrganizerContest(authenticatedRequest(
      `/api/organizer/contests/${CONTEST_ID}/archive`,
      { method: "POST", body: "{}", headers: { "content-type": "application/json" } },
    ), {
      DB: { prepare } as unknown as D1Database,
      PUBLIC_ORIGIN: "https://wasm-oj.test",
      ENVIRONMENT: "development",
    } as WasmOjWorkerEnv, CONTEST_ID);
    expect(await response.json()).toMatchObject({ contestId: CONTEST_ID, status: "archived", changed: true });
  });

  it("lists every participant independently of leaderboard results with a durable cursor", async () => {
    const prepare = vi.fn((sql: string) => ({ bind: (...values: unknown[]) => ({
      first: async () => {
        const session = await sessionRow(sql, values);
        if (session) return session;
        if (sql.includes("SELECT 1 AS present FROM contests")) return { present: 1 };
        throw new Error(`Unexpected first query: ${sql}`);
      },
      all: async () => {
        if (sql === "SELECT role FROM user_roles WHERE user_id = ? ORDER BY role") {
          return { results: [{ role: "organizer" }] };
        }
        if (sql.includes("FROM contest_participants")) return { results: [{
          user_id: PARTICIPANT_ID,
          joined_at: "2026-08-13T00:00:00.000Z",
        }] };
        if (sql.includes("FROM users")) return { results: [{
          user_id: PARTICIPANT_ID,
          status: "active",
          display_name: "Ada",
          visibility: "public",
          login: "ada",
          avatar_url: "https://example.test/ada.png",
        }] };
        throw new Error(`Unexpected all query: ${sql}`);
      },
    }) }));
    const response = await listOrganizerContestParticipants(authenticatedRequest(
      `/api/organizer/contests/${CONTEST_ID}/participants?limit=25`,
    ), {
      DB: { prepare } as unknown as D1Database,
      ACCOUNT_ERASURE_HMAC_SECRET: "a".repeat(64),
    } as WasmOjWorkerEnv, CONTEST_ID);
    expect(await response.json()).toEqual({
      participants: [{
        participant: {
          id: expect.stringMatching(/^participant-[0-9a-f]{24}$/),
          kind: "profile",
          label: "Ada",
          login: "ada",
          avatarUrl: "https://example.test/ada.png",
        },
        joinedAt: "2026-08-13T00:00:00.000Z",
      }],
      nextCursor: null,
    });

    await expect(listOrganizerContestParticipants(authenticatedRequest(
      `/api/organizer/contests/${CONTEST_ID}/participants?limit=25&limit=50`,
    ), {
      DB: { prepare } as unknown as D1Database,
      ACCOUNT_ERASURE_HMAC_SECRET: "a".repeat(64),
    } as WasmOjWorkerEnv, CONTEST_ID)).rejects.toMatchObject({
      status: 400,
      code: "contest-participant-cursor-invalid",
    });
  });
});
