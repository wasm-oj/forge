import capacity from "../config/capacity.json";
import type { WasmOjWorkerEnv } from "./env";
import type { CatalogWorkflowParameters } from "./catalog-workflow-identity";
import { operationalLog } from "./structured-log";

interface CatalogCandidate {
  readonly kind: "validation" | "publish";
  readonly id: string;
  readonly organizer_user_id: string;
  readonly created_at: string;
}

async function oldestEligibleCatalogJob(env: WasmOjWorkerEnv): Promise<CatalogCandidate | null> {
  return env.DB.prepare(`SELECT kind, id, organizer_user_id, created_at FROM (
      SELECT 'validation' AS kind, jobs.id, collections.organizer_user_id, jobs.created_at
        FROM catalog_validation_jobs AS jobs
        JOIN problem_collections AS collections ON collections.id=jobs.collection_id
        JOIN workflow_outbox AS outbox ON outbox.catalog_validation_job_id=jobs.id
          AND outbox.state='pending'
       WHERE jobs.state='queued'
      UNION ALL
      SELECT 'publish' AS kind, jobs.id, collections.organizer_user_id, jobs.created_at
        FROM catalog_publish_jobs AS jobs
        JOIN collection_revisions AS revisions ON revisions.id=jobs.collection_revision_id
        JOIN problem_collections AS collections ON collections.id=revisions.collection_id
        JOIN workflow_outbox AS outbox ON outbox.catalog_publish_job_id=jobs.id
          AND outbox.state='pending'
       WHERE jobs.state='queued'
    ) AS candidates
    WHERE (
      SELECT COUNT(*) FROM catalog_validation_jobs WHERE state='running'
    ) + (
      SELECT COUNT(*) FROM catalog_publish_jobs WHERE state='materializing'
    ) < ?
      AND (
        SELECT COUNT(*) FROM catalog_validation_jobs AS active_validation
        JOIN problem_collections AS active_collection ON active_collection.id=active_validation.collection_id
        WHERE active_validation.state='running' AND active_collection.organizer_user_id=candidates.organizer_user_id
      ) + (
        SELECT COUNT(*) FROM catalog_publish_jobs AS active_publish
        JOIN collection_revisions AS active_revision ON active_revision.id=active_publish.collection_revision_id
        JOIN problem_collections AS active_collection ON active_collection.id=active_revision.collection_id
        WHERE active_publish.state='materializing' AND active_collection.organizer_user_id=candidates.organizer_user_id
      ) < ?
    ORDER BY created_at ASC, id ASC LIMIT 1`)
    .bind(capacity.catalog.globalActive, capacity.catalog.perOrganizerActive).first<CatalogCandidate>();
}

async function claimCandidate(env: WasmOjWorkerEnv, candidate: CatalogCandidate, now: string): Promise<boolean> {
  const globalFence = `(SELECT COUNT(*) FROM catalog_validation_jobs WHERE state='running')
    + (SELECT COUNT(*) FROM catalog_publish_jobs WHERE state='materializing') < ${capacity.catalog.globalActive}`;
  const organizerFence = `(SELECT COUNT(*) FROM catalog_validation_jobs AS active_validation
      JOIN problem_collections AS active_collection ON active_collection.id=active_validation.collection_id
      WHERE active_validation.state='running' AND active_collection.organizer_user_id=?)
    + (SELECT COUNT(*) FROM catalog_publish_jobs AS active_publish
      JOIN collection_revisions AS active_revision ON active_revision.id=active_publish.collection_revision_id
      JOIN problem_collections AS active_collection ON active_collection.id=active_revision.collection_id
      WHERE active_publish.state='materializing' AND active_collection.organizer_user_id=?)
    < ${capacity.catalog.perOrganizerActive}`;
  const result = candidate.kind === "validation"
    ? await env.DB.prepare(`UPDATE catalog_validation_jobs SET state='running', started_at=?, updated_at=?
        WHERE id=? AND state='queued' AND ${globalFence} AND ${organizerFence}`)
      .bind(now, now, candidate.id, candidate.organizer_user_id, candidate.organizer_user_id).run()
    : await env.DB.prepare(`UPDATE catalog_publish_jobs SET state='materializing', started_at=?, updated_at=?
        WHERE id=? AND state='queued' AND ${globalFence} AND ${organizerFence}`)
      .bind(now, now, candidate.id, candidate.organizer_user_id, candidate.organizer_user_id).run();
  return result.meta.changes === 1;
}

