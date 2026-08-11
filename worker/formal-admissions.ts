import type { ForgeWorkerEnv } from "./env";
import { sha256Hex } from "./crypto";
import { operationalLog } from "./structured-log";

const ABORTED_CLEANUP_GRACE_MS = 2 * 60 * 1_000;

interface FormalAdmissionMarker {
  readonly submission_id: string;
  readonly managed_problem_version_id: string;
  readonly user_id: string;
  readonly contest_id: string | null;
  readonly admitted_at: string;
  readonly state: "pending" | "committed" | "aborted";
  readonly source_r2_key: string | null;
  readonly source_sha256: string | null;
  readonly cleanup_state: "pending" | "retained" | "complete";
  readonly expires_at: string;
  readonly updated_at: string;
}

interface SubmissionIdentity {
  readonly managed_problem_version_id: string;
  readonly user_id: string;
  readonly contest_id: string | null;
  readonly source_r2_key: string;
  readonly source_digest: string;
  readonly formal_admitted_at: string | null;
  readonly formal_admission_claim_sha256: string | null;
}

const FORMAL_ADMISSION_COLUMNS = `submission_id, managed_problem_version_id, user_id, contest_id, admitted_at,
  state, source_r2_key, source_sha256, cleanup_state, expires_at, updated_at`;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;

export interface FormalSubmissionAdmissionClaim {
  readonly submissionId: string;
  readonly managedProblemVersionId: string;
  readonly userId: string;
  readonly contestId: string | null;
  readonly admittedAt: string;
  readonly sourceR2Key: string;
  readonly sourceSha256: string;
}

export async function formalSubmissionAdmissionClaimSha256(
  claim: FormalSubmissionAdmissionClaim,
): Promise<string> {
  const requiredStrings: readonly unknown[] = [
    claim.submissionId,
    claim.managedProblemVersionId,
    claim.userId,
    claim.admittedAt,
    claim.sourceR2Key,
    claim.sourceSha256,
  ];
  if (
    requiredStrings.some((value) => typeof value !== "string")
    || (claim.contestId !== null && typeof claim.contestId !== "string")
  ) throw new TypeError("Formal submission admission claim is invalid.");
  const strings = [
    claim.submissionId,
    claim.managedProblemVersionId,
    claim.userId,
    claim.contestId ?? "",
    claim.admittedAt,
    claim.sourceR2Key,
    claim.sourceSha256,
  ];
  let canonicalAdmittedAt = false;
  try {
    canonicalAdmittedAt = new Date(claim.admittedAt).toISOString() === claim.admittedAt;
  } catch {
    canonicalAdmittedAt = false;
  }
  if (
    [claim.submissionId, claim.managedProblemVersionId, claim.userId, claim.admittedAt, claim.sourceR2Key]
      .some((value) => value.length < 1 || value.includes("\0"))
    || (claim.contestId !== null && (claim.contestId.length < 1 || claim.contestId.includes("\0")))
    || !SHA256_PATTERN.test(claim.sourceSha256)
    || !canonicalAdmittedAt
  ) throw new TypeError("Formal submission admission claim is invalid.");
  return sha256Hex(`forge-formal-admission-v1\0${strings.join("\0")}\n`);
}

export async function commitFormalSubmissionAdmission(
  env: ForgeWorkerEnv,
  input: {
    readonly submissionId: string;
    readonly managedProblemVersionId: string;
    readonly userId: string;
  },
): Promise<boolean> {
  const existing = await admissionMarker(env, input.submissionId);
  if (
    existing.managed_problem_version_id !== input.managedProblemVersionId
    || existing.user_id !== input.userId
    || !(await matchingSubmission(env, existing))
  ) throw new Error("Formal submission admission has no matching durable submission.");
  const committed = await env.CORE_DB.prepare(
    "UPDATE formal_submission_admissions SET state='committed', cleanup_state='retained', updated_at=? WHERE submission_id=? AND managed_problem_version_id=? AND user_id=? AND state='pending' AND cleanup_state='pending'",
  ).bind(new Date().toISOString(), input.submissionId, input.managedProblemVersionId, input.userId).run();
  if (committed.meta.changes === 1) return true;

  const marker = await admissionMarker(env, input.submissionId);
  if (
    marker?.state === "committed"
    && marker.cleanup_state === "retained"
    && marker.managed_problem_version_id === input.managedProblemVersionId
    && marker.user_id === input.userId
  ) return false;
  throw new Error("Formal submission admission lost its cross-database commit fence.");
}

