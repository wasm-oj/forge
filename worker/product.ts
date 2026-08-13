import { authenticatedSession, requireBrowserMutationSession, requireBrowserOrBearerMutationSession, requireSession } from "./auth";
import { constantTimeEqual, hmacSha256Hex } from "./crypto";
import type { WasmOjWorkerEnv } from "./env";
import { requireOrganizer } from "./github";
import { ApiError, jsonResponse, readJsonBody } from "./http";
import { requireStagingFormalAccess } from "./formal-access";
import { requireFormalMutationsEnabled } from "./formal-mutations";
import { queryContestLeaderboard, queryProblemLeaderboard, type LeaderboardEntryRow } from "./leaderboards";
import { queryPerformanceEvolution, queryPerformanceFrontier } from "./performance";
import { parseStoredProblemTitle } from "../src/online-judge/stored-problem-title";
import { parseJudgeAllowedProfiles, type JudgeAllowedProfiles } from "../src/online-judge/compile-profiles";
import { isBuiltinLanguage, type BuiltinLanguage } from "../src/core/types";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
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

function exact(value: unknown, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ApiError(400, "payload-invalid", "Payload must be an object.");
  }
  const record = value as Record<string, unknown>;
  const allowed = new Set([...required, ...optional]);
  if (
    required.some((key) => !Object.hasOwn(record, key))
    || Object.keys(record).some((key) => !allowed.has(key))
  ) throw new ApiError(400, "payload-invalid", "Payload has an invalid shape.");
  return record;
}

function timestamp(value: unknown, label: string): string {
  if (typeof value !== "string" || Number.isNaN(Date.parse(value)) || new Date(value).toISOString() !== value) {
    throw new ApiError(400, "timestamp-invalid", `${label} must be a canonical ISO timestamp.`);
  }
  return value;
}

function storedStringArray(value: unknown, label: string): string[] {
  if (typeof value !== "string") throw new Error(`${label} is missing.`);
  const parsed: unknown = JSON.parse(value);
  if (!Array.isArray(parsed) || parsed.length > 32 || parsed.some((item) => typeof item !== "string")) {
    throw new Error(`${label} is invalid.`);
  }
  return parsed;
}

function optionalStoredStringArray(value: unknown, label: string): string[] {
  return value === null ? [] : storedStringArray(value, label);
}

function storedAllowedProfiles(value: unknown): JudgeAllowedProfiles {
  if (typeof value !== "string") throw new Error("Problem allowed profiles are missing.");
  const parsed: unknown = JSON.parse(value);
  return parseJudgeAllowedProfiles(parsed, "stored problem allowedProfiles");
}

