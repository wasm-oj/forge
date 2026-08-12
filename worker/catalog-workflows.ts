import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { canonicalJsonBytes, parseCanonicalJsonBytes } from "../src/core/canonical-json";
import type { BuiltinLanguage } from "../src/core/types";
import {
  parseProblemCollectionIndex,
  verifyProblemBundleBytes,
  verifyProblemCollectionRevision,
  type ProblemCollectionEntry,
} from "../src/judge/problem-catalog-loader";
import { contestPublicProjectionBytes } from "../src/online-judge/contest-public";
import { assertJudgeDataMatchesPracticePublic } from "../src/online-judge/judge-data";
import { validateJudgePackage } from "../src/online-judge/judge-package";
import { parseManagedCollectionV2, type ManagedProblemPublication } from "../src/online-judge/managed-collection";
import type { CatalogWorkflowParameters } from "./catalog-workflow-identity";
import {
  boundedDeclaredBlob,
  catalogRepositoryById,
  declaredBlob,
  exactCommitTree,
  rawBlobResponse,
  readBoundedBlob,
  readVerifiedBlob,
  relativeRepositoryPath,
  type ExactGitBlob,
} from "./catalog-github";
import { dispatchCatalogJobs } from "./catalog-dispatcher";
import { sha256Hex } from "./crypto";
import type { WasmOjWorkerEnv } from "./env";
import { ApiError } from "./http";
import { operationalLog } from "./structured-log";

const INDEX_MAX_BYTES = 512 * 1024;
const MANAGED_MAX_BYTES = 2 * 1024 * 1024;
const PUBLIC_MAX_BYTES = 8 * 1024 * 1024;
const JUDGE_MAX_BYTES = 32 * 1024 * 1024;
const JUDGE_PACKAGE_PREFIX = "judge-packages/v2/";

interface ValidationContext {
  readonly jobId: string;
  readonly collectionId: string;
  readonly organizerUserId: string;
  readonly githubRepositoryId: number;
  readonly indexPath: string;
  readonly commitSha: string;
  readonly state: string;
}

interface ValidatedProblemRecord {
  readonly slug: string;
  readonly seriesId: string;
  readonly entry: ProblemCollectionEntry;
  readonly practiceBlob: ExactGitBlob;
  readonly contestBlob: ExactGitBlob;
  readonly judgeBlob: ExactGitBlob;
  readonly contestPath: string;
  readonly judgePath: string;
  readonly contestSha256: string;
  readonly judgeSha256: string;
  readonly allowedProfilesJson: string;
}

interface PublishContext {
  readonly jobId: string;
  readonly revisionId: string;
  readonly githubRepositoryId: number;
  readonly commitSha: string;
  readonly mode: "official-practice" | "contest";
  readonly requestedBy: string;
  readonly state: string;
}

interface PublishProblem {
  readonly problem_series_id: string;
  readonly judge_package_path: string;
  readonly judge_package_git_sha: string;
  readonly judge_package_bytes: number;
  readonly judge_package_sha256: string;
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  let difference = 0;
  for (let index = 0; index < left.byteLength; index += 1) difference |= left[index]! ^ right[index]!;
  return difference === 0;
}

function canonicalText(value: unknown): string {
  return new TextDecoder().decode(canonicalJsonBytes(value));
}

function managedPath(indexPath: string): string {
  return relativeRepositoryPath(indexPath, "managed.json");
}

function invalidCode(error: unknown): string {
  if (error instanceof ApiError) return error.code.slice(0, 100);
  if (error instanceof TypeError) return "catalog-contract-invalid";
  return "catalog-validation-failed";
}

function isValidationFailure(error: unknown): boolean {
  return error instanceof TypeError || (error instanceof ApiError && error.status >= 400 && error.status < 500);
}

