import type { WasmOjWorkerEnv } from "./env";
import { ApiError } from "./http";
import { sha256Hex } from "./crypto";

export interface CatalogContestProblemPublication {
  readonly problemId: string;
  readonly contestBundleSha256: string;
  readonly judgeDigest: string;
}

export interface ContestJudgeRolloutPreparation {
  readonly statements: readonly D1PreparedStatement[];
  readonly rolloutBatchIds: readonly string[];
}

interface CurrentProblemEpochRow {
  readonly contest_id: string;
  readonly problem_id: string;
  readonly problem_epoch: number;
  readonly rules_epoch: number;
  readonly content_epoch: number;
  readonly judge_epoch: number;
  readonly content_commit: string;
  readonly judge_commit: string;
  readonly judge_digest: string;
  readonly content_digest: string;
  readonly timeline_generation: number;
  readonly rollout_batch_id: string | null;
  readonly rollout_state: string | null;
  readonly rollout_attempt: number | null;
  readonly rollout_from_commit: string | null;
}

interface RolloutIdentity {
  readonly batchId: string;
  readonly idempotencyKey: string;
  readonly requestDigest: string;
}

function uuidFromDigest(digest: string): string {
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-5${digest.slice(13, 16)}-a${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
}

async function rolloutIdentity(input: {
  readonly contestId: string;
  readonly problemId: string;
  readonly fromCommit: string;
  readonly toCommit: string;
  readonly judgeEpoch: number;
  readonly attempt: number;
}): Promise<RolloutIdentity> {
  const canonical = JSON.stringify({
    kind: "contest-judge-rollout",
    contestId: input.contestId,
    problemId: input.problemId,
    fromCommit: input.fromCommit,
    toCommit: input.toCommit,
    judgeEpoch: input.judgeEpoch,
    attempt: input.attempt,
  });
  const requestDigest = await sha256Hex(canonical);
  const identityDigest = await sha256Hex(`wasm-oj-contest-judge-rollout-v1\0${canonical}`);
  return {
    batchId: uuidFromDigest(identityDigest),
    idempotencyKey: `contest-judge-rollout-${identityDigest.slice(0, 64)}`,
    requestDigest,
  };
}

function syncFence(jobId: string): string {
  // Kept as a helper so every state-changing statement below visibly carries
  // the same catalog workflow fence.
  return `EXISTS (SELECT 1 FROM catalog_sync_jobs WHERE id='${jobId.replaceAll("'", "''")}' AND state='running')`;
}

export function prepareContestJudgeRolloutPromptAttemptSnapshot(
  env: WasmOjWorkerEnv,
  input: {
    readonly jobId: string;
    readonly batchId: string;
    readonly contestId: string;
    readonly problemId: string;
    readonly timelineGeneration: number;
    readonly targetJudgeEpoch: number;
    readonly now: string;
  },
): D1PreparedStatement {
  const fence = syncFence(input.jobId);
  return env.DB.prepare(`INSERT INTO contest_judge_rollout_prompt_attempts
      (rejudge_batch_id, prompt_attempt_id, target_judge_epoch, state, origin_submission_id,
       resolution_reason, snapshotted_at, resolved_at)
    SELECT ?, attempts.id, ?, 'included', NULL, NULL, ?, NULL
    FROM prompt_attempts AS attempts
    JOIN prompt_attempt_quota AS quota ON quota.prompt_attempt_id=attempts.id
    JOIN contest_runtimes AS runtime ON runtime.contest_id=attempts.contest_id
    WHERE attempts.contest_id=? AND attempts.problem_id=?
      AND attempts.timeline_generation=?
      AND runtime.timeline_generation=attempts.timeline_generation
      AND attempts.judge_epoch<? AND attempts.eligibility='eligible'
      AND attempts.erased_at IS NULL AND attempts.submission_id IS NULL
      AND attempts.state IN ('reserved','generating','source-ready')
      AND quota.state IN ('reserved','consumed')
      AND ${fence}
      AND EXISTS (SELECT 1 FROM rejudge_batches
        WHERE id=? AND purpose='contest-judge-rollout'
          AND state='queued' AND expected_count=0 AND created_at=?)
    ON CONFLICT(rejudge_batch_id, prompt_attempt_id) DO NOTHING`)
    .bind(
      input.batchId, input.targetJudgeEpoch, input.now, input.contestId, input.problemId,
      input.timelineGeneration, input.targetJudgeEpoch, input.batchId, input.now,
    );
}

function prepareAutomaticBatchStatements(
  env: WasmOjWorkerEnv,
  input: {
    readonly jobId: string;
    readonly requestedBy: string;
    readonly contestId: string;
    readonly problemId: string;
    readonly fromCommit: string;
    readonly toCommit: string;
    readonly targetJudgeEpoch: number;
    readonly timelineGeneration: number;
    readonly attempt: number;
    readonly now: string;
    readonly identity: RolloutIdentity;
  },
): readonly D1PreparedStatement[] {
  const fence = syncFence(input.jobId);
  return [
    env.DB.prepare(`INSERT INTO rejudge_batches
        (id, problem_id, from_commit, to_commit, contest_id, requested_by, state,
         expected_count, idempotency_key, request_digest, failure_code,
         cancel_requested_at, created_at, updated_at, effective_at,
         purpose, rollout_attempt, snapshot_timeline_generation)
      SELECT ?, ?, ?, ?, ?, ?, 'queued', 0, ?, ?, NULL, NULL, ?, ?, NULL,
        'contest-judge-rollout', ?, ?
      WHERE ${fence}
      ON CONFLICT(requested_by, idempotency_key) DO NOTHING`)
      .bind(
        input.identity.batchId, input.problemId, input.fromCommit, input.toCommit,
        input.contestId, input.requestedBy, input.identity.idempotencyKey,
        input.identity.requestDigest, input.now, input.now, input.attempt,
        input.timelineGeneration,
      ),
    env.DB.prepare(`INSERT INTO contest_judge_rollout_origins
        (rejudge_batch_id, origin_submission_id, state, exclusion_reason,
         snapshotted_at, excluded_at)
      SELECT ?, records.submission_id, 'included', NULL, ?, NULL
      FROM contest_submission_records AS records
      JOIN submissions AS origin
        ON origin.id=records.submission_id AND origin.origin_submission_id=origin.id
      JOIN contest_runtimes AS runtime ON runtime.contest_id=records.contest_id
      WHERE records.contest_id=? AND origin.problem_id=?
        AND records.timeline_generation=?
        AND runtime.timeline_generation=records.timeline_generation
        AND records.eligibility='eligible' AND records.judge_epoch<?
        AND ${fence}
        AND EXISTS (SELECT 1 FROM rejudge_batches
          WHERE id=? AND purpose='contest-judge-rollout')
      ON CONFLICT(rejudge_batch_id, origin_submission_id) DO NOTHING`)
      .bind(
        input.identity.batchId, input.now, input.contestId, input.problemId,
        input.timelineGeneration, input.targetJudgeEpoch, input.identity.batchId,
      ),
    prepareContestJudgeRolloutPromptAttemptSnapshot(env, {
      jobId: input.jobId,
      batchId: input.identity.batchId,
      contestId: input.contestId,
      problemId: input.problemId,
      timelineGeneration: input.timelineGeneration,
      targetJudgeEpoch: input.targetJudgeEpoch,
      now: input.now,
    }),
    env.DB.prepare(`UPDATE rejudge_batches
      SET expected_count=(SELECT COUNT(*) FROM contest_judge_rollout_origins
            WHERE rejudge_batch_id=? AND state='included')
          +(SELECT COUNT(*) FROM contest_judge_rollout_prompt_attempts
            WHERE rejudge_batch_id=? AND state='included'),
          state=CASE WHEN NOT EXISTS (SELECT 1 FROM contest_judge_rollout_origins
              WHERE rejudge_batch_id=? AND state='included')
            AND NOT EXISTS (SELECT 1 FROM contest_judge_rollout_prompt_attempts
              WHERE rejudge_batch_id=? AND state='included') THEN 'effective' ELSE 'queued' END,
          effective_at=CASE WHEN NOT EXISTS (SELECT 1 FROM contest_judge_rollout_origins
              WHERE rejudge_batch_id=? AND state='included')
            AND NOT EXISTS (SELECT 1 FROM contest_judge_rollout_prompt_attempts
              WHERE rejudge_batch_id=? AND state='included') THEN ? ELSE NULL END,
          updated_at=?
      WHERE id=? AND purpose='contest-judge-rollout' AND state='queued' AND ${fence}`)
      .bind(
        input.identity.batchId, input.identity.batchId,
        input.identity.batchId, input.identity.batchId,
        input.identity.batchId, input.identity.batchId,
        input.now, input.now, input.identity.batchId,
      ),
  ];
}

/**
 * Builds the catalog transaction statements which advance live contest
 * content/judge epochs.  The caller appends these after immutable problem
 * revisions have been inserted and before the active catalog commit moves.
 */
export async function prepareCatalogContestJudgeRollouts(
  env: WasmOjWorkerEnv,
  input: {
    readonly jobId: string;
    readonly catalogId: string;
    readonly commitSha: string;
    readonly requestedBy: string;
    readonly now: string;
    readonly problems: readonly CatalogContestProblemPublication[];
  },
): Promise<ContestJudgeRolloutPreparation> {
  const current = await env.DB.prepare(`SELECT epochs.contest_id, epochs.problem_id,
      epochs.problem_epoch, epochs.rules_epoch, epochs.content_epoch, epochs.judge_epoch,
      epochs.content_commit, epochs.judge_commit, epochs.judge_digest,
      revisions.contest_bundle_sha256 AS content_digest,
      runtime.timeline_generation, epochs.rollout_batch_id,
      batches.state AS rollout_state, batches.rollout_attempt,
      batches.from_commit AS rollout_from_commit
    FROM contest_problem_epochs AS epochs
    JOIN contest_runtimes AS runtime ON runtime.contest_id=epochs.contest_id
    JOIN contest_series AS contests ON contests.id=epochs.contest_id
    JOIN problem_revisions AS revisions
      ON revisions.problem_id=epochs.problem_id AND revisions.commit_sha=epochs.content_commit
    LEFT JOIN rejudge_batches AS batches ON batches.id=epochs.rollout_batch_id
    WHERE contests.catalog_id=? AND epochs.state='effective'
      AND runtime.state IN ('scheduled','running','paused')
    ORDER BY epochs.contest_id, epochs.problem_id`)
    .bind(input.catalogId).all<CurrentProblemEpochRow>();
  const publicationByProblem = new Map(input.problems.map((problem) => [problem.problemId, problem]));
  const statements: D1PreparedStatement[] = [];
  const rolloutBatchIds: string[] = [];
  const fence = syncFence(input.jobId);

  for (const row of current.results) {
    const publication = publicationByProblem.get(row.problem_id);
    if (!publication) continue;
    const contentChanged = publication.contestBundleSha256 !== row.content_digest;
    const judgeChanged = publication.judgeDigest !== row.judge_digest;
    const rolloutUnsettled = row.rollout_batch_id !== null && row.rollout_state !== "effective";
    if (judgeChanged && rolloutUnsettled) {
      throw new ApiError(
        409,
        "contest-judge-rollout-active",
        "A newer judge package cannot replace an unsettled contest judge rollout. Retry or settle the current rollout first.",
      );
    }

    const retryFailed = !judgeChanged && row.rollout_state === "failed" && row.rollout_batch_id !== null;
    let rollout: {
      readonly identity: RolloutIdentity;
      readonly attempt: number;
      readonly fromCommit: string;
      readonly toCommit: string;
      readonly judgeEpoch: number;
    } | null = null;
    if (judgeChanged || retryFailed) {
      const attempt = retryFailed ? (row.rollout_attempt ?? 1) + 1 : 1;
      const fromCommit = retryFailed ? row.rollout_from_commit! : row.judge_commit;
      const toCommit = retryFailed ? row.judge_commit : input.commitSha;
      const judgeEpoch = retryFailed ? row.judge_epoch : row.judge_epoch + 1;
      rollout = {
        identity: await rolloutIdentity({
          contestId: row.contest_id,
          problemId: row.problem_id,
          fromCommit,
          toCommit,
          judgeEpoch,
          attempt,
        }),
        attempt,
        fromCommit,
        toCommit,
        judgeEpoch,
      };
      statements.push(...prepareAutomaticBatchStatements(env, {
        jobId: input.jobId,
        requestedBy: input.requestedBy,
        contestId: row.contest_id,
        problemId: row.problem_id,
        fromCommit,
        toCommit,
        targetJudgeEpoch: judgeEpoch,
        timelineGeneration: row.timeline_generation,
        attempt,
        now: input.now,
        identity: rollout.identity,
      }));
      rolloutBatchIds.push(rollout.identity.batchId);
    }

    if (!contentChanged && !judgeChanged) {
      if (retryFailed && rollout) {
        statements.push(env.DB.prepare(`UPDATE contest_problem_epochs
          SET rollout_batch_id=?
          WHERE contest_id=? AND problem_id=? AND problem_epoch=? AND state='effective'
            AND rollout_batch_id=? AND ${fence}
            AND EXISTS (SELECT 1 FROM rejudge_batches
              WHERE id=? AND purpose='contest-judge-rollout')`)
          .bind(
            rollout.identity.batchId, row.contest_id, row.problem_id, row.problem_epoch,
            row.rollout_batch_id, rollout.identity.batchId,
          ));
      }
      continue;
    }

    const newProblemEpoch = row.problem_epoch + 1;
    const newContentEpoch = row.content_epoch + (contentChanged ? 1 : 0);
    const newJudgeEpoch = row.judge_epoch + (judgeChanged ? 1 : 0);
    const newJudgeCommit = judgeChanged ? input.commitSha : row.judge_commit;
    const newJudgeDigest = judgeChanged ? publication.judgeDigest : row.judge_digest;
    const newRolloutBatchId = rollout?.identity.batchId ?? row.rollout_batch_id;
    statements.push(
      env.DB.prepare(`UPDATE contest_problem_epochs
        SET state='superseded'
        WHERE contest_id=? AND problem_id=? AND problem_epoch=? AND state='effective'
          AND ${fence}`)
        .bind(row.contest_id, row.problem_id, row.problem_epoch),
      env.DB.prepare(`INSERT INTO contest_problem_epochs
          (contest_id, problem_id, problem_epoch, rules_epoch, content_epoch, judge_epoch,
           content_commit, judge_commit, judge_digest, state, rollout_batch_id,
           created_at, effective_at, failure_code)
        SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, 'effective', ?, ?, ?, NULL
        WHERE ${fence}
          AND NOT EXISTS (SELECT 1 FROM contest_problem_epochs
            WHERE contest_id=? AND problem_id=? AND state='effective')
          AND (? IS NULL OR EXISTS (SELECT 1 FROM rejudge_batches WHERE id=?))`)
        .bind(
          row.contest_id, row.problem_id, newProblemEpoch, row.rules_epoch,
          newContentEpoch, newJudgeEpoch, input.commitSha, newJudgeCommit,
          newJudgeDigest, newRolloutBatchId, input.now, input.now,
          row.contest_id, row.problem_id, newRolloutBatchId, newRolloutBatchId,
        ),
      env.DB.prepare(`INSERT INTO contest_problem_prompt_contexts
          (contest_id, problem_id, content_epoch, public_context_sha256, created_at)
        SELECT ?, ?, ?, ?, ?
        WHERE ${fence}
          AND EXISTS (SELECT 1 FROM contest_problem_epochs
            WHERE contest_id=? AND problem_id=? AND problem_epoch=? AND state='effective')
        ON CONFLICT(contest_id, problem_id, content_epoch) DO NOTHING`)
        .bind(
          row.contest_id, row.problem_id, newContentEpoch,
          publication.contestBundleSha256, input.now,
          row.contest_id, row.problem_id, newProblemEpoch,
        ),
    );
  }
  return { statements, rolloutBatchIds };
}

/**
 * Removes snapshot members which can no longer become official results.  It
 * never adds members after the catalog transaction's bounded snapshot.
 */
export async function reconcileContestJudgeRolloutSnapshots(
  env: WasmOjWorkerEnv,
  now = new Date(),
): Promise<number> {
  const timestamp = now.toISOString();
  const [, promotedPromptAttempts, excludedPromptAttempts, excludedPromotedOrigins] = await env.DB.batch([
    env.DB.prepare(`INSERT INTO contest_judge_rollout_origins
        (rejudge_batch_id, origin_submission_id, state, exclusion_reason,
         snapshotted_at, excluded_at)
      SELECT membership.rejudge_batch_id, attempts.submission_id, 'included', NULL,
        membership.snapshotted_at, NULL
      FROM contest_judge_rollout_prompt_attempts AS membership
      JOIN rejudge_batches AS batch ON batch.id=membership.rejudge_batch_id
      JOIN prompt_attempts AS attempts ON attempts.id=membership.prompt_attempt_id
      JOIN contest_problem_epochs AS target_epoch
        ON target_epoch.contest_id=batch.contest_id
       AND target_epoch.problem_id=batch.problem_id
       AND target_epoch.judge_epoch=membership.target_judge_epoch
       AND target_epoch.rollout_batch_id=batch.id AND target_epoch.state='effective'
      JOIN contest_submission_records AS records
        ON records.prompt_attempt_id=attempts.id
       AND records.submission_id=attempts.submission_id
      JOIN submissions AS origin
        ON origin.id=attempts.submission_id AND origin.origin_submission_id=origin.id
      JOIN problem_revisions AS rollout_source
        ON rollout_source.problem_id=batch.problem_id
       AND rollout_source.commit_sha=batch.from_commit
      JOIN problem_revisions AS target_revision
        ON target_revision.problem_id=batch.problem_id
       AND target_revision.commit_sha=batch.to_commit
       AND target_revision.judge_digest=target_epoch.judge_digest
      WHERE membership.state='included'
        AND batch.purpose='contest-judge-rollout'
        AND batch.state IN ('queued','running','ready')
        AND attempts.state='submitted' AND attempts.eligibility='eligible'
        AND attempts.erased_at IS NULL
        AND records.contest_id=batch.contest_id
        AND records.timeline_generation=batch.snapshot_timeline_generation
        AND records.eligibility='eligible'
        AND origin.problem_id=batch.problem_id
        AND target_epoch.judge_commit=batch.to_commit
        AND origin.judge_digest=rollout_source.judge_digest
      ON CONFLICT(rejudge_batch_id, origin_submission_id) DO NOTHING`),
    env.DB.prepare(`UPDATE contest_judge_rollout_prompt_attempts AS membership
      SET state='promoted',
          origin_submission_id=(SELECT attempts.submission_id FROM prompt_attempts AS attempts
            WHERE attempts.id=membership.prompt_attempt_id),
          resolution_reason='official-submission-created', resolved_at=?
      WHERE membership.state='included'
        AND EXISTS (SELECT 1 FROM prompt_attempts AS attempts
          JOIN contest_judge_rollout_origins AS snapshot
            ON snapshot.rejudge_batch_id=membership.rejudge_batch_id
           AND snapshot.origin_submission_id=attempts.submission_id
           AND snapshot.state='included'
          WHERE attempts.id=membership.prompt_attempt_id
            AND attempts.submission_id IS NOT NULL)`)
      .bind(timestamp),
    env.DB.prepare(`UPDATE contest_judge_rollout_prompt_attempts AS membership
      SET state='excluded', origin_submission_id=NULL,
          resolution_reason=CASE
            WHEN EXISTS (SELECT 1 FROM prompt_attempts AS attempts
              WHERE attempts.id=membership.prompt_attempt_id AND attempts.erased_at IS NOT NULL)
              THEN 'attempt-erased'
            WHEN EXISTS (SELECT 1 FROM prompt_attempts AS attempts
              WHERE attempts.id=membership.prompt_attempt_id AND attempts.eligibility='invalid')
              THEN 'timeline-ineligible'
            WHEN EXISTS (SELECT 1 FROM prompt_attempt_quota AS quota
              WHERE quota.prompt_attempt_id=membership.prompt_attempt_id
                AND quota.state='released') THEN 'quota-released'
            WHEN EXISTS (SELECT 1 FROM prompt_attempt_quota AS quota
              WHERE quota.prompt_attempt_id=membership.prompt_attempt_id
                AND quota.state='invalid') THEN 'quota-invalidated'
            ELSE 'attempt-terminal-without-source' END,
          resolved_at=?
      WHERE membership.state='included'
        AND EXISTS (SELECT 1 FROM rejudge_batches AS batch
          WHERE batch.id=membership.rejudge_batch_id
            AND batch.purpose='contest-judge-rollout'
            AND batch.state IN ('queued','running','ready'))
        AND EXISTS (SELECT 1 FROM prompt_attempts AS attempts
          JOIN prompt_attempt_quota AS quota ON quota.prompt_attempt_id=attempts.id
          WHERE attempts.id=membership.prompt_attempt_id
            AND (attempts.erased_at IS NOT NULL OR attempts.eligibility='invalid'
              OR attempts.state IN ('failed','cancelled')
              OR quota.state IN ('released','invalid')))`)
      .bind(timestamp),
    env.DB.prepare(`UPDATE contest_judge_rollout_origins AS snapshot
      SET state='excluded', excluded_at=?, exclusion_reason=CASE
        WHEN EXISTS (SELECT 1 FROM contest_judge_rollout_prompt_attempts AS membership
          JOIN prompt_attempts AS attempts ON attempts.id=membership.prompt_attempt_id
          WHERE membership.rejudge_batch_id=snapshot.rejudge_batch_id
            AND membership.origin_submission_id=snapshot.origin_submission_id
            AND attempts.erased_at IS NOT NULL) THEN 'attempt-erased'
        WHEN EXISTS (SELECT 1 FROM contest_judge_rollout_prompt_attempts AS membership
          JOIN prompt_attempts AS attempts ON attempts.id=membership.prompt_attempt_id
          WHERE membership.rejudge_batch_id=snapshot.rejudge_batch_id
            AND membership.origin_submission_id=snapshot.origin_submission_id
            AND attempts.eligibility='invalid') THEN 'timeline-ineligible'
        WHEN EXISTS (SELECT 1 FROM contest_judge_rollout_prompt_attempts AS membership
          JOIN prompt_attempt_quota AS quota ON quota.prompt_attempt_id=membership.prompt_attempt_id
          WHERE membership.rejudge_batch_id=snapshot.rejudge_batch_id
            AND membership.origin_submission_id=snapshot.origin_submission_id
            AND quota.state='released') THEN 'quota-released'
        WHEN EXISTS (SELECT 1 FROM contest_judge_rollout_prompt_attempts AS membership
          JOIN prompt_attempt_quota AS quota ON quota.prompt_attempt_id=membership.prompt_attempt_id
          WHERE membership.rejudge_batch_id=snapshot.rejudge_batch_id
            AND membership.origin_submission_id=snapshot.origin_submission_id
            AND quota.state='invalid') THEN 'quota-invalidated'
        ELSE 'attempt-terminal-without-source' END
      WHERE snapshot.state='included'
        AND EXISTS (SELECT 1 FROM rejudge_batches AS batch
          WHERE batch.id=snapshot.rejudge_batch_id
            AND batch.purpose='contest-judge-rollout'
            AND batch.state IN ('queued','running','ready'))
        AND EXISTS (SELECT 1 FROM contest_judge_rollout_prompt_attempts AS membership
          JOIN prompt_attempts AS attempts ON attempts.id=membership.prompt_attempt_id
          JOIN prompt_attempt_quota AS quota ON quota.prompt_attempt_id=attempts.id
          WHERE membership.rejudge_batch_id=snapshot.rejudge_batch_id
            AND membership.origin_submission_id=snapshot.origin_submission_id
            AND membership.state='promoted'
            AND (attempts.erased_at IS NOT NULL OR attempts.eligibility='invalid'
              OR attempts.state IN ('failed','cancelled')
              OR quota.state IN ('released','invalid')))`)
      .bind(timestamp),
  ]);
  const updated = await env.DB.prepare(`UPDATE contest_judge_rollout_origins AS snapshot
    SET state='excluded', excluded_at=?, exclusion_reason=CASE
      WHEN NOT EXISTS (SELECT 1 FROM contest_submission_records AS records
        JOIN rejudge_batches AS batch ON batch.id=snapshot.rejudge_batch_id
        WHERE records.submission_id=snapshot.origin_submission_id
          AND records.contest_id=batch.contest_id
          AND records.timeline_generation=batch.snapshot_timeline_generation
          AND records.eligibility='eligible') THEN 'timeline-ineligible'
      WHEN EXISTS (SELECT 1 FROM submissions AS origin
        WHERE origin.id=snapshot.origin_submission_id AND origin.state='cancelled') THEN 'submission-cancelled'
      ELSE 'source-unavailable' END
    WHERE snapshot.state='included'
      AND EXISTS (SELECT 1 FROM rejudge_batches AS batch
        WHERE batch.id=snapshot.rejudge_batch_id
          AND batch.purpose='contest-judge-rollout' AND batch.state IN ('queued','running','ready'))
      AND NOT EXISTS (SELECT 1 FROM rejudge_jobs AS jobs
        WHERE jobs.rejudge_batch_id=snapshot.rejudge_batch_id
          AND jobs.origin_submission_id=snapshot.origin_submission_id)
      AND (
        NOT EXISTS (SELECT 1 FROM contest_submission_records AS records
          JOIN rejudge_batches AS batch ON batch.id=snapshot.rejudge_batch_id
          WHERE records.submission_id=snapshot.origin_submission_id
            AND records.contest_id=batch.contest_id
            AND records.timeline_generation=batch.snapshot_timeline_generation
            AND records.eligibility='eligible')
        OR EXISTS (SELECT 1 FROM submissions AS origin
          WHERE origin.id=snapshot.origin_submission_id AND origin.state='cancelled')
        OR NOT EXISTS (SELECT 1 FROM submissions AS origin
          JOIN submission_sources AS source ON source.id=origin.source_id
          JOIN users ON users.id=origin.user_id
          WHERE origin.id=snapshot.origin_submission_id
            AND source.state IN ('reserved','ready')
            AND source.owner_user_id=origin.user_id
            AND source.admission_erasure_epoch=users.erasure_epoch
            AND users.status='active'
            AND NOT EXISTS (SELECT 1 FROM account_erasure_jobs WHERE user_id=origin.user_id))
      )`)
    .bind(timestamp).run();
  await env.DB.prepare(`UPDATE rejudge_batches
    SET expected_count=(SELECT COUNT(*) FROM contest_judge_rollout_origins
          WHERE rejudge_batch_id=rejudge_batches.id AND state='included')
        +(SELECT COUNT(*) FROM contest_judge_rollout_prompt_attempts
          WHERE rejudge_batch_id=rejudge_batches.id AND state='included'),
        updated_at=?
    WHERE purpose='contest-judge-rollout' AND state IN ('queued','running','ready')
      AND expected_count<>(
        (SELECT COUNT(*) FROM contest_judge_rollout_origins
          WHERE rejudge_batch_id=rejudge_batches.id AND state='included')
        +(SELECT COUNT(*) FROM contest_judge_rollout_prompt_attempts
          WHERE rejudge_batch_id=rejudge_batches.id AND state='included'))`)
    .bind(timestamp).run();
  return promotedPromptAttempts.meta.changes + excludedPromptAttempts.meta.changes
    + excludedPromotedOrigins.meta.changes + updated.meta.changes;
}
