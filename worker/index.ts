import handler from "vinext/server/app-router-entry";
import { apiErrorResponse, jsonResponse } from "./http";
import type { WasmOjWorkerEnv } from "./env";
import {
  approveCliLogin,
  beginGithubLogin,
  completeGithubLogin,
  exchangeCliLoginToken,
  getCliLoginFlow,
  logout,
  sessionResponse,
  startCliLogin,
} from "./auth";
import {
  cancelSubmission,
  createSubmission,
  getSubmission,
  getSubmissionEvents,
  getSubmissionPolicySummary,
  listOwnSubmissions,
  publicSubmissionSource,
  updateSubmissionVisibility,
} from "./submissions";
import {
  beginGithubAppInstall,
  completeGithubAppInstall,
  githubWebhook,
  listOrganizerRepositories,
  organizerStatus,
} from "./organizer";
import {
  contestLeaderboard,
  currentProfile,
  getContest,
  getOrganizerContest,
  joinContest,
  listOrganizerContests,
  listOrganizerContestParticipants,
  listContests,
  listProblems,
  managedProblemProjection,
  problemPerformance,
  problemLeaderboard,
  publicProfile,
  rotateContestInviteCode,
  updateProfile,
} from "./product";
import {
  createCatalog,
  createCatalogSync,
  getCatalog,
  getCatalogSync,
  listCatalogs,
  publicProblemContent,
} from "./catalog";
import { reconcile } from "./reconciler";
import {
  createOrganizerApplication,
  getFormalMutationControl,
  listOrganizerApplications,
  revokeOrganizerRole,
  reviewOrganizerApplication,
  updateFormalMutationControl,
} from "./admin";
import { detailedReadiness, probeDeploymentContainer } from "./readiness";
import { eraseAccount } from "./account-erasure";
import { cancelRejudgeBatch, createRejudgeBatch, getRejudgeBatch, listRejudgeBatches, rejudgeOptions } from "./rejudge";
import { withSecurityHeaders } from "./security-headers";
import { TURNSTILE_CHALLENGE_PATH, turnstileChallengeResponse } from "./turnstile-challenge";
import { approveCliOfficialSubmissionRisk } from "./formal-access";
import {
  activatePendingContestRules,
  pauseContest,
  previewPendingContestRules,
  resumeContest,
  rewindContest,
  startContestEntrant,
} from "./contest-runtime";
import {
  createPromptAttempt,
  getPromptAttempt,
  getPromptAttemptEvents,
  listPromptAttempts,
} from "./prompt-api";
import { createPromptAssistDraft } from "./prompt-assist";
import { promptContestGallery } from "./prompt-gallery";

export { withSecurityHeaders } from "./security-headers";

export { SubmissionJudgeContainer } from "./judge-container";
export { SubmissionWorkflow } from "./workflows";
export { CatalogWorkflow } from "./catalog-workflows";
export { PromptAttemptWorkflow } from "./prompt-workflows";
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

