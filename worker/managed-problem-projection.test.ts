import { describe, expect, it, vi } from "vitest";
import { canonicalJsonBytes } from "../src/core/canonical-json";
import { PROBLEMS } from "../src/judge/problems";
import type { ForgeWorkerEnv } from "./env";
import { ApiError } from "./http";
import { managedProblemProjection } from "./product";
import { sha256Hex } from "./crypto";

const PROBLEM_VERSION_ID = "11111111-1111-4111-8111-111111111111";
const CONTEST_ID = "22222222-2222-4222-8222-222222222222";
const BUNDLE_DIGEST = "a".repeat(64);
const problem = PROBLEMS[0]!;
const contestProblem = {
  ...problem,
  editorial: { "zh-TW": "", en: "" },
  judgeCases: problem.judgeCases.filter((testCase) => testCase.kind === "sample"),
};

interface ProjectionEnvironmentOptions {
  readonly mode: "official-practice" | "contest";
  readonly projection: unknown;
  readonly contest?: {
    readonly accessMode: "public" | "invite";
    readonly exists?: boolean;
    readonly status?: "draft" | "published";
  };
}

async function projectionEnvironment(options: ProjectionEnvironmentOptions) {
  const bytes = canonicalJsonBytes(options.projection);
  const objectDigest = await sha256Hex(bytes);
  const objectKey = `snapshots/objects/${objectDigest}`;
  const get = vi.fn(async (key: string) => key === objectKey ? {
    size: bytes.byteLength,
    customMetadata: { sha256: objectDigest },
    async arrayBuffer() { return bytes.slice().buffer; },
  } : null);
  const prepare = vi.fn((sql: string) => ({
    bind: () => ({
      first: async () => {
        if (sql.includes("FROM managed_problem_versions JOIN managed_snapshots")) return {
          public_projection_r2_key: objectKey,
          bundle_digest: BUNDLE_DIGEST,
          mode: options.mode,
          status: "published",
        };
        if (sql.includes("FROM contests JOIN contest_problems")) {
          if (options.contest?.exists === false) return null;
          return {
            access_mode: options.contest?.accessMode ?? "public",
            status: options.contest?.status ?? "published",
            organizer_user_id: "33333333-3333-4333-8333-333333333333",
            starts_at: "2020-01-01T00:00:00.000Z",
            user_id: null,
          };
        }
        throw new Error(`Unexpected first query: ${sql}`);
      },
    }),
  }));
  return {
    env: {
      CORE_DB: { prepare },
      JUDGE_BUCKET: { get },
      JUDGE_MIRROR_BUCKET: { get },
    } as unknown as ForgeWorkerEnv,
    get,
  };
}

describe("managed public problem projection access", () => {
  it("serves published official practice anonymously", async () => {
    const { env } = await projectionEnvironment({
      mode: "official-practice",
      projection: {
        schema: "forge-practice-problem-projection-v1",
        problem,
        digest: BUNDLE_DIGEST,
      },
    });
    const response = await managedProblemProjection(
      new Request(`https://forge.test/api/problems/${PROBLEM_VERSION_ID}`),
      env,
      PROBLEM_VERSION_ID,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("public, max-age=300");
  });

  it("serves a started public contest anonymously without projecting hidden data", async () => {
    const { env } = await projectionEnvironment({
      mode: "contest",
      contest: { accessMode: "public" },
      projection: {
        schema: "forge-contest-public-problem-projection-v1",
        problem: contestProblem,
        digest: BUNDLE_DIGEST,
      },
    });
    const response = await managedProblemProjection(
      new Request(`https://forge.test/api/problems/${PROBLEM_VERSION_ID}?contestId=${CONTEST_ID}`),
      env,
      PROBLEM_VERSION_ID,
    );
    const value = await response.json() as { problem: typeof contestProblem };
    expect(response.status).toBe(200);
    expect(value.problem.editorial).toEqual({ "zh-TW": "", en: "" });
    expect(value.problem.judgeCases.every((testCase) => testCase.kind === "sample")).toBe(true);
  });

  it("rejects missing, malformed, unassociated, draft, and invite-only contest contexts before R2", async () => {
    for (const testCase of [
      { query: "", contest: { accessMode: "public" as const } },
      { query: "?contestId=wrong", contest: { accessMode: "public" as const } },
      { query: `?contestId=${CONTEST_ID}`, contest: { accessMode: "public" as const, exists: false } },
      { query: `?contestId=${CONTEST_ID}`, contest: { accessMode: "public" as const, status: "draft" as const } },
      { query: `?contestId=${CONTEST_ID}`, contest: { accessMode: "invite" as const } },
    ]) {
      const { env, get } = await projectionEnvironment({
        mode: "contest",
        contest: testCase.contest,
        projection: {
          schema: "forge-contest-public-problem-projection-v1",
          problem: contestProblem,
          digest: BUNDLE_DIGEST,
        },
      });
      await expect(managedProblemProjection(
        new Request(`https://forge.test/api/problems/${PROBLEM_VERSION_ID}${testCase.query}`),
        env,
        PROBLEM_VERSION_ID,
      )).rejects.toMatchObject({ status: 404, code: "managed-problem-not-found" } satisfies Partial<ApiError>);
      expect(get).not.toHaveBeenCalled();
    }
  });

  it("rejects semantic-role mismatches and hidden contest cases", async () => {
    for (const projection of [
      {
        schema: "forge-practice-problem-projection-v1",
        problem,
        digest: BUNDLE_DIGEST,
      },
      {
        schema: "forge-contest-public-problem-projection-v1",
        problem: {
          ...contestProblem,
          judgeCases: [...contestProblem.judgeCases, {
            id: "hidden-sentinel",
            kind: "adversarial",
            input: "FORGE_HIDDEN_SENTINEL",
            output: "FORGE_HIDDEN_EXPECTED_SENTINEL",
          }],
        },
        digest: BUNDLE_DIGEST,
      },
    ]) {
      const { env } = await projectionEnvironment({
        mode: "contest",
        contest: { accessMode: "public" },
        projection,
      });
      await expect(managedProblemProjection(
        new Request(`https://forge.test/api/problems/${PROBLEM_VERSION_ID}?contestId=${CONTEST_ID}`),
        env,
        PROBLEM_VERSION_ID,
      )).rejects.toMatchObject({ status: 500, code: "managed-projection-role" } satisfies Partial<ApiError>);
    }
  });
});
