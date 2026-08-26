import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import type { WasmOjWorkerEnv } from "./env";
import { sha256Hex } from "./crypto";
import { readContainerSubmissionResult, type VerifiedContainerSubmissionResult } from "./container-result";
import { FINALIZE_SUBMISSION_ATTEMPT_SQL, FINALIZE_SUBMISSION_SQL, finalizedSubmissionAttemptMatches } from "./submission-finalization";
import { deriveSubmissionAttemptToken, type SubmissionWorkflowParameters } from "./submission-workflow-identity";
import { hydrateSubmissionWorkflow, type HydratedSubmissionWorkflow } from "./submission-workflow-context";
import { prepareSubmissionEventInsert } from "./submission-events";
import { dispatchSubmissionJobs } from "./dispatcher";
import { operationalLog } from "./structured-log";
import { classifyRejudgeChildState } from "../src/online-judge/rejudge";
import { createRetryAttempt } from "./submission-retry";

export type { SubmissionWorkflowParameters } from "./submission-workflow-identity";

type SubmissionWorkflowResult = VerifiedContainerSubmissionResult
  | { readonly state: "infrastructure-error" | "cancelled"; readonly score: 0; readonly fullyPassedCases: 0 };

const TERMINAL_STATES = "'completed','compile-error','judge-error','infrastructure-error','cancelled'";

async function currentState(env: WasmOjWorkerEnv, submissionId: string): Promise<string | null> {
  const row = await env.DB.prepare("SELECT state FROM submissions WHERE id=?")
    .bind(submissionId).first<{ readonly state: string }>();
  return row?.state ?? null;
}

async function finalizeInfrastructureFailure(
  env: WasmOjWorkerEnv,
  submission: HydratedSubmissionWorkflow,
  attempt: number,
): Promise<"infrastructure-error" | "cancelled"> {
  const now = new Date().toISOString();
  await env.DB.batch([
    env.DB.prepare(`UPDATE submissions
        SET state='infrastructure-error', verdict='judge-error', score=0, fully_passed_cases=0,
            policy_summary_json=NULL, updated_at=?, completed_at=?
      WHERE id=? AND state NOT IN (${TERMINAL_STATES})`)
      .bind(now, now, submission.submissionId),
    env.DB.prepare(`UPDATE submission_attempts
        SET state='failed', finished_at=?, failure_code='container-failure'
      WHERE submission_id=? AND attempt=? AND state IN ('created','running')`)
      .bind(now, submission.submissionId, attempt),
    prepareSubmissionEventInsert(env.DB, {
      submissionId: submission.submissionId,
      eventKey: `workflow:infrastructure-error:${attempt}`,
      event: { kind: "state", state: "infrastructure-error" },
      timestamp: now,
      requiredState: "infrastructure-error",
    }),
  ]);
  const state = await currentState(env, submission.submissionId);
  if (state === "cancelled") return "cancelled";
  if (state !== "infrastructure-error") throw new Error("Submission infrastructure failure lost its terminal fence.");
  return "infrastructure-error";
}

async function finalizeContainerResult(
  env: WasmOjWorkerEnv,
  submission: HydratedSubmissionWorkflow,
  attempt: number,
  token: string,
  result: VerifiedContainerSubmissionResult,
): Promise<"committed" | "replayed" | "cancelled"> {
  const now = new Date().toISOString();
  const tokenHash = await sha256Hex(token);
  const terminalVerdict = result.state === "compile-error" ? "compile-error" : result.verdict;
  const deterministicCost = result.state === "compile-error" ? null : result.deterministicCost;
  const peakMemoryBytes = result.state === "compile-error" ? null : result.peakMemoryBytes;
  const policySummaryJson = result.state === "completed" ? JSON.stringify(result.policySummary) : null;
  const statements: D1PreparedStatement[] = [
    env.DB.prepare(FINALIZE_SUBMISSION_SQL).bind(
      result.state, terminalVerdict, result.score, result.fullyPassedCases,
      deterministicCost, peakMemoryBytes, policySummaryJson, attempt, now, now,
      submission.submissionId, attempt, submission.submissionId,
      submission.submissionId, attempt, tokenHash,
    ),
    env.DB.prepare(FINALIZE_SUBMISSION_ATTEMPT_SQL)
      .bind(now, submission.submissionId, attempt, tokenHash, submission.submissionId, attempt, result.state),
    prepareSubmissionEventInsert(env.DB, {
      submissionId: submission.submissionId,
      eventKey: `workflow:terminal:${attempt}`,
      event: { kind: "state", state: result.state },
      timestamp: now,
      requiredState: result.state,
      requiredAttempt: attempt,
    }),
  ];
  if (submission.rejudge) {
    const disposition = classifyRejudgeChildState(result.state);
    statements.push(env.DB.prepare(`UPDATE rejudge_jobs
        SET state=?, result_state=?, updated_at=?
      WHERE id=? AND new_submission_id=? AND state='dispatched'`)
      .bind(disposition, result.state, now, submission.rejudge.jobId, submission.submissionId));
  }
  const [claim, attemptClaim] = await env.DB.batch(statements);
  if (claim?.meta.changes === 1 && attemptClaim?.meta.changes === 1) return "committed";
  const state = await currentState(env, submission.submissionId);
  if (state === "cancelled") return "cancelled";
  const exact = await env.DB.prepare(`SELECT submissions.state, submissions.verdict, submissions.score,
      submissions.fully_passed_cases, submissions.deterministic_cost, submissions.peak_memory_bytes,
      submissions.policy_summary_json, submissions.effective_attempt,
      attempts.state AS attempt_state, attempts.token_hash
    FROM submissions
    JOIN submission_attempts AS attempts ON attempts.submission_id=submissions.id AND attempts.attempt=?
    WHERE submissions.id=?`)
    .bind(attempt, submission.submissionId).first<{
      readonly state: string;
      readonly verdict: string | null;
      readonly score: number | null;
      readonly fully_passed_cases: number | null;
      readonly deterministic_cost: number | null;
      readonly peak_memory_bytes: number | null;
      readonly policy_summary_json: string | null;
      readonly effective_attempt: number | null;
      readonly attempt_state: string;
      readonly token_hash: string;
    }>();
  if (finalizedSubmissionAttemptMatches(exact, {
    state: result.state,
    verdict: terminalVerdict,
    score: result.score,
    fullyPassedCases: result.fullyPassedCases,
    deterministicCost,
    peakMemoryBytes,
    policySummaryJson,
    attempt,
    tokenHash,
  })) return "replayed";
  throw new Error("Submission finalization lost its immutable result fence.");
}

