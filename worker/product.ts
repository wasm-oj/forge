import { isBuiltinLanguage, type BuiltinLanguage } from "../src/core/types";
import { parseJudgeAllowedProfiles, type JudgeAllowedProfiles } from "../src/online-judge/compile-profiles";
import { parseStoredProblemTitle } from "../src/online-judge/stored-problem-title";
import { authenticatedSession, requireBrowserMutationSession, requireBrowserOrBearerMutationSession, requireSession } from "./auth";
import { constantTimeEqual, hmacSha256Hex } from "./crypto";
import type { WasmOjWorkerEnv } from "./env";
import { requireStagingFormalAccess } from "./formal-access";
import { requireFormalMutationsEnabled } from "./formal-mutations";
import { requireOrganizer } from "./github";
import { ApiError, jsonResponse, readJsonBody } from "./http";
import { queryContestLeaderboard, queryProblemLeaderboard, type LeaderboardEntryRow } from "./leaderboards";
import { queryPerformanceEvolution, queryPerformanceFrontier } from "./performance";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const textEncoder = new TextEncoder();

export type ContestPhase = "upcoming" | "running" | "ended";

export function contestPhase(startsAt: string, endsAt: string, now = new Date()): ContestPhase {
  const timestamp = now.toISOString();
  if (startsAt > timestamp) return "upcoming";
  if (endsAt <= timestamp) return "ended";
  return "running";
}

interface LeaderboardParticipant {
  readonly id: string;
  readonly kind: "profile" | "anonymous" | "deleted";
  readonly label: string;
  readonly login?: string;
  readonly avatarUrl?: string;
}

interface LeaderboardIdentityRow {
  readonly user_id: string;
  readonly display_name: string;
  readonly visibility: "public" | "private";
  readonly login: string | null;
  readonly avatar_url: string | null;
  readonly status: "active" | "suspended";
}

interface ProblemRevisionRow {
  readonly problem_id: string;
  readonly catalog_id: string;
  readonly commit_sha: string;
  readonly slug: string;
  readonly ordinal: number;
  readonly title_json: string;
  readonly summary_json: string;
  readonly practice_enabled: number;
  readonly allowed_profiles_json: string;
  readonly judge_digest: string;
  readonly practice_bundle_bytes: number;
  readonly practice_bundle_sha256: string;
  readonly contest_bundle_bytes: number;
  readonly contest_bundle_sha256: string;
}

function exact(value: unknown, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ApiError(400, "payload-invalid", "Payload must be an object.");
  const record = value as Record<string, unknown>;
  const allowed = new Set([...required, ...optional]);
  if (required.some((key) => !Object.hasOwn(record, key)) || Object.keys(record).some((key) => !allowed.has(key))) {
    throw new ApiError(400, "payload-invalid", "Payload has an invalid shape.");
  }
  return record;
}

function storedAllowedProfiles(value: string): JudgeAllowedProfiles {
  return parseJudgeAllowedProfiles(JSON.parse(value) as unknown, "stored problem allowedProfiles");
}

function storedSummary(value: string): { readonly "zh-TW": string; readonly en: string } {
  const parsed = JSON.parse(value) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Stored problem summary is invalid.");
  const record = parsed as Record<string, unknown>;
  if (Object.keys(record).sort().join("\0") !== "en\0zh-TW" || typeof record.en !== "string" || typeof record["zh-TW"] !== "string") {
    throw new Error("Stored problem summary is invalid.");
  }
  return { "zh-TW": record["zh-TW"], en: record.en };
}

function officialRepositoryId(env: WasmOjWorkerEnv): number {
  const value = Number(env.OFFICIAL_GITHUB_REPOSITORY_ID);
  if (!Number.isSafeInteger(value) || value < 1) throw new Error("Official GitHub repository ID is not configured.");
  return value;
}

function publicProfileProjection(row: {
  readonly display_name: string;
  readonly bio: string;
  readonly website_url: string | null;
  readonly login: string;
  readonly avatar_url: string;
}) {
  return { displayName: row.display_name, bio: row.bio, websiteUrl: row.website_url, login: row.login, avatarUrl: row.avatar_url };
}

async function leaderboardParticipantId(env: WasmOjWorkerEnv, userId: string): Promise<string> {
  if (env.ACCOUNT_ERASURE_HMAC_SECRET.length < 32) throw new Error("Account-erasure HMAC secret is not configured.");
  return `participant-${(await hmacSha256Hex(
    env.ACCOUNT_ERASURE_HMAC_SECRET,
    textEncoder.encode(`wasm-oj-public-leaderboard-participant-v1\0${userId}`),
  )).slice(0, 24)}`;
}

