import { describe, expect, it, vi } from "vitest";
import type { ForgeWorkerEnv } from "./env";
import { acknowledgeRepositoryPushNotice, getContest, includeFrozenContestParticipants, listOrganizerContests, listProblems, listRepositoryPushNotices, managedProblemProjection, problemLeaderboard, publicProfile } from "./product";
import { sha256Hex } from "./crypto";

const PROBLEM_ID = "11111111-1111-4111-8111-111111111111";
const USER_ID = "22222222-2222-4222-8222-222222222222";
const NOTICE_ID = "44444444-4444-4444-8444-444444444444";

function environment(identity: { readonly visibility: "public" | "private"; readonly status: "active" | "suspended" }, mode: "official-practice" | "contest" = "official-practice"): ForgeWorkerEnv {
  const prepare = vi.fn((sql: string) => ({
    bind: () => ({
      first: async () => {
        if (sql.includes("FROM managed_problem_versions JOIN managed_snapshots")) return mode === "official-practice" ? { id: PROBLEM_ID, allowed_languages_json: JSON.stringify(["c", "rust"]) } : null;
        if (sql.includes("FROM effective_problem_versions")) return null;
        throw new Error(`Unexpected first query: ${sql}`);
      },
      all: async () => {
        if (sql.includes("FROM submissions")) return { results: [{
          user_id: USER_ID,
          language: "rust",
          score: 100,
          fully_passed_cases: 7,
          deterministic_cost: 123,
          peak_memory_bytes: 4_096,
          achieved_at: "2026-08-09T00:00:00.000Z",
          submission_id: "33333333-3333-4333-8333-333333333333",
        }] };
        if (!sql.includes("FROM users LEFT JOIN profiles")) throw new Error(`Unexpected all query: ${sql}`);
        return { results: [{
          user_id: USER_ID,
          status: identity.status,
          display_name: "Ada",
          visibility: identity.visibility,
          login: "ada",
          avatar_url: "https://avatars.githubusercontent.com/u/1?v=4",
        }] };
      },
    }),
  }));
  return {
    DB: { prepare } as unknown as D1Database,
    ACCOUNT_ERASURE_HMAC_SECRET: "a".repeat(64),
  } as unknown as ForgeWorkerEnv;
}

