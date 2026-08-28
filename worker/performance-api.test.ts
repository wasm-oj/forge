import { describe, expect, it, vi } from "vitest";
import type { WasmOjWorkerEnv } from "./env";

const PROBLEM_ID = "11111111-1111-4111-8111-111111111111";
const CONTEST_ID = "22222222-2222-4222-8222-222222222222";
const USER_ID = "33333333-3333-4333-8333-333333333333";
const SUBMISSION_ID = "44444444-4444-4444-8444-444444444444";

interface FixtureOptions {
  readonly organizer?: boolean;
  readonly pinned?: boolean;
  readonly participant?: boolean;
  readonly availability?: "locked" | "open" | "closed";
  readonly leaderboard?: "freeze" | "hidden-until-end" | "live";
  readonly clockKind?: "global" | "individual";
  readonly runtimeState?: "running" | "ended";
  readonly entrantPhase?: "running" | "ended";
}

const runtimeOptions = vi.hoisted(() => new WeakMap<object, FixtureOptions>());

vi.mock("./contest-runtime", () => ({
  loadContestRuntimeSnapshot: vi.fn(async (env: object) => {
    const input = runtimeOptions.get(env) ?? {};
    const availability = input.availability ?? "open";
    const leaderboard = input.leaderboard ?? "freeze";
    return {
      contestId: CONTEST_ID,
      rulesCommit: "a".repeat(40),
      rulesDigest: "b".repeat(64),
      rules: {
        clock: input.clockKind === "individual" ? {
          kind: "individual",
          enrollmentOpensAt: "2020-01-01T00:00:00.000Z",
          enrollmentClosesAt: "2999-01-01T00:00:00.000Z",
          durationSeconds: 3_600,
        } : {
          kind: "global",
          registrationOpensAt: "2020-01-01T00:00:00.000Z",
          registrationClosesAt: "2999-01-01T00:00:00.000Z",
          startsAt: "2020-01-01T00:00:00.000Z",
          durationSeconds: 3_600,
        },
        officialTrack: { kind: "code", aiAssist: "disabled" },
        evidenceAt: "input-admitted",
        problems: [{
          slug: "sum-two", batch: 1, releaseAfterSeconds: 0,
          submissionClosesAfterSeconds: 3_600, points: 100, attemptLimit: 3,
        }],
        scoring: { kind: "score", tieBreaks: ["final-best-achieved-at"] },
        checkpoints: [],
        leaderboard: leaderboard === "freeze"
          ? { kind: "freeze", atSeconds: 600 }
          : { kind: leaderboard },
      },
      state: input.runtimeState ?? "running",
      pausedFromState: null,
      scheduleShiftSeconds: 0,
      pauseReason: null,
      clock: {
        generation: 2,
        state: "running",
        logicalSeconds: 1_200,
        capturedAt: "2020-01-01T00:00:00.000Z",
      },
      epochs: { timelineGeneration: 2, ruleEpoch: 4 },
      entrant: input.participant === false ? null : {
        entrantId: "55555555-5555-4555-8555-555555555555",
        joined: true,
        started: true,
        state: "active",
        eliminatedAtSeconds: null,
      },
      problems: [{
        problemId: PROBLEM_ID,
        problemSlug: "sum-two",
        problemEpoch: 7,
        contentEpoch: 5,
        contentCommit: "a".repeat(40),
        judgeEpoch: 3,
        judgeDigest: "b".repeat(64),
        timelineGeneration: 2,
        ruleEpoch: 4,
      }],
      projection: {
        generation: 2,
        phase: input.entrantPhase ?? "running",
        logicalSeconds: 1_200,
        nextBoundarySeconds: 3_600,
        problems: [{
          slug: "sum-two", availability, releaseAfterSeconds: 0,
          submissionClosesAfterSeconds: 3_600, attemptsRemaining: 3,
        }],
      },
      publicRepositoryTimingWarning: true,
    };
  }),
}));

const { problemPerformance } = await import("./product");

function problemRow(input: FixtureOptions): Record<string, unknown> {
  return {
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
    organizer_user_id: input.organizer ? USER_ID : "66666666-6666-4666-8666-666666666666",
    contest_status: "published",
    access_mode: "public",
    content_epoch: 5,
  };
}