function configuredOfficialRepositoryId(env: WasmOjWorkerEnv): number {
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
  return {
    displayName: row.display_name,
    bio: row.bio,
    websiteUrl: row.website_url,
    login: row.login,
    avatarUrl: row.avatar_url,
  };
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
  if (unique.length === 0) return new Map();
  if (unique.length > 100 || unique.some((id) => typeof id !== "string" || id.length < 1 || id.length > 128)) {
    throw new Error("Leaderboard returned an invalid participant inventory.");
  }
  const activeIds = unique.filter((id) => UUID_PATTERN.test(id));
  const identities = activeIds.length === 0
    ? []
    : (await env.DB.prepare(`SELECT users.id AS user_id, users.status, profiles.display_name,
          profiles.visibility, github_identities.login, github_identities.avatar_url
        FROM users
        LEFT JOIN profiles ON profiles.user_id=users.id
        LEFT JOIN github_identities ON github_identities.user_id=users.id
        WHERE users.id IN (${activeIds.map(() => "?").join(",")})`)
      .bind(...activeIds).all<LeaderboardIdentityRow>()).results;
  const byId = new Map(identities.map((identity) => [identity.user_id, identity] as const));
  const projected = new Map<string, LeaderboardParticipant>();
  await Promise.all(unique.map(async (userId) => {
    const id = await leaderboardParticipantId(env, userId);
    const identity = byId.get(userId);
    if (identity?.status === "active" && identity.visibility === "public" && identity.login && identity.avatar_url) {
      projected.set(userId, { id, kind: "profile", label: identity.display_name, login: identity.login, avatarUrl: identity.avatar_url });
      return;
    }
    const deleted = /^erased-[0-9a-f]{32}$/.test(userId) || identity?.status === "suspended";
    projected.set(userId, {
      id,
      kind: deleted ? "deleted" : "anonymous",
      label: deleted ? "Deleted participant" : `Private participant ${id.slice(-6)}`,
    });
  }));
  return projected;
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
    ...(input.availableLanguages ? {
      availableLanguages: input.availableLanguages,
      selectedLanguage: input.selectedLanguage ?? null,
    } : {}),
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
    FROM profiles
    JOIN github_identities ON github_identities.user_id=profiles.user_id
    WHERE profiles.user_id=?`)
    .bind(session.userId).first<{ display_name: string; bio: string; website_url: string | null; visibility: "public" | "private"; login: string; avatar_url: string }>();
  if (!profile) throw new ApiError(404, "profile-not-found", "Profile was not found.");
  const solved = await env.DB.prepare(`SELECT COUNT(DISTINCT origin.problem_series_id) AS count
    FROM effective_submission_results AS effective
    JOIN submissions AS origin ON origin.id=effective.origin_submission_id
    JOIN submissions AS result ON result.id=effective.effective_submission_id
    JOIN official_practice_heads AS heads
      ON heads.problem_series_id=origin.problem_series_id
     AND heads.problem_version_id=effective.effective_problem_version_id
    JOIN problem_version_details AS versions ON versions.id=heads.problem_version_id
    WHERE origin.user_id=? AND origin.contest_id IS NULL
      AND result.state='completed' AND result.score>=versions.maximum_score`)
    .bind(session.userId).first<{ count: number }>();
  return jsonResponse({ profile: {
    ...publicProfileProjection(profile),
    visibility: profile.visibility,
    verifiedSolvedCount: solved?.count ?? 0,
  } });
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
    if (website.protocol !== "https:" || website.username || website.password) {
      throw new ApiError(400, "profile-invalid", "Website URL must be credential-free HTTPS.");
    }
  }
  await env.DB.prepare("UPDATE profiles SET display_name=?, bio=?, website_url=?, visibility=?, updated_at=? WHERE user_id=?")
    .bind(body.displayName.trim(), body.bio, body.websiteUrl ?? null, body.visibility, new Date().toISOString(), session.userId).run();
  return jsonResponse({ updated: true });
}

export async function publicProfile(request: Request, env: WasmOjWorkerEnv, login: string): Promise<Response> {
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(login)) throw new ApiError(404, "profile-not-found", "Profile was not found.");
  const profile = await env.DB.prepare(`SELECT profiles.user_id, profiles.display_name, profiles.bio,
      profiles.website_url, github_identities.login, github_identities.avatar_url
    FROM profiles
    JOIN github_identities ON github_identities.user_id=profiles.user_id
    JOIN users ON users.id=profiles.user_id
    WHERE github_identities.login=? COLLATE NOCASE AND profiles.visibility='public' AND users.status='active'`)
    .bind(login).first<{ user_id: string; display_name: string; bio: string; website_url: string | null; login: string; avatar_url: string }>();
  if (!profile) throw new ApiError(404, "profile-not-found", "Profile was not found.");
  const solves = await env.DB.prepare(`WITH eligible AS (
      SELECT effective.effective_problem_version_id AS problem_version_id,
        origin.problem_series_id,
        result.score,
        origin.completed_at AS solved_at,
        result.id AS result_id,
        ROW_NUMBER() OVER (
          PARTITION BY origin.problem_series_id
          ORDER BY result.score DESC, origin.completed_at ASC, result.id ASC
        ) AS solve_rank
      FROM effective_submission_results AS effective
      JOIN submissions AS origin ON origin.id=effective.origin_submission_id
      JOIN submissions AS result ON result.id=effective.effective_submission_id
      JOIN official_practice_heads AS heads
        ON heads.problem_series_id=origin.problem_series_id
       AND heads.problem_version_id=effective.effective_problem_version_id
      JOIN problem_version_details AS versions ON versions.id=heads.problem_version_id
      WHERE origin.user_id=? AND origin.contest_id IS NULL
        AND result.state='completed' AND result.score>=versions.maximum_score
    )
    SELECT eligible.problem_version_id, eligible.score, eligible.solved_at,
      versions.problem_slug, versions.title_json
    FROM eligible
    JOIN problem_version_details AS versions ON versions.id=eligible.problem_version_id
    WHERE eligible.solve_rank=1
    ORDER BY eligible.solved_at DESC, eligible.problem_version_id`)
    .bind(profile.user_id).all<Record<string, unknown>>();
  return jsonResponse({ profile: {
    ...publicProfileProjection(profile),
    verifiedSolvedCount: solves.results.length,
    verifiedSolves: solves.results.map((solve) => ({
      problemVersionId: solve.problem_version_id,
      score: solve.score,
      solvedAt: solve.solved_at,
      problemSlug: solve.problem_slug,
      title: parseStoredProblemTitle(solve.title_json),
    })),
  } });
}

export async function listProblems(request: Request, env: WasmOjWorkerEnv): Promise<Response> {
  const session = await authenticatedSession(request, env);
  const officialRepositoryId = configuredOfficialRepositoryId(env);
  const rows = await env.DB.prepare(`WITH progress AS (
      SELECT effective.effective_problem_version_id AS problem_version_id,
        MAX(result.score) AS best_score,
        MIN(CASE WHEN result.score>=versions.maximum_score THEN origin.completed_at END) AS solved_at
      FROM effective_submission_results AS effective
      JOIN submissions AS origin ON origin.id=effective.origin_submission_id
      JOIN submissions AS result ON result.id=effective.effective_submission_id
      JOIN problem_version_details AS versions ON versions.id=effective.effective_problem_version_id
      WHERE origin.user_id=? AND origin.contest_id IS NULL AND result.state='completed'
      GROUP BY effective.effective_problem_version_id
    )
    SELECT publications.id AS publication_id,
      revisions.collection_revision_sha256, revisions.commit_sha, publications.published_at,
      repositories.github_repository_id, repositories.owner_login, repositories.name AS repository_name,
      versions.id, versions.problem_series_id, versions.execution_semantic_sha256,
      versions.practice_bundle_sha256, versions.problem_slug, versions.problem_number,
      versions.title_json, versions.difficulty, versions.tags_json, versions.track_id,
      versions.track_json, versions.maximum_score, progress.best_score, progress.solved_at
    FROM official_practice_heads AS heads
    JOIN problem_version_details AS versions ON versions.id=heads.problem_version_id
    JOIN catalog_publications AS publications ON publications.id=versions.catalog_publication_id
    JOIN collection_revisions AS revisions ON revisions.id=versions.collection_revision_id
    JOIN problem_collections AS collections ON collections.id=versions.collection_id
    JOIN github_repositories AS repositories ON repositories.github_repository_id=collections.github_repository_id
    LEFT JOIN progress ON progress.problem_version_id=versions.id
    ORDER BY CASE WHEN repositories.github_repository_id=? THEN 0 ELSE 1 END,
      repositories.owner_login COLLATE NOCASE, repositories.name COLLATE NOCASE,
      publications.published_at DESC, versions.problem_number`)
    .bind(session?.userId ?? "", officialRepositoryId).all<Record<string, unknown>>();
  const collections = new Map<string, {
    publicationId: string;
    revision: string;
    commitSha: string;
    publishedAt: string;
    repository: { id: number; owner: string; name: string };
    official: boolean;
    problems: Array<Record<string, unknown>>;
  }>();
  for (const row of rows.results) {
    const publicationId = String(row.publication_id);
    let collection = collections.get(publicationId);
    if (!collection) {
      collection = {
        publicationId,
        revision: String(row.collection_revision_sha256),
        commitSha: String(row.commit_sha),
        publishedAt: String(row.published_at),
        repository: { id: Number(row.github_repository_id), owner: String(row.owner_login), name: String(row.repository_name) },
        official: Number(row.github_repository_id) === officialRepositoryId,
        problems: [],
      };
      collections.set(publicationId, collection);
    }
    collection.problems.push({
      id: row.id,
      seriesId: row.problem_series_id,
      executionSemanticDigest: row.execution_semantic_sha256,
      contentDigest: row.practice_bundle_sha256,
      contentUrl: `/api/problems/${encodeURIComponent(String(row.id))}/content?role=practice`,
      slug: row.problem_slug,
      number: row.problem_number,
      title: parseStoredProblemTitle(row.title_json),
      difficulty: row.difficulty,
      tags: optionalStoredStringArray(row.tags_json, "Problem tags"),
      trackId: row.track_id,
      track: row.track_json === null ? null : parseStoredProblemTitle(row.track_json),
      maximumScore: row.maximum_score,
      solved: row.solved_at !== null,
      bestScore: row.best_score ?? null,
    });
  }
  return jsonResponse({ collections: [...collections.values()] }, 200, {
    "cache-control": session ? "private, no-store" : "public, max-age=300",
    vary: "Cookie",
  });
}

export async function problemLeaderboard(request: Request, env: WasmOjWorkerEnv, problemVersionId: string): Promise<Response> {
  const problem = await env.DB.prepare(`SELECT versions.id, versions.allowed_profiles_json
    FROM problem_version_details AS versions
    WHERE versions.id=? AND versions.mode='official-practice'`)
    .bind(problemVersionId).first<{ id: string; allowed_profiles_json: string }>();
  if (!problem) throw new ApiError(404, "problem-not-found", "Problem version was not found.");
  const profiles = storedAllowedProfiles(problem.allowed_profiles_json);
  const availableLanguages = Object.keys(profiles).sort() as BuiltinLanguage[];
  const url = new URL(request.url);
  const selectedLanguageValue = url.searchParams.get("language");
  if (
    selectedLanguageValue !== null
    && (!isBuiltinLanguage(selectedLanguageValue) || !availableLanguages.includes(selectedLanguageValue))
  ) throw new ApiError(400, "leaderboard-language-invalid", "Language is not available for this problem leaderboard.");
  const selectedLanguage = selectedLanguageValue as BuiltinLanguage | null;
  const rawLimit = Number(url.searchParams.get("limit") ?? "50");
  const limit = Number.isSafeInteger(rawLimit) ? Math.min(100, Math.max(1, rawLimit)) : 50;
  const entries = await queryProblemLeaderboard(env.DB, {
    problemVersionId,
    language: selectedLanguage ?? undefined,
    limit,
  });
  return projectLeaderboardEntries(env, {
    frozen: false,
    entries,
    availableLanguages,
    selectedLanguage: selectedLanguage ?? undefined,
  });
}

interface PerformanceProblemContextRow {
  readonly problem_series_id: string;
  readonly allowed_profiles_json: string;
  readonly organizer_user_id?: string;
  readonly access_mode?: "public" | "invite";
  readonly status?: "draft" | "published" | "archived";
  readonly freeze_at?: string | null;
  readonly starts_at?: string;
  readonly ends_at?: string;
}

export async function problemPerformance(request: Request, env: WasmOjWorkerEnv, problemVersionId: string): Promise<Response> {
  const session = await authenticatedSession(request, env);
  const url = new URL(request.url);
  const contestId = url.searchParams.get("contestId");
  if (contestId !== null && !UUID_PATTERN.test(contestId)) {
    throw new ApiError(404, "problem-not-found", "Contest problem context was not found.");
  }

  let context: PerformanceProblemContextRow | null;
  if (contestId) {
    context = await env.DB.prepare(`SELECT contest_problem.problem_series_id,
        versions.allowed_profiles_json, contests.organizer_user_id, contests.access_mode,
        contests.status, contests.freeze_at, contests.starts_at, contests.ends_at
      FROM contest_problems AS contest_problem
      JOIN contests ON contests.id=contest_problem.contest_id
      JOIN problem_version_details AS versions ON versions.id=contest_problem.problem_version_id
      WHERE contest_problem.contest_id=? AND contest_problem.problem_version_id=?
        AND versions.mode='contest'`)
      .bind(contestId, problemVersionId).first<PerformanceProblemContextRow>();
    if (!context || context.status !== "published") {
      throw new ApiError(404, "problem-not-found", "Contest problem context was not found.");
    }
    if (context.organizer_user_id !== session?.userId
      && (typeof context.starts_at !== "string" || context.starts_at > new Date().toISOString())) {
      throw new ApiError(404, "problem-not-found", "Contest problem context was not found.");
    }
    if (context.access_mode === "invite" && context.organizer_user_id !== session?.userId) {
      const participant = session && await env.DB.prepare(
        "SELECT 1 AS allowed FROM contest_participants WHERE contest_id=? AND user_id=?",
      ).bind(contestId, session.userId).first();
      if (!participant) throw new ApiError(404, "problem-not-found", "Contest problem context was not found.");
    }
  } else {
    context = await env.DB.prepare(`SELECT versions.problem_series_id, versions.allowed_profiles_json
      FROM official_practice_heads AS heads
      JOIN problem_version_details AS versions ON versions.id=heads.problem_version_id
      WHERE heads.problem_version_id=? AND versions.mode='official-practice'`)
      .bind(problemVersionId).first<PerformanceProblemContextRow>();
    if (!context) throw new ApiError(404, "problem-not-found", "Problem version was not found.");
  }

  const profiles = storedAllowedProfiles(context.allowed_profiles_json);
  const availableLanguages = Object.keys(profiles).sort() as BuiltinLanguage[];
  const languageValue = url.searchParams.get("language");
  if (
    languageValue !== null
    && (!isBuiltinLanguage(languageValue) || !availableLanguages.includes(languageValue))
  ) throw new ApiError(400, "performance-language-invalid", "Language is not available for this performance view.");
  const language = languageValue as BuiltinLanguage | null;
  const now = new Date().toISOString();
  const frozen = contestId !== null
    && context.freeze_at !== null
    && context.freeze_at !== undefined
    && context.freeze_at <= now
    && typeof context.ends_at === "string"
    && now < context.ends_at
    && context.organizer_user_id !== session?.userId;

  const [frontier, evolution] = await Promise.all([
    queryPerformanceFrontier(env.DB, {
      problemVersionId,
      ...(contestId ? { contestId } : {}),
      ...(language ? { language } : {}),
      ...(frozen && context.freeze_at ? { submittedAtOrBefore: context.freeze_at } : {}),
    }),
    session
      ? queryPerformanceEvolution(env.DB, {
        userId: session.userId,
        problemSeriesId: context.problem_series_id,
        ...(contestId ? { contestId } : {}),
        ...(language ? { language } : {}),
      })
      : Promise.resolve(null),
  ]);
  const participants = await leaderboardParticipants(env, frontier.map((entry) => entry.userId));
  return jsonResponse({
    context: {
      problemVersionId,
      contestId,
      frozen,
      availableLanguages,
      selectedLanguage: language,
      myEvolutionTruncated: evolution?.truncated ?? false,
    },
    frontier: frontier.map(({ userId, ...entry }) => ({
      ...entry,
      participant: participants.get(userId)
        ?? { id: "participant-unavailable", kind: "anonymous", label: "Private participant" },
    })),
    myEvolution: evolution?.entries ?? null,
  }, 200, { "cache-control": "private, no-store", vary: "Cookie" });
}

export async function listContests(request: Request, env: WasmOjWorkerEnv): Promise<Response> {
  const session = await authenticatedSession(request, env);
  const rawLimit = Number(new URL(request.url).searchParams.get("limit") ?? "50");
  const limit = Number.isSafeInteger(rawLimit) ? Math.min(100, Math.max(1, rawLimit)) : 50;
  const now = new Date();
  const timestampNow = now.toISOString();
  const rows = await env.DB.prepare(`SELECT contests.id, contests.title, contests.description,
      contests.access_mode, contests.starts_at, contests.ends_at, contests.freeze_at,
      CASE WHEN contests.organizer_user_id=? THEN 1 ELSE 0 END AS is_organizer,
      CASE WHEN contest_participants.user_id IS NULL THEN 0 ELSE 1 END AS joined,
      profiles.display_name AS organizer_display_name, profiles.visibility AS organizer_visibility,
      github_identities.login AS organizer_login
    FROM contests
    LEFT JOIN contest_participants
      ON contest_participants.contest_id=contests.id AND contest_participants.user_id=?
    LEFT JOIN profiles ON profiles.user_id=contests.organizer_user_id
    LEFT JOIN github_identities ON github_identities.user_id=contests.organizer_user_id
    WHERE contests.status='published'
      AND (contests.access_mode='public' OR contests.organizer_user_id=? OR contest_participants.user_id IS NOT NULL)
    ORDER BY CASE WHEN contests.ends_at>? AND contests.starts_at<=? THEN 0
      WHEN contests.starts_at>? THEN 1 ELSE 2 END, contests.starts_at ASC, contests.id ASC
    LIMIT ?`)
    .bind(session?.userId ?? "", session?.userId ?? "", session?.userId ?? "", timestampNow, timestampNow, timestampNow, limit)
    .all<Record<string, unknown>>();
  return jsonResponse({ contests: rows.results.map((row) => ({
    id: row.id,
    title: row.title,
    description: row.description,
    accessMode: row.access_mode,
    startsAt: row.starts_at,
    endsAt: row.ends_at,
    freezeAt: row.freeze_at,
    phase: contestPhase(String(row.starts_at), String(row.ends_at), now),
    joined: row.joined === 1,
    organizer: row.is_organizer === 1,
    organizerProfile: row.organizer_visibility === "public" && typeof row.organizer_login === "string"
      ? { login: row.organizer_login, displayName: row.organizer_display_name }
      : null,
  })) });
}

interface ProblemMetadataRow {
  readonly id: string;
  readonly problem_series_id: string;
  readonly catalog_publication_id: string;
  readonly mode: "official-practice" | "contest";
  readonly problem_slug: string;
  readonly problem_number: number;
  readonly title_json: string;
  readonly difficulty: string | null;
  readonly tags_json: string | null;
  readonly track_id: string | null;
  readonly track_json: string | null;
  readonly allowed_profiles_json: string;
  readonly maximum_score: number;
  readonly execution_semantic_sha256: string;
  readonly practice_bundle_bytes: number;
  readonly practice_bundle_sha256: string;
  readonly contest_public_bytes: number;
  readonly contest_public_sha256: string;
}

function contentUrl(problemVersionId: string, role: "practice" | "contest-public", contestId?: string): string {
  const parameters = new URLSearchParams({ role });
  if (contestId) parameters.set("contestId", contestId);
  return `/api/problems/${encodeURIComponent(problemVersionId)}/content?${parameters}`;
}

function problemMetadata(
  problem: ProblemMetadataRow,
  role: "practice" | "contest-public",
  contestId?: string,
): Record<string, unknown> {
  const practice = role === "practice";
  return {
    schema: "wasm-oj-platform/problem-content-pointer/v2",
    problemVersionId: problem.id,
    problemSeriesId: problem.problem_series_id,
    catalogPublicationId: problem.catalog_publication_id,
    mode: problem.mode,
    problemSlug: problem.problem_slug,
    problemNumber: problem.problem_number,
    title: parseStoredProblemTitle(problem.title_json),
    difficulty: problem.difficulty,
    tags: optionalStoredStringArray(problem.tags_json, "Problem tags"),
    trackId: problem.track_id,
    track: problem.track_json === null ? null : parseStoredProblemTitle(problem.track_json),
    allowedProfiles: storedAllowedProfiles(problem.allowed_profiles_json),
    maximumScore: problem.maximum_score,
    executionSemanticDigest: problem.execution_semantic_sha256,
    content: {
      role,
      bytes: practice ? problem.practice_bundle_bytes : problem.contest_public_bytes,
      sha256: practice ? problem.practice_bundle_sha256 : problem.contest_public_sha256,
      url: contentUrl(problem.id, role, contestId),
    },
  };
}

/** Returns D1 metadata only; exact-commit bytes are served by catalog.publicProblemContent. */
export async function managedProblemProjection(request: Request, env: WasmOjWorkerEnv, problemVersionId: string): Promise<Response> {
  const contestId = new URL(request.url).searchParams.get("contestId");
  if (contestId === null) {
    const problem = await env.DB.prepare(`SELECT versions.*
      FROM official_practice_heads AS heads
      JOIN problem_version_details AS versions ON versions.id=heads.problem_version_id
      WHERE heads.problem_version_id=?`)
      .bind(problemVersionId).first<ProblemMetadataRow>();
    if (!problem) throw new ApiError(404, "problem-not-found", "Active practice problem was not found.");
    return jsonResponse(problemMetadata(problem, "practice"), 200, { "cache-control": "public, max-age=300" });
  }
  if (!UUID_PATTERN.test(contestId)) throw new ApiError(404, "problem-not-found", "Contest context is invalid.");
  const session = await authenticatedSession(request, env);
  const row = await env.DB.prepare(`SELECT versions.*,
      contests.access_mode, contests.status AS contest_status, contests.organizer_user_id,
      contests.starts_at, contest_participants.user_id AS participant_user_id
    FROM contest_problems
    JOIN contests ON contests.id=contest_problems.contest_id
    JOIN problem_version_details AS versions ON versions.id=contest_problems.problem_version_id
    LEFT JOIN contest_participants
      ON contest_participants.contest_id=contests.id AND contest_participants.user_id=?
    WHERE contest_problems.contest_id=? AND contest_problems.problem_version_id=?`)
    .bind(session?.userId ?? "", contestId, problemVersionId).first<ProblemMetadataRow & {
      readonly access_mode: "public" | "invite";
      readonly contest_status: "draft" | "published" | "archived";
      readonly organizer_user_id: string;
      readonly starts_at: string;
      readonly participant_user_id: string | null;
    }>();
  const organizer = row?.organizer_user_id === session?.userId;
  if (
    !row
    || (!organizer && row.contest_status !== "published")
    || (!organizer && row.starts_at > new Date().toISOString())
    || (row.access_mode === "invite" && !organizer && row.participant_user_id !== session?.userId)
  ) throw new ApiError(404, "problem-not-found", "Contest problem was not found.");
  return jsonResponse(problemMetadata(row, "contest-public", contestId), 200, {
    "cache-control": row.access_mode === "invite" || row.contest_status === "draft"
      ? "private, no-store"
      : "public, max-age=300",
    vary: "Cookie",
  });
}

interface ContestDraftInput {
  readonly title: string;
  readonly description: string;
  readonly accessMode: "public" | "invite";
  readonly inviteCode?: string;
  readonly startsAt: string;
  readonly endsAt: string;
  readonly freezeAt?: string;
  readonly problemVersionIds: readonly string[];
}

async function contestDraftInput(request: Request): Promise<ContestDraftInput> {
  const body = exact(await readJsonBody(request, 64 * 1024), [
    "title", "description", "accessMode", "startsAt", "endsAt", "problemVersionIds",
  ], ["freezeAt", "inviteCode"]);
  if (
    typeof body.title !== "string" || body.title.trim().length < 1 || body.title.length > 120
    || typeof body.description !== "string" || body.description.length > 10_000
    || (body.accessMode !== "public" && body.accessMode !== "invite")
    || !Array.isArray(body.problemVersionIds) || body.problemVersionIds.length < 1 || body.problemVersionIds.length > 100
    || body.problemVersionIds.some((id) => typeof id !== "string" || !UUID_PATTERN.test(id))
    || new Set(body.problemVersionIds).size !== body.problemVersionIds.length
  ) throw new ApiError(400, "contest-invalid", "Contest fields are invalid.");
  const startsAt = timestamp(body.startsAt, "startsAt");
  const endsAt = timestamp(body.endsAt, "endsAt");
  const freezeAt = body.freezeAt === undefined ? undefined : timestamp(body.freezeAt, "freezeAt");
  if (endsAt <= startsAt || (freezeAt && (freezeAt <= startsAt || freezeAt >= endsAt))) {
    throw new ApiError(400, "contest-time-invalid", "Contest time range is invalid.");
  }
  if (body.inviteCode !== undefined && (typeof body.inviteCode !== "string" || body.inviteCode.length < 16 || body.inviteCode.length > 128)) {
    throw new ApiError(400, "contest-invite-invalid", "Invite code must contain 16–128 characters.");
  }
  if (body.accessMode === "public" && body.inviteCode !== undefined) {
    throw new ApiError(400, "contest-invite-invalid", "Public contests cannot have an invite code.");
  }
  return {
    title: body.title.trim(),
    description: body.description,
    accessMode: body.accessMode,
    ...(typeof body.inviteCode === "string" ? { inviteCode: body.inviteCode } : {}),
    startsAt,
    endsAt,
    ...(freezeAt ? { freezeAt } : {}),
    problemVersionIds: body.problemVersionIds as string[],
  };
}

interface OwnedContestProblem {
  readonly id: string;
  readonly problem_series_id: string;
  readonly catalog_publication_id: string;
}

async function requireOwnedContestProblems(
  env: WasmOjWorkerEnv,
  userId: string,
  ids: readonly string[],
): Promise<readonly OwnedContestProblem[]> {
  const placeholders = ids.map(() => "?").join(",");
  const versions = await env.DB.prepare(`SELECT versions.id, versions.problem_series_id,
      versions.catalog_publication_id
    FROM problem_version_details AS versions
    JOIN problem_collections AS collections ON collections.id=versions.collection_id
    WHERE versions.id IN (${placeholders}) AND versions.mode='contest'
      AND collections.organizer_user_id=?`)
    .bind(...ids, userId).all<OwnedContestProblem>();
  if (versions.results.length !== ids.length) {
    throw new ApiError(409, "contest-problem-invalid", "Every contest problem must be an Organizer-owned published contest version.");
  }
  if (new Set(versions.results.map((version) => version.catalog_publication_id)).size !== 1) {
    throw new ApiError(409, "contest-publication-invalid", "A contest must bind problem versions from one explicit contest publication.");
  }
  const byId = new Map(versions.results.map((version) => [version.id, version] as const));
  return ids.map((id) => {
    const version = byId.get(id);
    if (!version) throw new Error("Contest problem lookup lost an accepted version.");
    return version;
  });
}

function contestProblemInsert(
  env: WasmOjWorkerEnv,
  contestId: string,
  problem: OwnedContestProblem,
  ordinal: number,
  ownerFence?: string,
): D1PreparedStatement {
  if (!ownerFence) {
    return env.DB.prepare(`INSERT INTO contest_problems
      (contest_id, problem_series_id, problem_version_id, ordinal)
      VALUES (?, ?, ?, ?)`)
      .bind(contestId, problem.problem_series_id, problem.id, ordinal);
  }
  return env.DB.prepare(`INSERT INTO contest_problems
      (contest_id, problem_series_id, problem_version_id, ordinal)
    SELECT ?, ?, ?, ?
    WHERE EXISTS (SELECT 1 FROM contests WHERE id=? AND organizer_user_id=? AND status='draft')`)
    .bind(contestId, problem.problem_series_id, problem.id, ordinal, contestId, ownerFence);
}

export async function createContest(request: Request, env: WasmOjWorkerEnv): Promise<Response> {
  const session = await requireBrowserOrBearerMutationSession(request, env);
  await requireStagingFormalAccess(env, session.userId);
  await requireOrganizer(env, session);
  const input = await contestDraftInput(request);
  if (input.accessMode === "invite" && input.inviteCode === undefined) {
    throw new ApiError(400, "contest-invite-invalid", "Invite contests require a 16–128 character code.");
  }
  const problems = await requireOwnedContestProblems(env, session.userId, input.problemVersionIds);
  const contestId = crypto.randomUUID();
  const now = new Date().toISOString();
  if (env.INVITE_CODE_HMAC_SECRET.length < 32) throw new Error("Invite-code HMAC secret is not configured.");
  const inviteCodeHash = input.inviteCode
    ? await hmacSha256Hex(env.INVITE_CODE_HMAC_SECRET, textEncoder.encode(input.inviteCode))
    : null;
  await requireFormalMutationsEnabled(env, request);
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO contests
      (id, organizer_user_id, catalog_publication_id, title, description, access_mode, invite_code_hash,
       starts_at, ends_at, freeze_at, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?)`)
      .bind(contestId, session.userId, problems[0]!.catalog_publication_id,
        input.title, input.description, input.accessMode,
        inviteCodeHash, input.startsAt, input.endsAt, input.freezeAt ?? null, now, now),
    ...problems.map((problem, index) => contestProblemInsert(env, contestId, problem, index + 1)),
  ]);
  return jsonResponse({
    contestId,
    status: "draft",
    catalogPublicationId: problems[0]!.catalog_publication_id,
  }, 201);
}