async function api(request: Request, env: WasmOjWorkerEnv): Promise<Response> {
  const url = new URL(request.url);
  const { pathname } = url;
  if (request.method === "GET" && pathname === "/api/health/live") return jsonResponse({ ok: true });
  if (request.method === "GET" && pathname === "/api/health/ready") {
    const ready = (await detailedReadiness(env)).ready;
    return jsonResponse({ ready }, ready ? 200 : 503);
  }
  if (request.method === "GET" && pathname === "/api/health/container") return probeDeploymentContainer(request, env);
  if (request.method === "GET" && pathname === "/api/auth/github") return beginGithubLogin(request, env);
  if (request.method === "GET" && pathname === "/api/auth/github/callback") return completeGithubLogin(request, env);
  if (request.method === "POST" && pathname === "/api/auth/cli/start") return startCliLogin(request, env);
  if (request.method === "POST" && pathname === "/api/auth/cli/token") return exchangeCliLoginToken(request, env);
  if (request.method === "POST" && pathname === "/api/auth/cli/turnstile/approve") return approveCliOfficialSubmissionRisk(request, env);
  const cliLoginFlowId = identifier(pathname, new RegExp(`^/api/auth/cli/flows/(${UUID})$`));
  if (request.method === "GET" && cliLoginFlowId) return getCliLoginFlow(request, env, cliLoginFlowId);
  const approveCliLoginFlowId = identifier(pathname, new RegExp(`^/api/auth/cli/flows/(${UUID})/approve$`));
  if (request.method === "POST" && approveCliLoginFlowId) return approveCliLogin(request, env, approveCliLoginFlowId);
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
  if (request.method === "GET" && pathname === "/api/organizer/catalogs") return listCatalogs(request, env);
  if (request.method === "POST" && pathname === "/api/organizer/catalogs") return createCatalog(request, env);
  const organizerCatalogId = identifier(pathname, new RegExp(`^/api/organizer/catalogs/(${UUID})$`));
  if (request.method === "GET" && organizerCatalogId) return getCatalog(request, env, organizerCatalogId);
  const syncCatalogId = identifier(pathname, new RegExp(`^/api/organizer/catalogs/(${UUID})/syncs$`));
  if (request.method === "POST" && syncCatalogId) return createCatalogSync(request, env, syncCatalogId);
  const syncId = identifier(pathname, new RegExp(`^/api/organizer/catalog-syncs/(${UUID})$`));
  if (request.method === "GET" && syncId) return getCatalogSync(request, env, syncId);
  if (request.method === "GET" && pathname === "/api/organizer/contests") return listOrganizerContests(request, env);
  const organizerContestId = identifier(pathname, new RegExp(`^/api/organizer/contests/(${UUID})$`));
  if (request.method === "GET" && organizerContestId) return getOrganizerContest(request, env, organizerContestId);
  const rotateContestInviteId = identifier(pathname, new RegExp(`^/api/organizer/contests/(${UUID})/invite-code$`));
  if (request.method === "POST" && rotateContestInviteId) return rotateContestInviteCode(request, env, rotateContestInviteId);
  const participantContestId = identifier(pathname, new RegExp(`^/api/organizer/contests/(${UUID})/participants$`));
  if (request.method === "GET" && participantContestId) return listOrganizerContestParticipants(request, env, participantContestId);
  const pauseOperationalContestId = identifier(pathname, new RegExp(`^/api/organizer/contests/(${UUID})/pause$`));
  if (request.method === "POST" && pauseOperationalContestId) return pauseContest(request, env, pauseOperationalContestId);
  const resumeOperationalContestId = identifier(pathname, new RegExp(`^/api/organizer/contests/(${UUID})/resume$`));
  if (request.method === "POST" && resumeOperationalContestId) return resumeContest(request, env, resumeOperationalContestId);
  const rewindOperationalContestId = identifier(pathname, new RegExp(`^/api/organizer/contests/(${UUID})/rewind$`));
  if (request.method === "POST" && rewindOperationalContestId) return rewindContest(request, env, rewindOperationalContestId);
  const pendingRulesContestId = identifier(pathname, new RegExp(`^/api/organizer/contests/(${UUID})/pending-rules$`));
  if (request.method === "GET" && pendingRulesContestId) return previewPendingContestRules(request, env, pendingRulesContestId);
  const applyPendingRulesContestId = identifier(pathname, new RegExp(`^/api/organizer/contests/(${UUID})/pending-rules/apply$`));
  if (request.method === "POST" && applyPendingRulesContestId) return activatePendingContestRules(request, env, applyPendingRulesContestId);
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
  const policySummarySubmissionId = identifier(pathname, new RegExp(`^/api/submissions/(${UUID})/policy-summary$`));
  if (request.method === "GET" && policySummarySubmissionId) return getSubmissionPolicySummary(request, env, policySummarySubmissionId);
  if (request.method === "POST" && pathname === "/api/prompt-attempts") return createPromptAttempt(request, env);
  if (request.method === "GET" && pathname === "/api/prompt-attempts") return listPromptAttempts(request, env);
  const promptAttemptId = identifier(pathname, new RegExp(`^/api/prompt-attempts/(${UUID})$`));
  if (request.method === "GET" && promptAttemptId) return getPromptAttempt(request, env, promptAttemptId);
  const promptAttemptEventsId = identifier(pathname, new RegExp(`^/api/prompt-attempts/(${UUID})/events$`));
  if (request.method === "GET" && promptAttemptEventsId) return getPromptAttemptEvents(request, env, promptAttemptEventsId);
  if (request.method === "POST" && pathname === "/api/prompt-assist") return createPromptAssistDraft(request, env);
  if (request.method === "GET" && pathname === "/api/profile") return currentProfile(request, env);
  if (request.method === "PATCH" && pathname === "/api/profile") return updateProfile(request, env);
  const profileLogin = identifier(pathname, /^\/api\/profiles\/([A-Za-z0-9-]{1,39})$/);
  if (request.method === "GET" && profileLogin) return publicProfile(request, env, profileLogin);
  if (request.method === "GET" && pathname === "/api/problems") return listProblems(request, env);
  const problemId = identifier(pathname, new RegExp(`^/api/problems/(${UUID})$`));
  if (request.method === "GET" && problemId) return managedProblemProjection(request, env, problemId);
  const problemContentId = identifier(pathname, new RegExp(`^/api/problems/(${UUID})/content$`));
  if (request.method === "GET" && problemContentId) return publicProblemContent(request, env, problemContentId);
  const problemLeaderboardId = identifier(pathname, new RegExp(`^/api/problems/(${UUID})/leaderboard$`));
  if (request.method === "GET" && problemLeaderboardId) return problemLeaderboard(request, env, problemLeaderboardId);
  const problemPerformanceId = identifier(pathname, new RegExp(`^/api/problems/(${UUID})/performance$`));
  if (request.method === "GET" && problemPerformanceId) return problemPerformance(request, env, problemPerformanceId);
  if (request.method === "GET" && pathname === "/api/contests") return listContests(request, env);
  const contestId = identifier(pathname, new RegExp(`^/api/contests/(${UUID})$`));
  if (request.method === "GET" && contestId) return getContest(request, env, contestId);
  const joinContestId = identifier(pathname, new RegExp(`^/api/contests/(${UUID})/join$`));
  if (request.method === "POST" && joinContestId) return joinContest(request, env, joinContestId);
  const startContestId = identifier(pathname, new RegExp(`^/api/contests/(${UUID})/start$`));
  if (request.method === "POST" && startContestId) return startContestEntrant(request, env, startContestId);
  const leaderboardContestId = identifier(pathname, new RegExp(`^/api/contests/(${UUID})/leaderboard$`));
  if (request.method === "GET" && leaderboardContestId) return contestLeaderboard(request, env, leaderboardContestId);
  const promptGalleryContestId = identifier(pathname, new RegExp(`^/api/contests/(${UUID})/prompt-gallery$`));
  if (request.method === "GET" && promptGalleryContestId) return promptContestGallery(request, env, promptGalleryContestId);

  return jsonResponse({ error: { code: "api-route-not-found", message: "API route was not found." } }, 404);
}

const worker = {
  async fetch(request: Request, env: WasmOjWorkerEnv, ctx: ExecutionContext): Promise<Response> {
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

  async scheduled(_controller: ScheduledController, env: WasmOjWorkerEnv, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(reconcile(env));
  },
};

export default worker;