async function matchingSubmission(env: ForgeWorkerEnv, marker: FormalAdmissionMarker): Promise<SubmissionIdentity | null> {
  const submission = await env.SUBMISSIONS_DB.prepare(
    `SELECT user_id, managed_problem_version_id, contest_id, source_r2_key, source_digest,
            formal_admitted_at, formal_admission_claim_sha256
       FROM submissions WHERE id=? AND rejudge_batch_id IS NULL`,
  ).bind(marker.submission_id).first<SubmissionIdentity>();
  if (submission) {
    const expectedClaim = await formalSubmissionAdmissionClaimSha256({
      submissionId: marker.submission_id,
      managedProblemVersionId: marker.managed_problem_version_id,
      userId: marker.user_id,
      contestId: marker.contest_id,
      admittedAt: marker.admitted_at,
      sourceR2Key: marker.source_r2_key ?? "",
      sourceSha256: marker.source_sha256 ?? "",
    });
    if (
      submission.user_id !== marker.user_id
      || submission.managed_problem_version_id !== marker.managed_problem_version_id
      || submission.contest_id !== marker.contest_id
      || submission.source_r2_key !== marker.source_r2_key
      || submission.source_digest !== marker.source_sha256
      || submission.formal_admitted_at !== marker.admitted_at
      || submission.formal_admission_claim_sha256 !== expectedClaim
    ) throw new Error("Formal submission admission has a cross-database identity mismatch.");
  }
  return submission;
}

async function admissionMarker(env: ForgeWorkerEnv, submissionId: string): Promise<FormalAdmissionMarker> {
  const marker = await env.CORE_DB.prepare(
    `SELECT ${FORMAL_ADMISSION_COLUMNS} FROM formal_submission_admissions WHERE submission_id=?`,
  ).bind(submissionId).first<FormalAdmissionMarker>();
  if (!marker) throw new Error("Formal submission admission cleanup marker is missing.");
  return marker;
}

export async function formalSubmissionWorkflowFence(
  env: ForgeWorkerEnv,
  submissionId: string,
): Promise<"start" | "wait" | "reject"> {
  const marker = await env.CORE_DB.prepare(
    `SELECT ${FORMAL_ADMISSION_COLUMNS} FROM formal_submission_admissions WHERE submission_id=?`,
  ).bind(submissionId).first<FormalAdmissionMarker>();
  if (!marker || marker.state === "aborted") return "reject";
  try {
    if (!await matchingSubmission(env, marker)) return "reject";
  } catch {
    return "reject";
  }
  return marker.state === "committed" ? "start" : "wait";
}

export async function cleanupAbortedFormalSubmissionAdmission(
  env: ForgeWorkerEnv,
  submissionId: string,
): Promise<"cleaned" | "already-clean" | "committed"> {
  const marker = await admissionMarker(env, submissionId);
  if (marker.state === "committed" && marker.cleanup_state === "retained") return "committed";
  if (marker.state !== "aborted") throw new Error("Only an aborted formal admission may be cleaned.");
  if (marker.cleanup_state === "complete") return "already-clean";
  if (marker.cleanup_state !== "pending" || !marker.source_r2_key || !marker.source_sha256) {
    throw new Error("Aborted formal admission cleanup claim is invalid.");
  }
  const cleanup = await Promise.allSettled([
    env.JUDGE_BUCKET.delete(marker.source_r2_key),
    env.JUDGE_MIRROR_BUCKET.delete(marker.source_r2_key),
  ]);
  const failures = cleanup.filter((result): result is PromiseRejectedResult => result.status === "rejected");
  if (failures.length > 0) throw new AggregateError(
    failures.map((failure) => failure.reason),
    "Formal submission admission cleanup was only partially applied.",
  );
  const [primary, mirror] = await Promise.all([
    env.JUDGE_BUCKET.head(marker.source_r2_key),
    env.JUDGE_MIRROR_BUCKET.head(marker.source_r2_key),
  ]);
  if (primary || mirror) throw new Error("Aborted formal submission source deletion postcondition failed.");
  const completed = await env.CORE_DB.prepare(
    "UPDATE formal_submission_admissions SET cleanup_state='complete', source_r2_key=NULL, source_sha256=NULL, updated_at=? WHERE submission_id=? AND state='aborted' AND cleanup_state='pending'",
  ).bind(new Date().toISOString(), marker.submission_id).run();
  if (completed.meta.changes === 1) return "cleaned";
  const current = await admissionMarker(env, marker.submission_id);
  if (current.state === "aborted" && current.cleanup_state === "complete") return "already-clean";
  if (current.state === "committed" && current.cleanup_state === "retained") return "committed";
  throw new Error("Formal submission admission cleanup lost its durable fence.");
}

