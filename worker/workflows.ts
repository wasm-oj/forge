import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import type { ForgeWorkerEnv } from "./env";
import { githubInstallationToken } from "./github";
import { randomToken, sha256Hex } from "./crypto";
import { canonicalJsonBytes } from "../src/core/canonical-json";
import { readContainerSubmissionResult, type VerifiedContainerSubmissionResult } from "./container-result";
import { assertActiveRelease } from "./release";
import {
  githubRepositoryCoordinates as parseGithubRepositoryCoordinates,
  parseValidationWorkflowParameters,
  parseValidationWorkflowResult,
  trustedGithubArchiveRedirect,
  type ValidationWorkflowParameters,
  type ValidationWorkflowResult,
} from "./validation-contract";
import { releaseImportObjectClaims } from "./canonical-object-claims";
import { readBoundedResponseBytes, readBoundedResponseJson } from "./http";
import { putImmutableObject } from "./immutable-r2";
import { operationalLog } from "./structured-log";
import {
  FINALIZE_SUBMISSION_ATTEMPT_SQL,
  FINALIZE_SUBMISSION_SQL,
  finalizedSubmissionAttemptMatches,
} from "./submission-finalization";
import {
  deriveSubmissionAttemptToken,
  type SubmissionWorkflowParameters,
} from "./submission-workflow-identity";
import { hydrateSubmissionWorkflow } from "./submission-workflow-context";
import {
  hydrateValidationWorkflowContext,
  validationWorkflowStepMarker,
  type HydratedValidationWorkflowContext,
} from "./validation-workflow-context";
import { archiveCleanupOutboxJson } from "./validation-workflow-outbox";
import { claimSubmissionExecutionSlot } from "./submission-capacity";
import {
  appendAuthorizedSubmissionEvent,
  prepareSubmissionEventInsert,
} from "./submission-events";

export type { SubmissionWorkflowParameters } from "./submission-workflow-identity";

export type { ValidationWorkflowParameters } from "./validation-contract";

type SubmissionWorkflowResult = VerifiedContainerSubmissionResult
  | { readonly state: "infrastructure-error" | "cancelled"; readonly score: 0; readonly fullyPassedCases: 0 };

const MAX_VALIDATION_RESULT_BYTES = 32 * 1024 * 1024;
// With 500 admitted jobs, 50 execution slots, and one isolated retry, the
// theoretical last queue wave can wait about nine hours. Twelve hours leaves
// operational headroom while remaining below the default 10,000 Workflow-step
// and subrequest limits (step.sleep calls do not count as steps).
const CAPACITY_WAIT_ITERATIONS = 12 * 60 * 60 / 10;

function digestBytes(digest: string): Uint8Array {
  return Uint8Array.from(digest.match(/.{2}/g) ?? [], (value) => Number.parseInt(value, 16));
}

async function putVerifiedPermanentAudit(
  env: ForgeWorkerEnv,
  key: string,
  bytes: Uint8Array,
  digest: string,
  metadata: Record<string, string>,
): Promise<void> {
  const options = {
    httpMetadata: { contentType: "application/json" },
    customMetadata: { ...metadata, sha256: digest },
    sha256: digestBytes(digest),
  } satisfies R2PutOptions;
  if (bytes.byteLength < 1 || bytes.byteLength > 2 * 1024 * 1024) throw new Error("Permanent audit exceeds its size limit.");
  await putImmutableObject(env.JUDGE_BUCKET, key, bytes, digest, options);
}

async function appendSubmissionEvent(
  env: ForgeWorkerEnv,
  submissionId: string,
  attempt: number,
  token: string,
  eventKey: string,
  event: unknown,
): Promise<void> {
  await appendAuthorizedSubmissionEvent(env, {
    submissionId,
    attempt,
    attemptTokenHash: await sha256Hex(token),
    eventKey,
    event,
  });
}

async function finalizePreExecutionInfrastructureFailure(
  env: ForgeWorkerEnv,
  submission: SubmissionWorkflowParameters,
): Promise<"infrastructure-error" | "cancelled"> {
  const now = new Date().toISOString();
  const [finalized] = await env.DB.batch([
    env.DB.prepare("UPDATE submissions SET state='infrastructure-error', score=0, fully_passed_cases=0, updated_at=?, completed_at=? WHERE id=? AND state NOT IN ('completed','compile-error','judge-error','infrastructure-error','cancelled')")
      .bind(now, now, submission.submissionId),
    env.DB.prepare("UPDATE submission_attempts SET state='failed', finished_at=?, failure_code='pre-execution-infrastructure-error' WHERE submission_id=? AND state IN ('created','running') AND EXISTS (SELECT 1 FROM submissions WHERE id=? AND state='infrastructure-error')")
      .bind(now, submission.submissionId, submission.submissionId),
    prepareSubmissionEventInsert(env.DB, {
      submissionId: submission.submissionId,
      eventKey: "workflow:pre-execution-infrastructure-error",
      event: { kind: "state", state: "infrastructure-error" },
      timestamp: now,
      requiredState: "infrastructure-error",
    }),
  ]);
  if (finalized?.meta.changes === 1) return "infrastructure-error";
  const current = await env.DB.prepare("SELECT state FROM submissions WHERE id=?")
    .bind(submission.submissionId).first<{ readonly state: string }>();
  if (current?.state === "cancelled") return "cancelled";
  if (current?.state === "infrastructure-error") return "infrastructure-error";
  throw new Error("Pre-execution failure lost its terminal-state fence.");
}

