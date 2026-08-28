import type { WasmOjWorkerEnv } from "./env";
import { PromptAttemptService, reconcileReadyPromptAttemptProducts } from "./prompt-attempts";
import { hostPromptCompilerRegistry } from "./prompt-compiler-registry";
import { createPromptAttemptHost } from "./submissions";
import { lookupWorkflowInstance } from "./workflow-instance-status";

const PROMPT_DISPATCH_MAX_ATTEMPTS = 5;
const PROMPT_DISPATCH_MAX_AGE_MS = 5 * 60 * 1_000;
const PROMPT_EXECUTION_MAX_AGE_MS = 75 * 60 * 1_000;
const TERMINAL_WORKFLOW_STATES = new Set(["complete", "errored", "terminated"]);

interface PendingPromptDispatchRow {
  readonly prompt_attempt_id: string;
  readonly attempts: number;
  readonly created_at: string;
  readonly attempt_state: string;
}

interface StalePromptExecutionRow {
  readonly prompt_attempt_id: string;
}

function promptAttemptService(env: WasmOjWorkerEnv, now: Date): PromptAttemptService {
  return new PromptAttemptService({
    database: env.DB,
    registry: hostPromptCompilerRegistry(),
    host: createPromptAttemptHost(env),
    now: () => now,
  });
}

/** Recover the reservation→Workflow dispatch gap with a deterministic ID. */
export async function reconcilePromptAttemptDispatches(
  env: WasmOjWorkerEnv,
  now = new Date(),
): Promise<number> {
  const rows = await env.DB.prepare(`SELECT dispatch.prompt_attempt_id,
      dispatch.attempts, dispatch.created_at, attempts.state AS attempt_state
    FROM prompt_attempt_dispatches AS dispatch
    JOIN prompt_attempts AS attempts ON attempts.id=dispatch.prompt_attempt_id
    WHERE dispatch.state='pending'
    ORDER BY dispatch.created_at, dispatch.prompt_attempt_id LIMIT 25`)
    .all<PendingPromptDispatchRow>();
  let handled = 0;
  for (const row of rows.results) {
    const service = promptAttemptService(env, now);
    try {
      if (row.attempt_state !== "reserved") {
        await service.markWorkflowDispatched(row.prompt_attempt_id);
        handled += 1;
        continue;
      }
      const initial = await lookupWorkflowInstance(env.PROMPT_ATTEMPT_WORKFLOW, row.prompt_attempt_id);
      if (initial.found) {
        await service.markWorkflowDispatched(row.prompt_attempt_id);
        if (TERMINAL_WORKFLOW_STATES.has(initial.status)) {
          await service.failWorkflowExecution(row.prompt_attempt_id);
        }
        handled += 1;
        continue;
      }
      try {
        await env.PROMPT_ATTEMPT_WORKFLOW.create({
          id: row.prompt_attempt_id,
          params: { attemptId: row.prompt_attempt_id },
        });
      } catch (error) {
        const recovered = await lookupWorkflowInstance(env.PROMPT_ATTEMPT_WORKFLOW, row.prompt_attempt_id);
        if (recovered.found) {
          await service.markWorkflowDispatched(row.prompt_attempt_id);
          if (TERMINAL_WORKFLOW_STATES.has(recovered.status)) {
            await service.failWorkflowExecution(row.prompt_attempt_id);
          }
        } else {
          const createdAt = Date.parse(row.created_at);
          const exhausted = row.attempts >= PROMPT_DISPATCH_MAX_ATTEMPTS
            && Number.isFinite(createdAt)
            && createdAt <= now.getTime() - PROMPT_DISPATCH_MAX_AGE_MS;
          if (exhausted) await service.failWorkflowDispatch(row.prompt_attempt_id);
          else await recordDispatchFailure(env, row, now, error, "workflow-create-failed");
        }
        handled += 1;
        continue;
      }
      try {
        await service.markWorkflowDispatched(row.prompt_attempt_id);
      } catch (error) {
        await recordDispatchFailure(env, row, now, error, "workflow-delivery-mark-failed");
      }
      handled += 1;
    } catch (error) {
      await recordDispatchFailure(env, row, now, error, "workflow-status-failed");
    }
  }
  const stale = await env.DB.prepare(`SELECT attempts.id AS prompt_attempt_id
    FROM prompt_attempts AS attempts
    JOIN prompt_attempt_dispatches AS dispatch
      ON dispatch.prompt_attempt_id=attempts.id AND dispatch.state='delivered'
    WHERE attempts.state IN ('reserved','generating') AND attempts.updated_at<=?
    ORDER BY attempts.updated_at, attempts.id LIMIT 25`)
    .bind(new Date(now.getTime() - PROMPT_EXECUTION_MAX_AGE_MS).toISOString())
    .all<StalePromptExecutionRow>();
  for (const row of stale.results) {
    try {
      const workflow = await lookupWorkflowInstance(env.PROMPT_ATTEMPT_WORKFLOW, row.prompt_attempt_id);
      if (workflow.found && !TERMINAL_WORKFLOW_STATES.has(workflow.status)) continue;
      await promptAttemptService(env, now).failWorkflowExecution(row.prompt_attempt_id);
      handled += 1;
    } catch {
      // Status uncertainty is not evidence that provider work is terminal.
    }
  }
  handled += await reconcileReadyPromptAttemptProducts(env.DB, now);
  return handled;
}

async function recordDispatchFailure(
  env: WasmOjWorkerEnv,
  row: PendingPromptDispatchRow,
  now: Date,
  error: unknown,
  fallback: string,
): Promise<void> {
  await env.DB.prepare(`UPDATE prompt_attempt_dispatches
    SET attempts=attempts+1, last_error=?, updated_at=?
    WHERE prompt_attempt_id=? AND state='pending' AND attempts=?`)
    .bind(
      error instanceof Error ? error.name.slice(0, 100) : fallback,
      now.toISOString(),
      row.prompt_attempt_id,
      row.attempts,
    ).run();
}
