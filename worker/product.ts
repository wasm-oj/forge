import { isBuiltinLanguage, type BuiltinLanguage } from "../src/core/types";
import { parseJudgeAllowedProfiles, type JudgeAllowedProfiles } from "../src/online-judge/compile-profiles";
import { ContestRuleEngine, type ContestLogicalClockSnapshot } from "../src/online-judge/contest-rules";
import { parseStoredProblemTitle } from "../src/online-judge/stored-problem-title";
import { authenticatedSession, requireBrowserMutationSession, requireBrowserOrBearerMutationSession, requireSession } from "./auth";
import { loadContestRuntimeSnapshot, type ContestRuntimeSnapshot } from "./contest-runtime";
import { constantTimeEqual, hmacSha256Hex } from "./crypto";
import type { AuthenticatedSession, WasmOjWorkerEnv } from "./env";
import { requireStagingFormalAccess } from "./formal-access";
import { requireFormalMutationsEnabled } from "./formal-mutations";
import { requireOrganizer } from "./github";
import { ApiError, jsonResponse, readJsonBody } from "./http";
import { queryContestLeaderboard, queryProblemLeaderboard, type LeaderboardEntryRow } from "./leaderboards";
import { queryPerformanceEvolution, queryPerformanceFrontier } from "./performance";
import { hostPromptAssistAvailable, hostPromptCompilerRegistry } from "./prompt-compiler-registry";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const textEncoder = new TextEncoder();

function promptCompilerAvailable(snapshot: ContestRuntimeSnapshot): boolean {
  const track = snapshot.rules.officialTrack;
  return track.kind === "prompt-program"
    && hostPromptCompilerRegistry().isAvailable(track.compiler.configId, track.compiler.configDigest);
}