async function leaderboardParticipants(
  env: WasmOjWorkerEnv,
  userIds: readonly string[],
): Promise<ReadonlyMap<string, LeaderboardParticipant>> {
  const unique = [...new Set(userIds)];
  if (unique.length > 100) throw new Error("Leaderboard participant inventory is too large.");
  const activeIds = unique.filter((id) => UUID.test(id));
  const identities = activeIds.length === 0 ? [] : (await env.DB.prepare(`SELECT users.id AS user_id, users.status,
      profiles.display_name, profiles.visibility, github_identities.login, github_identities.avatar_url
    FROM users LEFT JOIN profiles ON profiles.user_id=users.id
    LEFT JOIN github_identities ON github_identities.user_id=users.id
    WHERE users.id IN (${activeIds.map(() => "?").join(",")})`).bind(...activeIds).all<LeaderboardIdentityRow>()).results;
  const byId = new Map(identities.map((row) => [row.user_id, row] as const));
  const result = new Map<string, LeaderboardParticipant>();
  await Promise.all(unique.map(async (userId) => {
    const id = await leaderboardParticipantId(env, userId);
    const identity = byId.get(userId);
    if (identity?.status === "active" && identity.visibility === "public" && identity.login && identity.avatar_url) {
      result.set(userId, { id, kind: "profile", label: identity.display_name, login: identity.login, avatarUrl: identity.avatar_url });
    } else {
      const deleted = /^erased-[0-9a-f]{32}$/.test(userId) || identity?.status === "suspended";
      result.set(userId, { id, kind: deleted ? "deleted" : "anonymous", label: deleted ? "Deleted participant" : `Private participant ${id.slice(-6)}` });
    }
  }));
  return result;
}

async function projectLeaderboardEntries(
  env: WasmOjWorkerEnv,
  input: {
    readonly frozen: boolean;
    readonly entries: readonly LeaderboardEntryRow[];
    readonly availableLanguages?: readonly BuiltinLanguage[];
    readonly selectedLanguage?: BuiltinLanguage;
  },
): Promise<Response> {
  const entries = input.entries.map((entry, index) => ({ rank: index + 1, ...entry }));
  const identities = await leaderboardParticipants(env, entries.map((entry) => entry.userId));
  return jsonResponse({
    frozen: input.frozen,
    ...(input.availableLanguages ? { availableLanguages: input.availableLanguages, selectedLanguage: input.selectedLanguage ?? null } : {}),
    entries: entries.map(({ userId, ...entry }) => ({
      ...entry,
      participant: identities.get(userId) ?? { id: "participant-unavailable", kind: "anonymous", label: "Private participant" },
    })),
  });
}

export async function currentProfile(request: Request, env: WasmOjWorkerEnv): Promise<Response> {
  const session = await requireSession(request, env);
  const profile = await env.DB.prepare(`SELECT profiles.display_name, profiles.bio, profiles.website_url,
      profiles.visibility, github_identities.login, github_identities.avatar_url
    FROM profiles JOIN github_identities ON github_identities.user_id=profiles.user_id WHERE profiles.user_id=?`)
    .bind(session.userId).first<{ display_name: string; bio: string; website_url: string | null; visibility: "public" | "private"; login: string; avatar_url: string }>();
  if (!profile) throw new ApiError(404, "profile-not-found", "Profile was not found.");
  const solved = await env.DB.prepare(`SELECT COUNT(DISTINCT effective.problem_id) AS count
    FROM effective_submission_results AS effective
    JOIN submissions AS origin ON origin.id=effective.origin_submission_id
    JOIN submissions AS result ON result.id=effective.effective_submission_id
    WHERE origin.user_id=? AND origin.contest_id IS NULL AND result.state='completed' AND result.score>=100
      AND effective.active_commit IS NOT NULL`).bind(session.userId).first<{ readonly count: number }>();
  return jsonResponse({ profile: { ...publicProfileProjection(profile), visibility: profile.visibility, verifiedSolvedCount: solved?.count ?? 0 } });
}

export async function updateProfile(request: Request, env: WasmOjWorkerEnv): Promise<Response> {
  const session = await requireBrowserMutationSession(request, env);
  const body = exact(await readJsonBody(request, 32 * 1024), ["displayName", "bio", "visibility"], ["websiteUrl"]);
  if (
    typeof body.displayName !== "string" || body.displayName.trim().length < 1 || body.displayName.length > 80
    || typeof body.bio !== "string" || body.bio.length > 2_000
    || (body.visibility !== "public" && body.visibility !== "private")
  ) throw new ApiError(400, "profile-invalid", "Profile fields are invalid.");
  if (body.websiteUrl !== undefined) {
    if (typeof body.websiteUrl !== "string" || body.websiteUrl.length > 300) throw new ApiError(400, "profile-invalid", "Website URL is invalid.");
    const website = new URL(body.websiteUrl);
    if (website.protocol !== "https:" || website.username || website.password) throw new ApiError(400, "profile-invalid", "Website URL must be credential-free HTTPS.");
  }
  await env.DB.prepare("UPDATE profiles SET display_name=?, bio=?, website_url=?, visibility=?, updated_at=? WHERE user_id=?")
    .bind(body.displayName.trim(), body.bio, body.websiteUrl ?? null, body.visibility, new Date().toISOString(), session.userId).run();
  return jsonResponse({ updated: true });
}

