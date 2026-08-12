import { describe, expect, it, vi } from "vitest";
import type { WasmOjWorkerEnv } from "./env";
import { ApiError } from "./http";
import { managedProblemProjection } from "./product";

const PROBLEM_VERSION_ID = "11111111-1111-4111-8111-111111111111";
const SERIES_ID = "22222222-2222-4222-8222-222222222222";
const PUBLICATION_ID = "33333333-3333-4333-8333-333333333333";
const CONTEST_ID = "44444444-4444-4444-8444-444444444444";

function metadata(mode: "official-practice" | "contest") {
  return {
    id: PROBLEM_VERSION_ID,
    problem_series_id: SERIES_ID,
    catalog_publication_id: PUBLICATION_ID,
    mode,
    problem_slug: "two-sum",
    problem_number: 1,
    title_json: JSON.stringify({ "zh-TW": "兩數和", en: "Two Sum" }),
    difficulty: "easy",
    tags_json: JSON.stringify(["arrays"]),
    track_id: "foundations",
    track_json: JSON.stringify({ "zh-TW": "基礎", en: "Foundations" }),
    allowed_profiles_json: JSON.stringify({ c: { target: "wasip1", optimization: "release" } }),
    maximum_score: 100,
    execution_semantic_sha256: "a".repeat(64),
    practice_bundle_bytes: 1_024,
    practice_bundle_sha256: "b".repeat(64),
    contest_public_bytes: 512,
    contest_public_sha256: "c".repeat(64),
  };
}

interface ProjectionEnvironmentOptions {
  readonly mode: "official-practice" | "contest";
  readonly exists?: boolean;
  readonly contest?: {
    readonly accessMode?: "public" | "invite";
    readonly status?: "draft" | "published";
    readonly startsAt?: string;
  };
}

function projectionEnvironment(options: ProjectionEnvironmentOptions): WasmOjWorkerEnv {
  const prepare = vi.fn((sql: string) => ({
    bind: () => ({
      first: async () => {
        if (sql.includes("FROM official_practice_heads AS heads")) {
          return options.mode === "official-practice" && options.exists !== false
            ? metadata("official-practice")
            : null;
        }
        if (sql.includes("FROM contest_problems")) {
          if (options.mode !== "contest" || options.exists === false) return null;
          return {
            ...metadata("contest"),
            access_mode: options.contest?.accessMode ?? "public",
            contest_status: options.contest?.status ?? "published",
            organizer_user_id: "55555555-5555-4555-8555-555555555555",
            starts_at: options.contest?.startsAt ?? "2020-01-01T00:00:00.000Z",
            participant_user_id: null,
          };
        }
        throw new Error(`Unexpected query: ${sql}`);
      },
    }),
  }));
  return { DB: { prepare } as unknown as D1Database } as WasmOjWorkerEnv;
}

describe("managed problem metadata access", () => {
  it("returns an active practice exact-content pointer without reading R2", async () => {
    const response = await managedProblemProjection(
      new Request(`https://wasm-oj.test/api/problems/${PROBLEM_VERSION_ID}`),
      projectionEnvironment({ mode: "official-practice" }),
      PROBLEM_VERSION_ID,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("public, max-age=300");
    expect(await response.json()).toMatchObject({
      schema: "wasm-oj-platform/problem-content-pointer/v2",
      problemVersionId: PROBLEM_VERSION_ID,
      problemSeriesId: SERIES_ID,
      catalogPublicationId: PUBLICATION_ID,
      mode: "official-practice",
      executionSemanticDigest: "a".repeat(64),
      content: {
        role: "practice",
        bytes: 1_024,
        sha256: "b".repeat(64),
        url: `/api/problems/${PROBLEM_VERSION_ID}/content?role=practice`,
      },
    });
  });

  it("returns only the redacted contest-public pointer for an explicit started contest", async () => {
    const response = await managedProblemProjection(
      new Request(`https://wasm-oj.test/api/problems/${PROBLEM_VERSION_ID}?contestId=${CONTEST_ID}`),
      projectionEnvironment({ mode: "contest" }),
      PROBLEM_VERSION_ID,
    );
    expect(await response.json()).toMatchObject({
      mode: "contest",
      content: {
        role: "contest-public",
        bytes: 512,
        sha256: "c".repeat(64),
        url: `/api/problems/${PROBLEM_VERSION_ID}/content?role=contest-public&contestId=${CONTEST_ID}`,
      },
    });
  });

  it("rejects missing active heads, malformed contexts, pre-start, draft, and invite-only access", async () => {
    const cases = [
      {
        request: new Request(`https://wasm-oj.test/api/problems/${PROBLEM_VERSION_ID}`),
        env: projectionEnvironment({ mode: "official-practice", exists: false }),
      },
      {
        request: new Request(`https://wasm-oj.test/api/problems/${PROBLEM_VERSION_ID}?contestId=wrong`),
        env: projectionEnvironment({ mode: "contest" }),
      },
      {
        request: new Request(`https://wasm-oj.test/api/problems/${PROBLEM_VERSION_ID}?contestId=${CONTEST_ID}`),
        env: projectionEnvironment({ mode: "contest", exists: false }),
      },
      {
        request: new Request(`https://wasm-oj.test/api/problems/${PROBLEM_VERSION_ID}?contestId=${CONTEST_ID}`),
        env: projectionEnvironment({ mode: "contest", contest: { startsAt: "2099-01-01T00:00:00.000Z" } }),
      },
      {
        request: new Request(`https://wasm-oj.test/api/problems/${PROBLEM_VERSION_ID}?contestId=${CONTEST_ID}`),
        env: projectionEnvironment({ mode: "contest", contest: { status: "draft" } }),
      },
      {
        request: new Request(`https://wasm-oj.test/api/problems/${PROBLEM_VERSION_ID}?contestId=${CONTEST_ID}`),
        env: projectionEnvironment({ mode: "contest", contest: { accessMode: "invite" } }),
      },
    ];
    for (const testCase of cases) {
      await expect(managedProblemProjection(testCase.request, testCase.env, PROBLEM_VERSION_ID))
        .rejects.toMatchObject({ status: 404, code: "problem-not-found" } satisfies Partial<ApiError>);
    }
  });
});
