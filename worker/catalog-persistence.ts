import type { RepositoryContest, RepositoryProblem } from "../src/online-judge/repository-contract";
import { prepareCatalogContestJudgeRollouts } from "./contest-judge-rollout";
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

function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("Canonical catalog JSON cannot contain a non-finite number.");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => {
      const member = record[key];
      if (member === undefined) throw new TypeError("Canonical catalog JSON cannot contain undefined.");
      return `${JSON.stringify(key)}:${canonicalJson(member)}`;
    }).join(",")}}`;
  }
  throw new TypeError("Canonical catalog JSON contains a non-JSON value.");
}

async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

interface PersistedContestRules {
  readonly contest: RepositoryContest;
  readonly rulesJson: string;
  readonly rulesSha256: string;
  readonly activationSha256: string;
}

async function assertPromptContextDescriptors(
  env: WasmOjWorkerEnv,
  problems: readonly ValidatedCatalogProblem[],
): Promise<void> {
  const descriptors = new Map<string, { readonly bytes: number; readonly storageKey: string }>();
  for (const problem of problems) {
    for (const descriptor of [problem.source.practiceBundle, problem.source.contestBundle]) {
      const storageKey = `prompt-contexts/v1/${descriptor.sha256}`;
      const declared = descriptors.get(descriptor.sha256);
      if (declared && (declared.bytes !== descriptor.bytes || declared.storageKey !== storageKey)) {
        throw new TypeError(`Prompt public context '${descriptor.sha256}' has conflicting catalog descriptors.`);
      }
      descriptors.set(descriptor.sha256, { bytes: descriptor.bytes, storageKey });
    }
  }
  await Promise.all([...descriptors].map(async ([sha256, descriptor]) => {
    const existing = await env.DB.prepare(`SELECT bytes, storage_key FROM prompt_public_contexts WHERE sha256=?`)
      .bind(sha256).first<{ readonly bytes: number; readonly storage_key: string }>();
    if (existing && (existing.bytes !== descriptor.bytes || existing.storage_key !== descriptor.storageKey)) {
      throw new TypeError(`Prompt public context '${sha256}' conflicts with its persisted descriptor.`);
    }
  }));
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
  const problemsBySlug = new Map(problems.map((problem) => [problem.source.slug, problem]));
  const existingContests = await env.DB.prepare("SELECT id, slug FROM contest_series WHERE catalog_id=?")
    .bind(context.catalogId).all<{ readonly id: string; readonly slug: string }>();
  const contestIds = new Map(existingContests.results.map((row) => [row.slug, row.id]));
  for (const contest of contests) if (!contestIds.has(contest.slug)) contestIds.set(contest.slug, crypto.randomUUID());
  const persistedContests: PersistedContestRules[] = [];
  for (const contest of contests) {
    const rulesJson = canonicalJson(contest.rules);
    persistedContests.push({
      contest,
      rulesJson,
      rulesSha256: await sha256(rulesJson),
      activationSha256: await sha256(canonicalJson({
        accessMode: contest.accessMode,
        rules: contest.rules,
        status: contest.status,
      })),
    });
  }
  await assertPromptContextDescriptors(env, problems);
  const contestJudgeRollouts = await prepareCatalogContestJudgeRollouts(env, {
    jobId: context.jobId,
    catalogId: context.catalogId,
    commitSha: context.commitSha,
    requestedBy: context.requestedBy,
    now,
    problems: problems.map((problem) => ({
      problemId: problemIds.get(problem.source.slug)!,
      contestBundleSha256: problem.source.contestBundle.sha256,
      judgeDigest: problem.source.judgePackage.sha256,
    })),
  });

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
      env.DB.prepare(`INSERT INTO prompt_public_contexts
          (sha256, bytes, storage_key, created_at)
        SELECT ?, ?, ?, ?
        WHERE EXISTS (SELECT 1 FROM catalog_sync_jobs WHERE id=? AND state='running')
        ON CONFLICT(sha256) DO NOTHING`)
        .bind(
          problem.source.contestBundle.sha256,
          problem.source.contestBundle.bytes,
          `prompt-contexts/v1/${problem.source.contestBundle.sha256}`,
          now,
          context.jobId,
        ),
      env.DB.prepare(`INSERT INTO prompt_public_contexts
          (sha256, bytes, storage_key, created_at)
        SELECT ?, ?, ?, ?
        WHERE EXISTS (SELECT 1 FROM catalog_sync_jobs WHERE id=? AND state='running')
        ON CONFLICT(sha256) DO NOTHING`)
        .bind(
          problem.source.practiceBundle.sha256,
          problem.source.practiceBundle.bytes,
          `prompt-contexts/v1/${problem.source.practiceBundle.sha256}`,
          now,
          context.jobId,
        ),
    );
  }
  for (const persisted of persistedContests) {
    const contest = persisted.contest;
    const contestId = contestIds.get(contest.slug)!;
    const clock = contest.rules.clock;
    const registrationOpensAt = clock.kind === "global" ? clock.registrationOpensAt : clock.enrollmentOpensAt;
    const registrationClosesAt = clock.kind === "global" ? clock.registrationClosesAt : clock.enrollmentClosesAt;
    const track = contest.rules.officialTrack;
    const leaderboard = contest.rules.leaderboard;
    statements.push(
      env.DB.prepare(`INSERT INTO contest_series (id, catalog_id, slug, invite_code_hash, created_at)
        SELECT ?, ?, ?, NULL, ? WHERE EXISTS (
          SELECT 1 FROM catalog_sync_jobs WHERE id=? AND state='running'
        ) ON CONFLICT(catalog_id, slug) DO NOTHING`)
        .bind(contestId, context.catalogId, contest.slug, now, context.jobId),
      env.DB.prepare(`INSERT INTO contest_rule_revisions
        (contest_id, rules_commit, status, title, description, access_mode,
         rules_json, rules_sha256, activation_sha256,
         clock_kind, registration_opens_at, registration_closes_at, global_starts_at, duration_seconds,
         official_track, evidence_at, ai_assist,
         prompt_compiler_config_id, prompt_compiler_config_sha256,
         prompt_max_bytes, prompt_input_tokens, prompt_output_tokens,
         prompt_generated_source_bytes, prompt_timeout_seconds, prompt_disclosure,
         scoring_kind, leaderboard_kind, leaderboard_freeze_after_seconds, created_at)
        SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
        WHERE EXISTS (SELECT 1 FROM catalog_sync_jobs WHERE id=? AND state='running')
        ON CONFLICT(contest_id, rules_commit) DO NOTHING`)
        .bind(
          contestId, context.commitSha, contest.status, contest.title, contest.description, contest.accessMode,
          persisted.rulesJson, persisted.rulesSha256, persisted.activationSha256,
          clock.kind, registrationOpensAt, registrationClosesAt,
          clock.kind === "global" ? clock.startsAt : null, clock.durationSeconds,
          track.kind, contest.rules.evidenceAt, track.kind === "code" ? track.aiAssist : null,
          track.kind === "prompt-program" ? track.compiler.configId : null,
          track.kind === "prompt-program" ? track.compiler.configDigest : null,
          track.kind === "prompt-program" ? track.limits.promptBytes : null,
          track.kind === "prompt-program" ? track.limits.inputTokens : null,
          track.kind === "prompt-program" ? track.limits.outputTokens : null,
          track.kind === "prompt-program" ? track.limits.generatedSourceBytes : null,
          track.kind === "prompt-program" ? track.limits.timeoutSeconds : null,
          track.kind === "prompt-program" ? track.disclosure : null,
          contest.rules.scoring.kind, leaderboard.kind,
          leaderboard.kind === "freeze" ? leaderboard.atSeconds : null,
          now, context.jobId,
        ),
    );
    for (let ordinal = 0; ordinal < contest.rules.problems.length; ordinal += 1) {
      const problem = contest.rules.problems[ordinal]!;
      statements.push(env.DB.prepare(`INSERT INTO contest_rule_problems
          (contest_id, rules_commit, problem_id, ordinal, batch,
           release_after_seconds, submission_closes_after_seconds, points, attempt_limit,
           output_language, output_target, output_optimization, output_entry_path, problem_rules_json)
          SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
          WHERE EXISTS (SELECT 1 FROM catalog_sync_jobs WHERE id=? AND state='running')
          ON CONFLICT(contest_id, rules_commit, problem_id) DO NOTHING`)
        .bind(
          contestId, context.commitSha, problemIds.get(problem.slug)!, ordinal + 1, problem.batch,
          problem.releaseAfterSeconds, problem.submissionClosesAfterSeconds, problem.points, problem.attemptLimit,
          problem.output?.language ?? null, problem.output?.target ?? null,
          problem.output?.optimization ?? null, problem.output?.entry ?? null,
          canonicalJson(problem), context.jobId,
        ));
    }
    for (let ordinal = 0; ordinal < contest.rules.checkpoints.length; ordinal += 1) {
      const checkpoint = contest.rules.checkpoints[ordinal]!;
      const scope = checkpoint.scope;
      const ranking = checkpoint.ranking;
      statements.push(env.DB.prepare(`INSERT INTO contest_rule_checkpoints
          (contest_id, rules_commit, checkpoint_id, ordinal, at_seconds,
           scope_kind, scope_batch, scope_problem_slugs_json,
           minimum_solved, minimum_score, ranking_kind, ranking_value,
           settlement, checkpoint_rules_json)
          SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
          WHERE EXISTS (SELECT 1 FROM catalog_sync_jobs WHERE id=? AND state='running')
          ON CONFLICT(contest_id, rules_commit, checkpoint_id) DO NOTHING`)
        .bind(
          contestId, context.commitSha, checkpoint.id, ordinal + 1, checkpoint.atSeconds,
          scope.kind, scope.kind === "batch" ? scope.batch : null,
          scope.kind === "problems" ? canonicalJson(scope.slugs) : null,
          checkpoint.threshold.minimumSolved, checkpoint.threshold.minimumScore,
          ranking?.kind ?? null,
          ranking === null ? null : ranking.kind === "top-k" ? ranking.count : ranking.percent,
          checkpoint.settlement, canonicalJson(checkpoint), context.jobId,
        ));
    }
    const initialRuntimeState = contest.status === "archived" ? "ended" : "scheduled";
    statements.push(
      env.DB.prepare(`INSERT INTO contest_runtimes
        (contest_id, active_rules_commit, active_rules_sha256, active_activation_sha256,
         pending_rules_commit, pending_rules_sha256, pending_activation_sha256,
         rules_epoch, timeline_generation, state, wall_anchor_at, logical_anchor_seconds,
         pause_reason, paused_at, first_started_at, ended_at, created_at, updated_at)
        SELECT ?, ?, ?, ?, NULL, NULL, NULL, 1, 1, ?, NULL, 0,
          NULL, NULL, NULL, ?, ?, ?
        WHERE EXISTS (SELECT 1 FROM catalog_sync_jobs WHERE id=? AND state='running')
        ON CONFLICT(contest_id) DO NOTHING`)
        .bind(
          contestId, context.commitSha, persisted.rulesSha256, persisted.activationSha256,
          initialRuntimeState, initialRuntimeState === "ended" ? now : null, now, now,
          context.jobId,
        ),
      env.DB.prepare(`INSERT INTO contest_rule_epochs
        (contest_id, rules_epoch, rules_commit, rules_sha256, timeline_generation,
         activation_kind, activated_logical_seconds, activated_at, activated_by)
        SELECT ?, 1, ?, ?, 1, 'initial', 0, ?, ?
        WHERE EXISTS (SELECT 1 FROM catalog_sync_jobs WHERE id=? AND state='running')
          AND EXISTS (SELECT 1 FROM contest_runtimes
            WHERE contest_id=? AND active_rules_commit=?
              AND active_rules_sha256=? AND active_activation_sha256=?)
        ON CONFLICT(contest_id, rules_epoch) DO NOTHING`)
        .bind(
          contestId, context.commitSha, persisted.rulesSha256, now, context.requestedBy,
          context.jobId, contestId, context.commitSha, persisted.rulesSha256, persisted.activationSha256,
        ),
    );
    for (const problem of contest.rules.problems) {
      const problemId = problemIds.get(problem.slug)!;
      const source = problemsBySlug.get(problem.slug)!.source;
      statements.push(
        env.DB.prepare(`INSERT INTO contest_problem_epochs
            (contest_id, problem_id, problem_epoch, rules_epoch, content_epoch, judge_epoch,
             content_commit, judge_commit, judge_digest, state, rollout_batch_id,
             created_at, effective_at, failure_code)
            SELECT ?, ?, 1, 1, 1, 1, ?, ?, ?, 'effective', NULL, ?, ?, NULL
            WHERE EXISTS (SELECT 1 FROM catalog_sync_jobs WHERE id=? AND state='running')
              AND EXISTS (SELECT 1 FROM contest_runtimes
                WHERE contest_id=? AND active_rules_commit=?
                  AND active_rules_sha256=? AND active_activation_sha256=?)
            ON CONFLICT(contest_id, problem_id, problem_epoch) DO NOTHING`)
          .bind(
            contestId, problemId, context.commitSha, context.commitSha,
            source.judgePackage.sha256, now, now,
            context.jobId, contestId, context.commitSha,
            persisted.rulesSha256, persisted.activationSha256,
          ),
        env.DB.prepare(`INSERT INTO contest_problem_prompt_contexts
            (contest_id, problem_id, content_epoch, public_context_sha256, created_at)
          SELECT ?, ?, 1, ?, ?
          WHERE EXISTS (SELECT 1 FROM catalog_sync_jobs WHERE id=? AND state='running')
            AND EXISTS (SELECT 1 FROM contest_problem_epochs
              WHERE contest_id=? AND problem_id=? AND problem_epoch=1)
          ON CONFLICT(contest_id, problem_id, content_epoch) DO NOTHING`)
          .bind(
            contestId, problemId, source.contestBundle.sha256, now,
            context.jobId, contestId, problemId,
          ),
      );
    }
    statements.push(env.DB.prepare(`UPDATE contest_runtimes SET
        pending_rules_commit=CASE WHEN active_activation_sha256<>? THEN ? ELSE NULL END,
        pending_rules_sha256=CASE WHEN active_activation_sha256<>? THEN ? ELSE NULL END,
        pending_activation_sha256=CASE WHEN active_activation_sha256<>? THEN ? ELSE NULL END,
        updated_at=?
      WHERE contest_id=?
        AND EXISTS (SELECT 1 FROM catalog_sync_jobs WHERE id=? AND state='running')`)
      .bind(
        persisted.activationSha256, context.commitSha,
        persisted.activationSha256, persisted.rulesSha256,
        persisted.activationSha256, persisted.activationSha256,
        now, contestId, context.jobId,
      ));
  }
  statements.push(...contestJudgeRollouts.statements);
  statements.push(
    env.DB.prepare(`UPDATE catalog_contest_v2_resync_requirements
      SET state='ready', resynced_commit=?, resynced_at=?
      WHERE catalog_id=? AND state='pending'
        AND EXISTS (SELECT 1 FROM catalog_sync_jobs WHERE id=? AND state='running')`)
      .bind(context.commitSha, now, context.catalogId, context.jobId),
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