export async function listOrganizerContests(request: Request, env: WasmOjWorkerEnv): Promise<Response> {
  const session = await requireSession(request, env);
  await requireOrganizer(env, session);
  const status = new URL(request.url).searchParams.get("status");
  if (status !== null && !["draft", "published", "archived"].includes(status)) {
    throw new ApiError(400, "contest-status-invalid", "Contest status is invalid.");
  }
  const rows = await env.DB.prepare(`SELECT contests.id, contests.title, contests.description,
      contests.access_mode, contests.starts_at, contests.ends_at, contests.freeze_at,
      contests.status, contests.created_at, contests.updated_at, contests.catalog_publication_id,
      CASE WHEN contests.invite_code_hash IS NULL THEN 0 ELSE 1 END AS invite_code_configured,
      COUNT(contest_problems.problem_version_id) AS problem_count
    FROM contests
    LEFT JOIN contest_problems ON contest_problems.contest_id=contests.id
    WHERE contests.organizer_user_id=? AND (? IS NULL OR contests.status=?)
    GROUP BY contests.id
    ORDER BY contests.updated_at DESC, contests.id DESC
    LIMIT 100`)
    .bind(session.userId, status, status).all<Record<string, unknown>>();
  const now = new Date();
  return jsonResponse({ contests: rows.results.map((row) => ({
    id: row.id,
    title: row.title,
    description: row.description,
    accessMode: row.access_mode,
    inviteCodeConfigured: row.invite_code_configured === 1,
    startsAt: row.starts_at,
    endsAt: row.ends_at,
    freezeAt: row.freeze_at,
    status: row.status,
    phase: contestPhase(String(row.starts_at), String(row.ends_at), now),
    problemCount: row.problem_count,
    catalogPublicationId: row.catalog_publication_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  })) }, 200, { "cache-control": "private, no-store" });
}