export class SubmissionWorkflow extends WorkflowEntrypoint<ForgeWorkerEnv, SubmissionWorkflowParameters> {
  async run(event: WorkflowEvent<SubmissionWorkflowParameters>, step: WorkflowStep): Promise<SubmissionWorkflowResult> {
    const submission = await hydrateSubmissionWorkflow(this.env, event.payload);
    let currentAttempt = submission.attempt;
    let currentToken = submission.attemptToken;
    try {
      await step.do("publish queued state", async () => {
        await appendSubmissionEvent(
          this.env,
          submission.submissionId,
          currentAttempt,
          currentToken,
          "workflow:queued",
          { kind: "state", state: "queued" },
        );
      });
    } catch {
      const state = await step.do("finalize queue initialization failure", async () => (
        finalizePreExecutionInfrastructureFailure(this.env, submission)
      ));
      return { state, score: 0, fullyPassedCases: 0 };
    }

    let waitingPublished = false;
    let acquired = false;
    try {
      for (let waitIteration = 0; waitIteration < CAPACITY_WAIT_ITERATIONS; waitIteration += 1) {
        const state = await step.do(`check cancellation before capacity ${waitIteration}`, async () => (
          this.env.DB.prepare("SELECT state FROM submissions WHERE id=?")
            .bind(submission.submissionId).first<{ state: string }>()
        ));
        if (state?.state === "cancelled") {
          return { state: "cancelled", score: 0, fullyPassedCases: 0 };
        }
        acquired = await step.do(`acquire D1 execution slot ${waitIteration}`, async () => (
          claimSubmissionExecutionSlot(this.env, submission.submissionId)
        ));
        if (acquired) {
          acquired = true;
          break;
        }
        if (!waitingPublished) {
          await step.do(`publish waiting capacity state ${waitIteration}`, async () => {
            await appendSubmissionEvent(
              this.env,
              submission.submissionId,
              currentAttempt,
              currentToken,
              "workflow:waiting-capacity",
              { kind: "state", state: "waiting-capacity" },
            );
          });
          waitingPublished = true;
        }
        await step.sleep(`wait for D1 execution slot ${waitIteration}`, "10 seconds");
      }
      if (!acquired) throw new Error("Submission capacity wait exceeded its bounded window.");
    } catch {
      const state = await step.do("finalize capacity acquisition failure", async () => (
        finalizePreExecutionInfrastructureFailure(this.env, submission)
      ));
      return { state, score: 0, fullyPassedCases: 0 };
    }

    try {
      for (let attempt = submission.attempt; attempt <= submission.attempt + 1; attempt += 1) {
        try {
          const result = await step.do(`run judge container attempt ${attempt}`, {
            retries: { limit: 0, delay: "1 second" },
            timeout: "30 minutes",
          }, async () => {
            const started = await this.env.DB.prepare("UPDATE submission_attempts SET state='running', started_at=? WHERE submission_id=? AND attempt=? AND state='created' AND token_hash=? AND EXISTS (SELECT 1 FROM submissions WHERE id=? AND state NOT IN ('completed','compile-error','judge-error','infrastructure-error','cancelled'))")
              .bind(new Date().toISOString(), submission.submissionId, attempt, await sha256Hex(currentToken), submission.submissionId).run();
            if (started.meta.changes !== 1) throw new Error("Submission attempt lost its execution fence.");
            const container = this.env.SUBMISSION_CONTAINER.getByName(`${submission.submissionId}:${attempt}`);
            const response = await container.fetch(new Request("https://judge.container/execute", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                kind: "submission",
                jobId: submission.submissionId,
                submissionId: submission.submissionId,
                attempt,
                attemptToken: currentToken,
                sourceOwnerId: submission.sourceOwnerId,
                sourceR2Key: submission.sourceR2Key,
                sourceSha256: submission.sourceSha256,
                judgeR2Key: submission.judgeR2Key,
                judgeSha256: submission.judgeSha256,
                expectedReleaseId: submission.expectedReleaseId,
                expectedManifestSha256: submission.expectedManifestSha256,
                expectedContainerIdentitySha256: submission.expectedContainerIdentitySha256,
                expectedProblemBundleDigest: submission.expectedProblemBundleDigest,
              }),
            }));
            if (!response.ok) throw new Error(`Judge container failed with HTTP ${response.status}.`);
            return readContainerSubmissionResult(response, {
              submissionId: submission.submissionId,
              attempt,
              expectedReleaseId: submission.expectedReleaseId,
              expectedManifestSha256: submission.expectedManifestSha256,
              expectedContainerIdentitySha256: submission.expectedContainerIdentitySha256,
              expectedJudgeProjectionSha256: submission.judgeSha256,
              expectedProblemBundleDigest: submission.expectedProblemBundleDigest,
            });
          });
          const resultAudit = result.state === "compile-error" ? undefined : result.audit;
          const auditKey = resultAudit === undefined ? null : await step.do(`write permanent bounded audit ${attempt}`, async () => {
            const bytes = canonicalJsonBytes(resultAudit);
            if (bytes.byteLength > 2 * 1024 * 1024) throw new NonRetryableError("Judge audit exceeds 2 MiB.");
            const digest = await sha256Hex(bytes);
            const key = `audits/${submission.submissionId}/${attempt}.${digest}.json`;
            const tokenHash = await sha256Hex(currentToken);
            const claimed = await this.env.DB.prepare("UPDATE submission_attempts SET audit_r2_key=? WHERE submission_id=? AND attempt=? AND state='running' AND token_hash=? AND audit_r2_key IS NULL AND EXISTS (SELECT 1 FROM submissions WHERE id=? AND state NOT IN ('completed','compile-error','judge-error','infrastructure-error','cancelled'))")
              .bind(key, submission.submissionId, attempt, tokenHash, submission.submissionId).run();
            if (claimed.meta.changes !== 1) {
              const existing = await this.env.DB.prepare("SELECT 1 AS exact FROM submission_attempts JOIN submissions ON submissions.id=submission_attempts.submission_id WHERE submission_attempts.submission_id=? AND submission_attempts.attempt=? AND submission_attempts.state='running' AND submission_attempts.token_hash=? AND submission_attempts.audit_r2_key=? AND submissions.state NOT IN ('completed','compile-error','judge-error','infrastructure-error','cancelled')")
                .bind(submission.submissionId, attempt, tokenHash, key).first<{ readonly exact: number }>();
              if (!existing) throw new Error("Submission audit lost its durable attempt claim.");
            }
            await putVerifiedPermanentAudit(this.env, key, bytes, digest, {
              submissionId: submission.submissionId,
              attempt: String(attempt),
            });
            return key;
          });
          const finalized = await step.do(`finalize submission database ${attempt}`, async () => {
            const now = new Date().toISOString();
            const tokenHash = await sha256Hex(currentToken);
            const terminalVerdict = result.state === "compile-error" ? "compile-error" : result.verdict;
            const statements = [
              this.env.DB.prepare(FINALIZE_SUBMISSION_SQL)
                .bind(result.state, terminalVerdict, result.score, result.fullyPassedCases, result.state === "compile-error" ? null : result.deterministicCost, result.state === "compile-error" ? null : result.peakMemoryBytes, attempt, now, now, submission.submissionId, attempt, submission.submissionId, submission.submissionId, attempt, tokenHash),
              this.env.DB.prepare(FINALIZE_SUBMISSION_ATTEMPT_SQL)
                .bind(now, submission.submissionId, attempt, tokenHash, auditKey, auditKey, submission.submissionId, attempt, result.state),
              prepareSubmissionEventInsert(this.env.DB, {
                submissionId: submission.submissionId,
                eventKey: `workflow:terminal:${attempt}`,
                event: { kind: "state", state: result.state },
                timestamp: now,
                requiredState: result.state,
                requiredAttempt: attempt,
              }),
            ];
            const [claim, attemptClaim] = await this.env.DB.batch(statements);
            if (claim?.meta.changes === 1 && attemptClaim?.meta.changes === 1) return "committed" as const;
            const exact = await this.env.DB.prepare(`SELECT
                submissions.state, submissions.verdict, submissions.score, submissions.fully_passed_cases,
                submissions.deterministic_cost, submissions.peak_memory_bytes, submissions.effective_attempt,
                submission_attempts.state AS attempt_state, submission_attempts.token_hash,
                submission_attempts.audit_r2_key
              FROM submissions
              JOIN submission_attempts ON submission_attempts.submission_id=submissions.id AND submission_attempts.attempt=?
              WHERE submissions.id=?`)
              .bind(attempt, submission.submissionId).first<{
                readonly state: string;
                readonly verdict: string | null;
                readonly score: number | null;
                readonly fully_passed_cases: number | null;
                readonly deterministic_cost: number | null;
                readonly peak_memory_bytes: number | null;
                readonly effective_attempt: number | null;
                readonly attempt_state: string;
                readonly token_hash: string;
                readonly audit_r2_key: string | null;
              }>();
            const expected = {
              state: result.state,
              verdict: terminalVerdict,
              score: result.score,
              fullyPassedCases: result.fullyPassedCases,
              deterministicCost: result.state === "compile-error" ? null : result.deterministicCost,
              peakMemoryBytes: result.state === "compile-error" ? null : result.peakMemoryBytes,
              attempt,
              tokenHash,
              auditR2Key: auditKey,
            };
            if (finalizedSubmissionAttemptMatches(exact, expected)) return "replayed" as const;
            const submissionMatches = exact?.state === expected.state
              && exact.verdict === expected.verdict
              && exact.score === expected.score
              && exact.fully_passed_cases === expected.fullyPassedCases
              && exact.deterministic_cost === expected.deterministicCost
              && exact.peak_memory_bytes === expected.peakMemoryBytes
              && exact.effective_attempt === expected.attempt;
            const attemptMatches = exact?.token_hash === expected.tokenHash && exact.audit_r2_key === expected.auditR2Key;
            if (submissionMatches && attemptMatches && exact.attempt_state === "running") {
              const repaired = await this.env.DB.prepare(FINALIZE_SUBMISSION_ATTEMPT_SQL)
                .bind(now, submission.submissionId, attempt, tokenHash, auditKey, auditKey, submission.submissionId, attempt, result.state).run();
              if (repaired.meta.changes === 1) return "replayed" as const;
            }
            return "lost" as const;
          });
          if (finalized === "lost") {
            const state = await this.env.DB.prepare("SELECT state FROM submissions WHERE id=?")
              .bind(submission.submissionId).first<{ state: string }>();
            if (state?.state === "cancelled") return { state: "cancelled", score: 0, fullyPassedCases: 0 };
            throw new Error("Submission finalization lost its terminal-state fence.");
          }
          return result;
        } catch (error) {
          await step.do(`record failed attempt ${attempt}`, async () => {
            await this.env.DB.prepare("UPDATE submission_attempts SET state='failed', finished_at=?, failure_code='container-failure' WHERE submission_id=? AND attempt=? AND state='running'")
              .bind(new Date().toISOString(), submission.submissionId, attempt).run();
          });
          if (attempt >= submission.attempt + 1) throw error;
          const nextAttempt = attempt + 1;
          const nextToken = await deriveSubmissionAttemptToken(
            this.env.ACCOUNT_ERASURE_HMAC_SECRET,
            submission.submissionId,
            nextAttempt,
          );
          await step.do(`create isolated retry attempt ${nextAttempt}`, async () => {
            const now = new Date().toISOString();
            const [inserted, yielded, reclaimed] = await this.env.DB.batch([
              this.env.DB.prepare("INSERT INTO submission_attempts (submission_id, attempt, token_hash, container_key, state) SELECT ?, ?, ?, ?, 'created' WHERE EXISTS (SELECT 1 FROM submissions WHERE id=? AND state IN ('preparing','compiling','running'))")
                .bind(submission.submissionId, nextAttempt, await sha256Hex(nextToken), `${submission.submissionId}:${nextAttempt}`, submission.submissionId),
              this.env.DB.prepare("UPDATE submissions SET state='waiting-capacity', updated_at=? WHERE id=? AND state IN ('preparing','compiling','running') AND EXISTS (SELECT 1 FROM submission_attempts WHERE submission_id=? AND attempt=? AND state='created')")
                .bind(now, submission.submissionId, submission.submissionId, nextAttempt),
              this.env.DB.prepare("UPDATE submissions SET state='preparing', updated_at=? WHERE id=? AND state='waiting-capacity' AND EXISTS (SELECT 1 FROM submission_attempts WHERE submission_id=? AND attempt=? AND state='created')")
                .bind(now, submission.submissionId, submission.submissionId, nextAttempt),
            ]);
            if ([inserted, yielded, reclaimed].some((result) => result?.meta.changes !== 1)) {
              throw new Error("Submission could not retain its D1 execution slot for retry.");
            }
          });
          currentAttempt = nextAttempt;
          currentToken = nextToken;
        }
      }
      throw new Error(`No judge result after attempt ${currentAttempt}.`);
    } catch {
      const cancelled = await this.env.DB.prepare("SELECT 1 AS cancelled FROM submissions WHERE id=? AND state='cancelled'")
        .bind(submission.submissionId).first<{ cancelled: number }>();
      if (cancelled) return { state: "cancelled", score: 0, fullyPassedCases: 0 };
      try {
        await step.do("publish infrastructure error detail", async () => {
          await appendSubmissionEvent(
            this.env,
            submission.submissionId,
            currentAttempt,
            currentToken,
            `workflow:infrastructure-error-detail:${currentAttempt}`,
            {
              kind: "error",
              message: "The judge infrastructure could not complete this submission.",
              retryable: true,
            },
          );
        });
      } catch {
        operationalLog("warn", { event: "workflow.delivery-deferred", outcome: "deferred", code: "infrastructure-error-detail", aggregateType: "submission", aggregateId: submission.submissionId });
      }
      const infrastructureFinalized = await step.do("finalize infrastructure failure", async () => {
        const now = new Date().toISOString();
        const statements = [
          this.env.DB.prepare("UPDATE submissions SET state='infrastructure-error', score=0, fully_passed_cases=0, updated_at=?, completed_at=? WHERE id=? AND state NOT IN ('completed','compile-error','judge-error','infrastructure-error','cancelled')")
            .bind(now, now, submission.submissionId),
          this.env.DB.prepare("UPDATE submission_attempts SET state='failed', finished_at=COALESCE(finished_at, ?), failure_code=COALESCE(failure_code, 'workflow-infrastructure-error') WHERE submission_id=? AND state IN ('created','running') AND EXISTS (SELECT 1 FROM submissions WHERE id=? AND state='infrastructure-error')")
            .bind(now, submission.submissionId, submission.submissionId),
          prepareSubmissionEventInsert(this.env.DB, {
            submissionId: submission.submissionId,
            eventKey: "workflow:infrastructure-error",
            event: { kind: "state", state: "infrastructure-error" },
            timestamp: now,
            requiredState: "infrastructure-error",
          }),
        ];
        const [finalized] = await this.env.DB.batch(statements);
        return finalized.meta.changes === 1;
      });
      if (!infrastructureFinalized) {
        const state = await this.env.DB.prepare("SELECT state FROM submissions WHERE id=?")
          .bind(submission.submissionId).first<{ state: string }>();
        if (state?.state === "cancelled") return { state: "cancelled", score: 0, fullyPassedCases: 0 };
        return { state: "infrastructure-error", score: 0, fullyPassedCases: 0 };
      }
      return { state: "infrastructure-error", score: 0, fullyPassedCases: 0 };
    }
  }
}

