import { describe, expect, it, vi } from "vitest";
import type { WasmOjWorkerEnv } from "./env";
import { getProblemCollection } from "./catalog";
import { sha256Hex } from "./crypto";

const USER_ID = "11111111-1111-4111-8111-111111111111";
const COLLECTION_ID = "22222222-2222-4222-8222-222222222222";

describe("Organizer collection detail", () => {
  it("loads an exact owned collection without relying on the bounded list", async () => {
    const prepare = vi.fn((sql: string) => ({ bind: (...values: unknown[]) => ({
      first: async () => {
        if (sql.includes("FROM sessions JOIN users")) {
          expect(values).toEqual([await sha256Hex("session-token")]);
          return {
            user_id: USER_ID,
            expires_at: "2099-01-01T00:00:00.000Z",
            csrf_hash: "",
            login: "organizer",
            avatar_url: "https://example.test/avatar.png",
          };
        }
        if (sql.includes("FROM problem_collections AS collections")) {
          expect(values).toEqual([COLLECTION_ID, USER_ID]);
          return {
            id: COLLECTION_ID,
            github_repository_id: 42,
            index_path: "collection-v2/index.json",
            created_at: "2026-08-13T00:00:00.000Z",
            updated_at: "2026-08-13T00:00:00.000Z",
            owner_login: "wasm-oj",
            name: "official-problems",
          };
        }
        throw new Error(`Unexpected first query: ${sql}`);
      },
      all: async () => {
        if (sql === "SELECT role FROM user_roles WHERE user_id = ? ORDER BY role") {
          return { results: [{ role: "organizer" }] };
        }
        throw new Error(`Unexpected all query: ${sql}`);
      },
    }) }));
    const response = await getProblemCollection(new Request(
      `https://wasm-oj.test/api/organizer/collections/${COLLECTION_ID}`,
      { headers: { cookie: "wasm_oj_session=session-token" } },
    ), {
      DB: { prepare } as unknown as D1Database,
      ENVIRONMENT: "development",
      PUBLIC_ORIGIN: "https://wasm-oj.test",
    } as WasmOjWorkerEnv, COLLECTION_ID);
    expect(await response.json()).toEqual({ collection: {
      id: COLLECTION_ID,
      github_repository_id: 42,
      index_path: "collection-v2/index.json",
      created_at: "2026-08-13T00:00:00.000Z",
      updated_at: "2026-08-13T00:00:00.000Z",
      owner_login: "wasm-oj",
      name: "official-problems",
    } });
  });
});