export async function getOrganizerContest(request: Request, env: WasmOjWorkerEnv, contestId: string): Promise<Response> {
  const session = await requireSession(request, env);
  await requireOrganizer(env, session);
  const contest = await env.DB.prepare(`SELECT id, title, description, access_mode,
      CASE WHEN invite_code_hash IS NULL THEN 0 ELSE 1 END AS invite_code_configured,
      starts_at, ends_at, freeze_at, status, catalog_publication_id, created_at, updated_at
    FROM contests WHERE id=? AND organizer_user_id=?`)
    .bind(contestId, session.userId).first<Record<string, unknown>>();
  if (!contest) throw new ApiError(404, "contest-not-found", "Organizer-owned contest was not found.");
  const problems = await env.DB.prepare(`SELECT contest_problems.ordinal,
      versions.id AS problem_version_id, versions.problem_series_id, versions.problem_slug,
      versions.problem_number, versions.title_json, versions.catalog_publication_id,
      revisions.collection_revision_sha256, repositories.owner_login,
      repositories.name AS repository_name
    FROM contest_problems
    JOIN problem_version_details AS versions ON versions.id=contest_problems.problem_version_id
    JOIN collection_revisions AS revisions ON revisions.id=versions.collection_revision_id
    JOIN problem_collections AS collections ON collections.id=versions.collection_id
    JOIN github_repositories AS repositories ON repositories.github_repository_id=collections.github_repository_id
    WHERE contest_problems.contest_id=?
    ORDER BY contest_problems.ordinal`)
    .bind(contestId).all<Record<string, unknown>>();
  return jsonResponse({
    contest: {
      id: contest.id,
      title: contest.title,
      description: contest.description,
      accessMode: contest.access_mode,
      inviteCodeConfigured: contest.invite_code_configured === 1,
      startsAt: contest.starts_at,
      endsAt: contest.ends_at,
      freezeAt: contest.freeze_at,
      status: contest.status,
      phase: contestPhase(String(contest.starts_at), String(contest.ends_at)),
      problemCount: problems.results.length,
      catalogPublicationId: contest.catalog_publication_id,
      createdAt: contest.created_at,
      updatedAt: contest.updated_at,
    },
    problems: problems.results.map((problem) => ({
      ordinal: problem.ordinal,
      problemVersionId: problem.problem_version_id,
      problemSeriesId: problem.problem_series_id,
      problemSlug: problem.problem_slug,
      problemNumber: problem.problem_number,
      title: parseStoredProblemTitle(problem.title_json),
      collectionRevision: problem.collection_revision_sha256,
      repository: `${problem.owner_login}/${problem.repository_name}`,
    })),
  }, 200, { "cache-control": "private, no-store" });
}