describe("public leaderboard identity projection", () => {
  it("keeps participants with no pre-freeze result on the frozen board", () => {
    expect(includeFrozenContestParticipants([{
      userId: "user-a", score: 100, fullyPassedCases: 1, deterministicCost: 10,
      peakMemoryBytes: 20, achievedAt: "2026-08-12T00:00:00.000Z", problemResults: [],
    }], ["user-b", "user-a"], "2026-08-12T01:00:00.000Z")).toMatchObject([
      { userId: "user-a", score: 100 },
      { userId: "user-b", score: 0, attemptedProblems: 0, problemResults: [] },
    ]);
  });

  it("replaces internal user UUIDs with an explicit public profile", async () => {
    const response = await problemLeaderboard(new Request(`https://forge.test/api/problems/${PROBLEM_ID}/leaderboard`), environment({ visibility: "public", status: "active" }), PROBLEM_ID);
    const text = await response.text();
    expect(text).not.toContain(USER_ID);
    const value = JSON.parse(text) as { entries: Array<{ participant: Record<string, unknown> }> };
    expect(value.entries[0]?.participant).toMatchObject({ kind: "profile", login: "ada", label: "Ada" });
    expect(value).toMatchObject({ availableLanguages: ["c", "rust"], selectedLanguage: null, entries: [{ rank: 1, language: "rust" }] });
  });

  it("uses a stable irreversible label for a private profile", async () => {
    const env = environment({ visibility: "private", status: "active" });
    const first = await problemLeaderboard(new Request(`https://forge.test/api/problems/${PROBLEM_ID}/leaderboard`), env, PROBLEM_ID).then((response) => response.json()) as { entries: Array<{ participant: { id: string; kind: string } }> };
    const second = await problemLeaderboard(new Request(`https://forge.test/api/problems/${PROBLEM_ID}/leaderboard`), env, PROBLEM_ID).then((response) => response.json()) as typeof first;
    expect(first.entries[0]?.participant.kind).toBe("anonymous");
    expect(first.entries[0]?.participant.id).toBe(second.entries[0]?.participant.id);
    expect(JSON.stringify(first)).not.toContain(USER_ID);
  });

  it("does not expose a contest scoreboard through the public practice leaderboard", async () => {
    await expect(problemLeaderboard(
      new Request(`https://forge.test/api/problems/${PROBLEM_ID}/leaderboard`),
      environment({ visibility: "public", status: "active" }, "contest"),
      PROBLEM_ID,
    ))
      .rejects.toMatchObject({ status: 404, code: "managed-problem-not-found" });
  });

  it("validates a requested language against the problem contract", async () => {
    const env = environment({ visibility: "public", status: "active" });
    const response = await problemLeaderboard(
      new Request(`https://forge.test/api/problems/${PROBLEM_ID}/leaderboard?language=rust`),
      env,
      PROBLEM_ID,
    );
    expect(await response.json()).toMatchObject({ selectedLanguage: "rust", entries: [{ language: "rust" }] });

    await expect(problemLeaderboard(
      new Request(`https://forge.test/api/problems/${PROBLEM_ID}/leaderboard?language=go`),
      env,
      PROBLEM_ID,
    )).rejects.toMatchObject({ status: 400, code: "leaderboard-language-invalid" });

    await expect(problemLeaderboard(
      new Request(`https://forge.test/api/problems/${PROBLEM_ID}/leaderboard?language=brainfuck`),
      env,
      PROBLEM_ID,
    )).rejects.toMatchObject({ status: 400, code: "leaderboard-language-invalid" });
  });
});

describe("public problem catalog", () => {
  it("pins the configured official collection first and permits anonymous caching", async () => {
    const title = JSON.stringify({ "zh-TW": "兩數和", en: "Two Sum" });
    const track = JSON.stringify({ "zh-TW": "基礎", en: "Foundations" });
    const prepare = vi.fn(() => ({ bind: () => ({ all: async () => ({ results: [{
      snapshot_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      collection_revision: "a".repeat(64), published_at: "2026-08-09T00:00:00.000Z",
      github_repository_id: 1328710736, owner_login: "wasm-oj", repository_name: "official-problems",
      id: PROBLEM_ID, bundle_digest: "f".repeat(64), problem_slug: "two-sum", problem_number: 1, title_json: title,
      difficulty: "easy", tags_json: JSON.stringify(["arrays"]), track_id: "foundations", track_json: track,
      maximum_score: 100, best_score: null, solved_at: null,
    }] }) }) }));
    const response = await listProblems(new Request("https://forge.test/api/problems"), {
      DB: { prepare } as unknown as D1Database,
      OFFICIAL_GITHUB_REPOSITORY_ID: "1328710736",
    } as ForgeWorkerEnv);
    expect(response.headers.get("cache-control")).toBe("public, max-age=300");
    expect(await response.json()).toMatchObject({ collections: [{ official: true, repository: { name: "official-problems" }, problems: [{ id: PROBLEM_ID, bundleDigest: "f".repeat(64), solved: false, difficulty: "easy" }] }] });
  });
});

describe("public profile contest isolation", () => {
  it("queries only official-practice solves", async () => {
    const prepare = vi.fn((sql: string) => ({ bind: () => ({
      first: async () => {
        if (sql.includes("FROM profiles JOIN github_identities")) return {
          user_id: USER_ID,
          display_name: "Ada",
          bio: "",
          website_url: null,
          login: "ada",
          avatar_url: "https://avatars.githubusercontent.com/u/1?v=4",
        };
        throw new Error(`Unexpected first query: ${sql}`);
      },
      all: async () => {
        expect(sql).toContain("managed_snapshots.mode='official-practice'");
        return { results: [] };
      },
    }) }));
    const response = await publicProfile(new Request("https://forge.test/api/profiles/ada"), {
      DB: { prepare } as unknown as D1Database,
    } as ForgeWorkerEnv, "ada");
    expect(await response.json()).toMatchObject({ profile: { verifiedSolvedCount: 0, verifiedSolves: [] } });
  });
});