export async function publicProfile(_request: Request, env: WasmOjWorkerEnv, login: string): Promise<Response> {
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(login)) throw new ApiError(404, "profile-not-found", "Profile was not found.");
  const profile = await env.DB.prepare(`SELECT profiles.user_id, profiles.display_name, profiles.bio,
      profiles.website_url, github_identities.login, github_identities.avatar_url
    FROM profiles JOIN github_identities ON github_identities.user_id=profiles.user_id
    JOIN users ON users.id=profiles.user_id
    WHERE github_identities.login=? COLLATE NOCASE AND profiles.visibility='public' AND users.status='active'`)
    .bind(login).first<{ user_id: string; display_name: string; bio: string; website_url: string | null; login: string; avatar_url: string }>();
  if (!profile) throw new ApiError(404, "profile-not-found", "Profile was not found.");
  const solves = await env.DB.prepare(`WITH eligible AS (
      SELECT effective.problem_id, result.score, origin.completed_at AS solved_at,
        row_number() OVER (PARTITION BY effective.problem_id ORDER BY result.score DESC, origin.completed_at, result.id) AS rank
      FROM effective_submission_results AS effective
      JOIN submissions AS origin ON origin.id=effective.origin_submission_id
      JOIN submissions AS result ON result.id=effective.effective_submission_id
      WHERE origin.user_id=? AND origin.contest_id IS NULL AND result.state='completed'
        AND result.score>=100 AND effective.active_commit IS NOT NULL
    )
    SELECT eligible.problem_id, eligible.score, eligible.solved_at, problems.slug, revisions.title_json
    FROM eligible JOIN problem_series AS problems ON problems.id=eligible.problem_id
    JOIN catalogs ON catalogs.id=problems.catalog_id
    JOIN problem_revisions AS revisions ON revisions.problem_id=problems.id AND revisions.commit_sha=catalogs.active_commit_sha
    WHERE eligible.rank=1 ORDER BY eligible.solved_at DESC, eligible.problem_id`)
    .bind(profile.user_id).all<Record<string, unknown>>();
  return jsonResponse({ profile: {
    ...publicProfileProjection(profile),
    verifiedSolvedCount: solves.results.length,
    verifiedSolves: solves.results.map((solve) => ({
      problemId: solve.problem_id, score: solve.score, solvedAt: solve.solved_at,
      problemSlug: solve.slug, title: parseStoredProblemTitle(solve.title_json),
    })),
  } });
}

export async function listProblems(request: Request, env: WasmOjWorkerEnv): Promise<Response> {
  const session = await authenticatedSession(request, env);
  const rows = await env.DB.prepare(`WITH progress AS (
      SELECT effective.problem_id, MAX(result.score) AS best_score,
        MIN(CASE WHEN result.score>=100 THEN origin.completed_at END) AS solved_at
      FROM effective_submission_results AS effective
      JOIN submissions AS origin ON origin.id=effective.origin_submission_id
      JOIN submissions AS result ON result.id=effective.effective_submission_id
      WHERE origin.user_id=? AND origin.contest_id IS NULL AND result.state='completed'
      GROUP BY effective.problem_id
    )
    SELECT catalogs.id AS catalog_id, catalogs.active_commit_sha AS commit_sha,
      repositories.github_repository_id, repositories.owner_login, repositories.name AS repository_name,
      problems.id AS problem_id, problems.slug, revisions.ordinal, revisions.title_json,
      revisions.summary_json, revisions.practice_enabled, revisions.judge_digest,
      revisions.practice_bundle_bytes, revisions.practice_bundle_sha256,
      progress.best_score, progress.solved_at
    FROM catalogs JOIN github_repositories AS repositories
      ON repositories.github_repository_id=catalogs.github_repository_id
    JOIN problem_series AS problems ON problems.catalog_id=catalogs.id
    JOIN problem_revisions AS revisions ON revisions.problem_id=problems.id
      AND revisions.commit_sha=catalogs.active_commit_sha
    LEFT JOIN progress ON progress.problem_id=problems.id
    WHERE revisions.practice_enabled=1
    ORDER BY CASE WHEN repositories.github_repository_id=? THEN 0 ELSE 1 END,
      repositories.owner_login COLLATE NOCASE, repositories.name COLLATE NOCASE, revisions.ordinal`)
    .bind(session?.userId ?? "", officialRepositoryId(env)).all<Record<string, unknown>>();
  const catalogs = new Map<string, Record<string, unknown> & { problems: Array<Record<string, unknown>> }>();
  for (const row of rows.results) {
    const catalogId = String(row.catalog_id);
    let catalog = catalogs.get(catalogId);
    if (!catalog) {
      catalog = {
        catalogId,
        catalogCommit: row.commit_sha,
        repository: { id: row.github_repository_id, owner: row.owner_login, name: row.repository_name },
        official: Number(row.github_repository_id) === officialRepositoryId(env),
        problems: [],
      };
      catalogs.set(catalogId, catalog);
    }
    const problemId = String(row.problem_id);
    const commit = String(row.commit_sha);
    catalog.problems.push({
      id: problemId,
      slug: row.slug,
      number: row.ordinal,
      title: parseStoredProblemTitle(row.title_json),
      summary: storedSummary(String(row.summary_json)),
      practiceEnabled: true,
      catalogCommit: commit,
      judgeDigest: row.judge_digest,
      contentDigest: row.practice_bundle_sha256,
      contentUrl: `/api/problems/${encodeURIComponent(problemId)}/content?role=practice&commit=${commit}`,
      solved: row.solved_at !== null,
      bestScore: row.best_score ?? null,
      maximumScore: 100,
    });
  }
  return jsonResponse({ catalogs: [...catalogs.values()] }, 200, {
    "cache-control": session ? "private, no-store" : "public, max-age=300", vary: "Cookie",
  });
}

function contentUrl(problemId: string, commit: string, role: "practice" | "contest", contestId?: string): string {
  const parameters = new URLSearchParams({ role, commit });
  if (contestId) parameters.set("contestId", contestId);
  return `/api/problems/${encodeURIComponent(problemId)}/content?${parameters}`;
}