export async function updateOrganizerContest(request: Request, env: WasmOjWorkerEnv, contestId: string): Promise<Response> {
  const session = await requireBrowserOrBearerMutationSession(request, env);
  await requireStagingFormalAccess(env, session.userId);
  await requireOrganizer(env, session);
  const input = await contestDraftInput(request);
  const current = await env.DB.prepare("SELECT status, invite_code_hash FROM contests WHERE id=? AND organizer_user_id=?")
    .bind(contestId, session.userId).first<{ status: string; invite_code_hash: string | null }>();
  if (!current) throw new ApiError(404, "contest-not-found", "Organizer-owned contest was not found.");
  if (current.status !== "draft") throw new ApiError(409, "contest-not-editable", "Only contest drafts can be edited.");
  const problems = await requireOwnedContestProblems(env, session.userId, input.problemVersionIds);
  let inviteCodeHash: string | null = null;
  if (input.accessMode === "invite") {
    if (input.inviteCode) {
      if (env.INVITE_CODE_HMAC_SECRET.length < 32) throw new Error("Invite-code HMAC secret is not configured.");
      inviteCodeHash = await hmacSha256Hex(env.INVITE_CODE_HMAC_SECRET, textEncoder.encode(input.inviteCode));
    } else {
      inviteCodeHash = current.invite_code_hash;
    }
    if (!inviteCodeHash) {
      throw new ApiError(400, "contest-invite-invalid", "A new invite code is required when changing a public draft to invite access.");
    }
  }
  await requireFormalMutationsEnabled(env, request);
  const updatedAt = new Date().toISOString();
  const [, updated] = await env.DB.batch([
    env.DB.prepare(`DELETE FROM contest_problems
      WHERE contest_id=? AND EXISTS (
        SELECT 1 FROM contests WHERE id=? AND organizer_user_id=? AND status='draft'
      )`).bind(contestId, contestId, session.userId),
    env.DB.prepare(`UPDATE contests SET catalog_publication_id=?, title=?, description=?,
        access_mode=?, invite_code_hash=?, starts_at=?, ends_at=?, freeze_at=?, updated_at=?
      WHERE id=? AND organizer_user_id=? AND status='draft'`)
      .bind(problems[0]!.catalog_publication_id, input.title, input.description,
        input.accessMode, inviteCodeHash, input.startsAt, input.endsAt,
        input.freezeAt ?? null, updatedAt, contestId, session.userId),
    ...problems.map((problem, index) => contestProblemInsert(env, contestId, problem, index + 1, session.userId)),
  ]);
  if (updated.meta.changes !== 1) throw new ApiError(409, "contest-not-editable", "Contest draft changed while it was being edited.");
  return jsonResponse({
    contestId,
    status: "draft",
    catalogPublicationId: problems[0]!.catalog_publication_id,
    updatedAt,
  });
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
  const updatedAt = new Date().toISOString();
  const inviteCodeHash = await hmacSha256Hex(env.INVITE_CODE_HMAC_SECRET, textEncoder.encode(body.inviteCode));
  const result = await env.DB.prepare(`UPDATE contests SET invite_code_hash=?, updated_at=?
      WHERE id=? AND organizer_user_id=? AND access_mode='invite' AND status IN ('draft','published')`)
    .bind(inviteCodeHash, updatedAt, contestId, session.userId).run();
  if (result.meta.changes !== 1) {
    throw new ApiError(409, "contest-invite-not-rotatable", "Contest is not an Organizer-owned invite contest that can rotate its code.");
  }
  return jsonResponse({ contestId, inviteCodeConfigured: true, updatedAt });
}