function aiAssistAvailable(snapshot: ContestRuntimeSnapshot): boolean {
  const track = snapshot.rules.officialTrack;
  return track.kind === "code" && track.aiAssist === "allowed" && hostPromptAssistAvailable();
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

interface ContestMetadataRow {
  readonly id: string;
  readonly slug: string;
  readonly organizer_user_id: string;
  readonly rules_commit: string;
  readonly status: "draft" | "published" | "archived";
  readonly title: string;
  readonly description: string;
  readonly access_mode: "public" | "invite";
  readonly created_at: string;
  readonly invite_code_configured: number;
  readonly pending_rules_commit: string | null;
  readonly organizer_display_name: string | null;
  readonly organizer_visibility: "public" | "private" | null;
  readonly organizer_login: string | null;
}

interface ContestProblemMetadataRow extends ProblemRevisionRow {
  readonly organizer_user_id: string;
  readonly contest_status: "draft" | "published" | "archived";
  readonly access_mode: "public" | "invite";
  readonly content_epoch: number;
  readonly prompt_context_sha256: string | null;
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
    readonly hidden?: boolean;
    readonly entries: readonly LeaderboardEntryRow[];
    readonly availableLanguages?: readonly BuiltinLanguage[];
    readonly selectedLanguage?: BuiltinLanguage;
  },
): Promise<Response> {
  const entries = input.entries.map((entry, index) => ({ ...entry, rank: entry.rank ?? index + 1 }));
  const identities = await leaderboardParticipants(env, entries.map((entry) => entry.userId));
  return jsonResponse({
    frozen: input.frozen,
    hidden: input.hidden ?? false,
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

function problemMetadata(
  problem: ProblemRevisionRow,
  role: "practice" | "contest",
  contest?: {
    readonly contestId: string;
    readonly timelineGeneration: number;
    readonly ruleEpoch: number;
    readonly problemEpoch: number;
    readonly promptContextSha256?: string | null;
  },
  assist?: {
    readonly available: boolean;
    readonly contextSha256: string | null;
  },
): Record<string, unknown> {
  const practice = role === "practice";
  return {
    schema: "wasm-oj-platform/problem-content-pointer/v2",
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
    aiAssistAvailable: assist?.available === true,
    assistContextSha256: assist?.available === true ? assist.contextSha256 : null,
    ...(contest ? { contestAdmission: {
      timelineGeneration: contest.timelineGeneration,
      ruleEpoch: contest.ruleEpoch,
      problemEpoch: contest.problemEpoch,
    } } : {}),
    ...(contest?.promptContextSha256 !== undefined ? { promptContextSha256: contest.promptContextSha256 } : {}),
    content: {
      role,
      bytes: practice ? problem.practice_bundle_bytes : problem.contest_bundle_bytes,
      sha256: practice ? problem.practice_bundle_sha256 : problem.contest_bundle_sha256,
      url: contentUrl(problem.problem_id, problem.commit_sha, role, contest?.contestId),
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
    const available = hostPromptAssistAvailable();
    return jsonResponse(problemMetadata(row, "practice", undefined, {
      available,
      contextSha256: available ? row.practice_bundle_sha256 : null,
    }), 200, { "cache-control": "public, max-age=300" });
  }
  if (!UUID.test(contestId)) throw new ApiError(404, "problem-not-found", "Contest context is invalid.");
  const session = await authenticatedSession(request, env);
  const snapshot = await loadContestRuntimeSnapshot(env, contestId, session ?? null);
  const row = await contestProblemMetadata(env, contestId, problemId);
  const organizer = row?.organizer_user_id === session?.userId;
  const projectedProblem = snapshot.projection.problems.find((problem) => problem.slug === row?.slug);
  const runtimeProblem = snapshot.problems.find((problem) => problem.problemId === problemId);
  if (!row || !projectedProblem || !runtimeProblem || (!organizer && row.contest_status !== "published")
    || (!organizer && (!snapshot.entrant || projectedProblem.availability === "locked"))) {
    throw new ApiError(404, "problem-not-found", "Contest problem was not found.");
  }
  if (!organizer) await ensureContestReveal(env, snapshot, runtimeProblem, row.content_epoch);
  const assistAvailable = aiAssistAvailable(snapshot);
  return jsonResponse(problemMetadata(row, "contest", {
    contestId,
    timelineGeneration: snapshot.epochs.timelineGeneration,
    ruleEpoch: snapshot.epochs.ruleEpoch,
    problemEpoch: runtimeProblem.problemEpoch,
    ...(snapshot.rules.officialTrack.kind === "prompt-program"
      ? { promptContextSha256: row.prompt_context_sha256 }
      : {}),
  }, {
    available: assistAvailable,
    contextSha256: assistAvailable ? row.prompt_context_sha256 : null,
  }), 200, { "cache-control": "private, no-store", vary: "Cookie" });
}

async function contestProblemMetadata(
  env: WasmOjWorkerEnv,
  contestId: string,
  problemId: string,
): Promise<ContestProblemMetadataRow | null> {
  return env.DB.prepare(`SELECT revisions.*, problems.catalog_id, problems.slug,
      catalogs.organizer_user_id, rules.status AS contest_status, rules.access_mode,
      epochs.content_epoch, prompt_contexts.public_context_sha256 AS prompt_context_sha256
    FROM contest_series AS contests
    JOIN catalogs ON catalogs.id=contests.catalog_id
    JOIN contest_runtimes AS runtime ON runtime.contest_id=contests.id
    JOIN contest_rule_revisions AS rules
      ON rules.contest_id=runtime.contest_id
     AND rules.rules_commit=runtime.active_rules_commit
     AND rules.rules_sha256=runtime.active_rules_sha256
    JOIN contest_rule_problems AS selected
      ON selected.contest_id=runtime.contest_id
     AND selected.rules_commit=runtime.active_rules_commit
     AND selected.problem_id=?
    JOIN contest_problem_epochs AS epochs
      ON epochs.contest_id=selected.contest_id
     AND epochs.problem_id=selected.problem_id AND epochs.state='effective'
    JOIN problem_series AS problems ON problems.id=selected.problem_id
    JOIN problem_revisions AS revisions
      ON revisions.problem_id=problems.id AND revisions.commit_sha=epochs.content_commit
    LEFT JOIN contest_problem_prompt_contexts AS prompt_contexts
      ON prompt_contexts.contest_id=epochs.contest_id
     AND prompt_contexts.problem_id=epochs.problem_id
     AND prompt_contexts.content_epoch=epochs.content_epoch
    WHERE contests.id=?`).bind(problemId, contestId).first<ContestProblemMetadataRow>();
}

async function ensureContestReveal(
  env: WasmOjWorkerEnv,
  snapshot: ContestRuntimeSnapshot,
  problem: ContestRuntimeSnapshot["problems"][number],
  contentEpoch: number,
): Promise<void> {
  if (!snapshot.entrant || snapshot.projection.logicalSeconds === null) throw new ApiError(404, "problem-not-found", "Contest problem was not found.");
  const now = new Date().toISOString();
  const logicalSeconds = Math.floor(snapshot.projection.logicalSeconds);
  await env.DB.prepare(`INSERT OR IGNORE INTO contest_reveal_grants
      (contest_id, entrant_id, problem_id, timeline_generation, rules_epoch,
       content_epoch, granted_logical_seconds, granted_at, eligibility,
       invalidated_at, invalidation_reason)
    SELECT runtime.contest_id, entrants.id, epochs.problem_id,
      runtime.timeline_generation, runtime.rules_epoch, epochs.content_epoch,
      ?, ?, 'eligible', NULL, NULL
    FROM contest_runtimes AS runtime
    JOIN contest_entrants AS entrants
      ON entrants.contest_id=runtime.contest_id AND entrants.id=?
     AND entrants.state_timeline_generation=runtime.timeline_generation
    JOIN contest_problem_epochs AS epochs
      ON epochs.contest_id=runtime.contest_id AND epochs.problem_id=?
     AND epochs.problem_epoch=? AND epochs.content_epoch=? AND epochs.state='effective'
    JOIN contest_rule_problems AS rules
      ON rules.contest_id=runtime.contest_id
     AND rules.rules_commit=runtime.active_rules_commit
     AND rules.problem_id=epochs.problem_id
    WHERE runtime.contest_id=? AND runtime.timeline_generation=? AND runtime.rules_epoch=?
      AND runtime.state IN ('running','ended')
      AND entrants.state IN ('active','eliminated','completed')
      AND rules.release_after_seconds<=?`)
    .bind(
      logicalSeconds, now, snapshot.entrant.entrantId, problem.problemId,
      problem.problemEpoch, contentEpoch, snapshot.contestId,
      snapshot.epochs.timelineGeneration, snapshot.epochs.ruleEpoch, logicalSeconds,
    ).run();
  const grant = await env.DB.prepare(`SELECT 1 FROM contest_reveal_grants
    WHERE contest_id=? AND entrant_id=? AND problem_id=? AND timeline_generation=?
      AND rules_epoch=? AND content_epoch=? AND eligibility='eligible'`)
    .bind(
      snapshot.contestId, snapshot.entrant.entrantId, problem.problemId,
      snapshot.epochs.timelineGeneration, snapshot.epochs.ruleEpoch, contentEpoch,
    ).first();
  if (!grant) throw new ApiError(404, "problem-not-found", "Contest problem was not found.");
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
  let problem: ProblemRevisionRow;
  let contestSnapshot: ContestRuntimeSnapshot | null = null;
  let organizer = false;
  if (contestId) {
    contestSnapshot = await loadContestRuntimeSnapshot(env, contestId, session ?? null);
    const row = await contestProblemMetadata(env, contestId, problemId);
    organizer = row?.organizer_user_id === session?.userId;
    const projected = contestSnapshot.projection.problems.find((candidate) => candidate.slug === row?.slug);
    const runtimeProblem = contestSnapshot.problems.find((candidate) => candidate.problemId === problemId);
    if (!row || !runtimeProblem || !projected || (!organizer && (
      row.contest_status !== "published" || !contestSnapshot.entrant || projected.availability === "locked"
    ))) throw new ApiError(404, "problem-not-found", "Contest problem context was not found.");
    if (!organizer) await ensureContestReveal(env, contestSnapshot, runtimeProblem, row.content_epoch);
    problem = row;
  } else problem = await activeProblem(env, problemId);
  const availableLanguages = Object.keys(storedAllowedProfiles(problem.allowed_profiles_json)).sort() as BuiltinLanguage[];
  const languageValue = url.searchParams.get("language");
  if (languageValue !== null && (!isBuiltinLanguage(languageValue) || !availableLanguages.includes(languageValue))) {
    throw new ApiError(400, "performance-language-invalid", "Language is not available for this performance view.");
  }
  const language = languageValue as BuiltinLanguage | null;
  const leaderboard = contestSnapshot?.rules.leaderboard;
  // An individual entrant can finish while enrollment and other entrant clocks
  // remain active. Shared results end only with the canonical contest runtime,
  // never with the requesting entrant's local projection.
  const ended = contestSnapshot?.state === "ended";
  const hidden = Boolean(contestSnapshot && !organizer && leaderboard?.kind === "hidden-until-end" && !ended);
  const frozen = Boolean(contestSnapshot && !organizer && leaderboard?.kind === "freeze" && !ended
    && (contestSnapshot.projection.logicalSeconds ?? -1) >= leaderboard.atSeconds);
  const evidenceLogicalAtOrBefore = frozen && leaderboard?.kind === "freeze" ? leaderboard.atSeconds : undefined;
  const [frontier, evolution] = await Promise.all([
    hidden ? Promise.resolve([]) : queryPerformanceFrontier(env.DB, {
      problemId,
      ...(contestId ? { contestId } : {}),
      ...(language ? { language } : {}),
      ...(evidenceLogicalAtOrBefore !== undefined ? { evidenceLogicalAtOrBefore } : {}),
    }),
    session ? queryPerformanceEvolution(env.DB, {
      userId: session.userId, problemId, ...(contestId ? { contestId } : {}), ...(language ? { language } : {}),
    }) : Promise.resolve(null),
  ]);
  const participants = await leaderboardParticipants(env, frontier.map((entry) => entry.userId));
  return jsonResponse({
    context: { problemId, contestId, frozen, hidden, availableLanguages, selectedLanguage: language, myEvolutionTruncated: evolution?.truncated ?? false },
    frontier: frontier.map(({ userId, ...entry }) => ({ ...entry, participant: participants.get(userId) })),
    myEvolution: evolution?.entries ?? null,
  }, 200, { "cache-control": "private, no-store", vary: "Cookie" });
}

function activeContestQuery(): string {
  return `FROM contest_series AS contests
    JOIN catalogs ON catalogs.id=contests.catalog_id
    JOIN contest_runtimes AS runtime ON runtime.contest_id=contests.id
    JOIN contest_rule_revisions AS rules
      ON rules.contest_id=runtime.contest_id
     AND rules.rules_commit=runtime.active_rules_commit
     AND rules.rules_sha256=runtime.active_rules_sha256`;
}

async function contestMetadata(env: WasmOjWorkerEnv, contestId: string): Promise<ContestMetadataRow | null> {
  return env.DB.prepare(`SELECT contests.id, contests.slug, catalogs.organizer_user_id,
      runtime.active_rules_commit AS rules_commit, rules.status, rules.title,
      rules.description, rules.access_mode, contests.created_at,
      CASE WHEN contests.invite_code_hash IS NULL THEN 0 ELSE 1 END AS invite_code_configured,
      runtime.pending_rules_commit,
      profiles.display_name AS organizer_display_name, profiles.visibility AS organizer_visibility,
      github_identities.login AS organizer_login
    ${activeContestQuery()}
    LEFT JOIN profiles ON profiles.user_id=catalogs.organizer_user_id
    LEFT JOIN github_identities ON github_identities.user_id=catalogs.organizer_user_id
    WHERE contests.id=?`).bind(contestId).first<ContestMetadataRow>();
}

interface CheckpointProjectionRow {
  readonly checkpoint_id: string;
  readonly at_seconds: number;
  readonly settlement: "provisional" | "pause-until-terminal";
  readonly run_state: "evaluating" | "provisional" | "final" | "invalid" | null;
  readonly pending_work: number | null;
  readonly decision: "advanced" | "eliminated" | null;
  readonly decision_provisional: number | null;
}

async function contestOperationalProjection(
  env: WasmOjWorkerEnv,
  metadata: ContestMetadataRow,
  snapshot: ContestRuntimeSnapshot,
  organizer: boolean,
): Promise<Record<string, unknown>> {
  const checkpointRows = await env.DB.prepare(`SELECT checkpoints.checkpoint_id,
      checkpoints.at_seconds, checkpoints.settlement, runs.state AS run_state,
      runs.pending_work, decisions.decision, decisions.provisional AS decision_provisional
    FROM contest_rule_checkpoints AS checkpoints
    LEFT JOIN contest_checkpoint_runs AS runs
      ON runs.contest_id=checkpoints.contest_id
     AND runs.checkpoint_id=checkpoints.checkpoint_id
     AND runs.timeline_generation=?
     AND runs.rules_epoch=?
    LEFT JOIN contest_checkpoint_decisions AS decisions
      ON decisions.checkpoint_run_id=runs.id AND decisions.entrant_id=?
    WHERE checkpoints.contest_id=? AND checkpoints.rules_commit=?
    ORDER BY checkpoints.ordinal`)
    .bind(
      snapshot.epochs.timelineGeneration, snapshot.epochs.ruleEpoch,
      snapshot.entrant?.entrantId ?? "",
      snapshot.contestId, snapshot.rulesCommit,
    ).all<CheckpointProjectionRow>();
  const judgeRollout = await env.DB.prepare(`SELECT 1
    FROM contest_problem_epochs AS epochs
    JOIN rejudge_batches AS rollout ON rollout.id=epochs.rollout_batch_id
    WHERE epochs.contest_id=? AND epochs.state='effective'
      AND rollout.state<>'effective'
    LIMIT 1`).bind(snapshot.contestId).first();
  const elimination = snapshot.entrant ? await env.DB.prepare(`SELECT eliminated_at,
      eliminated_checkpoint_id, elimination_reason FROM contest_entrants WHERE id=?`)
    .bind(snapshot.entrant.entrantId).first<{
      readonly eliminated_at: string | null;
      readonly eliminated_checkpoint_id: string | null;
      readonly elimination_reason: string | null;
    }>() : null;
  const logicalSeconds = snapshot.projection.logicalSeconds;
  return {
    id: metadata.id,
    slug: metadata.slug,
    title: metadata.title,
    description: metadata.description,
    accessMode: metadata.access_mode,
    status: metadata.status,
    organizer,
    joined: snapshot.entrant !== null,
    rulesCommit: snapshot.rulesCommit,
    rulesDigest: snapshot.rulesDigest,
    clock: snapshot.rules.clock,
    officialTrack: snapshot.rules.officialTrack,
    evidenceAt: snapshot.rules.evidenceAt,
    scoring: snapshot.rules.scoring,
    leaderboard: snapshot.rules.leaderboard,
    runtimeState: snapshot.state,
    pausedFromState: snapshot.pausedFromState,
    scheduleShiftSeconds: snapshot.scheduleShiftSeconds,
    phase: snapshot.projection.phase,
    logicalTimeSeconds: logicalSeconds,
    nextBoundarySeconds: snapshot.projection.nextBoundarySeconds,
    problems: snapshot.projection.problems.map((problem, index) => ({
      ordinal: index + 1,
      availability: problem.availability,
      releaseAfterSeconds: problem.releaseAfterSeconds,
      submissionClosesAfterSeconds: problem.submissionClosesAfterSeconds,
      attemptsRemaining: problem.attemptsRemaining,
    })),
    paused: snapshot.state === "paused",
    pauseReason: snapshot.pauseReason,
    epochs: snapshot.epochs,
    entrant: snapshot.entrant ? {
      id: snapshot.entrant.entrantId,
      state: snapshot.entrant.state,
      started: snapshot.entrant.started,
      eliminatedAtLogicalSeconds: snapshot.entrant.eliminatedAtSeconds,
      eliminatedAt: snapshot.entrant.eliminatedAtSeconds === null ? null : elimination?.eliminated_at ?? null,
      eliminatedCheckpointId: snapshot.entrant.eliminatedAtSeconds === null ? null : elimination?.eliminated_checkpoint_id ?? null,
      eliminationReason: snapshot.entrant.eliminatedAtSeconds === null ? null : elimination?.elimination_reason ?? null,
    } : null,
    checkpoints: checkpointRows.results.map((checkpoint) => ({
      id: checkpoint.checkpoint_id,
      atSeconds: checkpoint.at_seconds,
      settlement: checkpoint.settlement,
      state: checkpoint.run_state ?? (logicalSeconds !== null && logicalSeconds >= checkpoint.at_seconds ? "pending" : "upcoming"),
      pendingWork: checkpoint.pending_work ?? 0,
      decision: checkpoint.decision,
      provisional: checkpoint.decision_provisional === 1,
    })),
    judgeProvisional: Boolean(judgeRollout),
    promptCompilerAvailable: promptCompilerAvailable(snapshot),
    aiAssistAvailable: aiAssistAvailable(snapshot),
    publicRepositoryTimingWarning: snapshot.publicRepositoryTimingWarning ? {
      active: true,
      message: "Scheduled release controls this UI only; GitHub repository content may be visible earlier.",
    } : null,
    ...(organizer ? { pendingRulesCommit: metadata.pending_rules_commit } : {}),
    createdAt: metadata.created_at,
  };
}

export async function listContests(request: Request, env: WasmOjWorkerEnv): Promise<Response> {
  const session = await authenticatedSession(request, env);
  const rawLimit = Number(new URL(request.url).searchParams.get("limit") ?? "50");
  const limit = Number.isSafeInteger(rawLimit) ? Math.min(100, Math.max(1, rawLimit)) : 50;
  const now = new Date();
  const rows = await env.DB.prepare(`SELECT contests.id, contests.slug,
      catalogs.organizer_user_id, runtime.active_rules_commit AS rules_commit,
      rules.status, rules.title, rules.description, rules.access_mode,
      contests.created_at,
      CASE WHEN contests.invite_code_hash IS NULL THEN 0 ELSE 1 END AS invite_code_configured,
      runtime.pending_rules_commit,
      profiles.display_name AS organizer_display_name, profiles.visibility AS organizer_visibility,
      github_identities.login AS organizer_login
    ${activeContestQuery()}
    LEFT JOIN contest_entrants AS entrants
      ON entrants.contest_id=contests.id AND entrants.kind='account' AND entrants.account_user_id=?
    LEFT JOIN profiles ON profiles.user_id=catalogs.organizer_user_id
    LEFT JOIN github_identities ON github_identities.user_id=catalogs.organizer_user_id
    WHERE rules.status='published'
      AND (rules.access_mode='public' OR catalogs.organizer_user_id=? OR entrants.id IS NOT NULL)
    ORDER BY rules.registration_opens_at, contests.id LIMIT ?`)
    .bind(session?.userId ?? "", session?.userId ?? "", limit).all<ContestMetadataRow>();
  const contests: Record<string, unknown>[] = [];
  for (const row of rows.results) {
    const snapshot = await loadContestRuntimeSnapshot(env, row.id, session ?? null, now);
    const organizer = row.organizer_user_id === session?.userId;
    contests.push({
      ...await contestOperationalProjection(env, row, snapshot, organizer),
      organizerProfile: row.organizer_visibility === "public" && row.organizer_login
        ? { login: row.organizer_login, displayName: row.organizer_display_name } : null,
    });
  }
  return jsonResponse({ contests });
}

export async function getContest(request: Request, env: WasmOjWorkerEnv, contestId: string): Promise<Response> {
  const session = await authenticatedSession(request, env);
  const snapshot = await loadContestRuntimeSnapshot(env, contestId, session ?? null);
  const metadata = await contestMetadata(env, contestId);
  const organizer = metadata?.organizer_user_id === session?.userId;
  if (!metadata || (metadata.status !== "published" && !organizer)) throw new ApiError(404, "contest-not-found", "Contest was not found.");
  const problems = await env.DB.prepare(`SELECT selected.ordinal, selected.batch,
      selected.release_after_seconds, selected.submission_closes_after_seconds,
      selected.points, selected.attempt_limit, problems.id AS problem_id,
      problems.slug, revisions.ordinal AS problem_number, revisions.title_json,
      epochs.problem_epoch, epochs.content_commit, epochs.judge_epoch, epochs.judge_digest,
      prompt_contexts.public_context_sha256 AS prompt_context_sha256
    FROM contest_rule_problems AS selected
    JOIN problem_series AS problems ON problems.id=selected.problem_id
    JOIN contest_problem_epochs AS epochs
      ON epochs.contest_id=selected.contest_id
     AND epochs.problem_id=selected.problem_id AND epochs.state='effective'
    JOIN problem_revisions AS revisions
      ON revisions.problem_id=problems.id AND revisions.commit_sha=epochs.content_commit
    LEFT JOIN contest_problem_prompt_contexts AS prompt_contexts
      ON prompt_contexts.contest_id=epochs.contest_id
     AND prompt_contexts.problem_id=epochs.problem_id
     AND prompt_contexts.content_epoch=epochs.content_epoch
    WHERE selected.contest_id=? AND selected.rules_commit=? ORDER BY selected.ordinal`)
    .bind(contestId, snapshot.rulesCommit).all<Record<string, unknown>>();
  const projectedProblems: Record<string, unknown>[] = [];
  for (const problem of problems.results) {
    const projection = snapshot.projection.problems.find((candidate) => candidate.slug === problem.slug);
    const runtimeProblem = snapshot.problems.find((candidate) => candidate.problemId === problem.problem_id);
    const canonicalProblem = snapshot.rules.problems.find((candidate) => candidate.slug === problem.slug);
    if (!projection || !runtimeProblem || !canonicalProblem) {
      throw new Error(`Stored contest problem '${String(problem.slug)}' is absent from its runtime epochs.`);
    }
    let revealed = organizer || (snapshot.entrant !== null && projection.availability !== "locked");
    if (revealed && !organizer) {
      try {
        await ensureContestReveal(env, snapshot, runtimeProblem, runtimeProblem.contentEpoch);
      } catch (error) {
        if (error instanceof ApiError && error.status === 404) revealed = false;
        else throw error;
      }
    }
    projectedProblems.push({
      ordinal: problem.ordinal,
      batch: problem.batch,
      availability: revealed ? projection.availability : "locked",
      releaseAfterSeconds: problem.release_after_seconds,
      submissionClosesAfterSeconds: problem.submission_closes_after_seconds,
      points: problem.points,
      attemptLimit: problem.attempt_limit,
      attemptsRemaining: projection.attemptsRemaining,
      ...(revealed ? {
        problemId: problem.problem_id,
        problemSlug: problem.slug,
        problemNumber: problem.problem_number,
        title: parseStoredProblemTitle(problem.title_json),
        contentCommit: problem.content_commit,
        judgeDigest: problem.judge_digest,
        ...(snapshot.rules.officialTrack.kind === "prompt-program" && "output" in canonicalProblem
          ? { output: canonicalProblem.output }
          : {}),
        ...(snapshot.rules.officialTrack.kind === "prompt-program"
          ? { promptContextSha256: problem.prompt_context_sha256 ?? null }
          : {}),
        ...(aiAssistAvailable(snapshot)
          ? { assistContextSha256: problem.prompt_context_sha256 ?? null }
          : {}),
        contentUrl: contentUrl(String(problem.problem_id), String(problem.content_commit), "contest", contestId),
        contestAdmission: {
          timelineGeneration: snapshot.epochs.timelineGeneration,
          ruleEpoch: snapshot.epochs.ruleEpoch,
          problemEpoch: problem.problem_epoch,
        },
      } : {}),
    });
  }
  return jsonResponse({
    contest: await contestOperationalProjection(env, metadata, snapshot, organizer),
    problems: projectedProblems,
  });
}

export async function joinContest(request: Request, env: WasmOjWorkerEnv, contestId: string): Promise<Response> {
  const session = await requireBrowserOrBearerMutationSession(request, env);
  await requireFormalMutationsEnabled(env, request);
  const body = exact(await readJsonBody(request, 8 * 1024), [], ["inviteCode"]);
  const timestamp = new Date().toISOString();
  const contest = await env.DB.prepare(`SELECT rules.access_mode, contests.invite_code_hash,
      rules.status, rules.registration_opens_at, rules.registration_closes_at,
      rules.clock_kind, rules.global_starts_at, runtime.state, runtime.timeline_generation,
      runtime.rules_epoch, runtime.schedule_shift_seconds,
      entrants.id AS entrant_id, entrants.joined_at,
      entrants.state AS entrant_state, entrants.started_at
    ${activeContestQuery()}
    LEFT JOIN contest_entrants AS entrants
      ON entrants.contest_id=contests.id AND entrants.kind='account' AND entrants.account_user_id=?
    WHERE contests.id=?`).bind(session.userId, contestId).first<{
      readonly access_mode: "public" | "invite";
      readonly invite_code_hash: string | null;
      readonly status: string;
      readonly registration_opens_at: string;
      readonly registration_closes_at: string;
      readonly clock_kind: "global" | "individual";
      readonly global_starts_at: string | null;
      readonly state: "scheduled" | "running" | "paused" | "ended";
      readonly timeline_generation: number;
      readonly rules_epoch: number;
      readonly schedule_shift_seconds: number;
      readonly entrant_id: string | null;
      readonly joined_at: string | null;
      readonly entrant_state: string | null;
      readonly started_at: string | null;
    }>();
  if (!contest || contest.status !== "published") throw new ApiError(409, "contest-closed", "Contest is not open for joining.");
  if (contest.entrant_id) return joinedContestResponse(env, contestId, session, {
    id: contest.entrant_id,
    joined_at: contest.joined_at!,
    state: contest.entrant_state!,
    started_at: contest.started_at,
  }, true);
  if (contest.state === "paused") throw new ApiError(409, "contest-paused", "The contest is paused.");
  const registrationOpensAt = Date.parse(contest.registration_opens_at) + contest.schedule_shift_seconds * 1_000;
  const registrationClosesAt = Date.parse(contest.registration_closes_at) + contest.schedule_shift_seconds * 1_000;
  const observedAt = Date.parse(timestamp);
  if (contest.state === "ended" || observedAt < registrationOpensAt || observedAt >= registrationClosesAt) {
    throw new ApiError(409, "contest-closed", "Contest is not open for joining.");
  }
  if (contest.access_mode === "invite") {
    if (env.INVITE_CODE_HMAC_SECRET.length < 32) throw new Error("Invite-code HMAC secret is not configured.");
    if (typeof body.inviteCode !== "string" || !contest.invite_code_hash
      || !constantTimeEqual(await hmacSha256Hex(env.INVITE_CODE_HMAC_SECRET, textEncoder.encode(body.inviteCode)), contest.invite_code_hash)) {
      throw new ApiError(403, "contest-invite-invalid", "Invite code is invalid.");
    }
  }
  const entrantId = crypto.randomUUID();
  await env.DB.prepare(`INSERT OR IGNORE INTO contest_entrants
      (id, contest_id, kind, subject_key, account_user_id, owner_user_id,
       joined_at, started_at, start_timeline_generation,
       individual_wall_anchor_at, individual_logical_anchor_seconds,
       state, state_timeline_generation, eliminated_at,
       eliminated_logical_seconds, eliminated_checkpoint_id, elimination_reason,
       created_at, updated_at)
    SELECT ?, runtime.contest_id, 'account', ?, ?, ?, ?,
      CASE WHEN rules.clock_kind='global' AND runtime.state='running'
        THEN COALESCE(runtime.first_started_at,
          strftime('%Y-%m-%dT%H:%M:%fZ', rules.global_starts_at,
            '+' || runtime.schedule_shift_seconds || ' seconds')) ELSE NULL END,
      CASE WHEN rules.clock_kind='global' AND runtime.state='running'
        THEN runtime.timeline_generation ELSE NULL END,
      NULL, 0,
      CASE WHEN rules.clock_kind='global' AND runtime.state='running' THEN 'active' ELSE 'joined' END,
      runtime.timeline_generation, NULL, NULL, NULL, NULL, ?, ?
    FROM contest_runtimes AS runtime
    JOIN contest_series AS series ON series.id=runtime.contest_id
    JOIN contest_rule_revisions AS rules
      ON rules.contest_id=runtime.contest_id
     AND rules.rules_commit=runtime.active_rules_commit
     AND rules.rules_sha256=runtime.active_rules_sha256
    WHERE runtime.contest_id=? AND runtime.timeline_generation=? AND runtime.rules_epoch=?
      AND runtime.state IN ('scheduled','running') AND rules.status='published'
      AND series.invite_code_hash IS ?
      AND ROUND((julianday(?) - julianday(rules.registration_opens_at))*86400000)
        >= runtime.schedule_shift_seconds*1000
      AND ROUND((julianday(?) - julianday(rules.registration_closes_at))*86400000)
        < runtime.schedule_shift_seconds*1000
      AND (rules.clock_kind='individual' OR NOT EXISTS (
        SELECT 1 FROM contest_rule_checkpoints AS checkpoints
        WHERE checkpoints.contest_id=runtime.contest_id
          AND checkpoints.rules_commit=runtime.active_rules_commit
          AND checkpoints.at_seconds<=CASE WHEN runtime.state='scheduled' THEN
            CASE
              WHEN ROUND((julianday(?) - julianday(rules.global_starts_at))*86400000)
                < runtime.schedule_shift_seconds*1000 THEN -1
              ELSE MIN(rules.duration_seconds,
                CAST(MAX(0,
                  ROUND((julianday(?) - julianday(rules.global_starts_at))*86400000)
                    - runtime.schedule_shift_seconds*1000)/1000 AS INTEGER))
            END
          ELSE MIN(rules.duration_seconds,
            runtime.logical_anchor_seconds
              + CAST(MAX(0, ROUND((julianday(?) - julianday(runtime.wall_anchor_at))*86400000))/1000 AS INTEGER))
          END
      ))
    ON CONFLICT(contest_id, kind, subject_key) DO NOTHING`)
    .bind(
      entrantId, session.userId, session.userId, session.userId, timestamp,
      timestamp, timestamp, contestId, contest.timeline_generation, contest.rules_epoch,
      contest.invite_code_hash, timestamp, timestamp, timestamp, timestamp, timestamp,
    ).run();
  const entrant = await env.DB.prepare(`SELECT id, joined_at, state, started_at
    FROM contest_entrants WHERE contest_id=? AND kind='account' AND account_user_id=?`)
    .bind(contestId, session.userId).first<{
      readonly id: string;
      readonly joined_at: string;
      readonly state: string;
      readonly started_at: string | null;
    }>();
  if (!entrant) {
    const checkpointClosed = await env.DB.prepare(`SELECT 1 AS closed
      FROM contest_runtimes AS runtime
      JOIN contest_rule_revisions AS rules
        ON rules.contest_id=runtime.contest_id
       AND rules.rules_commit=runtime.active_rules_commit
       AND rules.rules_sha256=runtime.active_rules_sha256
      JOIN contest_rule_checkpoints AS checkpoints
        ON checkpoints.contest_id=runtime.contest_id
       AND checkpoints.rules_commit=runtime.active_rules_commit
      WHERE runtime.contest_id=? AND rules.clock_kind='global'
        AND runtime.state IN ('scheduled','running')
        AND checkpoints.at_seconds<=CASE WHEN runtime.state='scheduled' THEN
          CASE
            WHEN ROUND((julianday(?) - julianday(rules.global_starts_at))*86400000)
              < runtime.schedule_shift_seconds*1000 THEN -1
            ELSE MIN(rules.duration_seconds,
              CAST(MAX(0,
                ROUND((julianday(?) - julianday(rules.global_starts_at))*86400000)
                  - runtime.schedule_shift_seconds*1000)/1000 AS INTEGER))
          END
        ELSE MIN(rules.duration_seconds,
          runtime.logical_anchor_seconds
            + CAST(MAX(0, ROUND((julianday(?) - julianday(runtime.wall_anchor_at))*86400000))/1000 AS INTEGER))
        END
      LIMIT 1`)
      .bind(contestId, timestamp, timestamp, timestamp).first<{ readonly closed: number }>();
    if (checkpointClosed) {
      throw new ApiError(
        409,
        "contest-checkpoint-registration-closed",
        "Joining closed when the first checkpoint boundary was reached.",
      );
    }
    throw new ApiError(409, "contest-join-raced", "Contest state changed before the join could be admitted.");
  }
  return joinedContestResponse(env, contestId, session, entrant, entrant.id !== entrantId);
}

async function joinedContestResponse(
  env: WasmOjWorkerEnv,
  contestId: string,
  session: AuthenticatedSession,
  entrant: { readonly id: string; readonly joined_at: string; readonly state: string; readonly started_at: string | null },
  replayed: boolean,
): Promise<Response> {
  const [snapshot, metadata] = await Promise.all([
    loadContestRuntimeSnapshot(env, contestId, session),
    contestMetadata(env, contestId),
  ]);
  if (!metadata) throw new ApiError(409, "contest-join-raced", "Contest metadata changed before the join projection was available.");
  return jsonResponse({
    contestId,
    entrantId: entrant.id,
    joined: true,
    state: entrant.state,
    joinedAt: entrant.joined_at,
    startedAt: entrant.started_at,
    replayed,
    contest: await contestOperationalProjection(env, metadata, snapshot, metadata.organizer_user_id === session.userId),
  });
}

export async function contestLeaderboard(request: Request, env: WasmOjWorkerEnv, contestId: string): Promise<Response> {
  const session = await authenticatedSession(request, env);
  const snapshot = await loadContestRuntimeSnapshot(env, contestId, session ?? null);
  const metadata = await contestMetadata(env, contestId);
  const organizer = metadata?.organizer_user_id === session?.userId;
  if (!metadata || (metadata.status !== "published" && !organizer)) throw new ApiError(404, "contest-not-found", "Contest was not found.");
  if (!organizer && !snapshot.entrant) throw new ApiError(409, "contest-not-joined", "Join this contest before viewing its leaderboard.");
  const rawLimit = Number(new URL(request.url).searchParams.get("limit") ?? "50");
  const limit = Number.isSafeInteger(rawLimit) ? Math.min(100, Math.max(1, rawLimit)) : 50;
  // projection.phase is entrant-local for individual clocks. Hidden and frozen
  // shared results switch only when the whole contest runtime has ended.
  const ended = snapshot.state === "ended";
  const hidden = !organizer && !ended && snapshot.rules.leaderboard.kind === "hidden-until-end";
  const frozen = !organizer && !ended && snapshot.rules.leaderboard.kind === "freeze"
    && (snapshot.projection.logicalSeconds ?? -1) >= snapshot.rules.leaderboard.atSeconds;
  const entries = hidden ? [] : await queryContestLeaderboard(env.DB, {
    contestId,
    ...(frozen && snapshot.rules.leaderboard.kind === "freeze"
      ? { evidenceLogicalAtOrBefore: snapshot.rules.leaderboard.atSeconds }
      : {}),
    limit,
  });
  return projectLeaderboardEntries(env, { frozen, hidden, entries });
}

export async function listOrganizerContests(request: Request, env: WasmOjWorkerEnv): Promise<Response> {
  const session = await requireSession(request, env);
  await requireOrganizer(env, session);
  const status = new URL(request.url).searchParams.get("status");
  if (status !== null && !["draft", "published", "archived"].includes(status)) throw new ApiError(400, "contest-status-invalid", "Contest status is invalid.");
  const rows = await env.DB.prepare(`SELECT contests.id, contests.slug, catalogs.organizer_user_id,
      runtime.active_rules_commit AS rules_commit, rules.title, rules.description,
      rules.access_mode, rules.status, contests.created_at,
      CASE WHEN contests.invite_code_hash IS NULL THEN 0 ELSE 1 END AS invite_code_configured,
      runtime.pending_rules_commit,
      NULL AS organizer_display_name, NULL AS organizer_visibility, NULL AS organizer_login,
      (SELECT COUNT(*) FROM contest_rule_problems AS selected
        WHERE selected.contest_id=contests.id
          AND selected.rules_commit=runtime.active_rules_commit) AS problem_count
    ${activeContestQuery()}
    WHERE catalogs.organizer_user_id=? AND (? IS NULL OR rules.status=?)
    ORDER BY contests.created_at DESC, contests.id DESC LIMIT 100`)
    .bind(session.userId, status, status).all<ContestMetadataRow & { readonly problem_count: number }>();
  const observedAt = new Date();
  const contests: Record<string, unknown>[] = [];
  for (const row of rows.results) {
    const snapshot = await loadContestRuntimeSnapshot(env, row.id, session, observedAt);
    contests.push({
      ...await contestOperationalProjection(env, row, snapshot, true),
      problemCount: row.problem_count,
    });
  }
  return jsonResponse({ contests }, 200, { "cache-control": "private, no-store" });
}

export async function getOrganizerContest(request: Request, env: WasmOjWorkerEnv, contestId: string): Promise<Response> {
  const session = await requireSession(request, env);
  await requireOrganizer(env, session);
  const metadata = await contestMetadata(env, contestId);
  if (!metadata || metadata.organizer_user_id !== session.userId) throw new ApiError(404, "contest-not-found", "Organizer-owned contest was not found.");
  const snapshot = await loadContestRuntimeSnapshot(env, contestId, session);
  const problems = await env.DB.prepare(`SELECT selected.ordinal, selected.batch,
      selected.release_after_seconds, selected.submission_closes_after_seconds,
      selected.points, selected.attempt_limit, selected.output_language,
      selected.output_target, selected.output_optimization, selected.output_entry_path,
      problems.id AS problem_id, problems.slug, revisions.ordinal AS problem_number,
      revisions.title_json, epochs.problem_epoch, epochs.content_epoch,
      epochs.content_commit, epochs.judge_epoch, epochs.judge_digest,
      prompt_contexts.public_context_sha256 AS prompt_context_sha256
    FROM contest_rule_problems AS selected
    JOIN problem_series AS problems ON problems.id=selected.problem_id
    JOIN contest_problem_epochs AS epochs
      ON epochs.contest_id=selected.contest_id
     AND epochs.problem_id=selected.problem_id AND epochs.state='effective'
    JOIN problem_revisions AS revisions
      ON revisions.problem_id=problems.id AND revisions.commit_sha=epochs.content_commit
    LEFT JOIN contest_problem_prompt_contexts AS prompt_contexts
      ON prompt_contexts.contest_id=epochs.contest_id
     AND prompt_contexts.problem_id=epochs.problem_id
     AND prompt_contexts.content_epoch=epochs.content_epoch
    WHERE selected.contest_id=? AND selected.rules_commit=? ORDER BY selected.ordinal`)
    .bind(contestId, snapshot.rulesCommit).all<Record<string, unknown>>();
  return jsonResponse({
    contest: {
      ...await contestOperationalProjection(env, metadata, snapshot, true),
      problemCount: problems.results.length,
    },
    problems: problems.results.map((problem) => {
      const projection = snapshot.projection.problems.find((candidate) => candidate.slug === problem.slug);
      if (!projection) throw new Error(`Stored contest problem '${String(problem.slug)}' is absent from its canonical rules.`);
      return {
        ordinal: problem.ordinal,
        batch: problem.batch,
        problemId: problem.problem_id,
        problemSlug: problem.slug,
        problemNumber: problem.problem_number,
        title: parseStoredProblemTitle(problem.title_json),
        availability: projection.availability,
        releaseAfterSeconds: problem.release_after_seconds,
        submissionClosesAfterSeconds: problem.submission_closes_after_seconds,
        points: problem.points,
        attemptLimit: problem.attempt_limit,
        ...(problem.output_language === null ? {} : { output: {
          language: problem.output_language,
          target: problem.output_target,
          optimization: problem.output_optimization,
          entry: problem.output_entry_path,
        } }),
        epochs: {
          timelineGeneration: snapshot.epochs.timelineGeneration,
          ruleEpoch: snapshot.epochs.ruleEpoch,
          problemEpoch: problem.problem_epoch,
          contentEpoch: problem.content_epoch,
          judgeEpoch: problem.judge_epoch,
        },
        contentCommit: problem.content_commit,
        judgeDigest: problem.judge_digest,
        ...(snapshot.rules.officialTrack.kind === "prompt-program"
          ? { promptContextSha256: problem.prompt_context_sha256 ?? null }
          : {}),
        contentUrl: contentUrl(String(problem.problem_id), String(problem.content_commit), "contest", contestId),
      };
    }),
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
      WHERE contests.id=contest_series.id AND catalogs.organizer_user_id=? AND rules.access_mode='invite'
    )`).bind(digest, contestId, session.userId).run();
  if (result.meta.changes !== 1) throw new ApiError(409, "contest-invite-not-rotatable", "Contest is not an Organizer-owned invite contest.");
  return jsonResponse({ contestId, inviteCodeConfigured: true, rotatedAt: new Date().toISOString() });
}

interface OrganizerEntrantRow {
  readonly entrant_id: string;
  readonly user_id: string;
  readonly joined_at: string;
  readonly started_at: string | null;
  readonly individual_wall_anchor_at: string | null;
  readonly individual_logical_anchor_seconds: number;
  readonly state: "joined" | "active" | "eliminated" | "completed";
  readonly state_timeline_generation: number;
  readonly eliminated_at: string | null;
  readonly eliminated_logical_seconds: number | null;
  readonly eliminated_checkpoint_id: string | null;
  readonly elimination_reason: string | null;
}

interface OrganizerAttemptRow {
  readonly entrant_id: string;
  readonly problem_slug: string;
  readonly attempts: number;
}

interface OrganizerCheckpointDecisionRow {
  readonly entrant_id: string;
  readonly checkpoint_id: string;
  readonly run_state: "evaluating" | "provisional" | "final" | "invalid";
  readonly decision: "advanced" | "eliminated";
  readonly provisional: number;
}

function organizerEntrantClock(
  snapshot: ContestRuntimeSnapshot,
  entrant: OrganizerEntrantRow,
  observedAt: string,
): ContestLogicalClockSnapshot | null {
  if (snapshot.rules.clock.kind === "global") return snapshot.clock;
  if (entrant.started_at === null || entrant.individual_wall_anchor_at === null) return null;
  if (snapshot.state === "running") {
    return {
      generation: snapshot.epochs.timelineGeneration,
      state: "running",
      logicalSeconds: entrant.individual_logical_anchor_seconds,
      capturedAt: entrant.individual_wall_anchor_at,
    };
  }
  return {
    generation: snapshot.epochs.timelineGeneration,
    state: "paused",
    logicalSeconds: Math.min(snapshot.rules.clock.durationSeconds, entrant.individual_logical_anchor_seconds),
    capturedAt: observedAt,
  };
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
  const snapshot = await loadContestRuntimeSnapshot(env, contestId, session);
  const rows = afterJoinedAt === null
    ? await env.DB.prepare(`SELECT id AS entrant_id, account_user_id AS user_id, joined_at,
        started_at, individual_wall_anchor_at, individual_logical_anchor_seconds,
        state, state_timeline_generation, eliminated_at, eliminated_logical_seconds,
        eliminated_checkpoint_id, elimination_reason
      FROM contest_entrants WHERE contest_id=? AND kind='account'
      ORDER BY joined_at, account_user_id LIMIT ?`)
      .bind(contestId, limit + 1).all<OrganizerEntrantRow>()
    : await env.DB.prepare(`SELECT id AS entrant_id, account_user_id AS user_id, joined_at,
        started_at, individual_wall_anchor_at, individual_logical_anchor_seconds,
        state, state_timeline_generation, eliminated_at, eliminated_logical_seconds,
        eliminated_checkpoint_id, elimination_reason
      FROM contest_entrants WHERE contest_id=? AND kind='account'
        AND (joined_at>? OR (joined_at=? AND account_user_id>?))
      ORDER BY joined_at, account_user_id LIMIT ?`)
      .bind(contestId, afterJoinedAt, afterJoinedAt, afterUserId, limit + 1).all<OrganizerEntrantRow>();
  const page = rows.results.slice(0, limit);
  const entrantIds = page.map((row) => row.entrant_id);
  const attempts = entrantIds.length === 0 ? [] : snapshot.rules.officialTrack.kind === "prompt-program"
    ? (await env.DB.prepare(`SELECT attempts.entrant_id, problems.slug AS problem_slug, COUNT(*) AS attempts
        FROM prompt_attempts AS attempts
        JOIN prompt_attempt_quota AS quota ON quota.prompt_attempt_id=attempts.id
        JOIN problem_series AS problems ON problems.id=attempts.problem_id
        WHERE attempts.contest_id=?
          AND attempts.entrant_id IN (${entrantIds.map(() => "?").join(",")})
          AND attempts.eligibility='eligible' AND quota.state IN ('reserved','consumed')
        GROUP BY attempts.entrant_id, problems.slug`)
      .bind(contestId, ...entrantIds)
      .all<OrganizerAttemptRow>()).results
    : (await env.DB.prepare(`SELECT records.entrant_id, problems.slug AS problem_slug, COUNT(*) AS attempts
        FROM contest_submission_records AS records
        JOIN submissions ON submissions.id=records.submission_id
        JOIN problem_series AS problems ON problems.id=submissions.problem_id
        WHERE records.contest_id=?
          AND records.entrant_id IN (${entrantIds.map(() => "?").join(",")})
          AND records.eligibility='eligible' AND submissions.origin_submission_id=submissions.id
        GROUP BY records.entrant_id, problems.slug`)
      .bind(contestId, ...entrantIds)
      .all<OrganizerAttemptRow>()).results;
  const checkpointDecisions = entrantIds.length === 0 ? [] : (await env.DB.prepare(`SELECT decisions.entrant_id,
      runs.checkpoint_id, runs.state AS run_state, decisions.decision, decisions.provisional
    FROM contest_checkpoint_decisions AS decisions
    JOIN contest_checkpoint_runs AS runs ON runs.id=decisions.checkpoint_run_id
    WHERE runs.contest_id=? AND runs.timeline_generation=?
      AND decisions.entrant_id IN (${entrantIds.map(() => "?").join(",")})
    ORDER BY runs.logical_seconds, runs.checkpoint_id`)
    .bind(contestId, snapshot.epochs.timelineGeneration, ...entrantIds)
    .all<OrganizerCheckpointDecisionRow>()).results;
  const attemptsByEntrant = new Map<string, Record<string, number>>();
  for (const attempt of attempts) {
    const entrantAttempts = attemptsByEntrant.get(attempt.entrant_id) ?? {};
    entrantAttempts[attempt.problem_slug] = attempt.attempts;
    attemptsByEntrant.set(attempt.entrant_id, entrantAttempts);
  }
  const decisionsByEntrant = new Map<string, OrganizerCheckpointDecisionRow[]>();
  for (const decision of checkpointDecisions) {
    const entrantDecisions = decisionsByEntrant.get(decision.entrant_id) ?? [];
    entrantDecisions.push(decision);
    decisionsByEntrant.set(decision.entrant_id, entrantDecisions);
  }
  const identities = await leaderboardParticipants(env, page.map((row) => row.user_id));
  const last = rows.results.length > limit ? page.at(-1) : undefined;
  const observedAt = new Date().toISOString();
  return jsonResponse({
    contest: {
      state: snapshot.state,
      paused: snapshot.state === "paused",
      pauseReason: snapshot.pauseReason,
      epochs: snapshot.epochs,
      promptCompilerAvailable: promptCompilerAvailable(snapshot),
      aiAssistAvailable: aiAssistAvailable(snapshot),
      publicRepositoryTimingWarning: snapshot.publicRepositoryTimingWarning ? {
        active: true,
        message: "Scheduled release controls this UI only; GitHub repository content may be visible earlier.",
      } : null,
    },
    participants: page.map((row) => {
      const eliminatedAtSeconds = row.state === "eliminated"
        && row.state_timeline_generation === snapshot.epochs.timelineGeneration
        ? row.eliminated_logical_seconds : null;
      const projection = ContestRuleEngine.project({
        rules: snapshot.rules,
        observedAt,
        clock: organizerEntrantClock(snapshot, row, observedAt),
        entrant: {
          joined: true,
          started: row.started_at !== null || snapshot.rules.clock.kind === "global",
          completed: row.state === "completed",
          eliminatedAtSeconds,
        },
        attemptedByProblem: attemptsByEntrant.get(row.entrant_id) ?? {},
        scheduleShiftSeconds: snapshot.scheduleShiftSeconds,
        contestEnded: snapshot.state === "ended",
      });
      return {
        entrantId: row.entrant_id,
        participant: identities.get(row.user_id),
        joinedAt: row.joined_at,
        startedAt: row.started_at,
        state: row.state,
        logicalTimeSeconds: projection.logicalSeconds,
        nextBoundarySeconds: projection.nextBoundarySeconds,
        phase: projection.phase,
        problems: projection.problems,
        checkpoints: snapshot.rules.checkpoints.map((checkpoint) => {
          const decision = (decisionsByEntrant.get(row.entrant_id) ?? [])
            .find((candidate) => candidate.checkpoint_id === checkpoint.id);
          return {
            id: checkpoint.id,
            atSeconds: checkpoint.atSeconds,
            settlement: checkpoint.settlement,
            state: decision?.run_state
              ?? (projection.logicalSeconds !== null && projection.logicalSeconds >= checkpoint.atSeconds ? "pending" : "upcoming"),
            decision: decision?.decision ?? null,
            provisional: decision?.provisional === 1,
          };
        }),
        elimination: eliminatedAtSeconds === null ? null : {
          at: row.eliminated_at,
          atLogicalSeconds: eliminatedAtSeconds,
          checkpointId: row.eliminated_checkpoint_id,
          reason: row.elimination_reason,
        },
      };
    }),
    nextCursor: last ? { afterJoinedAt: last.joined_at, afterUserId: last.user_id } : null,
  }, 200, { "cache-control": "private, no-store" });
}