function problemMetadata(problem: ProblemRevisionRow, role: "practice" | "contest", contestId?: string): Record<string, unknown> {
  const practice = role === "practice";
  return {
    schema: "wasm-oj-platform/problem-content-pointer/v1",
    problemId: problem.problem_id,
    catalogCommit: problem.commit_sha,
    problemSlug: problem.slug,
    problemNumber: problem.ordinal,
    title: parseStoredProblemTitle(problem.title_json),
    summary: storedSummary(problem.summary_json),
    practiceEnabled: problem.practice_enabled === 1,
    allowedProfiles: storedAllowedProfiles(problem.allowed_profiles_json),
    maximumScore: 100,
    judgeDigest: problem.judge_digest,
    content: {
      role,
      bytes: practice ? problem.practice_bundle_bytes : problem.contest_bundle_bytes,
      sha256: practice ? problem.practice_bundle_sha256 : problem.contest_bundle_sha256,
      url: contentUrl(problem.problem_id, problem.commit_sha, role, contestId),
    },
  };
}

export async function managedProblemProjection(request: Request, env: WasmOjWorkerEnv, problemId: string): Promise<Response> {
  const contestId = new URL(request.url).searchParams.get("contestId");
  if (contestId === null) {
    const row = await env.DB.prepare(`SELECT revisions.*, problems.catalog_id, problems.slug
      FROM problem_series AS problems JOIN catalogs ON catalogs.id=problems.catalog_id
      JOIN problem_revisions AS revisions ON revisions.problem_id=problems.id AND revisions.commit_sha=catalogs.active_commit_sha
      WHERE problems.id=? AND revisions.practice_enabled=1`).bind(problemId).first<ProblemRevisionRow>();
    if (!row) throw new ApiError(404, "problem-not-found", "Active practice problem was not found.");
    return jsonResponse(problemMetadata(row, "practice"), 200, { "cache-control": "public, max-age=300" });
  }
  if (!UUID.test(contestId)) throw new ApiError(404, "problem-not-found", "Contest context is invalid.");
  const session = await authenticatedSession(request, env);
  const row = await env.DB.prepare(`SELECT revisions.*, problems.catalog_id, problems.slug,
      contest_revisions.access_mode, contest_revisions.status AS contest_status,
      catalogs.organizer_user_id, contest_revisions.starts_at,
      participants.user_id AS participant_user_id
    FROM contest_series AS contests JOIN catalogs ON catalogs.id=contests.catalog_id
    JOIN contest_revisions ON contest_revisions.contest_id=contests.id AND contest_revisions.commit_sha=catalogs.active_commit_sha
    JOIN contest_revision_problems AS selected ON selected.contest_id=contests.id AND selected.commit_sha=contest_revisions.commit_sha
    JOIN problem_series AS problems ON problems.id=selected.problem_id
    JOIN problem_revisions AS revisions ON revisions.problem_id=problems.id AND revisions.commit_sha=selected.commit_sha
    LEFT JOIN contest_participants AS participants ON participants.contest_id=contests.id AND participants.user_id=?
    WHERE contests.id=? AND problems.id=?`).bind(session?.userId ?? "", contestId, problemId)
    .first<ProblemRevisionRow & { access_mode: "public" | "invite"; contest_status: string; organizer_user_id: string; starts_at: string; participant_user_id: string | null }>();
  const organizer = row?.organizer_user_id === session?.userId;
  if (!row || (!organizer && row.contest_status !== "published") || (!organizer && row.starts_at > new Date().toISOString())
    || (row.access_mode === "invite" && !organizer && row.participant_user_id !== session?.userId)) {
    throw new ApiError(404, "problem-not-found", "Contest problem was not found.");
  }
  return jsonResponse(problemMetadata(row, "contest", contestId), 200, {
    "cache-control": row.access_mode === "invite" || row.contest_status === "draft" ? "private, no-store" : "public, max-age=300",
    vary: "Cookie",
  });
}

async function activeProblem(env: WasmOjWorkerEnv, problemId: string): Promise<ProblemRevisionRow> {
  const row = await env.DB.prepare(`SELECT revisions.*, problems.catalog_id, problems.slug
    FROM problem_series AS problems JOIN catalogs ON catalogs.id=problems.catalog_id
    JOIN problem_revisions AS revisions ON revisions.problem_id=problems.id AND revisions.commit_sha=catalogs.active_commit_sha
    WHERE problems.id=?`).bind(problemId).first<ProblemRevisionRow>();
  if (!row) throw new ApiError(404, "problem-not-found", "Active problem was not found.");
  return row;
}

export async function problemLeaderboard(request: Request, env: WasmOjWorkerEnv, problemId: string): Promise<Response> {
  const problem = await activeProblem(env, problemId);
  const availableLanguages = Object.keys(storedAllowedProfiles(problem.allowed_profiles_json)).sort() as BuiltinLanguage[];
  const value = new URL(request.url).searchParams.get("language");
  if (value !== null && (!isBuiltinLanguage(value) || !availableLanguages.includes(value))) {
    throw new ApiError(400, "leaderboard-language-invalid", "Language is not available for this problem leaderboard.");
  }
  const language = value as BuiltinLanguage | null;
  const rawLimit = Number(new URL(request.url).searchParams.get("limit") ?? "50");
  const limit = Number.isSafeInteger(rawLimit) ? Math.min(100, Math.max(1, rawLimit)) : 50;
  return projectLeaderboardEntries(env, {
    frozen: false,
    entries: await queryProblemLeaderboard(env.DB, { problemId, language: language ?? undefined, limit }),
    availableLanguages,
    selectedLanguage: language ?? undefined,
  });
}

