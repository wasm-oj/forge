import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WasmOjWorkerEnv } from "./env";

const CONTEST_ID = "11111111-1111-4111-8111-111111111111";
const PROBLEM_ID = "22222222-2222-4222-8222-222222222222";
const USER_ID = "33333333-3333-4333-8333-333333333333";
const ENTRANT_ID = "44444444-4444-4444-8444-444444444444";
const CONTENT_COMMIT = "a".repeat(40);
const CONTEXT = "b".repeat(64);

const state = vi.hoisted(() => ({ snapshot: {} as Record<string, unknown> }));
vi.mock("./contest-runtime", () => ({
  loadContestRuntimeSnapshot: vi.fn(async () => state.snapshot),
}));

const { createPromptAssistHost } = await import("./prompt-assist");

const session = {
  userId: USER_ID,
  login: "ada",
  avatarUrl: "https://example.test/ada.png",
  roles: [] as const,
  expiresAt: "2999-01-01T00:00:00.000Z",
};

const request = {
  context: {
    kind: "contest" as const,
    contestId: CONTEST_ID,
    problemId: PROBLEM_ID,
    contentCommit: CONTENT_COMMIT,
    timelineGeneration: 2,
    ruleEpoch: 4,
    problemEpoch: 7,
    publicContextSha256: CONTEXT,
  },
  language: "c" as const,
  entry: "main.c",
  prompt: "solve",
};

function snapshot(availability: "locked" | "open" | "closed" = "open") {
  return {
    contestId: CONTEST_ID,
    rulesCommit: "c".repeat(40),
    rulesDigest: "d".repeat(64),
    rules: { officialTrack: { kind: "code", aiAssist: "allowed" } },
    state: "running",
    entrant: { entrantId: ENTRANT_ID, state: "active" },
    epochs: { timelineGeneration: 2, ruleEpoch: 4 },
    problems: [{
      problemId: PROBLEM_ID,
      problemSlug: "sum",
      problemEpoch: 7,
      contentEpoch: 5,
      contentCommit: CONTENT_COMMIT,
    }],
    projection: { problems: [{ slug: "sum", availability }] },
  };
}

function environment(overrides: Readonly<Record<string, unknown>> = {}) {
  const sql: string[] = [];
  const row = {
    rules_commit: "c".repeat(40),
    rules_sha256: "d".repeat(64),
    status: "published",
    official_track: "code",
    ai_assist: "allowed",
    runtime_state: "running",
    timeline_generation: 2,
    rules_epoch: 4,
    entrant_id: ENTRANT_ID,
    entrant_state: "active",
    entrant_state_generation: 2,
    problem_epoch: 7,
    content_epoch: 5,
    content_commit: CONTENT_COMMIT,
    allowed_profiles_json: JSON.stringify({ c: { target: "wasip1", optimization: "release" } }),
    public_context_sha256: CONTEXT,
    context_bytes: 123,
    context_storage_key: `prompt-contexts/v1/${CONTEXT}`,
    reveal_eligible: 1,
    ...overrides,
  };
  const prepare = vi.fn((query: string) => {
    sql.push(query);
    return { bind: () => ({ first: async () => row }) };
  });
  return {
    env: { DB: { prepare } as unknown as D1Database } as WasmOjWorkerEnv,
    sql,
  };
}

beforeEach(() => { state.snapshot = snapshot(); });

describe("contest Prompt Assist admission", () => {
  it("derives the compile profile server-side and binds reveal plus every current epoch", async () => {
    const { env, sql } = environment();
    const admission = await createPromptAssistHost(env, session).loadAdmission(request);

    expect(admission).toMatchObject({
      output: { language: "c", target: "wasip1", optimization: "release", entry: "main.c" },
      guard: {
        timelineGeneration: 2,
        ruleEpoch: 4,
        problemEpoch: 7,
        contentEpoch: 5,
        contentCommit: CONTENT_COMMIT,
      },
      publicContext: { sha256: CONTEXT, storageKey: `prompt-contexts/v1/${CONTEXT}` },
    });
    expect(sql[0]).toContain("contest_reveal_grants");
    expect(sql[0]).toContain("entrants.state_timeline_generation");
    expect(sql[0]).toContain("epochs.state='effective'");
  });

  it("rejects locked/closed, paused, and stale epochs before provider invocation", async () => {
    state.snapshot = snapshot("closed");
    await expect(createPromptAssistHost(environment().env, session).loadAdmission(request))
      .rejects.toMatchObject({ status: 409, code: "assist-problem-not-open" });

    state.snapshot = { ...snapshot(), state: "paused" };
    await expect(createPromptAssistHost(environment().env, session).loadAdmission(request))
      .rejects.toMatchObject({ status: 409, code: "assist-problem-not-open" });

    state.snapshot = { ...snapshot(), epochs: { timelineGeneration: 3, ruleEpoch: 4 } };
    await expect(createPromptAssistHost(environment().env, session).loadAdmission(request))
      .rejects.toMatchObject({ status: 409, code: "assist-context-stale" });
  });

  it("rejects a row-level policy or reveal race after the logical projection", async () => {
    await expect(createPromptAssistHost(environment({ ai_assist: "disabled" }).env, session).loadAdmission(request))
      .rejects.toMatchObject({ status: 409, code: "assist-not-allowed" });
    await expect(createPromptAssistHost(environment({ reveal_eligible: 0 }).env, session).loadAdmission(request))
      .rejects.toMatchObject({ status: 409, code: "assist-problem-not-open" });
  });
});