export class SubmissionWorkflow extends WorkflowEntrypoint<WasmOjWorkerEnv, SubmissionWorkflowParameters> {
  async run(event: WorkflowEvent<SubmissionWorkflowParameters>, step: WorkflowStep): Promise<SubmissionWorkflowResult> {
    const submission = await hydrateSubmissionWorkflow(this.env, event.payload);
    let token = submission.attemptToken;
    let finalAttempt = submission.attempt;
    try {
      for (let attempt = submission.attempt; attempt <= submission.attempt + 1; attempt += 1) {
        finalAttempt = attempt;
        const cancelled = await step.do(`check cancellation ${attempt}`, async () => (
          await currentState(this.env, submission.submissionId) === "cancelled"
        ));
        if (cancelled) return { state: "cancelled", score: 0, fullyPassedCases: 0 };
        try {
          const result = await step.do(`run judge container attempt ${attempt}`, {
            retries: { limit: 0, delay: "1 second" },
            timeout: "30 minutes",
          }, async () => {
            const started = await this.env.DB.prepare(`UPDATE submission_attempts
                SET state='running', started_at=?, runtime_build_id=?, worker_version_id=?
              WHERE submission_id=? AND attempt=? AND state='created' AND token_hash=?
                AND EXISTS (SELECT 1 FROM submissions WHERE id=? AND state NOT IN (${TERMINAL_STATES}))`)
              .bind(
                new Date().toISOString(), submission.buildId, submission.workerVersionId,
                submission.submissionId, attempt, await sha256Hex(token), submission.submissionId,
              ).run();
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
                attemptToken: token,
                sourceId: submission.sourceId,
                sourceR2Key: submission.sourceR2Key,
                sourceSha256: submission.sourceSha256,
                judgeR2Key: submission.judgeR2Key,
                judgeDigest: submission.judgeDigest,
                expectedBuildId: submission.buildId,
                expectedWorkerVersionId: submission.workerVersionId,
              }),
            }));
            if (!response.ok) throw new Error(`Judge container failed with HTTP ${response.status}.`);
            return readContainerSubmissionResult(response);
          });
          const finalized = await step.do(`finalize submission ${attempt}`, async () => (
            finalizeContainerResult(this.env, submission, attempt, token, result)
          ));
          if (finalized === "cancelled") return { state: "cancelled", score: 0, fullyPassedCases: 0 };
          return result;
        } catch (error) {
          if (attempt >= submission.attempt + 1) {
            await step.do(`record failed attempt ${attempt}`, async () => {
              await this.env.DB.prepare(`UPDATE submission_attempts
                  SET state='failed', finished_at=?, failure_code='container-failure'
                WHERE submission_id=? AND attempt=? AND state='running'`)
                .bind(new Date().toISOString(), submission.submissionId, attempt).run();
            });
            throw error;
          }
          const nextAttempt = attempt + 1;
          token = await deriveSubmissionAttemptToken(this.env.ACCOUNT_ERASURE_HMAC_SECRET, submission.submissionId, nextAttempt);
          await step.do(`create retry attempt ${nextAttempt}`, async () => (
            createRetryAttempt(this.env, submission, attempt, nextAttempt, token)
          ));
        }
      }
      throw new Error("Submission exhausted its bounded attempt set.");
    } catch {
      const state = await step.do("finalize infrastructure failure", async () => (
        finalizeInfrastructureFailure(this.env, submission, finalAttempt)
      ));
      return { state, score: 0, fullyPassedCases: 0 };
    } finally {
      try {
        await step.do("dispatch next submission", async () => { await dispatchSubmissionJobs(this.env); });
      } catch {
        operationalLog("warn", {
          event: "workflow.delivery-deferred",
          outcome: "deferred",
          code: "submission-terminal-dispatch",
          aggregateType: "submission",
          aggregateId: submission.submissionId,
        });
      }
    }
  }
}