export async function addOrganizerContestProblem(
  request: Request,
  env: WasmOjWorkerEnv,
  contestId: string,
  problemVersionId: string,
): Promise<Response> {
  const session = await requireBrowserOrBearerMutationSession(request, env);
  await requireStagingFormalAccess(env, session.userId);
  await requireOrganizer(env, session);
  exact(await readJsonBody(request, 8 * 1024), []);
  const [problem] = await requireOwnedContestProblems(env, session.userId, [problemVersionId]);
  await requireFormalMutationsEnabled(env, request);
  const inserted = await env.DB.prepare(`INSERT OR IGNORE INTO contest_problems
      (contest_id, problem_series_id, problem_version_id, ordinal)
    SELECT contests.id, ?, ?,
      COALESCE((SELECT MAX(ordinal) FROM contest_problems WHERE contest_id=contests.id), 0) + 1
    FROM contests
    WHERE contests.id=? AND contests.organizer_user_id=? AND contests.status='draft'
      AND contests.catalog_publication_id=?
      AND (SELECT COUNT(*) FROM contest_problems WHERE contest_id=contests.id) < 100`)
    .bind(problem!.problem_series_id, problem!.id, contestId, session.userId, problem!.catalog_publication_id)
    .run();
  if (inserted.meta.changes !== 1) {
    const contest = await env.DB.prepare(`SELECT status, catalog_publication_id,
        (SELECT COUNT(*) FROM contest_problems WHERE contest_id=contests.id) AS problem_count,
        EXISTS(SELECT 1 FROM contest_problems WHERE contest_id=contests.id
          AND (problem_version_id=? OR problem_series_id=?)) AS already_present
      FROM contests WHERE id=? AND organizer_user_id=?`)
      .bind(problemVersionId, problem!.problem_series_id, contestId, session.userId)
      .first<{ readonly status: string; readonly catalog_publication_id: string; readonly problem_count: number; readonly already_present: number }>();
    if (!contest) throw new ApiError(404, "contest-not-found", "Organizer-owned contest was not found.");
    if (contest.status !== "draft") throw new ApiError(409, "contest-not-editable", "Only contest drafts can be edited.");
    if (contest.catalog_publication_id !== problem!.catalog_publication_id) {
      throw new ApiError(409, "contest-publication-invalid", "The problem version is not from this contest's publication.");
    }
    if (contest.already_present === 1) throw new ApiError(409, "contest-problem-present", "This problem series is already in the contest.");
    if (contest.problem_count >= 100) throw new ApiError(409, "contest-problem-limit", "A contest can contain at most 100 problems.");
    throw new ApiError(409, "contest-state-changed", "Contest draft changed before the problem could be added.");
  }
  const row = await env.DB.prepare("SELECT ordinal FROM contest_problems WHERE contest_id=? AND problem_version_id=?")
    .bind(contestId, problemVersionId).first<{ readonly ordinal: number }>();
  if (!row) throw new Error("Inserted contest problem could not be read back.");
  return jsonResponse({ contestId, problemVersionId, ordinal: row.ordinal, changed: true });
}

