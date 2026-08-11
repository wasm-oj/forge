import { authenticatedSession, requireMutationSession, requireSession } from "./auth";
import { constantTimeEqual, hmacSha256Hex, sha256Hex } from "./crypto";
import type { ForgeWorkerEnv } from "./env";
import { requireOrganizer } from "./github";
import { ApiError, jsonResponse, readJsonBody } from "./http";
import { requireStagingFormalAccess } from "./formal-access";
import { requireFormalMutationsEnabled } from "./formal-mutations";
import { effectiveProblemVersion } from "./rejudge";
import { queryContestLeaderboard, queryProblemLeaderboard, type LeaderboardEntryRow } from "./leaderboards";
import { canonicalJsonBytes } from "../src/core/canonical-json";
import { parseManagedPublicProblemProjection } from "../src/online-judge/public-projection";
import { parseStoredProblemTitle } from "../src/online-judge/stored-problem-title";
import { isBuiltinLanguage, type BuiltinLanguage } from "../src/core/types";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const CONTENT_ADDRESSED_PROJECTION = /^snapshots\/objects\/([0-9a-f]{64})$/;
const MAX_PUBLIC_PROJECTION_BYTES = 32 * 1024 * 1024;
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

async function verifiedPublicProjectionBytes(env: ForgeWorkerEnv, key: string): Promise<Uint8Array> {
  const digest = CONTENT_ADDRESSED_PROJECTION.exec(key)?.[1];
  if (!digest) throw new ApiError(500, "managed-projection-address", "Managed public projection has an invalid content address.");
  const object = await env.JUDGE_BUCKET.get(key);
  if (
    !object
    || object.size < 1 || object.size > MAX_PUBLIC_PROJECTION_BYTES
    || object.customMetadata?.sha256 !== digest
  ) throw new ApiError(500, "managed-projection-integrity", "Managed public projection failed metadata verification.");
  const bytes = new Uint8Array(await object.arrayBuffer());
  if (bytes.byteLength !== object.size || await sha256Hex(bytes) !== digest) {
    bytes.fill(0);
    throw new ApiError(500, "managed-projection-integrity", "Managed public projection failed digest verification.");
  }
  return bytes;
}

function exact(value: unknown, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ApiError(400, "payload-invalid", "Payload must be an object.");
  const record = value as Record<string, unknown>;
  const allowed = new Set([...required, ...optional]);
  if (required.some((key) => !Object.hasOwn(record, key)) || Object.keys(record).some((key) => !allowed.has(key))) throw new ApiError(400, "payload-invalid", "Payload has an invalid shape.");
  return record;
}

function timestamp(value: unknown, label: string): string {
  if (typeof value !== "string" || Number.isNaN(Date.parse(value)) || new Date(value).toISOString() !== value) throw new ApiError(400, "timestamp-invalid", `${label} must be a canonical ISO timestamp.`);
  return value;
}

function storedStringArray(value: unknown, label: string): string[] {
  if (typeof value !== "string") throw new Error(`${label} is missing.`);
  const parsed: unknown = JSON.parse(value);
  if (!Array.isArray(parsed) || parsed.length > 32 || parsed.some((item) => typeof item !== "string")) throw new Error(`${label} is invalid.`);
  return parsed;
}