function githubHeaders(token: string): Headers {
  return new Headers({
    accept: "application/vnd.github+json",
    authorization: `Bearer ${token}`,
    "user-agent": "wasm-oj-forge",
    "x-github-api-version": "2022-11-28",
  });
}

async function resolveGithubRepositoryCoordinates(
  token: string,
  repositoryId: number,
  expectedOwner: string,
  expectedRepository: string,
): Promise<{ readonly owner: string; readonly repository: string }> {
  const response = await fetch(`https://api.github.com/repositories/${repositoryId}`, {
    headers: githubHeaders(token),
    redirect: "manual",
  });
  if (!response.ok) throw new Error(`GitHub repository identity request failed with HTTP ${response.status}.`);
  try {
    return parseGithubRepositoryCoordinates(
      await readBoundedResponseJson(response, 1024 * 1024),
      repositoryId,
      expectedOwner,
      expectedRepository,
    );
  } catch {
    throw new NonRetryableError("GitHub repository identity changed; reconnect the numeric repository before importing.");
  }
}

async function readBoundedValidationResult(
  response: Response,
  input: HydratedValidationWorkflowContext,
): Promise<ValidationWorkflowResult> {
  const declared = response.headers.get("content-length");
  if (declared !== null && (!Number.isSafeInteger(Number(declared)) || Number(declared) < 1 || Number(declared) > MAX_VALIDATION_RESULT_BYTES)) {
    throw new Error("Validation container result exceeds its protocol limit.");
  }
  if (!response.body) throw new Error("Validation container result has no body.");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_VALIDATION_RESULT_BYTES) {
        await reader.cancel("validation result too large");
        throw new Error("Validation container result exceeds its protocol limit.");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new Error("Validation container result is not valid UTF-8 JSON.");
  }
  return parseValidationWorkflowResult(value, {
    importId: input.importId,
    forgeReleaseId: input.expectedReleaseId,
  });
}