export async function removeOrganizerContestProblem(
  request: Request,
  env: WasmOjWorkerEnv,
  contestId: string,
  problemVersionId: string,
): Promise<Response> {
  const session = await requireBrowserOrBearerMutationSession(request, env);
  await requireStagingFormalAccess(env, session.userId);
  await requireOrganizer(env, session);
  exact(await readJsonBody(request, 8 * 1024), []);
  await requireFormalMutationsEnabled(env, request);
  const removed = await env.DB.prepare(`DELETE FROM contest_problems
    WHERE contest_id=? AND problem_version_id=?
      AND EXISTS (SELECT 1 FROM contests WHERE id=? AND organizer_user_id=? AND status='draft')`)
    .bind(contestId, problemVersionId, contestId, session.userId).run();
  if (removed.meta.changes === 1) return jsonResponse({ contestId, problemVersionId, changed: true });
  const contest = await env.DB.prepare("SELECT status FROM contests WHERE id=? AND organizer_user_id=?")
    .bind(contestId, session.userId).first<{ readonly status: string }>();
  if (!contest) throw new ApiError(404, "contest-not-found", "Organizer-owned contest was not found.");
  if (contest.status !== "draft") throw new ApiError(409, "contest-not-editable", "Only contest drafts can be edited.");
  return jsonResponse({ contestId, problemVersionId, changed: false });
}

export async function archiveOrganizerContest(request: Request, env: WasmOjWorkerEnv, contestId: string): Promise<Response> {
  const session = await requireBrowserOrBearerMutationSession(request, env);
  await requireStagingFormalAccess(env, session.userId);
  await requireOrganizer(env, session);
  exact(await readJsonBody(request, 8 * 1024), []);
  await requireFormalMutationsEnabled(env, request);
  const now = new Date().toISOString();
  const result = await env.DB.prepare(`UPDATE contests SET status='archived', updated_at=?
    WHERE id=? AND organizer_user_id=?
      AND (status='draft' OR (status='published' AND ends_at<=?))`)
    .bind(now, contestId, session.userId, now).run();
  if (result.meta.changes === 1) {
    return jsonResponse({ contestId, status: "archived", changed: true, updatedAt: now });
  }
  const current = await env.DB.prepare("SELECT status FROM contests WHERE id=? AND organizer_user_id=?")
    .bind(contestId, session.userId).first<{ readonly status: string }>();
  if (!current) throw new ApiError(404, "contest-not-found", "Organizer-owned contest was not found.");
  if (current.status === "archived") {
    return jsonResponse({ contestId, status: "archived", changed: false });
  }
  throw new ApiError(409, "contest-not-archivable", "A published contest can be archived only after it ends.");
}

export async function listOrganizerContestParticipants(
  request: Request,
  env: WasmOjWorkerEnv,
  contestId: string,
): Promise<Response> {
  const session = await requireSession(request, env);
  await requireOrganizer(env, session);
  const owned = await env.DB.prepare("SELECT 1 AS present FROM contests WHERE id=? AND organizer_user_id=?")
    .bind(contestId, session.userId).first<{ readonly present: number }>();
  if (!owned) throw new ApiError(404, "contest-not-found", "Organizer-owned contest was not found.");
  const url = new URL(request.url);
  const participantQueryKeys = new Set(["limit", "afterJoinedAt", "afterUserId"]);
  for (const key of new Set(url.searchParams.keys())) {
    if (!participantQueryKeys.has(key) || url.searchParams.getAll(key).length !== 1) {
      throw new ApiError(400, "contest-participant-cursor-invalid", "Participant query has an invalid shape.");
    }
  }
  const rawLimit = url.searchParams.get("limit") ?? "100";
  if (!/^[1-9]\d{0,2}$/u.test(rawLimit)) {
    throw new ApiError(400, "contest-participant-cursor-invalid", "Participant limit must be an integer from 1 to 100.");
  }
  const limit = Number(rawLimit);
  if (limit > 100) throw new ApiError(400, "contest-participant-cursor-invalid", "Participant limit must be an integer from 1 to 100.");
  const afterJoinedAt = url.searchParams.get("afterJoinedAt");
  const afterUserId = url.searchParams.get("afterUserId");
  if ((afterJoinedAt === null) !== (afterUserId === null)) {
    throw new ApiError(400, "contest-participant-cursor-invalid", "Both participant cursor fields are required together.");
  }
  if (afterJoinedAt !== null && (
    Number.isNaN(Date.parse(afterJoinedAt))
    || new Date(afterJoinedAt).toISOString() !== afterJoinedAt
    || !afterUserId
    || !UUID_PATTERN.test(afterUserId)
  )) {
    throw new ApiError(400, "contest-participant-cursor-invalid", "Participant cursor is invalid.");
  }
  const rows = afterJoinedAt === null
    ? await env.DB.prepare(`SELECT user_id, joined_at FROM contest_participants
      WHERE contest_id=? ORDER BY joined_at, user_id LIMIT ?`)
      .bind(contestId, limit + 1).all<{ readonly user_id: string; readonly joined_at: string }>()
    : await env.DB.prepare(`SELECT user_id, joined_at FROM contest_participants
      WHERE contest_id=? AND (joined_at>? OR (joined_at=? AND user_id>?))
      ORDER BY joined_at, user_id LIMIT ?`)
      .bind(contestId, afterJoinedAt, afterJoinedAt, afterUserId, limit + 1)
      .all<{ readonly user_id: string; readonly joined_at: string }>();
  const page = rows.results.slice(0, limit);
  const identities = await leaderboardParticipants(env, page.map((row) => row.user_id));
  const last = rows.results.length > limit ? page.at(-1) : undefined;
  return jsonResponse({
    participants: page.map((row) => ({
      participant: identities.get(row.user_id)
        ?? { id: "participant-unavailable", kind: "anonymous", label: "Private participant" },
      joinedAt: row.joined_at,
    })),
    nextCursor: last ? { afterJoinedAt: last.joined_at, afterUserId: last.user_id } : null,
  }, 200, { "cache-control": "private, no-store" });
}

