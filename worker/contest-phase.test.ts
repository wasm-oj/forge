import { describe, expect, it, vi } from "vitest";
import type { WasmOjWorkerEnv } from "./env";
import { contestPhase } from "./product";
import { managedMatch } from "./submissions";

const NOW = new Date("2026-08-11T12:00:00.000Z");

describe("contest phase", () => {
  it("derives upcoming, running, and ended from the schedule", () => {
    expect(contestPhase("2026-08-11T12:00:01.000Z", "2026-08-11T13:00:00.000Z", NOW)).toBe("upcoming");
    expect(contestPhase("2026-08-11T12:00:00.000Z", "2026-08-11T13:00:00.000Z", NOW)).toBe("running");
    expect(contestPhase("2026-08-11T11:00:00.000Z", "2026-08-11T12:00:00.000Z", NOW)).toBe("ended");
  });
});

describe("managed collection matching", () => {
  it("matches a published immutable collection without coupling it to the active release", async () => {
    const prepare = vi.fn((sql: string) => {
      expect(sql).toContain("catalog_publications");
      expect(sql).toContain("official_practice_heads");
      return {
        bind: (...values: unknown[]) => ({
          all: async () => {
            expect(values).toEqual(["wasm-oj", "official-problems", "a".repeat(64)]);
            return { results: [{
              publication_id: "11111111-1111-4111-8111-111111111111",
              problem_slug: "two-sum",
              problem_version_id: "22222222-2222-4222-8222-222222222222",
            }] };
          },
        }),
      };
    });
    const response = await managedMatch(new Request(`https://wasm-oj.test/api/collections/managed-match?repository=wasm-oj/official-problems&revision=${"a".repeat(64)}`), {
      DB: { prepare } as unknown as D1Database,
    } as WasmOjWorkerEnv);
    expect(await response.json()).toEqual({
      matched: true,
      publicationId: "11111111-1111-4111-8111-111111111111",
      problems: { "two-sum": "22222222-2222-4222-8222-222222222222" },
    });
  });
});