export async function problemPerformance(request: Request, env: WasmOjWorkerEnv, problemId: string): Promise<Response> {
  const session = await authenticatedSession(request, env);
  const url = new URL(request.url);
  const contestId = url.searchParams.get("contestId");
  if (contestId !== null && !UUID.test(contestId)) throw new ApiError(404, "problem-not-found", "Contest problem context was not found.");
  const problem = await activeProblem(env, problemId);
  let contest: { organizer_user_id: string; access_mode: string; status: string; freeze_at: string | null; starts_at: string; ends_at: string } | null = null;
  if (contestId) {
    contest = await env.DB.prepare(`SELECT catalogs.organizer_user_id, revisions.access_mode,
        revisions.status, revisions.freeze_at, revisions.starts_at, revisions.ends_at
      FROM contest_series AS contests JOIN catalogs ON catalogs.id=contests.catalog_id
      JOIN contest_revisions AS revisions ON revisions.contest_id=contests.id AND revisions.commit_sha=catalogs.active_commit_sha
      JOIN contest_revision_problems AS selected ON selected.contest_id=contests.id
        AND selected.commit_sha=revisions.commit_sha AND selected.problem_id=?
      WHERE contests.id=?`).bind(problemId, contestId).first<{
        readonly organizer_user_id: string;
        readonly access_mode: string;
        readonly status: string;
        readonly freeze_at: string | null;
        readonly starts_at: string;
        readonly ends_at: string;
      }>();
    if (!contest || contest.status !== "published") throw new ApiError(404, "problem-not-found", "Contest problem context was not found.");
    if (contest.organizer_user_id !== session?.userId && contest.starts_at > new Date().toISOString()) throw new ApiError(404, "problem-not-found", "Contest problem context was not found.");
    if (contest.access_mode === "invite" && contest.organizer_user_id !== session?.userId) {
      const participant = session && await env.DB.prepare("SELECT 1 FROM contest_participants WHERE contest_id=? AND user_id=?")
        .bind(contestId, session.userId).first();
      if (!participant) throw new ApiError(404, "problem-not-found", "Contest problem context was not found.");
    }
  }
  const availableLanguages = Object.keys(storedAllowedProfiles(problem.allowed_profiles_json)).sort() as BuiltinLanguage[];
  const languageValue = url.searchParams.get("language");
  if (languageValue !== null && (!isBuiltinLanguage(languageValue) || !availableLanguages.includes(languageValue))) {
    throw new ApiError(400, "performance-language-invalid", "Language is not available for this performance view.");
  }
  const language = languageValue as BuiltinLanguage | null;
  const now = new Date().toISOString();
  const frozen = Boolean(contestId && contest?.freeze_at && contest.freeze_at <= now && now < contest.ends_at && contest.organizer_user_id !== session?.userId);
  const [frontier, evolution] = await Promise.all([
    queryPerformanceFrontier(env.DB, {
      problemId,
      ...(contestId ? { contestId } : {}),
      ...(language ? { language } : {}),
      ...(frozen && contest?.freeze_at ? { submittedAtOrBefore: contest.freeze_at } : {}),
    }),
    session ? queryPerformanceEvolution(env.DB, {
      userId: session.userId, problemId, ...(contestId ? { contestId } : {}), ...(language ? { language } : {}),
    }) : Promise.resolve(null),
  ]);
  const participants = await leaderboardParticipants(env, frontier.map((entry) => entry.userId));
  return jsonResponse({
    context: { problemId, contestId, frozen, availableLanguages, selectedLanguage: language, myEvolutionTruncated: evolution?.truncated ?? false },
    frontier: frontier.map(({ userId, ...entry }) => ({ ...entry, participant: participants.get(userId) })),
    myEvolution: evolution?.entries ?? null,
  }, 200, { "cache-control": "private, no-store", vary: "Cookie" });
}

function activeContestQuery(): string {
  return `FROM contest_series AS contests
    JOIN catalogs ON catalogs.id=contests.catalog_id
    JOIN contest_revisions AS revisions ON revisions.contest_id=contests.id AND revisions.commit_sha=catalogs.active_commit_sha`;
}

export async function listContests(request: Request, env: WasmOjWorkerEnv): Promise<Response> {
  const session = await authenticatedSession(request, env);
  const rawLimit = Number(new URL(request.url).searchParams.get("limit") ?? "50");
  const limit = Number.isSafeInteger(rawLimit) ? Math.min(100, Math.max(1, rawLimit)) : 50;
  const now = new Date();
  const rows = await env.DB.prepare(`SELECT contests.id, revisions.title, revisions.description,
      revisions.access_mode, revisions.starts_at, revisions.ends_at, revisions.freeze_at,
      CASE WHEN catalogs.organizer_user_id=? THEN 1 ELSE 0 END AS is_organizer,
      CASE WHEN participants.user_id IS NULL THEN 0 ELSE 1 END AS joined,
      profiles.display_name AS organizer_display_name, profiles.visibility AS organizer_visibility,
      github_identities.login AS organizer_login
    ${activeContestQuery()}
    LEFT JOIN contest_participants AS participants ON participants.contest_id=contests.id AND participants.user_id=?
    LEFT JOIN profiles ON profiles.user_id=catalogs.organizer_user_id
    LEFT JOIN github_identities ON github_identities.user_id=catalogs.organizer_user_id
    WHERE revisions.status='published'
      AND (revisions.access_mode='public' OR catalogs.organizer_user_id=? OR participants.user_id IS NOT NULL)
    ORDER BY revisions.starts_at, contests.id LIMIT ?`)
    .bind(session?.userId ?? "", session?.userId ?? "", session?.userId ?? "", limit).all<Record<string, unknown>>();
  return jsonResponse({ contests: rows.results.map((row) => ({
    id: row.id, title: row.title, description: row.description, accessMode: row.access_mode,
    startsAt: row.starts_at, endsAt: row.ends_at, freezeAt: row.freeze_at,
    phase: contestPhase(String(row.starts_at), String(row.ends_at), now),
    joined: row.joined === 1, organizer: row.is_organizer === 1,
    organizerProfile: row.organizer_visibility === "public" && typeof row.organizer_login === "string"
      ? { login: row.organizer_login, displayName: row.organizer_display_name } : null,
  })) });
}