async function noticeEnvironment(acknowledgedAt: string | null = null): Promise<ForgeWorkerEnv> {
  const sessionHash = await sha256Hex("session-token");
  const csrfHash = await sha256Hex("csrf-token");
  const prepare = vi.fn((sql: string) => ({
    bind: (...values: unknown[]) => ({
      first: async () => {
        if (sql.includes("FROM sessions JOIN users")) {
          expect(values[0]).toBe(sessionHash);
          return { user_id: USER_ID, expires_at: "2099-01-01T00:00:00.000Z", csrf_hash: csrfHash, login: "ada", avatar_url: "https://avatars.githubusercontent.com/u/1?v=4" };
        }
        if (sql === "SELECT csrf_hash FROM sessions WHERE token_hash = ?") return { csrf_hash: csrfHash };
        if (sql.includes("SELECT repository_push_notices.acknowledged_at")) return { acknowledged_at: acknowledgedAt };
        throw new Error(`Unexpected first query: ${sql}`);
      },
      all: async () => {
        if (sql === "SELECT role FROM user_roles WHERE user_id = ? ORDER BY role") return { results: [{ role: "organizer" }] };
        if (sql.includes("FROM repository_push_notices") && sql.includes("ORDER BY repository_push_notices.received_at")) return { results: [{
          id: NOTICE_ID,
          github_repository_id: 123,
          owner_login: "private-owner",
          name: "private-repo",
          is_private: 1,
          commit_sha: "a".repeat(40),
          ref: "refs/heads/main",
          received_at: "2026-08-09T00:00:00.000Z",
          acknowledged_at: acknowledgedAt,
        }] };
        throw new Error(`Unexpected all query: ${sql}`);
      },
      run: async () => {
        if (sql.includes("UPDATE repository_push_notices SET acknowledged_at")) return { meta: { changes: acknowledgedAt ? 0 : 1 } };
        throw new Error(`Unexpected run query: ${sql}`);
      },
    }),
  }));
  return { DB: { prepare } as unknown as D1Database, PUBLIC_ORIGIN: "https://forge.test" } as unknown as ForgeWorkerEnv;
}

describe("Organizer repository push notifications", () => {
  it("keeps private repository metadata behind the owning Organizer session", async () => {
    const response = await listRepositoryPushNotices(new Request("https://forge.test/api/organizer/notices", {
      headers: { cookie: "forge_session=session-token" },
    }), await noticeEnvironment());
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(await response.json()).toMatchObject({ notices: [{ id: NOTICE_ID, repository: "private-owner/private-repo", private: true }] });
  });

  it("acknowledges a notice with mutation-session and ownership fences", async () => {
    const response = await acknowledgeRepositoryPushNotice(new Request(`https://forge.test/api/organizer/notices/${NOTICE_ID}/acknowledge`, {
      method: "POST",
      headers: {
        origin: "https://forge.test",
        cookie: "forge_session=session-token; forge_csrf=csrf-token",
        "x-forge-csrf": "csrf-token",
        "content-type": "application/json",
      },
      body: "{}",
    }), await noticeEnvironment(), NOTICE_ID);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ noticeId: NOTICE_ID, replayed: false });
  });
});

