import { describe, expect, it, vi } from "vitest";
import type { WasmOjWorkerEnv } from "./env";

const CONTEST_ID = "11111111-1111-4111-8111-111111111111";
const PROBLEM_ID = "22222222-2222-4222-8222-222222222222";
const USER_ID = "33333333-3333-4333-8333-333333333333";
const OTHER_USER_ID = "44444444-4444-4444-8444-444444444444";
const ENTRANT_ID = "55555555-5555-4555-8555-555555555555";
const CONTENT_COMMIT = "a".repeat(40);
const PROMPT_CONTEXT = "b".repeat(64);

interface FixtureOptions {
  readonly participant?: boolean;
  readonly organizer?: boolean;
  readonly availability?: "locked" | "open" | "closed";
  readonly leaderboard?: "live" | "freeze" | "hidden-until-end";
  readonly prompt?: boolean;
  readonly assistAllowed?: boolean;
  readonly eliminated?: boolean;
  readonly joinAdmissionMissing?: boolean;
  readonly checkpointRegistrationClosed?: boolean;
  readonly existingEntrant?: boolean;
  readonly clockKind?: "global" | "individual";
  readonly runtimeState?: "scheduled" | "running" | "ended";
  readonly entrantPhase?: "running" | "ended";
  readonly judgeRollout?: boolean;
}

const fixtures = vi.hoisted(() => ({
  options: new WeakMap<object, FixtureOptions>(),
  contestLeaderboard: vi.fn(),
}));

const session = {
  userId: USER_ID,
  login: "ada",
  avatarUrl: "https://example.test/ada.png",
  roles: ["organizer"] as const,
  method: "browser" as const,
  csrfHash: "unused",
};

vi.mock("./auth", () => ({
  authenticatedSession: vi.fn(async () => session),
  requireBrowserMutationSession: vi.fn(async () => session),
  requireBrowserOrBearerMutationSession: vi.fn(async () => session),
  requireSession: vi.fn(async () => session),
}));

vi.mock("./formal-access", () => ({ requireStagingFormalAccess: vi.fn(async () => undefined) }));
vi.mock("./formal-mutations", () => ({ requireFormalMutationsEnabled: vi.fn(async () => undefined) }));
vi.mock("./github", () => ({ requireOrganizer: vi.fn(async () => undefined) }));
vi.mock("./performance", () => ({
  queryPerformanceEvolution: vi.fn(async () => null),
  queryPerformanceFrontier: vi.fn(async () => []),
}));
vi.mock("./leaderboards", () => ({
  queryProblemLeaderboard: vi.fn(async () => []),
  queryContestLeaderboard: fixtures.contestLeaderboard,
}));
vi.mock("./prompt-compiler-registry", () => ({
  hostPromptCompilerRegistry: () => ({ isAvailable: () => false }),
  hostPromptAssistAvailable: () => true,
}));

