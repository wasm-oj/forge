import { describe, expect, it, vi } from "vitest";
import type { WasmOjWorkerEnv } from "./env";
import { problemPerformance } from "./product";

const PROBLEM_ID = "11111111-1111-4111-8111-111111111111";
const CONTEST_ID = "22222222-2222-4222-8222-222222222222";
const USER_ID = "33333333-3333-4333-8333-333333333333";
const SUBMISSION_ID = "44444444-4444-4444-8444-444444444444";

function environment(input: {
  readonly authenticated?: boolean;
  readonly organizer?: boolean;
  readonly invite?: boolean;
  readonly pinned?: boolean;
  readonly participant?: boolean;
  readonly startsAt?: string;
} = {}): { readonly env: WasmOjWorkerEnv; readonly sql: readonly string[] } {
  const preparedSql: string[] = [];
  const prepare = vi.fn((sql: string) => {
    preparedSql.push(sql);
    return { bind: () => ({
      first: async () => {
        if (sql.includes("FROM sessions JOIN users")) return input.authenticated ? {
          user_id: USER_ID,
          expires_at: "2999-01-01T00:00:00.000Z",
          csrf_hash: "unused",
          login: "ada",
          avatar_url: "https://example.test/avatar.png",
        } : null;
        if (sql.includes("FROM problem_series AS problems JOIN catalogs")) return {
          problem_id: PROBLEM_ID,
          catalog_id: "catalog",
          commit_sha: "a".repeat(40),
          slug: "sum-two",
          ordinal: 1,
          title_json: JSON.stringify({ "zh-TW": "加總", en: "Sum" }),
          summary_json: JSON.stringify({ "zh-TW": "摘要", en: "Summary" }),
          practice_enabled: 1,
          allowed_profiles_json: JSON.stringify({ rust: { target: "wasip1", optimization: "release" } }),
          judge_digest: "b".repeat(64),
          practice_bundle_bytes: 100,
          practice_bundle_sha256: "c".repeat(64),
          contest_bundle_bytes: 100,
          contest_bundle_sha256: "d".repeat(64),
        };
        if (sql.includes("FROM contest_series AS contests JOIN catalogs")) return input.pinned === false ? null : {
          organizer_user_id: input.organizer ? USER_ID : "55555555-5555-4555-8555-555555555555",
          access_mode: input.invite ? "invite" : "public",
          status: "published",
          freeze_at: "2020-01-01T00:00:00.000Z",
          starts_at: input.startsAt ?? "2020-01-01T00:00:00.000Z",
          ends_at: "2999-01-01T00:00:00.000Z",
        };
        if (sql.includes("SELECT 1 FROM contest_participants")) return input.participant ? { allowed: 1 } : null;
        throw new Error(`Unexpected first query: ${sql}`);
      },
      all: async () => {
        if (sql.includes("SELECT role FROM user_roles")) return { results: [] };
        if (sql.includes("WITH candidates AS")) return { results: [{
          user_id: USER_ID,
          submission_id: SUBMISSION_ID,
          language: "rust",
          score: 100,
          fully_passed_cases: 10,
          deterministic_cost: 123,
          peak_memory_bytes: 4_096,
          achieved_at: "2020-01-01T00:00:00.000Z",
          is_pareto: 1,
        }] };
        if (sql.includes("WITH resolved AS")) return { results: [{
          submission_id: SUBMISSION_ID,
          attempt_number: 1,
          language: "rust",
          state: "completed",
          verdict: "accepted",
          score: 100,
          fully_passed_cases: 10,
          deterministic_cost: 123,
          peak_memory_bytes: 4_096,
          created_at: "2020-01-01T00:00:00.000Z",
          completed_at: "2020-01-01T00:00:00.000Z",
          policy_summary_available: 1,
        }] };
        if (sql.includes("FROM users")) return { results: [{
          user_id: USER_ID,
          status: "active",
          display_name: "Ada",
          visibility: "public",
          login: "ada",
          avatar_url: "https://example.test/avatar.png",
        }] };
        throw new Error(`Unexpected all query: ${sql}`);
      },
    }) };
  });
  return {
    env: {
      DB: { prepare } as unknown as D1Database,
      ACCOUNT_ERASURE_HMAC_SECRET: "a".repeat(64),
    } as WasmOjWorkerEnv,
    sql: preparedSql,
  };
}

