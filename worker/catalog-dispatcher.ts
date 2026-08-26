import capacity from "../config/capacity.json";
import type { WasmOjWorkerEnv } from "./env";
import type { CatalogWorkflowParameters } from "./catalog-workflow-identity";
import { operationalLog } from "./structured-log";
import { workflowStatusOrUnknown } from "./workflow-instance-status";

interface CatalogCandidate {
  readonly id: string;
}

async function oldestEligibleCatalogJob(env: WasmOjWorkerEnv): Promise<CatalogCandidate | null> {
  return env.DB.prepare(`SELECT jobs.id
      FROM catalog_sync_jobs AS jobs
      JOIN catalogs ON catalogs.id=jobs.catalog_id
      JOIN workflow_outbox AS outbox ON outbox.catalog_sync_job_id=jobs.id AND outbox.state='pending'
      WHERE jobs.state='queued'
        AND (SELECT COUNT(*) FROM catalog_sync_jobs WHERE state='running') < ?
        AND (SELECT COUNT(*) FROM catalog_sync_jobs AS active
          JOIN catalogs AS active_catalog ON active_catalog.id=active.catalog_id
          WHERE active.state='running' AND active_catalog.organizer_user_id=catalogs.organizer_user_id) < ?
        AND NOT EXISTS (SELECT 1 FROM catalog_sync_jobs AS active
          WHERE active.catalog_id=jobs.catalog_id AND active.state='running')
      ORDER BY jobs.created_at, jobs.id LIMIT 1`)
    .bind(capacity.catalog.globalActive, capacity.catalog.perOrganizerActive)
    .first<CatalogCandidate>();
}

async function deliver(env: WasmOjWorkerEnv, syncJobId: string): Promise<void> {
  const workflowId = `catalog-sync-${syncJobId}`;
  const now = new Date().toISOString();
  const settle = async (increment: boolean): Promise<void> => {
    await env.DB.prepare(`UPDATE workflow_outbox SET state='delivered', settled_at=?, attempts=attempts+?,
        last_error=NULL, updated_at=? WHERE catalog_sync_job_id=? AND state='pending'`)
      .bind(now, increment ? 1 : 0, now, syncJobId).run();
  };
  const defer = async (error: unknown, increment: boolean): Promise<void> => {
    const message = error instanceof Error ? error.message : "workflow-delivery-failed";
    await env.DB.prepare(`UPDATE workflow_outbox SET attempts=attempts+?, last_error=?, updated_at=?
      WHERE catalog_sync_job_id=? AND state='pending'`)
      .bind(increment ? 1 : 0, message.slice(0, 500), now, syncJobId).run();
    operationalLog("warn", {
      event: "workflow.delivery-deferred", outcome: "deferred", code: "start-catalog-sync",
      aggregateType: "catalog", aggregateId: syncJobId,
    });
  };

  try {
    const status = await workflowStatusOrUnknown(env.CATALOG_WORKFLOW, workflowId);
    if (status.status !== "unknown") {
      await settle(false);
      return;
    }
  } catch (error) {
    await defer(error, false);
    return;
  }

  try {
    await env.CATALOG_WORKFLOW.create({ id: workflowId, params: { syncJobId } satisfies CatalogWorkflowParameters });
    await settle(true);
  } catch (error) {
    try {
      const status = await workflowStatusOrUnknown(env.CATALOG_WORKFLOW, workflowId);
      if (status.status !== "unknown") {
        await settle(true);
        return;
      }
    } catch (statusError) {
      await defer(statusError, false);
      return;
    }
    await defer(error, true);
  }
}

export async function dispatchCatalogJobs(env: WasmOjWorkerEnv, maximum = capacity.catalog.globalActive): Promise<number> {
  let claimed = 0;
  for (let index = 0; index < maximum; index += 1) {
    const candidate = await oldestEligibleCatalogJob(env);
    if (!candidate) break;
    const now = new Date().toISOString();
    const result = await env.DB.prepare(`UPDATE catalog_sync_jobs SET state='running', started_at=?, updated_at=?
      WHERE id=? AND state='queued'
        AND (SELECT COUNT(*) FROM catalog_sync_jobs WHERE state='running') < ?
        AND NOT EXISTS (SELECT 1 FROM catalog_sync_jobs AS active
          WHERE active.catalog_id=catalog_sync_jobs.catalog_id AND active.state='running')`)
      .bind(now, now, candidate.id, capacity.catalog.globalActive).run();
    if (result.meta.changes !== 1) continue;
    claimed += 1;
    await deliver(env, candidate.id);
  }
  return claimed;
}

export async function redeliverClaimedCatalogJob(
  env: WasmOjWorkerEnv,
  parameters: CatalogWorkflowParameters,
): Promise<boolean> {
  const row = await env.DB.prepare(`SELECT jobs.id FROM catalog_sync_jobs AS jobs
    JOIN workflow_outbox AS outbox ON outbox.catalog_sync_job_id=jobs.id AND outbox.state='pending'
    WHERE jobs.id=? AND jobs.state='running'`).bind(parameters.syncJobId).first();
  if (!row) return false;
  await deliver(env, parameters.syncJobId);
  return true;
}