function environment(input: FixtureOptions = {}): { readonly env: WasmOjWorkerEnv; readonly sql: readonly string[] } {
  const preparedSql: string[] = [];
  const prepare = vi.fn((sql: string) => {
    preparedSql.push(sql);
    return { bind: () => ({
      first: async () => {
        if (sql.includes("FROM sessions JOIN users")) return {
          user_id: USER_ID,
          expires_at: "2999-01-01T00:00:00.000Z",
          csrf_hash: "unused",
          login: "ada",
          avatar_url: "https://example.test/avatar.png",
        };
        if (sql.includes("FROM contest_series AS contests") && sql.includes("contest_problem_epochs")) {
          return input.pinned === false ? null : problemRow(input);
        }
        if (sql.includes("SELECT 1 FROM contest_reveal_grants")) return { allowed: 1 };
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
          achieved_at: "2020-01-01T00:10:00.000Z",
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
          created_at: "2020-01-01T00:10:00.000Z",
          completed_at: "2020-01-01T00:10:01.000Z",
          policy_summary_available: 1,
          eligibility: "eligible",
          invalidation_reason: null,
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
      run: async () => ({ meta: { changes: 1 } }),
    }) };
  });
  const env = {
    DB: { prepare } as unknown as D1Database,
    ACCOUNT_ERASURE_HMAC_SECRET: "a".repeat(64),
  } as WasmOjWorkerEnv;
  runtimeOptions.set(env, input);
  return { env, sql: preparedSql };
}

function request(): Request {
  return new Request(`https://wasm-oj.test/api/problems/${PROBLEM_ID}/performance?contestId=${CONTEST_ID}`, {
    headers: { cookie: "wasm_oj_session=participant-session" },
  });
}

describe("performance API contest v2 context", () => {
  it("uses logical evidence cutoff for the frozen frontier while retaining personal history", async () => {
    const fixture = environment();
    const response = await problemPerformance(request(), fixture.env, PROBLEM_ID);
    const body = await response.json() as Record<string, unknown>;
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(body).toMatchObject({
      context: { contestId: CONTEST_ID, frozen: true, hidden: false },
      myEvolution: [{ submissionId: SUBMISSION_ID, eligible: true }],
      frontier: [{ submissionId: SUBMISSION_ID, participant: { kind: "profile", login: "ada" } }],
    });
    expect(fixture.sql.find((sql) => sql.includes("WITH candidates AS")))
      .toContain("contest_record.evidence_logical_seconds<=?");
    expect(JSON.stringify(body)).not.toContain(USER_ID);
  });

  it("does not freeze Organizer preview", async () => {
    const fixture = environment({ organizer: true });
    const body = await (await problemPerformance(request(), fixture.env, PROBLEM_ID)).json() as Record<string, unknown>;
    expect(body).toMatchObject({ context: { frozen: false, hidden: false } });
    expect(fixture.sql.find((sql) => sql.includes("WITH candidates AS")))
      .not.toContain("contest_record.evidence_logical_seconds<=?");
  });

  it("fails closed for an unpinned, unjoined, or unrevealed contest problem", async () => {
    for (const options of [{ pinned: false }, { participant: false }, { availability: "locked" as const }]) {
      const fixture = environment(options);
      await expect(problemPerformance(request(), fixture.env, PROBLEM_ID))
        .rejects.toMatchObject({ status: 404, code: "problem-not-found" });
    }
  });

  it("hides the shared frontier but retains the entrant's own history", async () => {
    const fixture = environment({ leaderboard: "hidden-until-end" });
    const body = await (await problemPerformance(request(), fixture.env, PROBLEM_ID)).json() as Record<string, unknown>;
    expect(body).toMatchObject({ context: { hidden: true }, frontier: [], myEvolution: [{ submissionId: SUBMISSION_ID }] });
    expect(fixture.sql.some((sql) => sql.includes("WITH candidates AS"))).toBe(false);
  });

  it("does not reveal hidden shared performance when only an individual entrant has ended", async () => {
    const fixture = environment({
      clockKind: "individual",
      leaderboard: "hidden-until-end",
      entrantPhase: "ended",
      runtimeState: "running",
    });
    const body = await (await problemPerformance(request(), fixture.env, PROBLEM_ID)).json() as Record<string, unknown>;
    expect(body).toMatchObject({
      context: { hidden: true },
      frontier: [],
      myEvolution: [{ submissionId: SUBMISSION_ID }],
    });
    expect(fixture.sql.some((sql) => sql.includes("WITH candidates AS"))).toBe(false);
  });

  it("fences the public frontier against every unsettled contest judge rollout member", async () => {
    const fixture = environment({ leaderboard: "live" });
    await problemPerformance(request(), fixture.env, PROBLEM_ID);
    const frontierSql = fixture.sql.find((sql) => sql.includes("WITH candidates AS"));
    expect(frontierSql).toContain("rollout_epoch.judge_epoch=contest_record.judge_epoch");
    expect(frontierSql).toContain("rollout.state<>'effective'");
    expect(frontierSql).toContain("prompt_membership.prompt_attempt_id=contest_record.prompt_attempt_id");
    expect(frontierSql).toContain("prompt_membership.state IN ('included','promoted')");
    expect(frontierSql).toContain("prompt_rollout.state<>'effective'");
  });

  it("rejects a language outside the pinned content epoch profiles", async () => {
    const fixture = environment();
    const invalid = new Request(`${request().url}&language=go`, { headers: request().headers });
    await expect(problemPerformance(invalid, fixture.env, PROBLEM_ID))
      .rejects.toMatchObject({ status: 400, code: "performance-language-invalid" });
  });
});