vi.mock("./contest-runtime", () => ({
  loadContestRuntimeSnapshot: vi.fn(async (env: object) => {
    const input = fixtures.options.get(env) ?? {};
    const prompt = input.prompt === true;
    const availability = input.availability ?? "open";
    const leaderboard = input.leaderboard ?? "freeze";
    return {
      contestId: CONTEST_ID,
      rulesCommit: CONTENT_COMMIT,
      rulesDigest: "c".repeat(64),
      rules: {
        clock: input.clockKind === "individual" ? {
          kind: "individual",
          enrollmentOpensAt: "2020-01-01T00:00:00.000Z",
          enrollmentClosesAt: "2999-01-01T00:00:00.000Z",
          durationSeconds: 1_800,
        } : {
          kind: "global",
          registrationOpensAt: "2020-01-01T00:00:00.000Z",
          registrationClosesAt: "2999-01-01T00:00:00.000Z",
          startsAt: "2020-01-01T00:00:00.000Z",
          durationSeconds: 1_800,
        },
        officialTrack: prompt ? {
          kind: "prompt-program",
          compiler: { configId: "fake", configDigest: "d".repeat(64) },
          limits: { promptBytes: 16_384, inputTokens: 2_048, outputTokens: 2_048, generatedSourceBytes: 100_000, timeoutSeconds: 30 },
          attemptPolicy: { kind: "per-problem", maximumAttempts: 3 },
          disclosure: "private",
        } : { kind: "code", aiAssist: input.assistAllowed ? "allowed" : "disabled" },
        evidenceAt: prompt ? "generated-source-ready" : "input-admitted",
        problems: [{
          slug: "sum-two", batch: 1, releaseAfterSeconds: 0,
          submissionClosesAfterSeconds: 1_800, points: 100, attemptLimit: 3,
          ...(prompt ? { output: { language: "rust", target: "wasip1", optimization: "release", entry: "src/main.rs" } } : {}),
        }],
        scoring: { kind: "score", tieBreaks: ["final-best-achieved-at"] },
        checkpoints: [{
          id: "gate-1", atSeconds: 600, scope: { kind: "all-released" },
          threshold: { minimumSolved: 1 }, ranking: { kind: "none" }, settlement: "provisional",
        }],
        leaderboard: leaderboard === "freeze" ? { kind: "freeze", atSeconds: 300 } : { kind: leaderboard },
      },
      state: input.runtimeState ?? "running",
      pausedFromState: null,
      scheduleShiftSeconds: 120,
      pauseReason: null,
      clock: { generation: 2, state: "running", logicalSeconds: 900, capturedAt: "2020-01-01T00:00:00.000Z" },
      epochs: { timelineGeneration: 2, ruleEpoch: 4 },
      entrant: input.participant === false ? null : {
        entrantId: ENTRANT_ID,
        joined: true,
        started: true,
        state: input.eliminated ? "eliminated" : "active",
        eliminatedAtSeconds: input.eliminated ? 700 : null,
      },
      problems: [{
        problemId: PROBLEM_ID, problemSlug: "sum-two", problemEpoch: 7,
        contentEpoch: 5, contentCommit: CONTENT_COMMIT, judgeEpoch: 3,
        judgeDigest: "e".repeat(64), timelineGeneration: 2, ruleEpoch: 4,
      }],
      projection: {
        generation: 2,
        phase: input.eliminated ? "eliminated" : input.entrantPhase ?? "running",
        logicalSeconds: input.eliminated ? 700 : 900,
        nextBoundarySeconds: input.eliminated ? null : 1_800,
        problems: [{
          slug: "sum-two", availability, releaseAfterSeconds: 0,
          submissionClosesAfterSeconds: 1_800, attemptsRemaining: 2,
        }],
      },
      publicRepositoryTimingWarning: true,
    };
  }),
}));

const {
  contestLeaderboard,
  getContest,
  joinContest,
  listContests,
  listOrganizerContestParticipants,
} = await import("./product");

function metadata(input: FixtureOptions): Record<string, unknown> {
  return {
    id: CONTEST_ID,
    slug: "blitz",
    organizer_user_id: input.organizer ? USER_ID : OTHER_USER_ID,
    rules_commit: CONTENT_COMMIT,
    status: "published",
    title: "Blitz",
    description: "Fast contest",
    access_mode: "public",
    created_at: "2020-01-01T00:00:00.000Z",
    invite_code_configured: 0,
    pending_rules_commit: null,
    organizer_display_name: "Grace",
    organizer_visibility: "public",
    organizer_login: "grace",
    problem_count: 1,
  };
}

function problem(): Record<string, unknown> {
  return {
    ordinal: 1,
    batch: 1,
    release_after_seconds: 0,
    submission_closes_after_seconds: 1_800,
    points: 100,
    attempt_limit: 3,
    output_language: "rust",
    output_target: "wasip1",
    output_optimization: "release",
    output_entry_path: "src/main.rs",
    problem_id: PROBLEM_ID,
    slug: "sum-two",
    problem_number: 1,
    title_json: JSON.stringify({ "zh-TW": "兩數相加", en: "Sum Two" }),
    problem_epoch: 7,
    content_epoch: 5,
    content_commit: CONTENT_COMMIT,
    judge_epoch: 3,
    judge_digest: "e".repeat(64),
    prompt_context_sha256: PROMPT_CONTEXT,
  };
}