describe("contest start-time confidentiality", () => {
  it("does not enumerate problem identities before start", async () => {
    const prepare = vi.fn((sql: string) => ({ bind: () => ({
      first: async () => {
        if (sql.includes("SELECT contests.id, contests.organizer_user_id")) return {
          id: "55555555-5555-4555-8555-555555555555",
          organizer_user_id: USER_ID,
          title: "Future contest",
          description: "",
          access_mode: "public",
          starts_at: "2099-01-01T00:00:00.000Z",
          ends_at: "2099-01-02T00:00:00.000Z",
          freeze_at: null,
          status: "published",
          participant_user_id: null,
        };
        throw new Error(`Unexpected first query: ${sql}`);
      },
      all: async () => { throw new Error(`Problem inventory must not be queried before start: ${sql}`); },
    }) }));
    const response = await getContest(new Request("https://forge.test/api/contests/55555555-5555-4555-8555-555555555555"), {
      DB: { prepare } as unknown as D1Database,
    } as ForgeWorkerEnv, "55555555-5555-4555-8555-555555555555");
    expect((await response.json() as { problems: unknown[] }).problems).toEqual([]);
  });

  it("rejects a pre-start public projection before R2 is read", async () => {
    const get = vi.fn();
    const prepare = vi.fn((sql: string) => ({ bind: () => ({ first: async () => {
      if (sql.includes("FROM managed_problem_versions JOIN managed_snapshots")) return {
        public_projection_r2_key: `snapshots/objects/${"a".repeat(64)}`,
        bundle_digest: "b".repeat(64),
        mode: "contest",
        status: "published",
      };
      if (sql.includes("SELECT contests.access_mode")) return {
        access_mode: "public",
        status: "published",
        organizer_user_id: USER_ID,
        starts_at: "2099-01-01T00:00:00.000Z",
        user_id: null,
      };
      throw new Error(`Unexpected first query: ${sql}`);
    } }) }));
    await expect(managedProblemProjection(new Request(`https://forge.test/api/problems/${PROBLEM_ID}?contestId=55555555-5555-4555-8555-555555555555`), {
      DB: { prepare } as unknown as D1Database,
      JUDGE_BUCKET: { get } as unknown as R2Bucket,
    } as ForgeWorkerEnv, PROBLEM_ID)).rejects.toMatchObject({ status: 404, code: "managed-problem-not-found" });
    expect(get).not.toHaveBeenCalled();
  });
});

describe("Organizer contest draft discovery", () => {
  it("returns persisted drafts only to the owning Organizer session", async () => {
    const sessionHash = await sha256Hex("session-token");
    const prepare = vi.fn((sql: string) => ({ bind: (...values: unknown[]) => ({
      first: async () => {
        if (sql.includes("FROM sessions JOIN users")) {
          expect(values[0]).toBe(sessionHash);
          return { user_id: USER_ID, expires_at: "2099-01-01T00:00:00.000Z", csrf_hash: "unused", login: "ada", avatar_url: "https://example.test/ada.png" };
        }
        throw new Error(`Unexpected first query: ${sql}`);
      },
      all: async () => {
        if (sql === "SELECT role FROM user_roles WHERE user_id = ? ORDER BY role") return { results: [{ role: "organizer" }] };
        if (sql.includes("FROM contests") && sql.includes("COUNT(contest_problems.managed_problem_version_id)")) return { results: [{
          id: "55555555-5555-4555-8555-555555555555",
          title: "Draft contest",
          description: "Saved server-side",
          access_mode: "invite",
          invite_code_configured: 1,
          starts_at: "2099-01-01T00:00:00.000Z",
          ends_at: "2099-01-02T00:00:00.000Z",
          freeze_at: null,
          status: "draft",
          problem_count: 3,
          created_at: "2026-08-12T00:00:00.000Z",
          updated_at: "2026-08-12T00:00:00.000Z",
        }] };
        throw new Error(`Unexpected all query: ${sql}`);
      },
    }) }));
    const response = await listOrganizerContests(new Request("https://forge.test/api/organizer/contests?status=draft", {
      headers: { cookie: "forge_session=session-token" },
    }), { DB: { prepare } as unknown as D1Database } as ForgeWorkerEnv);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(await response.json()).toMatchObject({ contests: [{ title: "Draft contest", status: "draft", inviteCodeConfigured: true, problemCount: 3 }] });
  });
});
