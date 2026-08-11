import handler from "vinext/server/app-router-entry";
import { apiErrorResponse, jsonResponse } from "./http";
import type { ForgeWorkerEnv } from "./env";
import { beginGithubLogin, completeGithubLogin, logout, sessionResponse } from "./auth";
import {
  cancelSubmission,
  createSubmission,
  getSubmission,
  getSubmissionEvents,
  listOwnSubmissions,
  managedMatch,
  publicSubmissionSource,
  updateSubmissionVisibility,
} from "./submissions";
import {
  beginGithubAppInstall,
  completeGithubAppInstall,
  createCollectionImport,
  getCollectionImport,
  githubWebhook,
  listCollectionImports,
  listOrganizerRepositories,
  organizerStatus,
  publishCollectionImport,
  retryCollectionImport,
} from "./organizer";
import {
  acknowledgeRepositoryPushNotice,
  contestLeaderboard,
  createContest,
  currentProfile,
  getContest,
  getOrganizerContest,
  joinContest,
  listOrganizerContests,
  listRepositoryPushNotices,
  listContests,
  listOrganizerCollections,
  listProblems,
  managedProblemProjection,
  problemLeaderboard,
  publicProfile,
  publishContest,
  rotateContestInviteCode,
  updateOrganizerContest,
  updateProfile,
} from "./product";
import { reconcile } from "./reconciler";
import {
  createOrganizerApplication,
  getFormalMutationControl,
  listOrganizerApplications,
  revokeOrganizerRole,
  reviewOrganizerApplication,
  updateFormalMutationControl,
} from "./admin";
import { detailedReadiness } from "./readiness";
import { eraseAccount } from "./account-erasure";
import { cancelRejudgeBatch, createRejudgeBatch, getRejudgeBatch, listRejudgeBatches, rejudgeOptions } from "./rejudge";
import { withSecurityHeaders } from "./security-headers";
import { TURNSTILE_CHALLENGE_PATH, turnstileChallengeResponse } from "./turnstile-challenge";

export { withSecurityHeaders } from "./security-headers";

export { SubmissionJudgeContainer, ValidationJudgeContainer } from "./judge-container";
export { SubmissionWorkflow, ValidationWorkflow } from "./workflows";
export { ContainerProxy } from "@cloudflare/containers";

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";

function identifier(pathname: string, expression: RegExp): string | undefined {
  return expression.exec(pathname)?.[1];
}

export function isBrowserAssetPath(pathname: string): boolean {
  return pathname.startsWith("/_next/static/")
    || pathname.startsWith("/assets/")
    || pathname.startsWith("/toolchains/")
    || pathname === "/favicon.svg"
    || pathname === "/og.png"
    || pathname === "/toolchain-cache-sw.js"
    || pathname === "/vinext-client-entry-manifest.json";
}