async function validationContext(env: WasmOjWorkerEnv, jobId: string): Promise<ValidationContext> {
  const row = await env.DB.prepare(`SELECT jobs.id AS jobId, jobs.collection_id AS collectionId,
      collections.organizer_user_id AS organizerUserId,
      collections.github_repository_id AS githubRepositoryId, collections.index_path AS indexPath,
      jobs.commit_sha AS commitSha, jobs.state
    FROM catalog_validation_jobs AS jobs
    JOIN problem_collections AS collections ON collections.id=jobs.collection_id
    WHERE jobs.id=?`).bind(jobId).first<ValidationContext>();
  if (!row) throw new Error("Catalog validation job does not exist.");
  return row;
}

async function validateOneProblem(
  repository: Awaited<ReturnType<typeof catalogRepositoryById>>,
  tree: ReadonlyMap<string, ExactGitBlob>,
  indexPath: string,
  entry: ProblemCollectionEntry,
  managed: ManagedProblemPublication,
  seriesId: string,
): Promise<ValidatedProblemRecord> {
  if (entry.id !== managed.slug) throw new TypeError(`Managed problem '${managed.slug}' does not match collection ordering.`);
  const practicePath = relativeRepositoryPath(indexPath, entry.bundle.path);
  const contestPath = relativeRepositoryPath(indexPath, managed.contestPublic.repositoryPath);
  const judgePath = relativeRepositoryPath(indexPath, managed.judgePackage.repositoryPath);
  const practiceBlob = declaredBlob(tree, practicePath, entry.bundle.bytes, PUBLIC_MAX_BYTES);
  const contestBlob = declaredBlob(tree, contestPath, managed.contestPublic.bytes, PUBLIC_MAX_BYTES);
  const judgeBlob = declaredBlob(tree, judgePath, managed.judgePackage.bytes, JUDGE_MAX_BYTES);

  const practiceBytes = await readVerifiedBlob(repository, practiceBlob, entry.bundle.sha256, PUBLIC_MAX_BYTES);
  parseCanonicalJsonBytes(practiceBytes, `practice bundle '${entry.id}'`);
  const practice = await verifyProblemBundleBytes(practiceBytes, entry);
  const contestBytes = await readVerifiedBlob(repository, contestBlob, managed.contestPublic.sha256, PUBLIC_MAX_BYTES);
  const expectedContest = contestPublicProjectionBytes(practice, entry.bundle.sha256);
  if (!equalBytes(contestBytes, expectedContest)) {
    throw new TypeError(`Contest-public bundle '${entry.id}' is not the canonical redaction of its practice bundle.`);
  }

  const packageResponse = await rawBlobResponse(repository, judgeBlob, JUDGE_MAX_BYTES);
  if (!packageResponse.body) throw new ApiError(502, "github-blob-empty", "GitHub judge package response has no body.");
  const validatedPackage = await validateJudgePackage(packageResponse.body, {
    expectedBytes: managed.judgePackage.bytes,
    expectedSha256: managed.judgePackage.sha256,
  });
  if (!equalBytes(canonicalJsonBytes(validatedPackage.manifest.allowedProfiles), canonicalJsonBytes(managed.allowedProfiles))) {
    throw new TypeError(`Judge package '${entry.id}' allowedProfiles disagree with managed.json.`);
  }
  const languages = Object.keys(managed.allowedProfiles).sort() as BuiltinLanguage[];
  assertJudgeDataMatchesPracticePublic(validatedPackage.judgeData, practice, languages);
  return {
    slug: managed.slug,
    seriesId,
    entry,
    practiceBlob,
    contestBlob,
    judgeBlob,
    contestPath,
    judgePath,
    contestSha256: managed.contestPublic.sha256,
    judgeSha256: managed.judgePackage.sha256,
    allowedProfilesJson: canonicalText(managed.allowedProfiles),
  };
}

