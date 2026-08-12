import { describe, expect, it, vi } from "vitest";
import type { WasmOjWorkerEnv } from "./env";
import {
  getContest,
  includeFrozenContestParticipants,
  listOrganizerContests,
  listProblems,
  problemLeaderboard,
  publicProfile,
} from "./product";
import { sha256Hex } from "./crypto";

const PROBLEM_ID = "11111111-1111-4111-8111-111111111111";
const USER_ID = "22222222-2222-4222-8222-222222222222";

function leaderboardEnvironment(identity: {
  readonly visibility: "public" | "private";
  readonly status: "active" | "suspended";
}, mode: "official-practice" | "contest" = "official-practice"): WasmOjWorkerEnv {
  const prepare = vi.fn((sql: string) => ({
    bind: () => ({
      first: async () => {
        if (sql.includes("FROM problem_version_details AS versions")) {
          return mode === "official-practice"
            ? { id: PROBLEM_ID, allowed_profiles_json: JSON.stringify({
              c: { target: "wasip1", optimization: "release" },
              rust: { target: "wasip1", optimization: "release" },
            }) }
            : null;
        }
        throw new Error(`Unexpected first query: ${sql}`);
      },
      all: async () => {
        if (sql.includes("FROM effective_submission_results AS effective")) return { results: [{
          user_id: USER_ID,
          language: "rust",
          score: 100,
          fully_passed_cases: 7,
          deterministic_cost: 123,
          peak_memory_bytes: 4_096,
          achieved_at: "2026-08-09T00:00:00.000Z",
          submission_id: "33333333-3333-4333-8333-333333333333",
        }] };
        if (!sql.includes("FROM users")) throw new Error(`Unexpected all query: ${sql}`);
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
  } as unknown as WasmOjWorkerEnv;
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

  it("projects the effective-result row without exposing the internal user UUID", async () => {
    const response = await problemLeaderboard(
      new Request(`https://wasm-oj.test/api/problems/${PROBLEM_ID}/leaderboard`),
      leaderboardEnvironment({ visibility: "public", status: "active" }),
      PROBLEM_ID,
    );
    const text = await response.text();
    expect(text).not.toContain(USER_ID);
    const value = JSON.parse(text) as { entries: Array<{ participant: Record<string, unknown> }> };
    expect(value.entries[0]?.participant).toMatchObject({ kind: "profile", login: "ada", label: "Ada" });
    expect(value).toMatchObject({ availableLanguages: ["c", "rust"], selectedLanguage: null, entries: [{ rank: 1, language: "rust" }] });
  });

  it("uses a stable irreversible label for a private profile", async () => {
    const env = leaderboardEnvironment({ visibility: "private", status: "active" });
    const first = await problemLeaderboard(new Request(`https://wasm-oj.test/api/problems/${PROBLEM_ID}/leaderboard`), env, PROBLEM_ID)
      .then((response) => response.json()) as { entries: Array<{ participant: { id: string; kind: string } }> };
    const second = await problemLeaderboard(new Request(`https://wasm-oj.test/api/problems/${PROBLEM_ID}/leaderboard`), env, PROBLEM_ID)
      .then((response) => response.json()) as typeof first;
    expect(first.entries[0]?.participant.kind).toBe("anonymous");
    expect(first.entries[0]?.participant.id).toBe(second.entries[0]?.participant.id);
    expect(JSON.stringify(first)).not.toContain(USER_ID);
  });

  it("rejects contest-mode versions and validates the selected language", async () => {
    await expect(problemLeaderboard(
      new Request(`https://wasm-oj.test/api/problems/${PROBLEM_ID}/leaderboard`),
      leaderboardEnvironment({ visibility: "public", status: "active" }, "contest"),
      PROBLEM_ID,
    )).rejects.toMatchObject({ status: 404, code: "problem-not-found" });

    const env = leaderboardEnvironment({ visibility: "public", status: "active" });
    await expect(problemLeaderboard(
      new Request(`https://wasm-oj.test/api/problems/${PROBLEM_ID}/leaderboard?language=go`),
      env,
      PROBLEM_ID,
    )).rejects.toMatchObject({ status: 400, code: "leaderboard-language-invalid" });
  });
});

describe("v2 public problem catalog", () => {
  it("reads active heads and returns exact-commit content pointers", async () => {
    const title = JSON.stringify({ "zh-TW": "兩數和", en: "Two Sum" });
    const track = JSON.stringify({ "zh-TW": "基礎", en: "Foundations" });
    const prepare = vi.fn((sql: string) => {
      expect(sql).toContain("FROM official_practice_heads AS heads");
      expect(sql).toContain("JOIN problem_version_details AS versions");
      expect(sql).toContain("effective_submission_results");
      return { bind: () => ({ all: async () => ({ results: [{
        publication_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        collection_revision_sha256: "a".repeat(64), commit_sha: "b".repeat(40),
        published_at: "2026-08-09T00:00:00.000Z",
        github_repository_id: 1328710736, owner_login: "wasm-oj", repository_name: "official-problems",
        id: PROBLEM_ID, problem_series_id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
        execution_semantic_sha256: "d".repeat(64), practice_bundle_sha256: "e".repeat(64),
        problem_slug: "two-sum", problem_number: 1, title_json: title,
        difficulty: "easy", tags_json: JSON.stringify(["arrays"]), track_id: "foundations", track_json: track,
        maximum_score: 100, best_score: null, solved_at: null,
      }] }) }) };
    });
    const response = await listProblems(new Request("https://wasm-oj.test/api/problems"), {
      DB: { prepare } as unknown as D1Database,
      OFFICIAL_GITHUB_REPOSITORY_ID: "1328710736",
    } as WasmOjWorkerEnv);
    expect(response.headers.get("cache-control")).toBe("public, max-age=300");
    expect(await response.json()).toMatchObject({ collections: [{
      publicationId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      commitSha: "b".repeat(40),
      official: true,
      problems: [{
        id: PROBLEM_ID,
        executionSemanticDigest: "d".repeat(64),
        contentDigest: "e".repeat(64),
        contentUrl: `/api/problems/${PROBLEM_ID}/content?role=practice`,
        solved: false,
      }],
    }] });
  });
});

describe("public profile canonical result isolation", () => {
  it("uses effective_submission_results joined to active practice heads", async () => {
    const prepare = vi.fn((sql: string) => ({ bind: () => ({
      first: async () => {
        if (sql.includes("FROM profiles")) return {
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
        expect(sql).toContain("FROM effective_submission_results AS effective");
        expect(sql).toContain("JOIN official_practice_heads AS heads");
        return { results: [] };
      },
    }) }));
    const response = await publicProfile(new Request("https://wasm-oj.test/api/profiles/ada"), {
      DB: { prepare } as unknown as D1Database,
    } as WasmOjWorkerEnv, "ada");
    expect(await response.json()).toMatchObject({ profile: { verifiedSolvedCount: 0, verifiedSolves: [] } });
  });
});

describe("contest start-time confidentiality", () => {
  it("does not enumerate explicit problem versions before start", async () => {
    const prepare = vi.fn((sql: string) => ({ bind: () => ({
      first: async () => {
        if (sql.includes("FROM contests")) return {
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
    const response = await getContest(new Request("https://wasm-oj.test/api/contests/55555555-5555-4555-8555-555555555555"), {
      DB: { prepare } as unknown as D1Database,
    } as WasmOjWorkerEnv, "55555555-5555-4555-8555-555555555555");
    expect((await response.json() as { problems: unknown[] }).problems).toEqual([]);
  });
});

describe("Organizer contest draft discovery", () => {
  it("returns the bound publication and problem count to the owning Organizer", async () => {
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
        if (sql.includes("COUNT(contest_problems.problem_version_id)")) return { results: [{
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
          catalog_publication_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          created_at: "2026-08-12T00:00:00.000Z",
          updated_at: "2026-08-12T00:00:00.000Z",
        }] };
        throw new Error(`Unexpected all query: ${sql}`);
      },
    }) }));
    const response = await listOrganizerContests(new Request("https://wasm-oj.test/api/organizer/contests?status=draft", {
      headers: { cookie: "wasm_oj_session=session-token" },
    }), { DB: { prepare } as unknown as D1Database } as WasmOjWorkerEnv);
    expect(await response.json()).toMatchObject({ contests: [{
      title: "Draft contest",
      status: "draft",
      problemCount: 3,
      catalogPublicationId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    }] });
  });
});