export async function abortFormalSubmissionAdmission(
  env: ForgeWorkerEnv,
  input: { readonly submissionId: string; readonly managedProblemVersionId: string; readonly userId: string },
): Promise<"cleaned" | "already-clean"> {
  const marker = await admissionMarker(env, input.submissionId);
  if (
    marker.managed_problem_version_id !== input.managedProblemVersionId
    || marker.user_id !== input.userId
  ) throw new Error("Formal submission admission abort identity is invalid.");
  if (await matchingSubmission(env, marker)) throw new Error("A committed formal submission cannot be aborted.");
  if (marker.state === "committed") throw new Error("A committed formal submission cannot be aborted.");
  if (marker.state === "pending") {
    const aborted = await env.CORE_DB.prepare(
      "UPDATE formal_submission_admissions SET state='aborted', updated_at=? WHERE submission_id=? AND managed_problem_version_id=? AND user_id=? AND state='pending' AND cleanup_state='pending'",
    ).bind(new Date().toISOString(), marker.submission_id, marker.managed_problem_version_id, marker.user_id).run();
    if (aborted.meta.changes !== 1) {
      const current = await admissionMarker(env, marker.submission_id);
      if (current.state !== "aborted" || current.cleanup_state === "retained") throw new Error("Formal submission admission abort lost its durable fence.");
    }
  }
  const cleanup = await cleanupAbortedFormalSubmissionAdmission(env, marker.submission_id);
  if (cleanup === "committed") throw new Error("A formal submission committed while its abort was being reconciled.");
  return cleanup;
}

export async function reconcileConcurrentFormalSubmissionWinner(
  env: ForgeWorkerEnv,
  input: {
    readonly winner: { readonly submissionId: string; readonly managedProblemVersionId: string; readonly userId: string };
    readonly loser: { readonly submissionId: string; readonly managedProblemVersionId: string; readonly userId: string };
  },
): Promise<void> {
  if (input.winner.submissionId === input.loser.submissionId || input.winner.userId !== input.loser.userId) {
    throw new Error("Concurrent formal submission identities are invalid.");
  }
  await commitFormalSubmissionAdmission(env, input.winner);
  await abortFormalSubmissionAdmission(env, input.loser);
}

export async function cleanupFormalSubmissionAdmissionsForUser(
  env: ForgeWorkerEnv,
  userId: string,
): Promise<void> {
  const claims = await env.CORE_DB.prepare(
    `SELECT ${FORMAL_ADMISSION_COLUMNS} FROM formal_submission_admissions WHERE user_id=? AND cleanup_state='pending' ORDER BY created_at, submission_id`,
  ).bind(userId).all<FormalAdmissionMarker>();
  for (const marker of claims.results) {
    if (marker.state === "pending" && await matchingSubmission(env, marker)) {
      await commitFormalSubmissionAdmission(env, {
        submissionId: marker.submission_id,
        managedProblemVersionId: marker.managed_problem_version_id,
        userId: marker.user_id,
      });
      continue;
    }
    if (marker.state === "pending") {
      const aborted = await env.CORE_DB.prepare(
        "UPDATE formal_submission_admissions SET state='aborted', updated_at=? WHERE submission_id=? AND user_id=? AND state='pending' AND cleanup_state='pending'",
      ).bind(new Date().toISOString(), marker.submission_id, marker.user_id).run();
      if (aborted.meta.changes !== 1) throw new Error("Account erasure lost a formal admission cleanup fence.");
    }
    await cleanupAbortedFormalSubmissionAdmission(env, marker.submission_id);
  }
  const remaining = await env.CORE_DB.prepare(
    "SELECT 1 AS pending FROM formal_submission_admissions WHERE user_id=? AND cleanup_state='pending' LIMIT 1",
  ).bind(userId).first<{ readonly pending: number }>();
  if (remaining) throw new Error("Account erasure did not drain formal admission cleanup claims.");
}