async function api(request: Request, env: ForgeWorkerEnv): Promise<Response> {
  const url = new URL(request.url);
  const { pathname } = url;
  if (request.method === "GET" && pathname === "/api/health/live") return jsonResponse({ ok: true });
  if (request.method === "GET" && pathname === "/api/health/ready") {
    const ready = (await detailedReadiness(env)).ready;
    return jsonResponse({ ready }, ready ? 200 : 503);
  }
  if (request.method === "GET" && pathname === "/api/auth/github") return beginGithubLogin(request, env);
  if (request.method === "GET" && pathname === "/api/auth/github/callback") return completeGithubLogin(request, env);
  if (request.method === "GET" && pathname === "/api/auth/session") return sessionResponse(request, env);
  if (request.method === "POST" && pathname === "/api/auth/logout") return logout(request, env);
  if (request.method === "DELETE" && pathname === "/api/account") return eraseAccount(request, env);
  if (request.method === "POST" && pathname === "/api/github/webhook") return githubWebhook(request, env);
  if (request.method === "POST" && pathname === "/api/organizer/applications") return createOrganizerApplication(request, env);
  if (request.method === "GET" && pathname === "/api/admin/organizer-applications") return listOrganizerApplications(request, env);
  if (request.method === "GET" && pathname === "/api/admin/formal-mutations") return getFormalMutationControl(request, env);
  if (request.method === "POST" && pathname === "/api/admin/formal-mutations/pause") return updateFormalMutationControl(request, env, false);
  if (request.method === "POST" && pathname === "/api/admin/formal-mutations/resume") return updateFormalMutationControl(request, env, true);
  const applicationId = identifier(pathname, new RegExp(`^/api/admin/organizer-applications/(${UUID})/review$`));
  if (request.method === "POST" && applicationId) return reviewOrganizerApplication(request, env, applicationId);
  const revokedOrganizerUserId = identifier(pathname, new RegExp(`^/api/admin/organizers/(${UUID})/revoke$`));
  if (request.method === "POST" && revokedOrganizerUserId) return revokeOrganizerRole(request, env, revokedOrganizerUserId);

  if (request.method === "GET" && pathname === "/api/organizer/status") return organizerStatus(request, env);
  if (request.method === "GET" && pathname === "/api/organizer/github/install") return beginGithubAppInstall(request, env);
  if (request.method === "GET" && pathname === "/api/organizer/github/callback") return completeGithubAppInstall(request, env);
  if (request.method === "GET" && pathname === "/api/organizer/repositories") return listOrganizerRepositories(request, env);
  if (request.method === "GET" && pathname === "/api/organizer/notices") return listRepositoryPushNotices(request, env);
  const repositoryNoticeId = identifier(pathname, new RegExp(`^/api/organizer/notices/(${UUID})/acknowledge$`));
  if (request.method === "POST" && repositoryNoticeId) return acknowledgeRepositoryPushNotice(request, env, repositoryNoticeId);
  if (request.method === "GET" && pathname === "/api/organizer/imports") return listCollectionImports(request, env);
  if (request.method === "GET" && pathname === "/api/organizer/collections") return listOrganizerCollections(request, env);
  if (request.method === "POST" && pathname === "/api/organizer/imports") return createCollectionImport(request, env);
  const importId = identifier(pathname, new RegExp(`^/api/organizer/imports/(${UUID})$`));
  if (request.method === "GET" && importId) return getCollectionImport(request, env, importId);
  const publishImportId = identifier(pathname, new RegExp(`^/api/organizer/imports/(${UUID})/publish$`));
  if (request.method === "POST" && publishImportId) return publishCollectionImport(request, env, publishImportId);
  const retryImportId = identifier(pathname, new RegExp(`^/api/organizer/imports/(${UUID})/retry$`));
  if (request.method === "POST" && retryImportId) return retryCollectionImport(request, env, retryImportId);
  if (request.method === "GET" && pathname === "/api/organizer/contests") return listOrganizerContests(request, env);
  const organizerContestId = identifier(pathname, new RegExp(`^/api/organizer/contests/(${UUID})$`));
  if (request.method === "GET" && organizerContestId) return getOrganizerContest(request, env, organizerContestId);
  if (request.method === "PUT" && organizerContestId) return updateOrganizerContest(request, env, organizerContestId);
  const rotateContestInviteId = identifier(pathname, new RegExp(`^/api/organizer/contests/(${UUID})/invite-code$`));
  if (request.method === "POST" && rotateContestInviteId) return rotateContestInviteCode(request, env, rotateContestInviteId);
  if (request.method === "GET" && pathname === "/api/organizer/rejudges/options") return rejudgeOptions(request, env);
  if (request.method === "GET" && pathname === "/api/organizer/rejudges") return listRejudgeBatches(request, env);
  if (request.method === "POST" && pathname === "/api/organizer/rejudges") return createRejudgeBatch(request, env);
  const rejudgeBatchId = identifier(pathname, new RegExp(`^/api/organizer/rejudges/(${UUID})$`));
  if (request.method === "GET" && rejudgeBatchId) return getRejudgeBatch(request, env, rejudgeBatchId);
  const cancelRejudgeBatchId = identifier(pathname, new RegExp(`^/api/organizer/rejudges/(${UUID})/cancel$`));
  if (request.method === "POST" && cancelRejudgeBatchId) return cancelRejudgeBatch(request, env, cancelRejudgeBatchId);

  if (request.method === "POST" && pathname === "/api/submissions") return createSubmission(request, env);
  if (request.method === "GET" && pathname === "/api/submissions") return listOwnSubmissions(request, env);
  const submissionId = identifier(pathname, new RegExp(`^/api/submissions/(${UUID})$`));
  if (request.method === "GET" && submissionId) return getSubmission(request, env, submissionId);
  if (request.method === "PATCH" && submissionId) return updateSubmissionVisibility(request, env, submissionId);
  const eventSubmissionId = identifier(pathname, new RegExp(`^/api/submissions/(${UUID})/events$`));
  if (request.method === "GET" && eventSubmissionId) return getSubmissionEvents(request, env, eventSubmissionId);
  const cancelSubmissionId = identifier(pathname, new RegExp(`^/api/submissions/(${UUID})/cancel$`));
  if (request.method === "POST" && cancelSubmissionId) return cancelSubmission(request, env, cancelSubmissionId);
  const sourceSubmissionId = identifier(pathname, new RegExp(`^/api/submissions/(${UUID})/source$`));
  if (request.method === "GET" && sourceSubmissionId) return publicSubmissionSource(request, env, sourceSubmissionId);
  if (request.method === "GET" && pathname === "/api/collections/managed-match") return managedMatch(request, env);

  if (request.method === "GET" && pathname === "/api/profile") return currentProfile(request, env);
  if (request.method === "PATCH" && pathname === "/api/profile") return updateProfile(request, env);
  const profileLogin = identifier(pathname, /^\/api\/profiles\/([A-Za-z0-9-]{1,39})$/);
  if (request.method === "GET" && profileLogin) return publicProfile(request, env, profileLogin);
  if (request.method === "GET" && pathname === "/api/problems") return listProblems(request, env);
  const problemId = identifier(pathname, new RegExp(`^/api/problems/(${UUID})$`));
  if (request.method === "GET" && problemId) return managedProblemProjection(request, env, problemId);
  const problemLeaderboardId = identifier(pathname, new RegExp(`^/api/problems/(${UUID})/leaderboard$`));
  if (request.method === "GET" && problemLeaderboardId) return problemLeaderboard(request, env, problemLeaderboardId);
  if (request.method === "GET" && pathname === "/api/contests") return listContests(request, env);
  if (request.method === "POST" && pathname === "/api/contests") return createContest(request, env);
  const contestId = identifier(pathname, new RegExp(`^/api/contests/(${UUID})$`));
  if (request.method === "GET" && contestId) return getContest(request, env, contestId);
  const publishContestId = identifier(pathname, new RegExp(`^/api/contests/(${UUID})/publish$`));
  if (request.method === "POST" && publishContestId) return publishContest(request, env, publishContestId);
  const joinContestId = identifier(pathname, new RegExp(`^/api/contests/(${UUID})/join$`));
  if (request.method === "POST" && joinContestId) return joinContest(request, env, joinContestId);
  const leaderboardContestId = identifier(pathname, new RegExp(`^/api/contests/(${UUID})/leaderboard$`));
  if (request.method === "GET" && leaderboardContestId) return contestLeaderboard(request, env, leaderboardContestId);

  return jsonResponse({ error: { code: "api-route-not-found", message: "API route was not found." } }, 404);
}

const worker = {
  async fetch(request: Request, env: ForgeWorkerEnv, ctx: ExecutionContext): Promise<Response> {
    try {
      const pathname = new URL(request.url).pathname;
      if (pathname === TURNSTILE_CHALLENGE_PATH) return turnstileChallengeResponse(request, env);
      const response = pathname.startsWith("/api/")
        ? await api(request, env)
        : isBrowserAssetPath(pathname)
          ? await env.ASSETS.fetch(request)
          : await handler.fetch(request, env, ctx);
      return await withSecurityHeaders(response, env);
    } catch (error) {
      if (error instanceof TypeError) return await withSecurityHeaders(jsonResponse({ error: { code: "invalid-request", message: error.message } }, 400), env);
      return await withSecurityHeaders(apiErrorResponse(error), env);
    }
  },

  async scheduled(_controller: ScheduledController, env: ForgeWorkerEnv, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(reconcile(env));
  },
};

export default worker;