interface ContestDetailBody {
  readonly contest: Record<string, unknown>;
  readonly problems: readonly Record<string, unknown>[];
}

interface ContestListBody {
  readonly contests: readonly Record<string, unknown>[];
}

function environment(input: FixtureOptions = {}): { readonly env: WasmOjWorkerEnv; readonly sql: string[] } {
  const sqlLog: string[] = [];
  let insertedEntrantId: string | null = null;
  const prepare = vi.fn((sql: string) => {
    sqlLog.push(sql);
    return { bind: (...parameters: readonly unknown[]) => ({
      first: async () => {
        if (sql.includes("SELECT rules.access_mode")) return {
          access_mode: "public", invite_code_hash: null, status: "published",
          registration_opens_at: "2020-01-01T00:00:00.000Z",
          registration_closes_at: "2999-01-01T00:00:00.000Z",
          clock_kind: input.clockKind ?? "global", global_starts_at: input.clockKind === "individual" ? null : "2020-01-01T00:00:00.000Z",
          state: input.runtimeState ?? "running", timeline_generation: 2, rules_epoch: 4,
          schedule_shift_seconds: 120,
          entrant_id: input.existingEntrant ? ENTRANT_ID : null,
          joined_at: input.existingEntrant ? "2020-01-01T00:00:00.000Z" : null,
          entrant_state: input.existingEntrant ? "active" : null,
          started_at: input.existingEntrant ? "2020-01-01T00:00:00.000Z" : null,
        };
        if (sql.includes("SELECT id, joined_at, state, started_at") && sql.includes("FROM contest_entrants")) return input.joinAdmissionMissing ? null : {
          id: insertedEntrantId ?? ENTRANT_ID, joined_at: "2020-01-01T00:00:00.000Z", state: "active",
          started_at: "2020-01-01T00:00:00.000Z",
        };
        if (sql.includes("SELECT 1 AS closed") && sql.includes("contest_rule_checkpoints")) {
          return input.checkpointRegistrationClosed ? { closed: 1 } : null;
        }
        if (sql.includes("SELECT contests.id, contests.slug") && sql.includes("WHERE contests.id=?")) return metadata(input);
        if (sql.includes("SELECT 1 FROM contest_reveal_grants")) return { granted: 1 };
        if (sql.includes("FROM contest_problem_epochs AS epochs") && sql.includes("rejudge_batches AS rollout")) {
          return input.judgeRollout ? { provisional: 1 } : null;
        }
        if (sql.includes("SELECT eliminated_at")) return input.eliminated ? {
          eliminated_at: "2020-01-01T00:11:40.000Z",
          eliminated_checkpoint_id: "gate-1",
          elimination_reason: "checkpoint-threshold",
        } : null;
        if (sql.includes("SELECT 1") && sql.includes("catalogs.organizer_user_id")) return { owned: 1 };
        throw new Error(`Unexpected first query: ${sql}`);
      },
      all: async () => {
        if (sql.includes("ORDER BY rules.registration_opens_at")) return { results: [metadata(input)] };
        if (sql.includes("FROM contest_rule_problems AS selected")) return { results: [problem()] };
        if (sql.includes("FROM contest_rule_checkpoints AS checkpoints")) return { results: [{
          checkpoint_id: "gate-1", at_seconds: 600, settlement: "provisional",
          run_state: "final", pending_work: 0,
          decision: input.eliminated ? "eliminated" : "advanced", decision_provisional: 0,
        }] };
        if (sql.includes("FROM contest_entrants WHERE contest_id=? AND kind='account'")) return { results: [{
          entrant_id: ENTRANT_ID,
          user_id: USER_ID,
          joined_at: "2020-01-01T00:00:00.000Z",
          started_at: "2020-01-01T00:00:00.000Z",
          individual_wall_anchor_at: null,
          individual_logical_anchor_seconds: 0,
          state: input.eliminated ? "eliminated" : "active",
          state_timeline_generation: 2,
          eliminated_at: input.eliminated ? "2020-01-01T00:11:40.000Z" : null,
          eliminated_logical_seconds: input.eliminated ? 700 : null,
          eliminated_checkpoint_id: input.eliminated ? "gate-1" : null,
          elimination_reason: input.eliminated ? "checkpoint-threshold" : null,
        }] };
        if (sql.includes("FROM contest_submission_records AS records")) return { results: [{
          entrant_id: ENTRANT_ID, problem_slug: "sum-two", attempts: 1,
        }] };
        if (sql.includes("FROM contest_checkpoint_decisions AS decisions")) return { results: [{
          entrant_id: ENTRANT_ID, checkpoint_id: "gate-1", run_state: "final",
          decision: input.eliminated ? "eliminated" : "advanced", provisional: 0,
        }] };
        if (sql.includes("FROM users LEFT JOIN profiles")) return { results: [{
          user_id: USER_ID, display_name: "Ada", visibility: "public", login: "ada",
          avatar_url: "https://example.test/ada.png", status: "active",
        }] };
        throw new Error(`Unexpected all query: ${sql}`);
      },
      run: async () => {
        if (sql.includes("INSERT OR IGNORE INTO contest_entrants")) {
          insertedEntrantId = String(parameters[0]);
        }
        return { meta: { changes: 1 } };
      },
    }) };
  });
  const env = {
    DB: { prepare } as unknown as D1Database,
    ACCOUNT_ERASURE_HMAC_SECRET: "f".repeat(64),
    INVITE_CODE_HMAC_SECRET: "0".repeat(64),
  } as WasmOjWorkerEnv;
  fixtures.options.set(env, input);
  return { env, sql: sqlLog };
}

