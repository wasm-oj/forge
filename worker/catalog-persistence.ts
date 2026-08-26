import type { RepositoryContest, RepositoryProblem } from "../src/online-judge/repository-contract";
import type { WasmOjWorkerEnv } from "./env";
import { ApiError } from "./http";

export interface CatalogSyncContext {
  readonly jobId: string;
  readonly catalogId: string;
  readonly githubRepositoryId: number;
  readonly commitSha: string;
  readonly requestedBy: string;
  readonly state: "running" | "succeeded";
}

export interface ValidatedCatalogProblem {
  readonly source: RepositoryProblem;
  readonly allowedProfilesJson: string;
}

export async function persistCatalogSync(
  env: WasmOjWorkerEnv,
  context: CatalogSyncContext,
  problems: readonly ValidatedCatalogProblem[],
  contests: readonly RepositoryContest[],
): Promise<void> {
  const now = new Date().toISOString();
  const existingProblems = await env.DB.prepare("SELECT id, slug FROM problem_series WHERE catalog_id=?")
    .bind(context.catalogId).all<{ readonly id: string; readonly slug: string }>();
  const problemIds = new Map(existingProblems.results.map((row) => [row.slug, row.id]));
  for (const problem of problems) if (!problemIds.has(problem.source.slug)) problemIds.set(problem.source.slug, crypto.randomUUID());
  const existingContests = await env.DB.prepare("SELECT id, slug FROM contest_series WHERE catalog_id=?")
    .bind(context.catalogId).all<{ readonly id: string; readonly slug: string }>();
  const contestIds = new Map(existingContests.results.map((row) => [row.slug, row.id]));
  for (const contest of contests) if (!contestIds.has(contest.slug)) contestIds.set(contest.slug, crypto.randomUUID());

  const summary = JSON.stringify({
    schema: "wasm-oj-platform/catalog-sync-summary/v1",
    commitSha: context.commitSha,
    problemCount: problems.length,
    contestCount: contests.length,
  });
  const statements: D1PreparedStatement[] = [];
  for (const problem of problems) {
    const problemId = problemIds.get(problem.source.slug)!;
    statements.push(
      env.DB.prepare(`INSERT INTO problem_series (id, catalog_id, slug, created_at)
        SELECT ?, ?, ?, ? WHERE EXISTS (
          SELECT 1 FROM catalog_sync_jobs WHERE id=? AND state='running'
        ) ON CONFLICT(catalog_id, slug) DO NOTHING`)
        .bind(problemId, context.catalogId, problem.source.slug, now, context.jobId),
      env.DB.prepare(`INSERT INTO problem_revisions
        (problem_id, commit_sha, ordinal, title_json, summary_json, practice_enabled,
         practice_bundle_path, practice_bundle_bytes, practice_bundle_sha256,
         contest_bundle_path, contest_bundle_bytes, contest_bundle_sha256,
         judge_package_path, judge_package_bytes, judge_digest, allowed_profiles_json, created_at)
        SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
        WHERE EXISTS (SELECT 1 FROM catalog_sync_jobs WHERE id=? AND state='running')
        ON CONFLICT(problem_id, commit_sha) DO NOTHING`)
        .bind(
          problemId, context.commitSha, problem.source.order, JSON.stringify(problem.source.title),
          JSON.stringify(problem.source.summary), problem.source.practiceEnabled ? 1 : 0,
          problem.source.practiceBundle.path, problem.source.practiceBundle.bytes, problem.source.practiceBundle.sha256,
          problem.source.contestBundle.path, problem.source.contestBundle.bytes, problem.source.contestBundle.sha256,
          problem.source.judgePackage.path, problem.source.judgePackage.bytes, problem.source.judgePackage.sha256,
          problem.allowedProfilesJson, now, context.jobId,
        ),
    );
  }
  for (const contest of contests) {
    const contestId = contestIds.get(contest.slug)!;
    statements.push(
      env.DB.prepare(`INSERT INTO contest_series (id, catalog_id, slug, invite_code_hash, created_at)
        SELECT ?, ?, ?, NULL, ? WHERE EXISTS (
          SELECT 1 FROM catalog_sync_jobs WHERE id=? AND state='running'
        ) ON CONFLICT(catalog_id, slug) DO NOTHING`)
        .bind(contestId, context.catalogId, contest.slug, now, context.jobId),
      env.DB.prepare(`INSERT INTO contest_revisions
        (contest_id, commit_sha, status, title, description, access_mode, starts_at, ends_at, freeze_at, created_at)
        SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
        WHERE EXISTS (SELECT 1 FROM catalog_sync_jobs WHERE id=? AND state='running')
        ON CONFLICT(contest_id, commit_sha) DO NOTHING`)
        .bind(contestId, context.commitSha, contest.status, contest.title, contest.description,
          contest.accessMode, contest.startsAt, contest.endsAt, contest.freezeAt, now, context.jobId),
    );
    for (let ordinal = 0; ordinal < contest.problems.length; ordinal += 1) {
      statements.push(env.DB.prepare(`INSERT INTO contest_revision_problems
          (contest_id, commit_sha, problem_id, ordinal) SELECT ?, ?, ?, ?
          WHERE EXISTS (SELECT 1 FROM catalog_sync_jobs WHERE id=? AND state='running')
          ON CONFLICT(contest_id, commit_sha, problem_id) DO NOTHING`)
        .bind(contestId, context.commitSha, problemIds.get(contest.problems[ordinal]!)!, ordinal + 1, context.jobId));
    }
  }
  statements.push(
    env.DB.prepare(`INSERT INTO catalog_deployments
      (catalog_id, commit_sha, sync_job_id, synced_by, synced_at, problem_count, contest_count)
      SELECT ?, ?, ?, ?, ?, ?, ?
      WHERE EXISTS (SELECT 1 FROM catalog_sync_jobs WHERE id=? AND state='running')
      ON CONFLICT(catalog_id, commit_sha) DO UPDATE SET
        sync_job_id=excluded.sync_job_id, synced_by=excluded.synced_by,
        synced_at=excluded.synced_at, problem_count=excluded.problem_count, contest_count=excluded.contest_count`)
      .bind(context.catalogId, context.commitSha, context.jobId, context.requestedBy, now,
        problems.length, contests.length, context.jobId),
    env.DB.prepare(`UPDATE catalogs SET active_commit_sha=?, updated_at=? WHERE id=?
      AND EXISTS (SELECT 1 FROM catalog_sync_jobs WHERE id=? AND state='running')`)
      .bind(context.commitSha, now, context.catalogId, context.jobId),
    env.DB.prepare(`UPDATE catalog_sync_jobs SET state='succeeded', error_code=NULL, summary_json=?, updated_at=?, finished_at=?
      WHERE id=? AND state='running'`).bind(summary, now, now, context.jobId),
  );
  const results = await env.DB.batch(statements);
  if (results.at(-1)?.meta.changes !== 1) throw new Error("Catalog sync lost its running-state fence.");
}

function failureCode(error: unknown): string {
  if (error instanceof ApiError) return error.code.slice(0, 100);
  if (error instanceof TypeError) return "catalog-contract-invalid";
  return "catalog-sync-failed";
}

export async function failCatalogSync(env: WasmOjWorkerEnv, jobId: string, error: unknown): Promise<void> {
  const now = new Date().toISOString();
  await env.DB.prepare(`UPDATE catalog_sync_jobs SET state='failed', error_code=?, updated_at=?, finished_at=?
    WHERE id=? AND state='running'`).bind(failureCode(error), now, now, jobId).run();
}