async function persistValidRevision(
  env: WasmOjWorkerEnv,
  context: ValidationContext,
  input: {
    readonly revisionId: string;
    readonly indexBlob: ExactGitBlob;
    readonly indexSha256: string;
    readonly managedBlob: ExactGitBlob;
    readonly managedSha256: string;
    readonly collectionRevision: string;
    readonly problems: readonly ValidatedProblemRecord[];
  },
): Promise<void> {
  const now = new Date().toISOString();
  const summary = canonicalText({
    schema: "wasm-oj-platform/catalog-validation-summary/v2",
    valid: true,
    commitSha: context.commitSha,
    collectionRevision: input.collectionRevision,
    problemCount: input.problems.length,
  });
  const statements: D1PreparedStatement[] = [
    env.DB.prepare(`UPDATE catalog_validation_jobs
      SET state='valid', error_code=NULL, updated_at=?, finished_at=?
      WHERE id=? AND state='running'`).bind(now, now, context.jobId),
    ...input.problems.map((problem) => env.DB.prepare(`INSERT INTO problem_series
      (id, collection_id, problem_slug, created_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(collection_id, problem_slug) DO NOTHING`)
      .bind(problem.seriesId, context.collectionId, problem.slug, now)),
    env.DB.prepare(`INSERT INTO collection_revisions
      (id, collection_id, validation_job_id, commit_sha, collection_revision_sha256,
       index_path, index_git_sha, index_bytes, index_sha256,
       managed_path, managed_git_sha, managed_bytes, managed_sha256,
       contract_version, validation_summary_json, validated_by, validated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 2, ?, ?, ?)`)
      .bind(
        input.revisionId, context.collectionId, context.jobId, context.commitSha, input.collectionRevision,
        context.indexPath, input.indexBlob.gitSha, input.indexBlob.bytes, input.indexSha256,
        managedPath(context.indexPath), input.managedBlob.gitSha, input.managedBlob.bytes, input.managedSha256,
        summary, context.organizerUserId, now,
      ),
  ];
  for (const problem of input.problems) {
    statements.push(env.DB.prepare(`INSERT INTO collection_revision_problems
      (collection_revision_id, problem_series_id, problem_number, title_json, difficulty, tags_json,
       track_id, track_json, practice_bundle_path, practice_bundle_git_sha, practice_bundle_bytes,
       practice_bundle_sha256, contest_public_path, contest_public_git_sha, contest_public_bytes,
       contest_public_sha256, judge_package_path, judge_package_git_sha, judge_package_bytes,
       judge_package_sha256, allowed_profiles_json, maximum_score)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 100)`)
      .bind(
        input.revisionId, problem.seriesId, problem.entry.number, JSON.stringify(problem.entry.title),
        problem.entry.difficulty, JSON.stringify(problem.entry.tags), problem.entry.trackId,
        JSON.stringify(problem.entry.track), problem.practiceBlob.path, problem.practiceBlob.gitSha,
        problem.practiceBlob.bytes, problem.entry.bundle.sha256, problem.contestPath,
        problem.contestBlob.gitSha, problem.contestBlob.bytes,
        problem.contestSha256,
        problem.judgePath, problem.judgeBlob.gitSha, problem.judgeBlob.bytes,
        problem.judgeSha256, problem.allowedProfilesJson,
      ));
  }
  const results = await env.DB.batch(statements);
  if (results[0]?.meta.changes !== 1) throw new Error("Catalog validation lost its running-state fence.");
}