function request(path: string, init?: RequestInit): Request {
  return new Request(`https://wasm-oj.test${path}`, init);
}

describe("contest product v2 APIs", () => {
  it("keeps locked problems redacted, then grants an epoch-bound Prompt Program reveal", async () => {
    const locked = environment({ participant: false, availability: "locked", prompt: true });
    const lockedBody = await (await getContest(
      request(`/api/contests/${CONTEST_ID}`), locked.env, CONTEST_ID,
    )).json() as ContestDetailBody;
    expect(lockedBody.contest).toMatchObject({
      logicalTimeSeconds: 900,
      nextBoundarySeconds: 1_800,
      promptCompilerAvailable: false,
      aiAssistAvailable: false,
      publicRepositoryTimingWarning: { active: true },
    });
    expect(lockedBody.problems[0]).toMatchObject({ ordinal: 1, availability: "locked" });
    expect(lockedBody.problems[0]).not.toHaveProperty("problemId");
    expect(JSON.stringify(lockedBody)).not.toContain("sum-two");

    const revealed = environment({ participant: true, availability: "open", prompt: true });
    const revealedBody = await (await getContest(
      request(`/api/contests/${CONTEST_ID}`), revealed.env, CONTEST_ID,
    )).json() as ContestDetailBody;
    expect(revealedBody.problems[0]).toMatchObject({
      problemId: PROBLEM_ID,
      availability: "open",
      promptContextSha256: PROMPT_CONTEXT,
      output: { language: "rust", target: "wasip1", optimization: "release", entry: "src/main.rs" },
      contestAdmission: { timelineGeneration: 2, ruleEpoch: 4, problemEpoch: 7 },
    });
    expect(revealed.sql.some((sql) => sql.includes("INSERT OR IGNORE INTO contest_reveal_grants"))).toBe(true);
    expect(revealed.sql.some((sql) => sql.includes("contest_problem_prompt_contexts"))).toBe(true);
  });

  it("projects code Assist independently from official Prompt Compiler availability", async () => {
    const fixture = environment({ participant: true, availability: "open", assistAllowed: true });
    const body = await (await getContest(
      request(`/api/contests/${CONTEST_ID}`), fixture.env, CONTEST_ID,
    )).json() as ContestDetailBody;

    expect(body.contest).toMatchObject({
      promptCompilerAvailable: false,
      aiAssistAvailable: true,
    });
    expect(body.problems[0]).toMatchObject({
      problemId: PROBLEM_ID,
      assistContextSha256: PROMPT_CONTEXT,
    });
    expect(body.problems[0]).not.toHaveProperty("promptContextSha256");
  });

  it("returns the runtime projection after an atomically fenced public join", async () => {
    const fixture = environment({ participant: true });
    const response = await joinContest(request(`/api/contests/${CONTEST_ID}/join`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    }), fixture.env, CONTEST_ID);
    const body: unknown = await response.json();
    expect(body).toMatchObject({
      joined: true,
      entrantId: expect.any(String),
      replayed: false,
      contest: {
        logicalTimeSeconds: 900,
        epochs: { timelineGeneration: 2, ruleEpoch: 4 },
        problems: [{ ordinal: 1, availability: "open" }],
      },
    });
    expect(fixture.sql.some((sql) => sql.includes("INSERT OR IGNORE INTO contest_entrants"))).toBe(true);
    expect(fixture.sql.some((sql) => sql.includes("runtime.schedule_shift_seconds*1000"))).toBe(true);
    expect(fixture.sql.some((sql) => sql.includes("NOT EXISTS") && sql.includes("contest_rule_checkpoints"))).toBe(true);
  });

  it("rejects a new global entrant after a current-rule checkpoint without affecting replay", async () => {
    const fixture = environment({ joinAdmissionMissing: true, checkpointRegistrationClosed: true });
    await expect(joinContest(request(`/api/contests/${CONTEST_ID}/join`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    }), fixture.env, CONTEST_ID)).rejects.toMatchObject({
      status: 409,
      code: "contest-checkpoint-registration-closed",
    });
    expect(fixture.sql.some((sql) => sql.includes("rules.clock_kind='individual'")
      && sql.includes("runtime.state='scheduled'")
      && sql.includes("julianday(rules.global_starts_at)"))).toBe(true);

    const lazyScheduled = environment({
      joinAdmissionMissing: true,
      checkpointRegistrationClosed: true,
      runtimeState: "scheduled",
    });
    await expect(joinContest(request(`/api/contests/${CONTEST_ID}/join`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    }), lazyScheduled.env, CONTEST_ID)).rejects.toMatchObject({
      status: 409,
      code: "contest-checkpoint-registration-closed",
    });
    expect(lazyScheduled.sql.some((sql) => sql.includes("runtime.state IN ('scheduled','running')")
      && sql.includes("runtime.schedule_shift_seconds*1000"))).toBe(true);

    const replay = environment({ participant: true, checkpointRegistrationClosed: true, existingEntrant: true });
    const response = await joinContest(request(`/api/contests/${CONTEST_ID}/join`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    }), replay.env, CONTEST_ID);
    expect(await response.json()).toMatchObject({ replayed: true, entrantId: ENTRANT_ID });
    expect(replay.sql.some((sql) => sql.includes("INSERT OR IGNORE INTO contest_entrants"))).toBe(false);

    const individual = environment({ participant: true, clockKind: "individual", checkpointRegistrationClosed: true });
    const individualResponse = await joinContest(request(`/api/contests/${CONTEST_ID}/join`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    }), individual.env, CONTEST_ID);
    expect(await individualResponse.json()).toMatchObject({ joined: true, replayed: false });
  });

  it("uses logical evidence freeze and requires even public viewers to join", async () => {
    fixtures.contestLeaderboard.mockResolvedValueOnce([{
      rank: 4, userId: USER_ID, score: 100, fullyPassedCases: 1, deterministicCost: 1,
      peakMemoryBytes: 1, achievedAt: "2020-01-01T00:05:00.000Z",
    }]);
    const fixture = environment({ participant: true, leaderboard: "freeze" });
    const body: unknown = await (await contestLeaderboard(
      request(`/api/contests/${CONTEST_ID}/leaderboard`), fixture.env, CONTEST_ID,
    )).json();
    expect(body).toMatchObject({ frozen: true, hidden: false, entries: [{ rank: 4, score: 100 }] });
    expect(fixtures.contestLeaderboard).toHaveBeenLastCalledWith(fixture.env.DB, {
      contestId: CONTEST_ID,
      evidenceLogicalAtOrBefore: 300,
      limit: 50,
    });

    const unjoined = environment({ participant: false });
    await expect(contestLeaderboard(
      request(`/api/contests/${CONTEST_ID}/leaderboard`), unjoined.env, CONTEST_ID,
    )).rejects.toMatchObject({ status: 409, code: "contest-not-joined" });
  });

  it("keeps shared results hidden when only an individual entrant has ended", async () => {
    fixtures.contestLeaderboard.mockClear();
    const entrantEnded = environment({
      participant: true,
      clockKind: "individual",
      leaderboard: "hidden-until-end",
      entrantPhase: "ended",
      runtimeState: "running",
    });
    const hiddenBody: unknown = await (await contestLeaderboard(
      request(`/api/contests/${CONTEST_ID}/leaderboard`), entrantEnded.env, CONTEST_ID,
    )).json();
    expect(hiddenBody).toMatchObject({ hidden: true, entries: [] });
    expect(fixtures.contestLeaderboard).not.toHaveBeenCalled();

    fixtures.contestLeaderboard.mockResolvedValueOnce([]);
    const contestEnded = environment({
      participant: true,
      clockKind: "individual",
      leaderboard: "hidden-until-end",
      entrantPhase: "ended",
      runtimeState: "ended",
    });
    const visibleBody: unknown = await (await contestLeaderboard(
      request(`/api/contests/${CONTEST_ID}/leaderboard`), contestEnded.env, CONTEST_ID,
    )).json();
    expect(visibleBody).toMatchObject({ hidden: false });
    expect(fixtures.contestLeaderboard).toHaveBeenCalledOnce();
  });

  it("marks an effective problem epoch with an unsettled rollout provisional", async () => {
    const fixture = environment({ participant: true, judgeRollout: true });
    const body = await (await getContest(
      request(`/api/contests/${CONTEST_ID}`), fixture.env, CONTEST_ID,
    )).json() as ContestDetailBody;
    expect(body.contest).toMatchObject({ judgeProvisional: true });
    expect(fixture.sql.some((sql) => sql.includes("epochs.state='effective'")
      && sql.includes("rollout.state<>'effective'"))).toBe(true);
  });

  it("projects list and Organizer entrant checkpoint/elimination state from the current timeline", async () => {
    const fixture = environment({ participant: true, organizer: true, eliminated: true, availability: "closed" });
    const list = await (await listContests(request("/api/contests"), fixture.env)).json() as ContestListBody;
    expect(list.contests[0]).toMatchObject({
      runtimeState: "running",
      logicalTimeSeconds: 700,
      epochs: { timelineGeneration: 2, ruleEpoch: 4 },
      entrant: { eliminatedAtLogicalSeconds: 700 },
      checkpoints: [{ id: "gate-1", decision: "eliminated" }],
    });

    const participants: unknown = await (await listOrganizerContestParticipants(
      request(`/api/organizer/contests/${CONTEST_ID}/participants`), fixture.env, CONTEST_ID,
    )).json();
    expect(participants).toMatchObject({
      contest: { epochs: { timelineGeneration: 2, ruleEpoch: 4 }, promptCompilerAvailable: false },
      participants: [{
        entrantId: ENTRANT_ID,
        phase: "eliminated",
        logicalTimeSeconds: 1_800,
        problems: [{ slug: "sum-two", availability: "closed", attemptsRemaining: 2 }],
        checkpoints: [{ id: "gate-1", decision: "eliminated", provisional: false }],
        elimination: { atLogicalSeconds: 700, checkpointId: "gate-1" },
      }],
    });
  });
});