export async function getContest(request: Request, env: WasmOjWorkerEnv, contestId: string): Promise<Response> {
  const session = await authenticatedSession(request, env);
  const contest = await env.DB.prepare(`SELECT contests.id, catalogs.organizer_user_id,
      catalogs.active_commit_sha AS catalog_commit, revisions.title, revisions.description,
      revisions.access_mode, revisions.starts_at, revisions.ends_at, revisions.freeze_at,
      revisions.status, participants.user_id AS participant_user_id
    ${activeContestQuery()}
    LEFT JOIN contest_participants AS participants ON participants.contest_id=contests.id AND participants.user_id=?
    WHERE contests.id=?`).bind(session?.userId ?? "", contestId).first<Record<string, unknown>>();
  const organizer = contest?.organizer_user_id === session?.userId;
  if (!contest || (contest.status !== "published" && !organizer)) throw new ApiError(404, "contest-not-found", "Contest was not found.");
  const now = new Date();
  const joined = contest.participant_user_id === session?.userId;
  const visible = organizer || (contest.status === "published" && String(contest.starts_at) <= now.toISOString()
    && (contest.access_mode === "public" || joined));
  const problems = visible ? await env.DB.prepare(`SELECT selected.ordinal, problems.id AS problem_id,
      problems.slug, revisions.ordinal AS problem_number, revisions.title_json
    FROM contest_revision_problems AS selected
    JOIN problem_series AS problems ON problems.id=selected.problem_id
    JOIN problem_revisions AS revisions ON revisions.problem_id=problems.id AND revisions.commit_sha=selected.commit_sha
    WHERE selected.contest_id=? AND selected.commit_sha=? ORDER BY selected.ordinal`)
    .bind(contestId, contest.catalog_commit).all<Record<string, unknown>>() : { results: [] as readonly Record<string, unknown>[] };
  return jsonResponse({
    contest: {
      id: contest.id, title: contest.title, description: contest.description, accessMode: contest.access_mode,
      startsAt: contest.starts_at, endsAt: contest.ends_at, freezeAt: contest.freeze_at,
      status: contest.status, phase: contestPhase(String(contest.starts_at), String(contest.ends_at), now),
      joined, organizer, catalogCommit: contest.catalog_commit,
    },
    problems: problems.results.map((problem) => ({
      ordinal: problem.ordinal, problemId: problem.problem_id, problemSlug: problem.slug,
      problemNumber: problem.problem_number, title: parseStoredProblemTitle(problem.title_json),
      catalogCommit: contest.catalog_commit,
      contentUrl: contentUrl(String(problem.problem_id), String(contest.catalog_commit), "contest", contestId),
    })),
  });
}

export async function joinContest(request: Request, env: WasmOjWorkerEnv, contestId: string): Promise<Response> {
  const session = await requireBrowserOrBearerMutationSession(request, env);
  await requireFormalMutationsEnabled(env, request);
  const body = exact(await readJsonBody(request, 8 * 1024), [], ["inviteCode"]);
  const contest = await env.DB.prepare(`SELECT revisions.access_mode, contests.invite_code_hash,
      revisions.status, revisions.ends_at ${activeContestQuery()} WHERE contests.id=?`)
    .bind(contestId).first<{ access_mode: string; invite_code_hash: string | null; status: string; ends_at: string }>();
  if (!contest || contest.status !== "published" || contest.ends_at <= new Date().toISOString()) throw new ApiError(409, "contest-closed", "Contest is not open for joining.");
  if (env.INVITE_CODE_HMAC_SECRET.length < 32) throw new Error("Invite-code HMAC secret is not configured.");
  if (contest.access_mode === "invite" && (
    typeof body.inviteCode !== "string" || !contest.invite_code_hash
    || !constantTimeEqual(await hmacSha256Hex(env.INVITE_CODE_HMAC_SECRET, textEncoder.encode(body.inviteCode)), contest.invite_code_hash)
  )) throw new ApiError(403, "contest-invite-invalid", "Invite code is invalid.");
  await env.DB.prepare("INSERT OR IGNORE INTO contest_participants (contest_id, user_id, joined_at) VALUES (?, ?, ?)")
    .bind(contestId, session.userId, new Date().toISOString()).run();
  return jsonResponse({ contestId, joined: true });
}