async function runValidation(env: WasmOjWorkerEnv, jobId: string): Promise<{ readonly revisionId: string }> {
  const context = await validationContext(env, jobId);
  if (context.state === "valid") {
    const existing = await env.DB.prepare("SELECT id FROM collection_revisions WHERE validation_job_id=?")
      .bind(jobId).first<{ readonly id: string }>();
    if (!existing) throw new Error("Valid catalog job has no immutable revision.");
    return { revisionId: existing.id };
  }
  if (context.state !== "running") throw new Error(`Catalog validation job is not runnable from '${context.state}'.`);
  const repository = await catalogRepositoryById(env, context.githubRepositoryId);
  const tree = await exactCommitTree(repository, context.commitSha);
  const indexBlob = boundedDeclaredBlob(tree, context.indexPath, INDEX_MAX_BYTES);
  const indexBytes = await readBoundedBlob(repository, indexBlob, INDEX_MAX_BYTES);
  const indexSha256 = await sha256Hex(indexBytes);
  const index = parseProblemCollectionIndex(parseCanonicalJsonBytes(indexBytes, "collection index"));
  await verifyProblemCollectionRevision(index);
  const managedObjectPath = managedPath(context.indexPath);
  const managedBlob = boundedDeclaredBlob(tree, managedObjectPath, MANAGED_MAX_BYTES);
  const managedBytes = await readBoundedBlob(repository, managedBlob, MANAGED_MAX_BYTES);
  const managedSha256 = await sha256Hex(managedBytes);
  const managed = parseManagedCollectionV2(managedBytes);
  if (managed.collectionRevision !== index.revision || managed.problems.length !== index.problems.length) {
    throw new TypeError("managed.json does not identify the exact collection revision and problem inventory.");
  }
  for (let indexPosition = 0; indexPosition < index.problems.length; indexPosition += 1) {
    if (index.problems[indexPosition]!.id !== managed.problems[indexPosition]!.slug) {
      throw new TypeError("managed.json problem ordering must exactly match collection/index.json.");
    }
  }
  const existingSeries = await env.DB.prepare(`SELECT id, problem_slug FROM problem_series
    WHERE collection_id=?`).bind(context.collectionId).all<{ readonly id: string; readonly problem_slug: string }>();
  const series = new Map(existingSeries.results.map((item) => [item.problem_slug, item.id]));
  for (const problem of managed.problems) {
    if (!series.has(problem.slug)) series.set(problem.slug, crypto.randomUUID());
  }
  const problems: ValidatedProblemRecord[] = [];
  for (let problemIndex = 0; problemIndex < index.problems.length; problemIndex += 1) {
    const entry = index.problems[problemIndex]!;
    const managedProblem = managed.problems[problemIndex]!;
    const seriesId = series.get(managedProblem.slug);
    if (!seriesId) throw new Error("Problem series could not be established.");
    problems.push(await validateOneProblem(repository, tree, context.indexPath, entry, managedProblem, seriesId));
  }
  const revisionId = crypto.randomUUID();
  await persistValidRevision(env, context, {
    revisionId,
    indexBlob,
    indexSha256,
    managedBlob,
    managedSha256,
    collectionRevision: index.revision,
    problems,
  });
  return { revisionId };
}

function r2Sha256(object: R2Object): string | undefined {
  return object.checksums.toJSON().sha256;
}

async function assertJudgeObject(
  object: R2Object | null,
  expected: { readonly bytes: number; readonly sha256: string },
): Promise<void> {
  if (
    !object
    || object.size !== expected.bytes
    || r2Sha256(object) !== expected.sha256
    || object.customMetadata?.schema !== "wasm-oj-v2/judge-package"
    || object.customMetadata?.sha256 !== expected.sha256
    || object.customMetadata?.bytes !== String(expected.bytes)
  ) throw new Error("Immutable R2 judge package disagrees with its content identity.");
}

async function claimJudgePackage(
  env: WasmOjWorkerEnv,
  problem: PublishProblem,
  now: string,
): Promise<"staging" | "ready"> {
  await env.DB.prepare(`INSERT INTO judge_packages
      (sha256, bytes, state, staged_at)
    VALUES (?, ?, 'staging', ?)
    ON CONFLICT(sha256) DO NOTHING`)
    .bind(problem.judge_package_sha256, problem.judge_package_bytes, now).run();
  const row = await env.DB.prepare("SELECT bytes, state FROM judge_packages WHERE sha256=?")
    .bind(problem.judge_package_sha256)
    .first<{ readonly bytes: number; readonly state: "staging" | "ready" | "deleting" }>();
  if (!row || row.bytes !== problem.judge_package_bytes) {
    throw new Error("Judge package digest is bound to conflicting durable metadata.");
  }
  if (row.state === "deleting") {
    throw new Error("Judge package is behind an active deletion fence; publication must retry.");
  }
  return row.state;
}

