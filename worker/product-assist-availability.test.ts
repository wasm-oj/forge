import { describe, expect, it, vi } from "vitest";
import type { WasmOjWorkerEnv } from "./env";

vi.mock("./contest-runtime", () => ({ loadContestRuntimeSnapshot: vi.fn() }));
vi.mock("./leaderboards", () => ({ queryContestLeaderboard: vi.fn(), queryProblemLeaderboard: vi.fn() }));
vi.mock("./performance", () => ({ queryPerformanceEvolution: vi.fn(), queryPerformanceFrontier: vi.fn() }));

const { managedProblemProjection } = await import("./product");

const PROBLEM_ID = "11111111-1111-4111-8111-111111111111";

describe("production Prompt Assist availability", () => {
  it("projects an empty host registry as unavailable and withholds an actionable context", async () => {
    const prepare = vi.fn(() => ({
      bind: () => ({
        first: async () => ({
          problem_id: PROBLEM_ID,
          catalog_id: "22222222-2222-4222-8222-222222222222",
          commit_sha: "a".repeat(40),
          slug: "sum",
          ordinal: 1,
          title_json: JSON.stringify({ "zh-TW": "加總", en: "Sum" }),
          summary_json: JSON.stringify({ "zh-TW": "計算", en: "Compute" }),
          practice_enabled: 1,
          allowed_profiles_json: JSON.stringify({ c: { target: "wasip1", optimization: "release" } }),
          judge_digest: "b".repeat(64),
          practice_bundle_bytes: 100,
          practice_bundle_sha256: "c".repeat(64),
          contest_bundle_bytes: 80,
          contest_bundle_sha256: "d".repeat(64),
        }),
      }),
    }));
    const env = { DB: { prepare } as unknown as D1Database } as WasmOjWorkerEnv;

    const response = await managedProblemProjection(
      new Request(`https://wasm-oj.test/api/problems/${PROBLEM_ID}`),
      env,
      PROBLEM_ID,
    );

    expect(await response.json()).toMatchObject({
      aiAssistAvailable: false,
      assistContextSha256: null,
      content: { role: "practice", sha256: "c".repeat(64) },
    });
  });
});