export async function contestLeaderboard(request: Request, env: WasmOjWorkerEnv, contestId: string): Promise<Response> {
  const session = await authenticatedSession(request, env);
  const contest = await env.DB.prepare(`SELECT catalogs.organizer_user_id, revisions.access_mode,
      revisions.status, revisions.freeze_at, revisions.ends_at ${activeContestQuery()} WHERE contests.id=?`)
    .bind(contestId).first<{ organizer_user_id: string; access_mode: string; status: string; freeze_at: string | null; ends_at: string }>();
  if (!contest || contest.status !== "published") throw new ApiError(404, "contest-not-found", "Contest was not found.");
  if (contest.access_mode === "invite") {
    const participant = session && await env.DB.prepare("SELECT 1 FROM contest_participants WHERE contest_id=? AND user_id=?")
      .bind(contestId, session.userId).first();
    if (!participant && contest.organizer_user_id !== session?.userId) throw new ApiError(404, "contest-not-found", "Contest was not found.");
  }
  const rawLimit = Number(new URL(request.url).searchParams.get("limit") ?? "50");
  const limit = Number.isSafeInteger(rawLimit) ? Math.min(100, Math.max(1, rawLimit)) : 50;
  const now = new Date().toISOString();
  const viewerFrozen = Boolean(contest.freeze_at && contest.freeze_at <= now && now < contest.ends_at && contest.organizer_user_id !== session?.userId);
  let entries = await queryContestLeaderboard(env.DB, {
    contestId, submittedAtOrBefore: viewerFrozen ? contest.freeze_at ?? undefined : undefined, limit,
  });
  if (viewerFrozen) {
    const participants = await env.DB.prepare("SELECT user_id FROM contest_participants WHERE contest_id=? ORDER BY user_id")
      .bind(contestId).all<{ readonly user_id: string }>();
    entries = includeFrozenContestParticipants(entries, participants.results.map((row) => row.user_id), contest.freeze_at ?? now);
  }
  return projectLeaderboardEntries(env, { frozen: viewerFrozen, entries });
}

export function includeFrozenContestParticipants(
  entries: readonly LeaderboardEntryRow[], participantIds: readonly string[], freezeAt: string,
): readonly LeaderboardEntryRow[] {
  const ranked = new Set(entries.map((entry) => entry.userId));
  return [...entries, ...[...new Set(participantIds)].filter((id) => !ranked.has(id)).sort().map((userId) => ({
    userId, score: 0, fullyPassedCases: 0, deterministicCost: 0, peakMemoryBytes: 0,
    achievedAt: freezeAt, attemptedProblems: 0, problemResults: [],
  }))];
}

export async function listOrganizerContests(request: Request, env: WasmOjWorkerEnv): Promise<Response> {
  const session = await requireSession(request, env);
  await requireOrganizer(env, session);
  const status = new URL(request.url).searchParams.get("status");
  if (status !== null && !["draft", "published", "archived"].includes(status)) throw new ApiError(400, "contest-status-invalid", "Contest status is invalid.");
  const rows = await env.DB.prepare(`SELECT contests.id, contests.slug, catalogs.active_commit_sha AS catalog_commit,
      revisions.title, revisions.description, revisions.access_mode, revisions.starts_at,
      revisions.ends_at, revisions.freeze_at, revisions.status, contests.created_at,
      CASE WHEN contests.invite_code_hash IS NULL THEN 0 ELSE 1 END AS invite_code_configured,
      COUNT(selected.problem_id) AS problem_count
    ${activeContestQuery()}
    LEFT JOIN contest_revision_problems AS selected ON selected.contest_id=contests.id AND selected.commit_sha=revisions.commit_sha
    WHERE catalogs.organizer_user_id=? AND (? IS NULL OR revisions.status=?)
    GROUP BY contests.id ORDER BY contests.created_at DESC, contests.id DESC LIMIT 100`)
    .bind(session.userId, status, status).all<Record<string, unknown>>();
  const now = new Date();
  return jsonResponse({ contests: rows.results.map((row) => ({
    id: row.id, slug: row.slug, catalogCommit: row.catalog_commit, title: row.title,
    description: row.description, accessMode: row.access_mode,
    inviteCodeConfigured: row.invite_code_configured === 1, startsAt: row.starts_at,
    endsAt: row.ends_at, freezeAt: row.freeze_at, status: row.status,
    phase: contestPhase(String(row.starts_at), String(row.ends_at), now), problemCount: row.problem_count,
    createdAt: row.created_at,
  })) }, 200, { "cache-control": "private, no-store" });
}