async function materializeJudgePackage(
  env: WasmOjWorkerEnv,
  repository: Awaited<ReturnType<typeof catalogRepositoryById>>,
  problem: PublishProblem,
): Promise<void> {
  const key = `${JUDGE_PACKAGE_PREFIX}${problem.judge_package_sha256}`;
  const existing = await env.JUDGE_BUCKET.head(key);
  if (existing) {
    await assertJudgeObject(existing, { bytes: problem.judge_package_bytes, sha256: problem.judge_package_sha256 });
    return;
  }
  const blob: ExactGitBlob = {
    path: problem.judge_package_path,
    gitSha: problem.judge_package_git_sha,
    bytes: problem.judge_package_bytes,
  };
  const response = await rawBlobResponse(repository, blob, JUDGE_MAX_BYTES);
  if (!response.body) throw new Error("GitHub judge package response has no body.");
  const fixedLength = new FixedLengthStream(problem.judge_package_bytes);
  const transferAbort = new AbortController();
  const transfer = response.body.pipeTo(fixedLength.writable, { signal: transferAbort.signal });
  let created: R2Object | null;
  try {
    created = await env.JUDGE_BUCKET.put(key, fixedLength.readable, {
      onlyIf: { etagDoesNotMatch: "*" },
      sha256: problem.judge_package_sha256,
      httpMetadata: { contentType: "application/octet-stream" },
      customMetadata: {
        schema: "wasm-oj-v2/judge-package",
        sha256: problem.judge_package_sha256,
        bytes: String(problem.judge_package_bytes),
      },
    });
  } catch (error) {
    transferAbort.abort(error);
    await transfer.catch(() => undefined);
    throw error;
  }
  if (created === null) {
    transferAbort.abort("conditional R2 create lost");
    await transfer.catch(() => undefined);
  } else {
    await transfer;
  }
  await assertJudgeObject(created ?? await env.JUDGE_BUCKET.head(key), {
    bytes: problem.judge_package_bytes,
    sha256: problem.judge_package_sha256,
  });
}

async function publishContext(env: WasmOjWorkerEnv, jobId: string): Promise<PublishContext> {
  const row = await env.DB.prepare(`SELECT jobs.id AS jobId, jobs.collection_revision_id AS revisionId,
      collections.github_repository_id AS githubRepositoryId,
      revisions.commit_sha AS commitSha, jobs.mode, jobs.requested_by AS requestedBy, jobs.state
    FROM catalog_publish_jobs AS jobs
    JOIN collection_revisions AS revisions ON revisions.id=jobs.collection_revision_id
    JOIN problem_collections AS collections ON collections.id=revisions.collection_id
    WHERE jobs.id=?`).bind(jobId).first<PublishContext>();
  if (!row) throw new Error("Catalog publish job does not exist.");
  return row;
}