describe("performance API contest context", () => {
  it("freezes only the public frontier and does not return anonymous evolution", async () => {
    const fixture = environment();
    const response = await problemPerformance(
      new Request(`https://wasm-oj.test/api/problems/${PROBLEM_ID}/performance?contestId=${CONTEST_ID}`),
      fixture.env,
      PROBLEM_ID,
    );
    const body = await response.json() as Record<string, unknown>;
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("vary")).toBe("Cookie");
    expect(body).toMatchObject({
      context: { problemId: PROBLEM_ID, contestId: CONTEST_ID, frozen: true, selectedLanguage: null, myEvolutionTruncated: false },
      myEvolution: null,
      frontier: [{ submissionId: SUBMISSION_ID, isPareto: true, participant: { kind: "profile", login: "ada" } }],
    });
    expect(fixture.sql.find((sql) => sql.includes("WITH candidates AS"))).toContain("origin.origin_submitted_at<=?");
    expect(JSON.stringify(body)).not.toContain(USER_ID);
  });

  it("does not freeze the organizer and keeps their complete personal evolution", async () => {
    const fixture = environment({ authenticated: true, organizer: true });
    const response = await problemPerformance(
      new Request(`https://wasm-oj.test/api/problems/${PROBLEM_ID}/performance?contestId=${CONTEST_ID}`, {
        headers: { cookie: "wasm_oj_session=owner-session" },
      }),
      fixture.env,
      PROBLEM_ID,
    );
    const body = await response.json() as Record<string, unknown>;
    expect(body).toMatchObject({
      context: { frozen: false },
      myEvolution: [{ submissionId: SUBMISSION_ID, attemptNumber: 1, policySummaryAvailable: true }],
    });
    expect(fixture.sql.find((sql) => sql.includes("WITH candidates AS"))).not.toContain("origin.completed_at<=?");
  });

  it("fails closed for an unpinned problem or an inaccessible invite contest", async () => {
    const unpinned = environment({ pinned: false });
    await expect(problemPerformance(
      new Request(`https://wasm-oj.test/api/problems/${PROBLEM_ID}/performance?contestId=${CONTEST_ID}`),
      unpinned.env,
      PROBLEM_ID,
    )).rejects.toMatchObject({ status: 404, code: "problem-not-found" });

    const invite = environment({ invite: true });
    await expect(problemPerformance(
      new Request(`https://wasm-oj.test/api/problems/${PROBLEM_ID}/performance?contestId=${CONTEST_ID}`),
      invite.env,
      PROBLEM_ID,
    )).rejects.toMatchObject({ status: 404, code: "problem-not-found" });
  });

  it("allows an authenticated invite participant but hides the inventory before start", async () => {
    const participant = environment({ authenticated: true, invite: true, participant: true });
    await expect(problemPerformance(
      new Request(`https://wasm-oj.test/api/problems/${PROBLEM_ID}/performance?contestId=${CONTEST_ID}`, {
        headers: { cookie: "wasm_oj_session=participant-session" },
      }),
      participant.env,
      PROBLEM_ID,
    )).resolves.toBeInstanceOf(Response);

    const upcoming = environment({ authenticated: true, participant: true, startsAt: "2998-01-01T00:00:00.000Z" });
    await expect(problemPerformance(
      new Request(`https://wasm-oj.test/api/problems/${PROBLEM_ID}/performance?contestId=${CONTEST_ID}`, {
        headers: { cookie: "wasm_oj_session=participant-session" },
      }),
      upcoming.env,
      PROBLEM_ID,
    )).rejects.toMatchObject({ status: 404, code: "problem-not-found" });
  });

  it("rejects a language outside the pinned problem profiles", async () => {
    const fixture = environment();
    await expect(problemPerformance(
      new Request(`https://wasm-oj.test/api/problems/${PROBLEM_ID}/performance?contestId=${CONTEST_ID}&language=go`),
      fixture.env,
      PROBLEM_ID,
    )).rejects.toMatchObject({ status: 400, code: "performance-language-invalid" });
  });
});