function exactValidationArchiveKey(importId: string, commitSha: string, value: string): boolean {
  return value === `imports/${importId}/${commitSha}.tar.gz`;
}

async function assertValidationArchiveCleanupFence(env: ForgeWorkerEnv, importId: string): Promise<void> {
  const cleanup = await env.DB.prepare("SELECT 1 AS valid FROM collection_imports WHERE id=? AND archive_r2_key IS NULL AND archive_disposition='deleted' UNION ALL SELECT 1 AS valid FROM outbox WHERE kind='cleanup-import-archive' AND aggregate_id=? AND delivered_at IS NULL LIMIT 1")
    .bind(importId, importId).first<{ readonly valid: number }>();
  if (!cleanup) throw new Error("Validation result lost its archive-cleanup fence.");
}

export class ValidationWorkflow extends WorkflowEntrypoint<ForgeWorkerEnv, ValidationWorkflowParameters> {
  async run(event: WorkflowEvent<ValidationWorkflowParameters>, step: WorkflowStep): Promise<ValidationWorkflowResult> {
    const opaque = parseValidationWorkflowParameters(event.payload);
    try {
      await step.do("hydrate exact import and verify active release", {
        retries: { limit: 2, delay: "2 seconds", backoff: "exponential" },
        timeout: "1 minute",
      }, async () => {
        if (opaque.expectedReleaseId !== this.env.FORGE_RELEASE_ID || opaque.expectedManifestSha256 !== this.env.FORGE_RELEASE_MANIFEST_SHA256) {
          throw new NonRetryableError("Validation target is no longer the deployed release.");
        }
        // Full context exists only inside this closure. The returned marker is
        // intentionally the sole non-sensitive Workflow step output.
        const context = await hydrateValidationWorkflowContext(this.env, opaque, ["queued", "validating"]);
        if (context.status !== "queued") {
          throw new NonRetryableError("GitHub archive import entered validation before its archive was acquired.");
        }
        const active = await assertActiveRelease(this.env.DB, this.env.JUDGE_BUCKET, this.env.ENVIRONMENT, opaque.expectedReleaseId, opaque.expectedManifestSha256);
        if (active.manifest.artifacts.containerImage.identitySha256 !== opaque.expectedContainerIdentitySha256) {
          throw new NonRetryableError("Validation Container identity does not match the active release.");
        }
        return validationWorkflowStepMarker(context);
      });
      await step.do("verify immutable Git tree", async () => {
        const context = await hydrateValidationWorkflowContext(this.env, opaque, ["queued"]);
        const token = await githubInstallationToken(this.env, context.source.installationId);
        const coordinates = await resolveGithubRepositoryCoordinates(token, context.githubRepositoryId, context.source.expectedOwner, context.source.expectedRepository);
        const response = await fetch(`https://api.github.com/repos/${encodeURIComponent(coordinates.owner)}/${encodeURIComponent(coordinates.repository)}/git/trees/${context.commitSha}?recursive=1`, {
          headers: githubHeaders(token),
          redirect: "manual",
        });
        if (!response.ok) throw new Error(`Git tree request failed with HTTP ${response.status}.`);
        let body: { truncated?: unknown; tree?: unknown };
        try {
          body = await readBoundedResponseJson(response, 8 * 1024 * 1024) as { truncated?: unknown; tree?: unknown };
        } catch {
          throw new NonRetryableError("Git tree response is malformed or exceeds 8 MiB.");
        }
        if (body.truncated !== false || !Array.isArray(body.tree) || body.tree.length > 10_000) throw new NonRetryableError("Git tree is truncated or exceeds 10,000 entries.");
        let totalBytes = 0;
        for (const item of body.tree) {
          const entry = item as Record<string, unknown>;
          if (entry.mode === "160000" || entry.type === "commit") throw new NonRetryableError("Git submodules are forbidden.");
          if (entry.mode === "120000") throw new NonRetryableError("Symbolic links are forbidden.");
          if (entry.type === "blob") {
            if (!Number.isSafeInteger(entry.size) || (entry.size as number) < 0 || (entry.size as number) > 32 * 1024 * 1024) throw new NonRetryableError("Repository contains an oversized blob.");
            totalBytes += entry.size as number;
            if (totalBytes > 256 * 1024 * 1024) throw new NonRetryableError("Repository contents exceed 256 MiB.");
          }
        }
      });
      await step.do("reserve exact commit archive key", async () => {
        const context = await hydrateValidationWorkflowContext(this.env, opaque, ["queued", "downloading"]);
        const key = `imports/${context.importId}/${context.commitSha}.tar.gz`;
        if (context.status === "downloading") {
          if (context.source.archiveR2Key !== key) throw new NonRetryableError("GitHub archive reservation changed.");
          return;
        }
        const reserved = await this.env.DB.prepare("UPDATE collection_imports SET archive_r2_key=?, status='downloading', updated_at=? WHERE id=? AND status='queued' AND archive_r2_key IS NULL")
          .bind(key, new Date().toISOString(), context.importId).run();
        if (reserved.meta.changes === 1) return;
        const replayed = await this.env.DB.prepare("SELECT 1 AS valid FROM collection_imports WHERE id=? AND status='downloading' AND archive_r2_key=?")
          .bind(context.importId, key).first<{ valid: number }>();
        if (!replayed) throw new NonRetryableError("GitHub archive import could not reserve immutable storage.");
      });
      await step.do("download exact commit archive", { retries: { limit: 5, delay: "5 seconds", backoff: "exponential" }, timeout: "5 minutes" }, async () => {
        const context = await hydrateValidationWorkflowContext(this.env, opaque, ["downloading", "validating"]);
        if (!context.source.archiveR2Key) throw new NonRetryableError("GitHub archive reservation is missing.");
        const token = await githubInstallationToken(this.env, context.source.installationId);
        const coordinates = await resolveGithubRepositoryCoordinates(token, context.githubRepositoryId, context.source.expectedOwner, context.source.expectedRepository);
        const archiveApi = `https://api.github.com/repos/${encodeURIComponent(coordinates.owner)}/${encodeURIComponent(coordinates.repository)}/tarball/${context.commitSha}`;
        const redirect = await fetch(archiveApi, { headers: githubHeaders(token), redirect: "manual" });
        if (redirect.status < 300 || redirect.status > 399) throw new Error(`GitHub archive request failed with HTTP ${redirect.status}.`);
        let archiveLocation: string;
        try { archiveLocation = trustedGithubArchiveRedirect(redirect.headers.get("location")); } catch { throw new NonRetryableError("GitHub archive redirect target is not trusted."); }
        const archive = await fetch(archiveLocation, { redirect: "manual", credentials: "omit" });
        if (!archive.ok || !archive.body) throw new Error(`GitHub archive download failed with HTTP ${archive.status}.`);
        const declaredHeader = archive.headers.get("content-length");
        if (declaredHeader !== null) {
          const declared = Number(declaredHeader);
          if (!Number.isSafeInteger(declared) || declared < 1 || declared > 128 * 1024 * 1024) throw new NonRetryableError("Repository archive exceeds 128 MiB.");
        }
        let archiveBytes: Uint8Array;
        try {
          archiveBytes = await readBoundedResponseBytes(archive, 128 * 1024 * 1024);
        } catch (error) {
          if (error instanceof RangeError) throw new NonRetryableError("Repository archive exceeds 128 MiB.");
          throw error;
        }
        if (archiveBytes.byteLength < 1) throw new NonRetryableError("Repository archive is empty.");
        await this.env.JUDGE_BUCKET.put(context.source.archiveR2Key, archiveBytes, {
          httpMetadata: { contentType: "application/gzip" },
          customMetadata: { importId: context.importId, commitSha: context.commitSha },
        });
        const claimed = await this.env.DB.prepare("UPDATE collection_imports SET status='validating', updated_at=? WHERE id=? AND status='downloading' AND archive_r2_key=?")
          .bind(new Date().toISOString(), context.importId, context.source.archiveR2Key).run();
        if (claimed.meta.changes !== 1) {
          const replayed = await this.env.DB.prepare("SELECT 1 AS valid FROM collection_imports WHERE id=? AND status='validating' AND archive_r2_key=?")
            .bind(context.importId, context.source.archiveR2Key).first<{ valid: number }>();
          if (!replayed) throw new NonRetryableError("GitHub archive import could not claim validation.");
        }
      });
      const result = await step.do("validate and project collection", { retries: { limit: 2, delay: "10 seconds", backoff: "exponential" }, timeout: "30 minutes" }, async () => {
        const context = await hydrateValidationWorkflowContext(this.env, opaque, ["validating"]);
        if (!context.source.archiveR2Key) {
          throw new NonRetryableError("GitHub archive validation source is missing its reserved object.");
        }
        const attemptToken = randomToken();
        const container = this.env.VALIDATION_CONTAINER.getByName(`validation:${context.importId}`);
        const response = await container.fetch(new Request("https://validator.container/execute", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            kind: "validation",
            jobId: context.importId,
            attempt: 1,
            attemptToken,
            outputPrefix: "snapshots/objects",
            githubRepositoryId: context.githubRepositoryId,
            commitSha: context.commitSha,
            indexPath: context.indexPath,
            forgeReleaseId: context.expectedReleaseId,
            expectedReleaseId: context.expectedReleaseId,
            expectedManifestSha256: context.expectedManifestSha256,
            expectedContainerIdentitySha256: context.expectedContainerIdentitySha256,
            source: { kind: "github-archive", archiveR2Key: context.source.archiveR2Key },
          }),
        }));
        if (response.status === 409 || response.status === 422) throw new NonRetryableError("Managed collection validation rejected the canonical source.");
        if (!response.ok) throw new Error(`Validation container infrastructure failed with HTTP ${response.status}.`);
        return readBoundedValidationResult(response, context);
      });
      await step.do("record successful validation", async () => {
        const report = result.report;
        const canonical = result.canonicalSource?.manifest;
        const replayedTerminal = await this.env.DB.prepare("SELECT commit_sha, status, validation_report_r2_key, canonical_source_r2_key, canonical_source_sha256, archive_r2_key, archive_disposition FROM collection_imports WHERE id=? AND forge_release_id=?")
          .bind(opaque.importId, opaque.expectedReleaseId).first<{
            readonly commit_sha: string;
            readonly status: string;
            readonly validation_report_r2_key: string | null;
            readonly canonical_source_r2_key: string | null;
            readonly canonical_source_sha256: string | null;
            readonly archive_r2_key: string | null;
            readonly archive_disposition: string;
          }>();
        if (replayedTerminal?.status === "valid") {
          if (
            replayedTerminal.validation_report_r2_key !== report.key
            || replayedTerminal.canonical_source_r2_key !== canonical.key
            || replayedTerminal.canonical_source_sha256 !== canonical.digest
            || (replayedTerminal.archive_r2_key !== null && !exactValidationArchiveKey(opaque.importId, replayedTerminal.commit_sha, replayedTerminal.archive_r2_key))
          ) throw new Error("Replayed validation result does not match its immutable import.");
          if (replayedTerminal.archive_r2_key !== null) await assertValidationArchiveCleanupFence(this.env, opaque.importId);
          else if (replayedTerminal.archive_disposition !== "deleted") throw new Error("Replayed validation result has an invalid archive disposition.");
          return;
        }
        if (replayedTerminal && ["invalid", "infrastructure-error"].includes(replayedTerminal.status)) {
          throw new Error("Validation success cannot replace a terminal failed import.");
        }
        const context = await hydrateValidationWorkflowContext(this.env, opaque, ["validating"]);
        const archiveR2Key = context.source.archiveR2Key;
        const now = new Date();
        const statements = [
          this.env.DB.prepare("UPDATE collection_imports SET validation_report_r2_key=?, canonical_source_r2_key=?, canonical_source_sha256=?, archive_disposition=?, archive_delete_after=?, canonical_draft_delete_after=?, canonical_expired_at=NULL, status='valid', error_code=NULL, updated_at=? WHERE id=? AND status='validating' AND forge_release_id=?")
            .bind(
              report.key,
              canonical.key,
              canonical.digest,
              archiveR2Key ? "pending" : "deleted",
              archiveR2Key ? now.toISOString() : null,
              new Date(now.getTime() + 30 * 24 * 60 * 60 * 1_000).toISOString(),
              now.toISOString(),
              context.importId,
              context.expectedReleaseId,
            ),
        ];
        if (archiveR2Key) statements.push(
          this.env.DB.prepare("INSERT OR IGNORE INTO outbox (id, kind, aggregate_id, payload_json, created_at) SELECT ?, 'cleanup-import-archive', ?, ?, ? WHERE EXISTS (SELECT 1 FROM collection_imports WHERE id=? AND status='valid' AND archive_r2_key=? AND archive_disposition='pending')")
            .bind(crypto.randomUUID(), context.importId, archiveCleanupOutboxJson(context.importId), now.toISOString(), context.importId, archiveR2Key),
        );
        const results = await this.env.DB.batch(statements);
        if (results[0]?.meta.changes !== 1) {
          const replayed = await this.env.DB.prepare("SELECT 1 AS valid FROM collection_imports WHERE id=? AND status='valid' AND validation_report_r2_key=? AND canonical_source_r2_key=? AND canonical_source_sha256=?")
            .bind(context.importId, report.key, canonical.key, canonical.digest).first<{ valid: number }>();
          if (!replayed) throw new Error("Validation result lost its immutable import fence.");
        }
        if (archiveR2Key) {
          await assertValidationArchiveCleanupFence(this.env, context.importId);
        }
      });
      return result;
    } catch (error) {
      const invalid = error instanceof NonRetryableError || (error instanceof Error && error.name === "NonRetryableError");
      await step.do("record failed validation", async () => {
        const expectedStatus = invalid ? "invalid" : "infrastructure-error";
        const expectedErrorCode = invalid ? "validation-failed" : "validation-infrastructure";
        const replayedTerminal = await this.env.DB.prepare("SELECT commit_sha, status, error_code, archive_r2_key, archive_disposition FROM collection_imports WHERE id=? AND forge_release_id=?")
          .bind(opaque.importId, opaque.expectedReleaseId).first<{
            readonly commit_sha: string;
            readonly status: string;
            readonly error_code: string | null;
            readonly archive_r2_key: string | null;
            readonly archive_disposition: string;
          }>();
        if (replayedTerminal?.status === expectedStatus && replayedTerminal.error_code === expectedErrorCode) {
          if (
            (replayedTerminal.archive_r2_key !== null && !exactValidationArchiveKey(opaque.importId, replayedTerminal.commit_sha, replayedTerminal.archive_r2_key))
            || (expectedStatus === "invalid" && replayedTerminal.archive_r2_key !== null && replayedTerminal.archive_disposition !== "pending")
            || (expectedStatus === "infrastructure-error" && replayedTerminal.archive_r2_key !== null && replayedTerminal.archive_disposition !== "quarantined")
            || (replayedTerminal.archive_r2_key === null && replayedTerminal.archive_disposition !== "deleted")
          ) throw new Error("Replayed validation failure does not match its immutable import.");
          if (expectedStatus === "invalid" && replayedTerminal.archive_r2_key !== null) {
            await assertValidationArchiveCleanupFence(this.env, opaque.importId);
          }
          await releaseImportObjectClaims(this.env, opaque.importId, new Date());
          return;
        }
        if (replayedTerminal && ["valid", "invalid", "infrastructure-error"].includes(replayedTerminal.status)) {
          throw new Error("Validation failure cannot replace a different terminal import.");
        }
        const context = await hydrateValidationWorkflowContext(this.env, opaque, ["queued", "downloading", "validating"]);
        const archiveR2Key = context.source.archiveR2Key;
        const now = new Date();
        const quarantine = archiveR2Key !== undefined && !invalid;
        const cleanup = archiveR2Key !== undefined && invalid;
        const statements = [
          this.env.DB.prepare("UPDATE collection_imports SET status=?, error_code=?, archive_disposition=?, archive_delete_after=?, updated_at=? WHERE id=? AND status IN ('queued','downloading','validating')")
            .bind(
              expectedStatus,
              expectedErrorCode,
              cleanup ? "pending" : quarantine ? "quarantined" : "deleted",
              cleanup ? now.toISOString() : quarantine ? new Date(now.getTime() + 24 * 60 * 60 * 1_000).toISOString() : null,
              now.toISOString(),
              context.importId,
            ),
        ];
        if (cleanup) statements.push(
          this.env.DB.prepare("INSERT OR IGNORE INTO outbox (id, kind, aggregate_id, payload_json, created_at) SELECT ?, 'cleanup-import-archive', ?, ?, ? WHERE EXISTS (SELECT 1 FROM collection_imports WHERE id=? AND archive_r2_key=? AND archive_disposition='pending')")
            .bind(crypto.randomUUID(), context.importId, archiveCleanupOutboxJson(context.importId), now.toISOString(), context.importId, archiveR2Key),
        );
        const results = await this.env.DB.batch(statements);
        if (results[0]?.meta.changes !== 1) {
          const replayed = await this.env.DB.prepare("SELECT 1 AS valid FROM collection_imports WHERE id=? AND status=? AND error_code=?")
            .bind(context.importId, expectedStatus, expectedErrorCode).first<{ valid: number }>();
          if (!replayed) throw new Error("Failed validation lost its terminal state fence.");
        }
        if (cleanup) {
          await assertValidationArchiveCleanupFence(this.env, context.importId);
        }
        await releaseImportObjectClaims(this.env, context.importId, now);
      });
      throw error;
    }
  }
}
