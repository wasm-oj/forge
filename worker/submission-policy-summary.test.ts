import { describe, expect, it, vi } from "vitest";
import type { WasmOjWorkerEnv } from "./env";
import { getSubmissionPolicySummary, parseSubmissionPolicySummary } from "./submissions";

const SUBMISSION_ID = "11111111-1111-4111-8111-111111111111";
const USER_ID = "22222222-2222-4222-8222-222222222222";

const summary = {
  totalCases: 10,
  outputAcceptedCases: 8,
  policies: [
    { id: "baseline", earnedCases: 6, costExceededCases: 1, memoryExceededCases: 2, logicalTimeExceededCases: 0 },
    { id: "efficient", earnedCases: 4, costExceededCases: 3, memoryExceededCases: 2, logicalTimeExceededCases: 1 },
    { id: "optimal", earnedCases: 3, costExceededCases: 5, memoryExceededCases: 4, logicalTimeExceededCases: 2 },
  ],
};

function environment(input: {
  readonly visibility: "private" | "public";
  readonly state?: string;
  readonly authenticated?: boolean;
  readonly stored?: string | null;
  readonly requestedIsChild?: boolean;
  readonly contestEndsAt?: string;
}): WasmOjWorkerEnv {
  const prepare = vi.fn((sql: string) => ({
    bind: () => ({
      first: async () => {
        if (sql.includes("FROM sessions JOIN users")) return input.authenticated ? {
          user_id: USER_ID,
          expires_at: "2999-01-01T00:00:00.000Z",
          csrf_hash: "unused",
          login: "ada",
          avatar_url: "https://example.test/avatar.png",
        } : null;
        if (sql.includes("FROM submissions AS requested")) return {
          user_id: USER_ID,
          visibility: input.visibility,
          state: input.state ?? "completed",
          policy_summary_json: input.stored === undefined ? JSON.stringify(summary) : input.stored,
          contest_id: input.contestEndsAt ? "33333333-3333-4333-8333-333333333333" : null,
          contest_ends_at: input.contestEndsAt ?? null,
        };
        throw new Error(`Unexpected first query: ${sql}`);
      },
      all: async () => {
        if (sql.includes("SELECT role FROM user_roles")) return { results: [] };
        throw new Error(`Unexpected all query: ${sql}`);
      },
    }),
  }));
  return { DB: { prepare } as unknown as D1Database } as WasmOjWorkerEnv;
}

describe("submission policy summary parser", () => {
  it("accepts overlapping bounded failure counts in the fixed policy order", () => {
    expect(parseSubmissionPolicySummary(JSON.stringify(summary))).toEqual(summary);
  });

  it("rejects reordered levels, unknown fields, and counts beyond total cases", () => {
    expect(() => parseSubmissionPolicySummary(JSON.stringify({
      ...summary,
      policies: [summary.policies[1], summary.policies[0], summary.policies[2]],
    }))).toThrow("order");
    expect(() => parseSubmissionPolicySummary(JSON.stringify({ ...summary, hiddenCaseId: "secret" }))).toThrow("invalid");
    expect(() => parseSubmissionPolicySummary(JSON.stringify({
      ...summary,
      policies: [{ ...summary.policies[0], costExceededCases: 11 }, ...summary.policies.slice(1)],
    }))).toThrow("cost-exceeded");
  });
});

describe("policy summary authorization", () => {
  it("allows a public completed submission without exposing stored implementation fields", async () => {
    const response = await getSubmissionPolicySummary(
      new Request(`https://wasm-oj.test/api/submissions/${SUBMISSION_ID}/policy-summary`),
      environment({ visibility: "public" }),
      SUBMISSION_ID,
    );
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(await response.json()).toEqual({ submissionId: SUBMISSION_ID, policySummary: summary });
  });

  it("hides a private submission from anonymous viewers", async () => {
    await expect(getSubmissionPolicySummary(
      new Request(`https://wasm-oj.test/api/submissions/${SUBMISSION_ID}/policy-summary`),
      environment({ visibility: "private" }),
      SUBMISSION_ID,
    )).rejects.toMatchObject({ status: 404, code: "submission-not-found" });
  });

  it("allows the owner but returns a conflict when no completed summary exists", async () => {
    const request = new Request(`https://wasm-oj.test/api/submissions/${SUBMISSION_ID}/policy-summary`, {
      headers: { cookie: "wasm_oj_session=owner-session" },
    });
    await expect(getSubmissionPolicySummary(
      request,
      environment({ visibility: "private", authenticated: true, state: "compile-error", stored: null }),
      SUBMISSION_ID,
    )).rejects.toMatchObject({ status: 409, code: "policy-summary-unavailable" });
  });

  it("resolves an effective child selection through its canonical origin visibility", async () => {
    const response = await getSubmissionPolicySummary(
      new Request(`https://wasm-oj.test/api/submissions/${SUBMISSION_ID}/policy-summary`),
      environment({ visibility: "public", requestedIsChild: true }),
      SUBMISSION_ID,
    );
    expect(await response.json()).toEqual({ submissionId: SUBMISSION_ID, policySummary: summary });
  });

  it("keeps even a public policy summary embargoed until its contest ends", async () => {
    await expect(getSubmissionPolicySummary(
      new Request(`https://wasm-oj.test/api/submissions/${SUBMISSION_ID}/policy-summary`),
      environment({ visibility: "public", contestEndsAt: "2999-01-01T00:00:00.000Z" }),
      SUBMISSION_ID,
    )).rejects.toMatchObject({ status: 404, code: "submission-not-found" });
  });
});