function configuredOfficialRepositoryId(env: ForgeWorkerEnv): number {
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

async function leaderboardParticipantId(env: ForgeWorkerEnv, userId: string): Promise<string> {
  if (env.ACCOUNT_ERASURE_HMAC_SECRET.length < 32) throw new Error("Account-erasure HMAC secret is not configured.");
  return `participant-${(await hmacSha256Hex(
    env.ACCOUNT_ERASURE_HMAC_SECRET,
    textEncoder.encode(`forge-public-leaderboard-participant-v1\0${userId}`),
  )).slice(0, 24)}`;
}

async function leaderboardParticipants(
  env: ForgeWorkerEnv,
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
    : (await env.DB.prepare(`SELECT users.id AS user_id, users.status, profiles.display_name, profiles.visibility, github_identities.login, github_identities.avatar_url FROM users LEFT JOIN profiles ON profiles.user_id=users.id LEFT JOIN github_identities ON github_identities.user_id=users.id WHERE users.id IN (${activeIds.map(() => "?").join(",")})`)
      .bind(...activeIds).all<LeaderboardIdentityRow>()).results;
  const byId = new Map(identities.map((identity) => [identity.user_id, identity] as const));
  const projected = new Map<string, LeaderboardParticipant>();
  await Promise.all(unique.map(async (userId) => {
    const id = await leaderboardParticipantId(env, userId);
    const identity = byId.get(userId);
    if (identity?.status === "active" && identity.visibility === "public" && identity.login && identity.avatar_url) {
      projected.set(userId, {
        id,
        kind: "profile",
        label: identity.display_name,
        login: identity.login,
        avatarUrl: identity.avatar_url,
      });
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
  env: ForgeWorkerEnv,
  input: {
    readonly frozen: boolean;
    readonly entries: readonly LeaderboardEntryRow[];
    readonly availableLanguages?: readonly BuiltinLanguage[];
    readonly selectedLanguage?: BuiltinLanguage;
    readonly rejudgeBatchId?: string;
    readonly rejudgeSelection?: Readonly<Record<string, { readonly batchId: string; readonly stagedProblemVersionId: string }>>;
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
    ...(input.rejudgeBatchId ? { rejudgeBatchId: input.rejudgeBatchId } : {}),
    ...(input.rejudgeSelection ? { rejudgeSelection: input.rejudgeSelection } : {}),
    entries: entries.map(({ userId, ...entry }) => ({
      ...entry,
      participant: identities.get(userId) ?? { id: "participant-unavailable", kind: "anonymous", label: "Private participant" },
    })),
  });
}

export async function currentProfile(request: Request, env: ForgeWorkerEnv): Promise<Response> {
  const session = await requireSession(request, env);
  const profile = await env.DB.prepare("SELECT profiles.display_name, profiles.bio, profiles.website_url, profiles.visibility, github_identities.login, github_identities.avatar_url FROM profiles JOIN github_identities ON github_identities.user_id=profiles.user_id WHERE profiles.user_id=?")
    .bind(session.userId).first<{ display_name: string; bio: string; website_url: string | null; visibility: "public" | "private"; login: string; avatar_url: string }>();
  if (!profile) throw new ApiError(404, "profile-not-found", "Profile was not found.");
  const solved = await env.DB.prepare(`SELECT COUNT(DISTINCT submissions.managed_problem_version_id) AS count
    FROM submissions
    JOIN managed_problem_versions ON managed_problem_versions.id=submissions.managed_problem_version_id
    JOIN managed_snapshots ON managed_snapshots.id=managed_problem_versions.snapshot_id
    WHERE submissions.user_id=? AND submissions.state='completed' AND submissions.contest_id IS NULL
      AND submissions.score>=managed_problem_versions.maximum_score
      AND (
        (submissions.rejudge_batch_id IS NULL AND NOT EXISTS (
          SELECT 1 FROM effective_problem_versions
          WHERE original_problem_version_id=submissions.managed_problem_version_id
        ))
        OR EXISTS (
          SELECT 1 FROM effective_rejudges
          WHERE new_submission_id=submissions.id AND became_effective_at IS NOT NULL
        )
      )
      AND managed_snapshots.mode='official-practice'`)
    .bind(session.userId).first<{ count: number }>();
  return jsonResponse({ profile: { ...publicProfileProjection(profile), visibility: profile.visibility, verifiedSolvedCount: solved?.count ?? 0 } });
}

export async function updateProfile(request: Request, env: ForgeWorkerEnv): Promise<Response> {
  const session = await requireMutationSession(request, env);
  const body = exact(await readJsonBody(request, 32 * 1024), ["displayName", "bio", "visibility"], ["websiteUrl"]);
  if (typeof body.displayName !== "string" || body.displayName.trim().length < 1 || body.displayName.length > 80 || typeof body.bio !== "string" || body.bio.length > 2_000 || (body.visibility !== "public" && body.visibility !== "private")) {
    throw new ApiError(400, "profile-invalid", "Profile fields are invalid.");
  }
  if (body.websiteUrl !== undefined) {
    if (typeof body.websiteUrl !== "string" || body.websiteUrl.length > 300) throw new ApiError(400, "profile-invalid", "Website URL is invalid.");
    const website = new URL(body.websiteUrl);
    if (website.protocol !== "https:" || website.username || website.password) throw new ApiError(400, "profile-invalid", "Website URL must be credential-free HTTPS.");
  }
  await env.DB.prepare("UPDATE profiles SET display_name=?, bio=?, website_url=?, visibility=?, updated_at=? WHERE user_id=?")
    .bind(body.displayName.trim(), body.bio, body.websiteUrl ?? null, body.visibility, new Date().toISOString(), session.userId).run();
  return jsonResponse({ updated: true });
}

export async function publicProfile(request: Request, env: ForgeWorkerEnv, login: string): Promise<Response> {
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(login)) throw new ApiError(404, "profile-not-found", "Profile was not found.");
  const profile = await env.DB.prepare(
    "SELECT profiles.user_id, profiles.display_name, profiles.bio, profiles.website_url, github_identities.login, github_identities.avatar_url FROM profiles JOIN github_identities ON github_identities.user_id=profiles.user_id JOIN users ON users.id=profiles.user_id WHERE github_identities.login=? COLLATE NOCASE AND profiles.visibility='public' AND users.status='active'",
  ).bind(login).first<{ user_id: string; display_name: string; bio: string; website_url: string | null; login: string; avatar_url: string }>();
  if (!profile) throw new ApiError(404, "profile-not-found", "Profile was not found.");
  const solves = await env.DB.prepare(`WITH eligible AS (
      SELECT submissions.managed_problem_version_id,
             submissions.score,
             COALESCE(original.completed_at, submissions.completed_at) AS solved_at,
             submissions.id,
             ROW_NUMBER() OVER (
               PARTITION BY submissions.managed_problem_version_id
               ORDER BY submissions.score DESC, COALESCE(original.completed_at, submissions.completed_at), submissions.id
             ) AS rank
      FROM submissions
      LEFT JOIN effective_rejudges ON effective_rejudges.new_submission_id=submissions.id
        AND effective_rejudges.became_effective_at IS NOT NULL
      LEFT JOIN submissions AS original ON original.id=effective_rejudges.old_submission_id
      JOIN managed_problem_versions ON managed_problem_versions.id=submissions.managed_problem_version_id
      WHERE submissions.user_id=? AND submissions.state='completed' AND submissions.contest_id IS NULL
        AND submissions.score>=managed_problem_versions.maximum_score
        AND (
          (submissions.rejudge_batch_id IS NULL AND NOT EXISTS (
            SELECT 1 FROM effective_problem_versions
            WHERE original_problem_version_id=submissions.managed_problem_version_id
          ))
          OR effective_rejudges.new_submission_id IS NOT NULL
        )
    )
    SELECT eligible.managed_problem_version_id, eligible.score, eligible.solved_at,
           managed_problem_versions.problem_slug, managed_problem_versions.title_json
    FROM eligible
    JOIN managed_problem_versions ON managed_problem_versions.id=eligible.managed_problem_version_id
    JOIN managed_snapshots ON managed_snapshots.id=managed_problem_versions.snapshot_id
    WHERE eligible.rank=1 AND managed_snapshots.mode='official-practice'
      AND managed_snapshots.status IN ('published','superseded')
    ORDER BY eligible.solved_at DESC`)
    .bind(profile.user_id).all();
  return jsonResponse({ profile: {
    ...publicProfileProjection(profile),
    verifiedSolvedCount: solves.results.length,
    verifiedSolves: solves.results.map((solve) => ({
      managedProblemVersionId: solve.managed_problem_version_id,
      score: solve.score,
      solvedAt: solve.solved_at,
      problemSlug: solve.problem_slug,
      title: parseStoredProblemTitle(solve.title_json),
    })),
  } });
}

export async function listProblems(request: Request, env: ForgeWorkerEnv): Promise<Response> {
  const session = await authenticatedSession(request, env);
  const officialRepositoryId = configuredOfficialRepositoryId(env);
  const rows = await env.DB.prepare(`WITH progress AS (
      SELECT submissions.managed_problem_version_id,
             MAX(submissions.score) AS best_score,
             MIN(CASE WHEN submissions.score>=managed_problem_versions.maximum_score
                      THEN COALESCE(original.completed_at, submissions.completed_at) END) AS solved_at
      FROM submissions
      JOIN managed_problem_versions ON managed_problem_versions.id=submissions.managed_problem_version_id
      LEFT JOIN effective_rejudges ON effective_rejudges.new_submission_id=submissions.id
        AND effective_rejudges.became_effective_at IS NOT NULL
      LEFT JOIN submissions AS original ON original.id=effective_rejudges.old_submission_id
      WHERE submissions.user_id=? AND submissions.state='completed' AND submissions.contest_id IS NULL
        AND (
          (submissions.rejudge_batch_id IS NULL AND NOT EXISTS (
            SELECT 1 FROM effective_problem_versions
            WHERE original_problem_version_id=submissions.managed_problem_version_id
          ))
          OR effective_rejudges.new_submission_id IS NOT NULL
        )
      GROUP BY submissions.managed_problem_version_id
    )
    SELECT
      managed_snapshots.id AS snapshot_id,
      managed_snapshots.collection_revision,
      managed_snapshots.published_at,
      github_repositories.github_repository_id,
      github_repositories.owner_login,
      github_repositories.name AS repository_name,
      managed_problem_versions.id,
      managed_problem_versions.bundle_digest,
      managed_problem_versions.problem_slug,
      managed_problem_versions.problem_number,
      managed_problem_versions.title_json,
      managed_problem_versions.difficulty,
      managed_problem_versions.tags_json,
      managed_problem_versions.track_id,
      managed_problem_versions.track_json,
      managed_problem_versions.maximum_score,
      progress.best_score,
      progress.solved_at
    FROM managed_snapshots
    JOIN collection_imports ON collection_imports.id=managed_snapshots.import_id
    JOIN github_repositories ON github_repositories.github_repository_id=collection_imports.github_repository_id
    JOIN managed_problem_versions ON managed_problem_versions.snapshot_id=managed_snapshots.id
    LEFT JOIN progress ON progress.managed_problem_version_id=managed_problem_versions.id
    WHERE managed_snapshots.mode='official-practice' AND managed_snapshots.status='published'
      AND managed_problem_versions.difficulty IS NOT NULL
      AND managed_problem_versions.tags_json IS NOT NULL
      AND managed_problem_versions.track_id IS NOT NULL
      AND managed_problem_versions.track_json IS NOT NULL
    ORDER BY CASE WHEN github_repositories.github_repository_id=? THEN 0 ELSE 1 END,
      github_repositories.owner_login COLLATE NOCASE,
      github_repositories.name COLLATE NOCASE,
      managed_problem_versions.problem_number`)
    .bind(session?.userId ?? "", officialRepositoryId).all<Record<string, unknown>>();
  const collections = new Map<string, {
    snapshotId: string;
    revision: string;
    publishedAt: string;
    repository: { id: number; owner: string; name: string };
    official: boolean;
    problems: Array<Record<string, unknown>>;
  }>();
  for (const row of rows.results) {
    const snapshotId = String(row.snapshot_id);
    let collection = collections.get(snapshotId);
    if (!collection) {
      collection = {
        snapshotId,
        revision: String(row.collection_revision),
        publishedAt: String(row.published_at),
        repository: { id: Number(row.github_repository_id), owner: String(row.owner_login), name: String(row.repository_name) },
        official: Number(row.github_repository_id) === officialRepositoryId,
        problems: [],
      };
      collections.set(snapshotId, collection);
    }
    collection.problems.push({
      id: row.id,
      bundleDigest: row.bundle_digest,
      slug: row.problem_slug,
      number: row.problem_number,
      title: parseStoredProblemTitle(row.title_json),
      difficulty: row.difficulty,
      tags: storedStringArray(row.tags_json, "Problem tags"),
      trackId: row.track_id,
      track: parseStoredProblemTitle(row.track_json),
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

export async function listOrganizerCollections(request: Request, env: ForgeWorkerEnv): Promise<Response> {
  const session = await requireSession(request, env);
  await requireOrganizer(env, session);
  const imports = await env.DB.prepare(`SELECT collection_imports.id, collection_imports.requested_ref, collection_imports.commit_sha,
      collection_imports.index_path, collection_imports.retry_of_import_id, collection_imports.status, collection_imports.error_code, collection_imports.created_at, collection_imports.updated_at,
      github_repositories.github_repository_id, github_repositories.owner_login, github_repositories.name AS repository_name
    FROM collection_imports
    JOIN github_repositories ON github_repositories.github_repository_id=collection_imports.github_repository_id
    WHERE collection_imports.organizer_user_id=?
    ORDER BY collection_imports.created_at DESC LIMIT 100`)
    .bind(session.userId).all<Record<string, unknown>>();
  const rows = await env.DB.prepare(`SELECT managed_snapshots.id AS snapshot_id, managed_snapshots.import_id, managed_snapshots.mode,
      managed_snapshots.collection_revision, managed_snapshots.status, managed_snapshots.published_at,
      managed_problem_versions.id, managed_problem_versions.problem_slug, managed_problem_versions.problem_number,
      managed_problem_versions.title_json, managed_problem_versions.difficulty, managed_problem_versions.tags_json,
      github_repositories.github_repository_id, github_repositories.owner_login, github_repositories.name AS repository_name
    FROM managed_snapshots
    JOIN collection_imports ON collection_imports.id=managed_snapshots.import_id
    JOIN github_repositories ON github_repositories.github_repository_id=collection_imports.github_repository_id
    LEFT JOIN managed_problem_versions ON managed_problem_versions.snapshot_id=managed_snapshots.id
    WHERE collection_imports.organizer_user_id=?
    ORDER BY managed_snapshots.created_at DESC, managed_problem_versions.problem_number`)
    .bind(session.userId).all<Record<string, unknown>>();
  const collections = new Map<string, Record<string, unknown> & { problems: Array<Record<string, unknown>> }>();
  for (const row of rows.results) {
    const snapshotId = String(row.snapshot_id);
    let collection = collections.get(snapshotId);
    if (!collection) {
      collection = {
        snapshotId,
        importId: row.import_id,
        mode: row.mode,
        revision: row.collection_revision,
        status: row.status,
        publishedAt: row.published_at,
        repository: { id: row.github_repository_id, owner: row.owner_login, name: row.repository_name },
        problems: [],
      };
      collections.set(snapshotId, collection);
    }
    if (row.id) collection.problems.push({
      id: row.id,
      slug: row.problem_slug,
      number: row.problem_number,
      title: parseStoredProblemTitle(row.title_json),
      difficulty: row.difficulty,
      tags: row.tags_json ? storedStringArray(row.tags_json, "Problem tags") : [],
    });
  }
  return jsonResponse({ imports: imports.results, collections: [...collections.values()] }, 200, { "cache-control": "private, no-store" });
}

export async function problemLeaderboard(request: Request, env: ForgeWorkerEnv, problemVersionId: string): Promise<Response> {
  const problem = await env.DB.prepare("SELECT managed_problem_versions.id, managed_problem_versions.allowed_languages_json FROM managed_problem_versions JOIN managed_snapshots ON managed_snapshots.id=managed_problem_versions.snapshot_id WHERE managed_problem_versions.id=? AND managed_snapshots.mode='official-practice' AND managed_snapshots.status IN ('published','superseded')")
    .bind(problemVersionId).first<{ id: string; allowed_languages_json: string }>();
  if (!problem) throw new ApiError(404, "managed-problem-not-found", "Managed problem version was not found.");
  const url = new URL(request.url);
  const availableLanguages = storedStringArray(problem.allowed_languages_json, "Problem allowed languages");
  if (availableLanguages.length < 1 || availableLanguages.some((language) => !isBuiltinLanguage(language))) {
    throw new Error("Problem allowed languages are invalid.");
  }
  const selectedLanguageValue = url.searchParams.get("language");
  if (
    selectedLanguageValue !== null
    && (!isBuiltinLanguage(selectedLanguageValue) || !availableLanguages.includes(selectedLanguageValue))
  ) {
    throw new ApiError(400, "leaderboard-language-invalid", "Language is not available for this problem leaderboard.");
  }
  const selectedLanguage = selectedLanguageValue as BuiltinLanguage | null;
  const rawLimit = Number(url.searchParams.get("limit") ?? "50");
  const limit = Number.isSafeInteger(rawLimit) ? Math.min(100, Math.max(1, rawLimit)) : 50;
  const effective = await effectiveProblemVersion(env, problemVersionId);
  const entries = await queryProblemLeaderboard(env.DB, {
    effectiveProblemVersionId: effective.effectiveProblemVersionId,
    rejudgeBatchId: effective.rejudgeBatchId,
    language: selectedLanguage ?? undefined,
    limit,
  });
  return projectLeaderboardEntries(env, {
    frozen: false,
    entries,
    availableLanguages: availableLanguages as BuiltinLanguage[],
    selectedLanguage: selectedLanguage ?? undefined,
    rejudgeBatchId: effective.rejudgeBatchId,
  });
}

export async function listContests(request: Request, env: ForgeWorkerEnv): Promise<Response> {
  const session = await authenticatedSession(request, env);
  const rawLimit = Number(new URL(request.url).searchParams.get("limit") ?? "50");
  const limit = Number.isSafeInteger(rawLimit) ? Math.min(100, Math.max(1, rawLimit)) : 50;
  const rows = await env.DB.prepare(`SELECT contests.id, contests.title, contests.description, contests.access_mode, contests.starts_at, contests.ends_at, contests.freeze_at,
    CASE WHEN contests.organizer_user_id=? THEN 1 ELSE 0 END AS is_organizer,
    CASE WHEN contest_participants.user_id IS NULL THEN 0 ELSE 1 END AS joined,
    profiles.display_name AS organizer_display_name, profiles.visibility AS organizer_visibility, github_identities.login AS organizer_login
    FROM contests
    LEFT JOIN contest_participants ON contest_participants.contest_id=contests.id AND contest_participants.user_id=?
    LEFT JOIN profiles ON profiles.user_id=contests.organizer_user_id
    LEFT JOIN github_identities ON github_identities.user_id=contests.organizer_user_id
    WHERE contests.status='published' AND (contests.access_mode='public' OR contests.organizer_user_id=? OR contest_participants.user_id IS NOT NULL)
    ORDER BY CASE WHEN contests.ends_at>? AND contests.starts_at<=? THEN 0 WHEN contests.starts_at>? THEN 1 ELSE 2 END, contests.starts_at ASC, contests.id ASC LIMIT ?`)
    .bind(session?.userId ?? "", session?.userId ?? "", session?.userId ?? "", new Date().toISOString(), new Date().toISOString(), new Date().toISOString(), limit)
    .all<Record<string, unknown>>();
  const now = new Date();
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

export async function managedProblemProjection(request: Request, env: ForgeWorkerEnv, problemVersionId: string): Promise<Response> {
  const problem = await env.DB.prepare(
    "SELECT managed_problem_versions.public_projection_r2_key, managed_problem_versions.bundle_digest, managed_problem_versions.problem_slug, managed_snapshots.mode, managed_snapshots.status, collection_imports.github_repository_id FROM managed_problem_versions JOIN managed_snapshots ON managed_snapshots.id=managed_problem_versions.snapshot_id JOIN collection_imports ON collection_imports.id=managed_snapshots.import_id WHERE managed_problem_versions.id=?",
  ).bind(problemVersionId).first<{ public_projection_r2_key: string; bundle_digest: string; problem_slug: string; mode: string; status: string; github_repository_id: number }>();
  if (
    !problem
    || (problem.mode === "official-practice" && problem.status !== "published" && problem.status !== "superseded")
    || (problem.mode === "contest" && problem.status !== "published")
  ) throw new ApiError(404, "managed-problem-not-found", "Managed problem version was not found.");
  if (problem.mode !== "official-practice" && problem.mode !== "contest") throw new ApiError(500, "managed-projection-mode", "Managed public projection has an invalid publication mode.");
  let cacheControl = problem.status === "superseded"
    ? "public, max-age=31536000, immutable"
    : "public, max-age=300";
  if (problem.mode === "contest") {
    const contestId = new URL(request.url).searchParams.get("contestId");
    if (!contestId || !UUID_PATTERN.test(contestId)) throw new ApiError(404, "managed-problem-not-found", "Contest context is required.");
    const session = await authenticatedSession(request, env);
    const contest = await env.DB.prepare("SELECT contests.access_mode, contests.status, contests.organizer_user_id, contests.starts_at, contest_participants.user_id FROM contests JOIN contest_problems ON contest_problems.contest_id=contests.id LEFT JOIN contest_participants ON contest_participants.contest_id=contests.id AND contest_participants.user_id=? WHERE contests.id=? AND contest_problems.managed_problem_version_id=?")
      .bind(session?.userId ?? "", contestId, problemVersionId).first<{ access_mode: string; status: string; organizer_user_id: string; starts_at: string; user_id: string | null }>();
    const organizer = contest?.organizer_user_id === session?.userId;
    if (
      !contest || (!organizer && contest.status !== "published") || (!organizer && contest.starts_at > new Date().toISOString())
      || (contest.access_mode === "invite" && !contest.user_id && !organizer)
    ) throw new ApiError(404, "managed-problem-not-found", "Managed problem version was not found.");
    if (contest.access_mode === "invite" || contest.status === "draft") cacheControl = "private, no-store";
  }
  const bytes = await verifiedPublicProjectionBytes(env, problem.public_projection_r2_key);
  try {
    const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
    const projection = parseManagedPublicProblemProjection(
      value,
      problem.mode === "contest" ? "contest" : "official-practice",
      problem.bundle_digest,
    );
    const responseBytes = canonicalJsonBytes(projection);
    let currentProblemVersionId: string | undefined;
    if (problem.mode === "official-practice" && problem.status === "superseded") {
      const current = await env.DB.prepare(`SELECT managed_problem_versions.id
        FROM managed_problem_versions
        JOIN managed_snapshots ON managed_snapshots.id=managed_problem_versions.snapshot_id
        JOIN collection_imports ON collection_imports.id=managed_snapshots.import_id
        WHERE collection_imports.github_repository_id=?
          AND managed_snapshots.mode='official-practice'
          AND managed_snapshots.status='published'
          AND managed_problem_versions.problem_slug=?
        ORDER BY managed_snapshots.published_at DESC, managed_problem_versions.id DESC
        LIMIT 1`)
        .bind(problem.github_repository_id, problem.problem_slug).first<{ id: string }>();
      currentProblemVersionId = current?.id;
    }
    return new Response(responseBytes.buffer as ArrayBuffer, { headers: {
      "content-type": "application/json",
      "cache-control": cacheControl,
      ...(problem.mode === "official-practice" ? {
        "x-forge-problem-status": problem.status === "superseded" ? "archived" : "current",
        ...(currentProblemVersionId ? { "x-forge-current-problem-version": currentProblemVersionId } : {}),
      } : {}),
    } });
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(500, "managed-projection-role", "Managed public projection failed semantic role verification.");
  } finally {
    bytes.fill(0);
  }
}

export async function listRepositoryPushNotices(request: Request, env: ForgeWorkerEnv): Promise<Response> {
  const session = await requireSession(request, env);
  await requireOrganizer(env, session);
  const rows = await env.DB.prepare(`SELECT repository_push_notices.id, repository_push_notices.commit_sha, repository_push_notices.ref,
    repository_push_notices.received_at, repository_push_notices.acknowledged_at,
    github_repositories.github_repository_id, github_repositories.owner_login, github_repositories.name, github_repositories.is_private
    FROM repository_push_notices
    JOIN github_repositories ON github_repositories.github_repository_id=repository_push_notices.github_repository_id
    JOIN github_installations ON github_installations.installation_id=github_repositories.installation_id
    WHERE github_installations.installed_by_user_id=?
    ORDER BY repository_push_notices.received_at DESC, repository_push_notices.id DESC LIMIT 100`)
    .bind(session.userId).all<Record<string, unknown>>();
  return jsonResponse({ notices: rows.results.map((row) => ({
    id: row.id,
    githubRepositoryId: row.github_repository_id,
    repository: `${row.owner_login}/${row.name}`,
    private: row.is_private === 1,
    commitSha: row.commit_sha,
    ref: row.ref,
    receivedAt: row.received_at,
    acknowledgedAt: row.acknowledged_at,
  })) }, 200, { "cache-control": "private, no-store" });
}

export async function acknowledgeRepositoryPushNotice(request: Request, env: ForgeWorkerEnv, noticeId: string): Promise<Response> {
  const session = await requireMutationSession(request, env);
  await requireOrganizer(env, session);
  exact(await readJsonBody(request, 1_024), []);
  const acknowledgedAt = new Date().toISOString();
  const updated = await env.DB.prepare(`UPDATE repository_push_notices SET acknowledged_at=?
    WHERE id=? AND acknowledged_at IS NULL AND EXISTS (
      SELECT 1 FROM github_repositories
      JOIN github_installations ON github_installations.installation_id=github_repositories.installation_id
      WHERE github_repositories.github_repository_id=repository_push_notices.github_repository_id
        AND github_installations.installed_by_user_id=?
    )`).bind(acknowledgedAt, noticeId, session.userId).run();
  if (updated.meta.changes !== 1) {
    const owned = await env.DB.prepare(`SELECT repository_push_notices.acknowledged_at FROM repository_push_notices
      JOIN github_repositories ON github_repositories.github_repository_id=repository_push_notices.github_repository_id
      JOIN github_installations ON github_installations.installation_id=github_repositories.installation_id
      WHERE repository_push_notices.id=? AND github_installations.installed_by_user_id=?`)
      .bind(noticeId, session.userId).first<{ acknowledged_at: string | null }>();
    if (!owned) throw new ApiError(404, "repository-notice-not-found", "Repository notification was not found.");
    if (!owned.acknowledged_at) throw new ApiError(409, "repository-notice-conflict", "Repository notification could not be acknowledged.");
    return jsonResponse({ noticeId, acknowledgedAt: owned.acknowledged_at, replayed: true });
  }
  return jsonResponse({ noticeId, acknowledgedAt, replayed: false });
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
  const body = exact(await readJsonBody(request, 64 * 1024), ["title", "description", "accessMode", "startsAt", "endsAt", "problemVersionIds"], ["freezeAt", "inviteCode"]);
  if (typeof body.title !== "string" || body.title.trim().length < 1 || body.title.length > 120 || typeof body.description !== "string" || body.description.length > 10_000 || (body.accessMode !== "public" && body.accessMode !== "invite") || !Array.isArray(body.problemVersionIds) || body.problemVersionIds.length < 1 || body.problemVersionIds.length > 100 || body.problemVersionIds.some((id) => typeof id !== "string" || !UUID_PATTERN.test(id)) || new Set(body.problemVersionIds).size !== body.problemVersionIds.length) {
    throw new ApiError(400, "contest-invalid", "Contest fields are invalid.");
  }
  const startsAt = timestamp(body.startsAt, "startsAt");
  const endsAt = timestamp(body.endsAt, "endsAt");
  const freezeAt = body.freezeAt === undefined ? undefined : timestamp(body.freezeAt, "freezeAt");
  if (endsAt <= startsAt || (freezeAt && (freezeAt <= startsAt || freezeAt >= endsAt))) throw new ApiError(400, "contest-time-invalid", "Contest time range is invalid.");
  if (body.inviteCode !== undefined && (typeof body.inviteCode !== "string" || body.inviteCode.length < 16 || body.inviteCode.length > 128)) throw new ApiError(400, "contest-invite-invalid", "Invite code must contain 16–128 characters.");
  if (body.accessMode === "public" && body.inviteCode !== undefined) throw new ApiError(400, "contest-invite-invalid", "Public contests cannot have an invite code.");
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

async function requireOwnedContestProblems(env: ForgeWorkerEnv, userId: string, ids: readonly string[]): Promise<void> {
  const placeholders = ids.map(() => "?").join(",");
  const versions = await env.DB.prepare(`SELECT managed_problem_versions.id FROM managed_problem_versions JOIN managed_snapshots ON managed_snapshots.id=managed_problem_versions.snapshot_id JOIN collection_imports ON collection_imports.id=managed_snapshots.import_id WHERE managed_problem_versions.id IN (${placeholders}) AND managed_snapshots.mode='contest' AND managed_snapshots.status='published' AND collection_imports.organizer_user_id=?`)
    .bind(...ids, userId).all<{ id: string }>();
  if (versions.results.length !== ids.length) throw new ApiError(409, "contest-problem-invalid", "Every contest problem must be an Organizer-owned published contest snapshot.");
}

export async function createContest(request: Request, env: ForgeWorkerEnv): Promise<Response> {
  const session = await requireMutationSession(request, env);
  await requireStagingFormalAccess(env, session.userId);
  await requireOrganizer(env, session);
  const input = await contestDraftInput(request);
  if (input.accessMode === "invite" && input.inviteCode === undefined) throw new ApiError(400, "contest-invite-invalid", "Invite contests require a 16–128 character code.");
  await requireOwnedContestProblems(env, session.userId, input.problemVersionIds);
  const contestId = crypto.randomUUID();
  const now = new Date().toISOString();
  if (env.INVITE_CODE_HMAC_SECRET.length < 32) throw new Error("Invite-code HMAC secret is not configured.");
  const inviteCodeHash = input.inviteCode ? await hmacSha256Hex(env.INVITE_CODE_HMAC_SECRET, new TextEncoder().encode(input.inviteCode)) : null;
  await requireFormalMutationsEnabled(env);
  await env.DB.batch([
    env.DB.prepare("INSERT INTO contests (id, organizer_user_id, title, description, access_mode, invite_code_hash, starts_at, ends_at, freeze_at, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?)")
      .bind(contestId, session.userId, input.title, input.description, input.accessMode, inviteCodeHash, input.startsAt, input.endsAt, input.freezeAt ?? null, now, now),
    ...input.problemVersionIds.map((id, index) => env.DB.prepare("INSERT INTO contest_problems (contest_id, managed_problem_version_id, ordinal) VALUES (?, ?, ?)").bind(contestId, id, index + 1)),
  ]);
  return jsonResponse({ contestId, status: "draft" }, 201);
}

export async function listOrganizerContests(request: Request, env: ForgeWorkerEnv): Promise<Response> {
  const session = await requireSession(request, env);
  await requireOrganizer(env, session);
  const status = new URL(request.url).searchParams.get("status");
  if (status !== null && !["draft", "published", "archived"].includes(status)) {
    throw new ApiError(400, "contest-status-invalid", "Contest status is invalid.");
  }
  const rows = await env.DB.prepare(`SELECT contests.id, contests.title, contests.description, contests.access_mode,
      contests.starts_at, contests.ends_at, contests.freeze_at, contests.status, contests.created_at, contests.updated_at,
      CASE WHEN contests.invite_code_hash IS NULL THEN 0 ELSE 1 END AS invite_code_configured,
      COUNT(contest_problems.managed_problem_version_id) AS problem_count
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
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  })) }, 200, { "cache-control": "private, no-store" });
}

export async function getOrganizerContest(request: Request, env: ForgeWorkerEnv, contestId: string): Promise<Response> {
  const session = await requireSession(request, env);
  await requireOrganizer(env, session);
  const contest = await env.DB.prepare(`SELECT id, title, description, access_mode,
      CASE WHEN invite_code_hash IS NULL THEN 0 ELSE 1 END AS invite_code_configured,
      starts_at, ends_at, freeze_at, status, created_at, updated_at
    FROM contests WHERE id=? AND organizer_user_id=?`)
    .bind(contestId, session.userId).first<Record<string, unknown>>();
  if (!contest) throw new ApiError(404, "contest-not-found", "Organizer-owned contest was not found.");
  const problems = await env.DB.prepare(`SELECT contest_problems.ordinal,
      managed_problem_versions.id AS problem_version_id, managed_problem_versions.problem_slug,
      managed_problem_versions.problem_number, managed_problem_versions.title_json,
      managed_snapshots.collection_revision,
      github_repositories.owner_login, github_repositories.name AS repository_name
    FROM contest_problems
    JOIN managed_problem_versions ON managed_problem_versions.id=contest_problems.managed_problem_version_id
    JOIN managed_snapshots ON managed_snapshots.id=managed_problem_versions.snapshot_id
    JOIN collection_imports ON collection_imports.id=managed_snapshots.import_id
    JOIN github_repositories ON github_repositories.github_repository_id=collection_imports.github_repository_id
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
      createdAt: contest.created_at,
      updatedAt: contest.updated_at,
    },
    problems: problems.results.map((problem) => ({
      ordinal: problem.ordinal,
      problemVersionId: problem.problem_version_id,
      problemSlug: problem.problem_slug,
      problemNumber: problem.problem_number,
      title: parseStoredProblemTitle(problem.title_json),
      collectionRevision: problem.collection_revision,
      repository: `${problem.owner_login}/${problem.repository_name}`,
    })),
  }, 200, { "cache-control": "private, no-store" });
}

export async function updateOrganizerContest(request: Request, env: ForgeWorkerEnv, contestId: string): Promise<Response> {
  const session = await requireMutationSession(request, env);
  await requireStagingFormalAccess(env, session.userId);
  await requireOrganizer(env, session);
  const input = await contestDraftInput(request);
  const current = await env.DB.prepare("SELECT status, invite_code_hash FROM contests WHERE id=? AND organizer_user_id=?")
    .bind(contestId, session.userId).first<{ status: string; invite_code_hash: string | null }>();
  if (!current) throw new ApiError(404, "contest-not-found", "Organizer-owned contest was not found.");
  if (current.status !== "draft") throw new ApiError(409, "contest-not-editable", "Only contest drafts can be edited.");
  await requireOwnedContestProblems(env, session.userId, input.problemVersionIds);
  let inviteCodeHash: string | null = null;
  if (input.accessMode === "invite") {
    if (input.inviteCode) {
      if (env.INVITE_CODE_HMAC_SECRET.length < 32) throw new Error("Invite-code HMAC secret is not configured.");
      inviteCodeHash = await hmacSha256Hex(env.INVITE_CODE_HMAC_SECRET, new TextEncoder().encode(input.inviteCode));
    } else {
      inviteCodeHash = current.invite_code_hash;
    }
    if (!inviteCodeHash) throw new ApiError(400, "contest-invite-invalid", "A new invite code is required when changing a public draft to invite access.");
  }
  await requireFormalMutationsEnabled(env);
  const updatedAt = new Date().toISOString();
  const [updated] = await env.DB.batch([
    env.DB.prepare(`UPDATE contests SET title=?, description=?, access_mode=?, invite_code_hash=?, starts_at=?, ends_at=?, freeze_at=?, updated_at=?
      WHERE id=? AND organizer_user_id=? AND status='draft'`)
      .bind(input.title, input.description, input.accessMode, inviteCodeHash, input.startsAt, input.endsAt, input.freezeAt ?? null, updatedAt, contestId, session.userId),
    env.DB.prepare("DELETE FROM contest_problems WHERE contest_id=? AND EXISTS (SELECT 1 FROM contests WHERE id=? AND organizer_user_id=? AND status='draft')")
      .bind(contestId, contestId, session.userId),
    ...input.problemVersionIds.map((id, index) => env.DB.prepare(`INSERT INTO contest_problems (contest_id, managed_problem_version_id, ordinal)
      SELECT ?, ?, ? WHERE EXISTS (SELECT 1 FROM contests WHERE id=? AND organizer_user_id=? AND status='draft')`)
      .bind(contestId, id, index + 1, contestId, session.userId)),
  ]);
  if (updated.meta.changes !== 1) throw new ApiError(409, "contest-not-editable", "Contest draft changed while it was being edited.");
  return jsonResponse({ contestId, status: "draft", updatedAt });
}

export async function rotateContestInviteCode(request: Request, env: ForgeWorkerEnv, contestId: string): Promise<Response> {
  const session = await requireMutationSession(request, env);
  await requireStagingFormalAccess(env, session.userId);
  await requireOrganizer(env, session);
  const body = exact(await readJsonBody(request, 8 * 1024), ["inviteCode"]);
  if (typeof body.inviteCode !== "string" || body.inviteCode.length < 16 || body.inviteCode.length > 128) {
    throw new ApiError(400, "contest-invite-invalid", "Invite code must contain 16–128 characters.");
  }
  if (env.INVITE_CODE_HMAC_SECRET.length < 32) throw new Error("Invite-code HMAC secret is not configured.");
  await requireFormalMutationsEnabled(env);
  const updatedAt = new Date().toISOString();
  const inviteCodeHash = await hmacSha256Hex(env.INVITE_CODE_HMAC_SECRET, new TextEncoder().encode(body.inviteCode));
  const result = await env.DB.prepare(`UPDATE contests SET invite_code_hash=?, updated_at=?
      WHERE id=? AND organizer_user_id=? AND access_mode='invite' AND status IN ('draft','published')`)
    .bind(inviteCodeHash, updatedAt, contestId, session.userId).run();
  if (result.meta.changes !== 1) throw new ApiError(409, "contest-invite-not-rotatable", "Contest is not an Organizer-owned invite contest that can rotate its code.");
  return jsonResponse({ contestId, inviteCodeConfigured: true, updatedAt });
}

export async function publishContest(request: Request, env: ForgeWorkerEnv, contestId: string): Promise<Response> {
  const session = await requireMutationSession(request, env);
  await requireStagingFormalAccess(env, session.userId);
  await requireOrganizer(env, session);
  await requireFormalMutationsEnabled(env);
  const result = await env.DB.prepare("UPDATE contests SET status='published', updated_at=? WHERE id=? AND organizer_user_id=? AND status='draft'")
    .bind(new Date().toISOString(), contestId, session.userId).run();
  if (result.meta.changes !== 1) throw new ApiError(409, "contest-not-publishable", "Contest is not an Organizer-owned draft.");
  return jsonResponse({ contestId, status: "published" });
}

export async function joinContest(request: Request, env: ForgeWorkerEnv, contestId: string): Promise<Response> {
  const session = await requireMutationSession(request, env);
  const body = exact(await readJsonBody(request, 8 * 1024), [], ["inviteCode"]);
  const contest = await env.DB.prepare("SELECT access_mode, invite_code_hash, status, ends_at FROM contests WHERE id=?")
    .bind(contestId).first<{ access_mode: string; invite_code_hash: string | null; status: string; ends_at: string }>();
  if (!contest || contest.status !== "published" || contest.ends_at <= new Date().toISOString()) throw new ApiError(409, "contest-closed", "Contest is not open for joining.");
  if (env.INVITE_CODE_HMAC_SECRET.length < 32) throw new Error("Invite-code HMAC secret is not configured.");
  if (contest.access_mode === "invite" && (typeof body.inviteCode !== "string" || !contest.invite_code_hash || !constantTimeEqual(await hmacSha256Hex(env.INVITE_CODE_HMAC_SECRET, new TextEncoder().encode(body.inviteCode)), contest.invite_code_hash))) {
    throw new ApiError(403, "contest-invite-invalid", "Invite code is invalid.");
  }
  await env.DB.prepare("INSERT OR IGNORE INTO contest_participants (contest_id, user_id, joined_at) VALUES (?, ?, ?)")
    .bind(contestId, session.userId, new Date().toISOString()).run();
  return jsonResponse({ contestId, joined: true });
}

export async function getContest(request: Request, env: ForgeWorkerEnv, contestId: string): Promise<Response> {
  const session = await authenticatedSession(request, env);
  const contest = await env.DB.prepare("SELECT contests.id, contests.organizer_user_id, contests.title, contests.description, contests.access_mode, contests.starts_at, contests.ends_at, contests.freeze_at, contests.status, contest_participants.user_id AS participant_user_id FROM contests LEFT JOIN contest_participants ON contest_participants.contest_id=contests.id AND contest_participants.user_id=? WHERE contests.id=?")
    .bind(session?.userId ?? "", contestId).first<Record<string, unknown>>();
  const organizer = contest?.organizer_user_id === session?.userId;
  if (!contest || (contest.status !== "published" && !organizer)) throw new ApiError(404, "contest-not-found", "Contest was not found.");
  const now = new Date();
  const joined = contest.participant_user_id === session?.userId;
  const problemVisible = organizer || (contest.status === "published" && (
    String(contest.starts_at) <= now.toISOString()
    && (contest.access_mode === "public" || joined)
  ));
  const problems = problemVisible
    ? await env.DB.prepare("SELECT contest_problems.ordinal, managed_problem_versions.id AS problem_version_id, managed_problem_versions.problem_slug, managed_problem_versions.title_json FROM contest_problems JOIN managed_problem_versions ON managed_problem_versions.id=contest_problems.managed_problem_version_id WHERE contest_problems.contest_id=? ORDER BY contest_problems.ordinal")
      .bind(contestId).all()
    : { results: [] };
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
    },
    problems: problems.results.map((problem) => ({
      ordinal: problem.ordinal,
      problemVersionId: problem.problem_version_id,
      problemSlug: problem.problem_slug,
      title: parseStoredProblemTitle(problem.title_json),
    })),
  });
}

export async function contestLeaderboard(request: Request, env: ForgeWorkerEnv, contestId: string): Promise<Response> {
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
  const mappings = await env.DB.prepare(`SELECT
      contest_problems.managed_problem_version_id AS original_problem_version_id,
      CASE WHEN rejudge_batches.id IS NULL THEN contest_problems.managed_problem_version_id ELSE effective_problem_versions.effective_problem_version_id END AS effective_problem_version_id,
      rejudge_batches.id AS rejudge_batch_id
    FROM contest_problems
    LEFT JOIN effective_problem_versions ON effective_problem_versions.original_problem_version_id=contest_problems.managed_problem_version_id
    LEFT JOIN rejudge_batches ON rejudge_batches.id=effective_problem_versions.rejudge_batch_id AND rejudge_batches.status='effective'
    WHERE contest_problems.contest_id=?
    ORDER BY contest_problems.ordinal`)
    .bind(contestId).all<{ original_problem_version_id: string; effective_problem_version_id: string; rejudge_batch_id: string | null }>();
  const now = new Date().toISOString();
  const frozen = contest.freeze_at !== null && contest.freeze_at <= now && now < contest.ends_at;
  const organizer = contest.organizer_user_id === session?.userId;
  const viewerFrozen = frozen && !organizer;
  let entries = await queryContestLeaderboard(env.DB, {
    contestId,
    problems: mappings.results.map((row) => ({
      originalProblemVersionId: row.original_problem_version_id,
      effectiveProblemVersionId: row.effective_problem_version_id,
      ...(row.rejudge_batch_id ? { rejudgeBatchId: row.rejudge_batch_id } : {}),
    })),
    completedAtOrBefore: viewerFrozen ? contest.freeze_at ?? undefined : undefined,
    limit,
  });
  if (viewerFrozen) {
    const participants = await env.DB.prepare("SELECT user_id FROM contest_participants WHERE contest_id=? ORDER BY user_id")
      .bind(contestId).all<{ user_id: string }>();
    entries = includeFrozenContestParticipants(entries, participants.results.map((row) => row.user_id), contest.freeze_at ?? now);
  }
  const rejudgeSelection = Object.fromEntries(mappings.results.flatMap((row) => row.rejudge_batch_id ? [[
    row.original_problem_version_id,
    { batchId: row.rejudge_batch_id, stagedProblemVersionId: row.effective_problem_version_id },
  ]] : []));
  return projectLeaderboardEntries(env, {
    frozen: viewerFrozen,
    entries,
    ...(Object.keys(rejudgeSelection).length > 0 ? { rejudgeSelection } : {}),
  });
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