async function runPublish(env: WasmOjWorkerEnv, jobId: string): Promise<{ readonly publicationId: string }> {
  const context = await publishContext(env, jobId);
  if (context.state === "published") {
    const existing = await env.DB.prepare("SELECT id FROM catalog_publications WHERE publish_job_id=?")
      .bind(jobId).first<{ readonly id: string }>();
    if (!existing) throw new Error("Published catalog job has no immutable publication.");
    return { publicationId: existing.id };
  }
  if (context.state !== "materializing") throw new Error(`Catalog publish job is not runnable from '${context.state}'.`);
  const problems = await env.DB.prepare(`SELECT problem_series_id, judge_package_path, judge_package_git_sha,
      judge_package_bytes, judge_package_sha256
    FROM collection_revision_problems WHERE collection_revision_id=? ORDER BY problem_number`)
    .bind(context.revisionId).all<PublishProblem>();
  if (problems.results.length < 1) throw new Error("Validated revision has no problem inventory.");
  const repository = await catalogRepositoryById(env, context.githubRepositoryId);
  const uniquePackages = new Map(problems.results.map((problem) => [problem.judge_package_sha256, problem]));
  const materializationStartedAt = new Date().toISOString();
  for (const problem of uniquePackages.values()) {
    // The D1 claim is created before the first R2 observation. GC must acquire
    // the same row's deleting state, so a live publisher can never adopt bytes
    // concurrently removed as an orphan.
    await claimJudgePackage(env, problem, materializationStartedAt);
    await materializeJudgePackage(env, repository, problem);
  }

  const publicationId = crypto.randomUUID();
  const now = new Date().toISOString();
  const statements: D1PreparedStatement[] = [
    ...[...uniquePackages.values()].map((problem) => env.DB.prepare(`UPDATE judge_packages
      SET state='ready', ready_at=?, last_error=NULL
      WHERE sha256=? AND bytes=? AND state='staging'`)
      .bind(now, problem.judge_package_sha256, problem.judge_package_bytes)),
    env.DB.prepare(`UPDATE catalog_publish_jobs SET state='published', error_code=NULL, updated_at=?, finished_at=?
      WHERE id=? AND state='materializing'`).bind(now, now, jobId),
    env.DB.prepare(`INSERT INTO catalog_publications
      (id, publish_job_id, collection_revision_id, mode, published_by, published_at)
      VALUES (?, ?, ?, ?, ?, ?)`)
      .bind(publicationId, jobId, context.revisionId, context.mode, context.requestedBy, now),
  ];
  for (const problem of problems.results) {
    statements.push(env.DB.prepare(`INSERT INTO problem_versions
      (id, catalog_publication_id, problem_series_id, execution_semantic_sha256, created_at)
      SELECT ?, ?, revision_problem.problem_series_id, revision_problem.judge_package_sha256, ?
      FROM collection_revision_problems AS revision_problem
      WHERE revision_problem.collection_revision_id=? AND revision_problem.problem_series_id=?`)
      .bind(crypto.randomUUID(), publicationId, now, context.revisionId, problem.problem_series_id));
  }
  const results = await env.DB.batch(statements);
  const jobResult = results[uniquePackages.size];
  if (jobResult?.meta.changes !== 1) throw new Error("Catalog publication lost its materializing-state fence.");
  return { publicationId };
}

async function terminalizeFailure(
  env: WasmOjWorkerEnv,
  parameters: CatalogWorkflowParameters,
  error: unknown,
): Promise<void> {
  const now = new Date().toISOString();
  if (parameters.kind === "validation") {
    const state = isValidationFailure(error) ? "invalid" : "infrastructure-error";
    await env.DB.prepare(`UPDATE catalog_validation_jobs
      SET state=?, error_code=?, updated_at=?, finished_at=? WHERE id=? AND state='running'`)
      .bind(state, invalidCode(error), now, now, parameters.jobId).run();
  } else {
    await env.DB.prepare(`UPDATE catalog_publish_jobs
      SET state='failed', error_code=?, updated_at=?, finished_at=? WHERE id=? AND state='materializing'`)
      .bind(invalidCode(error), now, now, parameters.jobId).run();
  }
}

export class CatalogWorkflow extends WorkflowEntrypoint<WasmOjWorkerEnv, CatalogWorkflowParameters> {
  async run(event: WorkflowEvent<CatalogWorkflowParameters>, step: WorkflowStep): Promise<unknown> {
    try {
      return event.payload.kind === "validation"
        ? await step.do("validate exact commit catalog", () => runValidation(this.env, event.payload.jobId))
        : await step.do("materialize immutable judge packages", () => runPublish(this.env, event.payload.jobId));
    } catch (error) {
      await step.do("record catalog terminal failure", () => terminalizeFailure(this.env, event.payload, error));
      throw error;
    } finally {
      try {
        await step.do("dispatch next catalog jobs", () => dispatchCatalogJobs(this.env));
      } catch {
        operationalLog("warn", {
          event: "workflow.delivery-deferred",
          outcome: "deferred",
          code: "catalog-terminal-dispatch",
          aggregateType: "catalog",
          aggregateId: event.payload.jobId,
        });
      }
    }
  }
}