async function deliverCatalogWorkflow(env: WasmOjWorkerEnv, parameters: CatalogWorkflowParameters): Promise<void> {
  const workflowId = `catalog-${parameters.kind}-${parameters.jobId}`;
  const timestamp = new Date().toISOString();
  const target = parameters.kind === "validation" ? "catalog_validation_job_id" : "catalog_publish_job_id";
  const markDelivered = async (incrementAttempts: boolean): Promise<void> => {
    await env.DB.prepare(`UPDATE workflow_outbox SET state='delivered', settled_at=?, attempts=attempts+?,
        last_error=NULL, updated_at=? WHERE ${target}=? AND state='pending'`)
      .bind(timestamp, incrementAttempts ? 1 : 0, timestamp, parameters.jobId).run();
  };
  const recordDeferred = async (message: string, incrementAttempts: boolean): Promise<void> => {
    await env.DB.prepare(`UPDATE workflow_outbox
        SET attempts=attempts+?, last_error=?, updated_at=?
      WHERE ${target}=? AND state='pending'`)
      .bind(incrementAttempts ? 1 : 0, message.slice(0, 500), timestamp, parameters.jobId).run();
    operationalLog("warn", {
      event: "workflow.delivery-deferred",
      outcome: "deferred",
      code: `start-catalog-${parameters.kind}`,
      aggregateType: "catalog",
      aggregateId: parameters.jobId,
    });
  };

  let status: { readonly status: string };
  try {
    status = await (await env.CATALOG_WORKFLOW.get(workflowId)).status();
  } catch (error) {
    await recordDeferred(error instanceof Error ? error.message : "workflow-status-failed", false);
    return;
  }
  if (status.status !== "unknown") {
    await markDelivered(false);
    return;
  }

  try {
    await env.CATALOG_WORKFLOW.create({ id: workflowId, params: parameters });
    await markDelivered(true);
  } catch (createError) {
    try {
      const observed = await (await env.CATALOG_WORKFLOW.get(workflowId)).status();
      if (observed.status !== "unknown") {
        await markDelivered(true);
        return;
      }
    } catch (statusError) {
      await recordDeferred(statusError instanceof Error ? statusError.message : "workflow-status-failed", false);
      return;
    }
    await recordDeferred(createError instanceof Error ? createError.message : "workflow-create-failed", true);
  }
}

export async function dispatchCatalogJobs(env: WasmOjWorkerEnv, maximum = capacity.catalog.globalActive): Promise<number> {
  let claimed = 0;
  for (let iteration = 0; iteration < maximum; iteration += 1) {
    const candidate = await oldestEligibleCatalogJob(env);
    if (!candidate) break;
    const now = new Date().toISOString();
    if (!await claimCandidate(env, candidate, now)) continue;
    claimed += 1;
    await deliverCatalogWorkflow(env, { kind: candidate.kind, jobId: candidate.id });
  }
  return claimed;
}

export async function redeliverClaimedCatalogJob(
  env: WasmOjWorkerEnv,
  parameters: CatalogWorkflowParameters,
): Promise<boolean> {
  const target = parameters.kind === "validation" ? "catalog_validation_job_id" : "catalog_publish_job_id";
  const state = parameters.kind === "validation" ? "running" : "materializing";
  const table = parameters.kind === "validation" ? "catalog_validation_jobs" : "catalog_publish_jobs";
  const row = await env.DB.prepare(`SELECT jobs.id FROM ${table} AS jobs
    JOIN workflow_outbox AS outbox ON outbox.${target}=jobs.id AND outbox.state='pending'
    WHERE jobs.id=? AND jobs.state=?`).bind(parameters.jobId, state).first();
  if (!row) return false;
  await deliverCatalogWorkflow(env, parameters);
  return true;
}