export async function publishContest(request: Request, env: WasmOjWorkerEnv, contestId: string): Promise<Response> {
  const session = await requireBrowserOrBearerMutationSession(request, env);
  await requireStagingFormalAccess(env, session.userId);
  await requireOrganizer(env, session);
  await requireFormalMutationsEnabled(env, request);
  const result = await env.DB.prepare(`UPDATE contests SET status='published', updated_at=?
    WHERE id=? AND organizer_user_id=? AND status='draft'
      AND EXISTS (SELECT 1 FROM contest_problems WHERE contest_id=contests.id)`)
    .bind(new Date().toISOString(), contestId, session.userId).run();
  if (result.meta.changes !== 1) throw new ApiError(409, "contest-not-publishable", "Contest is not an Organizer-owned non-empty draft.");
  return jsonResponse({ contestId, status: "published" });
}

export async function joinContest(request: Request, env: WasmOjWorkerEnv, contestId: string): Promise<Response> {
  const session = await requireBrowserOrBearerMutationSession(request, env);
  await requireFormalMutationsEnabled(env, request);
  const body = exact(await readJsonBody(request, 8 * 1024), [], ["inviteCode"]);
  const contest = await env.DB.prepare("SELECT access_mode, invite_code_hash, status, ends_at FROM contests WHERE id=?")
    .bind(contestId).first<{ access_mode: string; invite_code_hash: string | null; status: string; ends_at: string }>();
  if (!contest || contest.status !== "published" || contest.ends_at <= new Date().toISOString()) {
    throw new ApiError(409, "contest-closed", "Contest is not open for joining.");
  }
  if (env.INVITE_CODE_HMAC_SECRET.length < 32) throw new Error("Invite-code HMAC secret is not configured.");
  if (
    contest.access_mode === "invite"
    && (
      typeof body.inviteCode !== "string" || !contest.invite_code_hash
      || !constantTimeEqual(
        await hmacSha256Hex(env.INVITE_CODE_HMAC_SECRET, textEncoder.encode(body.inviteCode)),
        contest.invite_code_hash,
      )
    )
  ) throw new ApiError(403, "contest-invite-invalid", "Invite code is invalid.");
  await env.DB.prepare("INSERT OR IGNORE INTO contest_participants (contest_id, user_id, joined_at) VALUES (?, ?, ?)")
    .bind(contestId, session.userId, new Date().toISOString()).run();
  return jsonResponse({ contestId, joined: true });
}

export async function getContest(request: Request, env: WasmOjWorkerEnv, contestId: string): Promise<Response> {
  const session = await authenticatedSession(request, env);
  const contest = await env.DB.prepare(`SELECT contests.id, contests.organizer_user_id, contests.title,
      contests.description, contests.access_mode, contests.starts_at, contests.ends_at,
      contests.freeze_at, contests.status, contest_participants.user_id AS participant_user_id
    FROM contests
    LEFT JOIN contest_participants
      ON contest_participants.contest_id=contests.id AND contest_participants.user_id=?
    WHERE contests.id=?`)
    .bind(session?.userId ?? "", contestId).first<Record<string, unknown>>();
  const organizer = contest?.organizer_user_id === session?.userId;
  if (!contest || (contest.status !== "published" && !organizer)) {
    throw new ApiError(404, "contest-not-found", "Contest was not found.");
  }
  const now = new Date();
  const joined = contest.participant_user_id === session?.userId;
  const problemVisible = organizer || (contest.status === "published" && (
    String(contest.starts_at) <= now.toISOString()
    && (contest.access_mode === "public" || joined)
  ));
  const problems = problemVisible
    ? await env.DB.prepare(`SELECT contest_problems.ordinal, versions.id AS problem_version_id,
        versions.problem_series_id, versions.catalog_publication_id, versions.problem_slug,
        versions.title_json
      FROM contest_problems
      JOIN problem_version_details AS versions ON versions.id=contest_problems.problem_version_id
      WHERE contest_problems.contest_id=?
      ORDER BY contest_problems.ordinal`).bind(contestId).all<Record<string, unknown>>()
    : { results: [] as readonly Record<string, unknown>[] };
  return jsonResponse({
    contest: {
      id: contest.id,
      title: contest.title,
      description: contest.description,
      accessMode: contest.access_mode,
      startsAt: contest.starts_at,
      endsAt: contest.ends_at,
      freezeAt: contest.freeze_at,
      status: contest.status,
      phase: contestPhase(String(contest.starts_at), String(contest.ends_at), now),
      joined,
      organizer,
      catalogPublicationId: problems.results[0]?.catalog_publication_id ?? null,
    },
    problems: problems.results.map((problem) => ({
      ordinal: problem.ordinal,
      problemVersionId: problem.problem_version_id,
      problemSeriesId: problem.problem_series_id,
      problemSlug: problem.problem_slug,
      title: parseStoredProblemTitle(problem.title_json),
      contentUrl: contentUrl(String(problem.problem_version_id), "contest-public", contestId),
    })),
  });
}

export async function contestLeaderboard(request: Request, env: WasmOjWorkerEnv, contestId: string): Promise<Response> {
  const session = await authenticatedSession(request, env);
  const contest = await env.DB.prepare("SELECT organizer_user_id, access_mode, status, freeze_at, ends_at FROM contests WHERE id=?")
    .bind(contestId).first<{ organizer_user_id: string; access_mode: string; status: string; freeze_at: string | null; ends_at: string }>();
  if (!contest || contest.status !== "published") throw new ApiError(404, "contest-not-found", "Contest was not found.");
  if (contest.access_mode === "invite") {
    const participant = session && await env.DB.prepare("SELECT 1 AS allowed FROM contest_participants WHERE contest_id=? AND user_id=?")
      .bind(contestId, session.userId).first();
    if (!participant && contest.organizer_user_id !== session?.userId) throw new ApiError(404, "contest-not-found", "Contest was not found.");
  }
  const rawLimit = Number(new URL(request.url).searchParams.get("limit") ?? "50");
  const limit = Number.isSafeInteger(rawLimit) ? Math.min(100, Math.max(1, rawLimit)) : 50;
  const now = new Date().toISOString();
  const frozen = contest.freeze_at !== null && contest.freeze_at <= now && now < contest.ends_at;
  const organizer = contest.organizer_user_id === session?.userId;
  const viewerFrozen = frozen && !organizer;
  let entries = await queryContestLeaderboard(env.DB, {
    contestId,
    submittedAtOrBefore: viewerFrozen ? contest.freeze_at ?? undefined : undefined,
    limit,
  });
  if (viewerFrozen) {
    const participants = await env.DB.prepare("SELECT user_id FROM contest_participants WHERE contest_id=? ORDER BY user_id")
      .bind(contestId).all<{ user_id: string }>();
    entries = includeFrozenContestParticipants(entries, participants.results.map((row) => row.user_id), contest.freeze_at ?? now);
  }
  return projectLeaderboardEntries(env, { frozen: viewerFrozen, entries });
}

export function includeFrozenContestParticipants(
  entries: readonly LeaderboardEntryRow[],
  participantIds: readonly string[],
  freezeAt: string,
): readonly LeaderboardEntryRow[] {
  const ranked = new Set(entries.map((entry) => entry.userId));
  return [
    ...entries,
    ...[...new Set(participantIds)]
      .filter((userId) => !ranked.has(userId))
      .sort()
      .map((userId) => ({
        userId,
        score: 0,
        fullyPassedCases: 0,
        deterministicCost: 0,
        peakMemoryBytes: 0,
        achievedAt: freezeAt,
        attemptedProblems: 0,
        problemResults: [],
      })),
  ];
}