export async function getOrganizerContest(request: Request, env: WasmOjWorkerEnv, contestId: string): Promise<Response> {
  const session = await requireSession(request, env);
  await requireOrganizer(env, session);
  const contest = await env.DB.prepare(`SELECT contests.id, contests.slug, catalogs.active_commit_sha AS catalog_commit,
      revisions.title, revisions.description, revisions.access_mode, revisions.starts_at,
      revisions.ends_at, revisions.freeze_at, revisions.status, contests.created_at,
      CASE WHEN contests.invite_code_hash IS NULL THEN 0 ELSE 1 END AS invite_code_configured
    ${activeContestQuery()} WHERE contests.id=? AND catalogs.organizer_user_id=?`)
    .bind(contestId, session.userId).first<Record<string, unknown>>();
  if (!contest) throw new ApiError(404, "contest-not-found", "Organizer-owned contest was not found.");
  const problems = await env.DB.prepare(`SELECT selected.ordinal, problems.id AS problem_id, problems.slug,
      revisions.ordinal AS problem_number, revisions.title_json
    FROM contest_revision_problems AS selected JOIN problem_series AS problems ON problems.id=selected.problem_id
    JOIN problem_revisions AS revisions ON revisions.problem_id=problems.id AND revisions.commit_sha=selected.commit_sha
    WHERE selected.contest_id=? AND selected.commit_sha=? ORDER BY selected.ordinal`)
    .bind(contestId, contest.catalog_commit).all<Record<string, unknown>>();
  return jsonResponse({
    contest: {
      id: contest.id, slug: contest.slug, catalogCommit: contest.catalog_commit, title: contest.title,
      description: contest.description, accessMode: contest.access_mode,
      inviteCodeConfigured: contest.invite_code_configured === 1,
      startsAt: contest.starts_at, endsAt: contest.ends_at, freezeAt: contest.freeze_at,
      status: contest.status, phase: contestPhase(String(contest.starts_at), String(contest.ends_at)),
      problemCount: problems.results.length, createdAt: contest.created_at,
    },
    problems: problems.results.map((problem) => ({
      ordinal: problem.ordinal, problemId: problem.problem_id, problemSlug: problem.slug,
      problemNumber: problem.problem_number, title: parseStoredProblemTitle(problem.title_json),
    })),
  }, 200, { "cache-control": "private, no-store" });
}

export async function rotateContestInviteCode(request: Request, env: WasmOjWorkerEnv, contestId: string): Promise<Response> {
  const session = await requireBrowserMutationSession(request, env);
  await requireStagingFormalAccess(env, session.userId);
  await requireOrganizer(env, session);
  const body = exact(await readJsonBody(request, 8 * 1024), ["inviteCode"]);
  if (typeof body.inviteCode !== "string" || body.inviteCode.length < 16 || body.inviteCode.length > 128) {
    throw new ApiError(400, "contest-invite-invalid", "Invite code must contain 16–128 characters.");
  }
  if (env.INVITE_CODE_HMAC_SECRET.length < 32) throw new Error("Invite-code HMAC secret is not configured.");
  await requireFormalMutationsEnabled(env, request);
  const digest = await hmacSha256Hex(env.INVITE_CODE_HMAC_SECRET, textEncoder.encode(body.inviteCode));
  const result = await env.DB.prepare(`UPDATE contest_series SET invite_code_hash=?
    WHERE id=? AND EXISTS (
      SELECT 1 ${activeContestQuery()}
      WHERE contests.id=contest_series.id AND catalogs.organizer_user_id=? AND revisions.access_mode='invite'
    )`).bind(digest, contestId, session.userId).run();
  if (result.meta.changes !== 1) throw new ApiError(409, "contest-invite-not-rotatable", "Contest is not an Organizer-owned invite contest.");
  return jsonResponse({ contestId, inviteCodeConfigured: true, rotatedAt: new Date().toISOString() });
}

export async function listOrganizerContestParticipants(
  request: Request, env: WasmOjWorkerEnv, contestId: string,
): Promise<Response> {
  const session = await requireSession(request, env);
  await requireOrganizer(env, session);
  const owned = await env.DB.prepare(`SELECT 1 ${activeContestQuery()} WHERE contests.id=? AND catalogs.organizer_user_id=?`)
    .bind(contestId, session.userId).first();
  if (!owned) throw new ApiError(404, "contest-not-found", "Organizer-owned contest was not found.");
  const url = new URL(request.url);
  const rawLimit = url.searchParams.get("limit") ?? "100";
  const limit = Number(rawLimit);
  const afterJoinedAt = url.searchParams.get("afterJoinedAt");
  const afterUserId = url.searchParams.get("afterUserId");
  if (!/^[1-9]\d{0,2}$/.test(rawLimit) || limit > 100 || ((afterJoinedAt === null) !== (afterUserId === null))
    || (afterUserId !== null && !UUID.test(afterUserId))
    || (afterJoinedAt !== null && (Number.isNaN(Date.parse(afterJoinedAt)) || new Date(afterJoinedAt).toISOString() !== afterJoinedAt))) {
    throw new ApiError(400, "contest-participant-cursor-invalid", "Participant cursor is invalid.");
  }
  const rows = afterJoinedAt === null
    ? await env.DB.prepare("SELECT user_id, joined_at FROM contest_participants WHERE contest_id=? ORDER BY joined_at, user_id LIMIT ?")
      .bind(contestId, limit + 1).all<{ user_id: string; joined_at: string }>()
    : await env.DB.prepare(`SELECT user_id, joined_at FROM contest_participants
      WHERE contest_id=? AND (joined_at>? OR (joined_at=? AND user_id>?)) ORDER BY joined_at, user_id LIMIT ?`)
      .bind(contestId, afterJoinedAt, afterJoinedAt, afterUserId, limit + 1).all<{ user_id: string; joined_at: string }>();
  const page = rows.results.slice(0, limit);
  const identities = await leaderboardParticipants(env, page.map((row) => row.user_id));
  const last = rows.results.length > limit ? page.at(-1) : undefined;
  return jsonResponse({
    participants: page.map((row) => ({ participant: identities.get(row.user_id), joinedAt: row.joined_at })),
    nextCursor: last ? { afterJoinedAt: last.joined_at, afterUserId: last.user_id } : null,
  }, 200, { "cache-control": "private, no-store" });
}