/**
 * Repair the CORE_DB side of the cross-D1 admission saga. A committed
 * SUBMISSIONS_DB row wins while a marker is pending. A marker with no matching
 * row is aborted only after its claim expires, so an in-flight submission
 * transaction cannot be guessed away.
 */
export async function reconcileFormalSubmissionAdmissions(
  env: ForgeWorkerEnv,
  options: { readonly managedProblemVersionId?: string; readonly limit?: number } = {},
): Promise<{ readonly committed: number; readonly aborted: number; readonly pending: number }> {
  const limit = options.limit ?? 100;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) throw new TypeError("Formal admission reconciliation limit is invalid.");
  const where = options.managedProblemVersionId === undefined
    ? "(state='pending' OR (state='aborted' AND cleanup_state='pending'))"
    : "(state='pending' OR (state='aborted' AND cleanup_state='pending')) AND managed_problem_version_id=?";
  const statement = env.CORE_DB.prepare(
    `SELECT ${FORMAL_ADMISSION_COLUMNS}
       FROM formal_submission_admissions
      WHERE ${where}
      ORDER BY created_at, submission_id
      LIMIT ?`,
  );
  const pending = options.managedProblemVersionId === undefined
    ? await statement.bind(limit).all<FormalAdmissionMarker>()
    : await statement.bind(options.managedProblemVersionId, limit).all<FormalAdmissionMarker>();
  const nowDate = new Date();
  const now = nowDate.toISOString();
  const cleanupCutoff = new Date(nowDate.getTime() - ABORTED_CLEANUP_GRACE_MS).toISOString();
  let committed = 0;
  let aborted = 0;
  for (const marker of pending.results) {
    let submission: SubmissionIdentity | null;
    try {
      submission = await matchingSubmission(env, marker);
    } catch {
      operationalLog("error", {
        event: "reconciler.delivery-failed",
        outcome: "failure",
        code: "formal-admission-identity-mismatch",
        aggregateType: "submission",
        aggregateId: marker.submission_id,
      });
      continue;
    }
    if (submission && marker.state === "pending") {
      try {
        if (await commitFormalSubmissionAdmission(env, {
          submissionId: marker.submission_id,
          managedProblemVersionId: marker.managed_problem_version_id,
          userId: marker.user_id,
        })) committed += 1;
      } catch {
        operationalLog("error", {
          event: "reconciler.delivery-failed",
          outcome: "failure",
          code: "formal-admission-commit",
          aggregateType: "submission",
          aggregateId: marker.submission_id,
        });
      }
      continue;
    }
    if (marker.state === "pending" && marker.expires_at <= now) {
      const updated = await env.CORE_DB.prepare(
        "UPDATE formal_submission_admissions SET state='aborted', updated_at=? WHERE submission_id=? AND state='pending' AND cleanup_state='pending' AND expires_at<=?",
      ).bind(now, marker.submission_id, now).run();
      aborted += updated.meta.changes;
      continue;
    }
    if (marker.state === "aborted" && marker.updated_at <= cleanupCutoff) {
      try {
        await cleanupAbortedFormalSubmissionAdmission(env, marker.submission_id);
      } catch {
        operationalLog("warn", {
          event: "reconciler.delivery-failed",
          outcome: "deferred",
          code: "formal-admission-cleanup",
          aggregateType: "submission",
          aggregateId: marker.submission_id,
        });
      }
    }
  }
  const remainingStatement = env.CORE_DB.prepare(
    `SELECT COUNT(*) AS count FROM formal_submission_admissions WHERE state='pending'${options.managedProblemVersionId === undefined ? "" : " AND managed_problem_version_id=?"}`,
  );
  const remaining = options.managedProblemVersionId === undefined
    ? await remainingStatement.first<{ readonly count: number }>()
    : await remainingStatement.bind(options.managedProblemVersionId).first<{ readonly count: number }>();
  return { committed, aborted, pending: remaining?.count ?? 0 };
}
