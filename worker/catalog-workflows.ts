import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { canonicalJsonBytes } from "../src/core/canonical-json";
import type { BuiltinLanguage } from "../src/core/types";
import { parseStandaloneProblemBundle } from "../src/judge/problem-catalog-loader";
import { deriveContestPublic } from "../src/online-judge/contest-public";
import { assertJudgeDataMatchesPracticePublic } from "../src/online-judge/judge-data";
import { validateJudgePackage } from "../src/online-judge/judge-package";
import { parseContestPublicProblemProjection } from "../src/online-judge/public-projection";
import {
  MAX_JUDGE_PACKAGE_BYTES,
  MAX_PUBLIC_BUNDLE_BYTES,
  MAX_REPOSITORY_MANIFEST_BYTES,
  REPOSITORY_ROOT_PATH,
  parseRepositoryContests,
  parseRepositoryProblems,
  parseRepositoryRoot,
  validateRepositoryCatalog,
  type RepositoryObjectDescriptor,
  type RepositoryProblem,
} from "../src/online-judge/repository-contract";
import {
  boundedDeclaredBlob,
  catalogRepositoryById,
  declaredBlob,
  exactCommitTree,
  readBoundedBlob,
  readVerifiedBlob,
  type AuthorizedCatalogRepository,
  type ExactGitBlob,
} from "./catalog-github";
import { dispatchCatalogJobs } from "./catalog-dispatcher";
import {
  failCatalogSync,
  persistCatalogSync,
  type CatalogSyncContext,
  type ValidatedCatalogProblem,
} from "./catalog-persistence";
import { parseCatalogWorkflowParameters, type CatalogWorkflowParameters } from "./catalog-workflow-identity";
import type { WasmOjWorkerEnv } from "./env";
import { operationalLog } from "./structured-log";

export type { CatalogWorkflowParameters } from "./catalog-workflow-identity";

function digestBytes(digest: string): Uint8Array {
  return Uint8Array.from(digest.match(/.{2}/g) ?? [], (byte) => Number.parseInt(byte, 16));
}

function parseJson(bytes: Uint8Array, label: string): unknown {
  let text: string;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch (error) { throw new TypeError(`${label} must be valid UTF-8.`, { cause: error }); }
  try { return JSON.parse(text) as unknown; }
  catch (error) { throw new TypeError(`${label} must be valid JSON.`, { cause: error }); }
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index += 1) if (left[index] !== right[index]) return false;
  return true;
}

function jsonBytes(value: unknown): Uint8Array {
  return canonicalJsonBytes(value);
}

function sameLocalizedText(
  left: { readonly "zh-TW": string; readonly en: string },
  right: { readonly "zh-TW": string; readonly en: string },
): boolean {
  return left["zh-TW"] === right["zh-TW"] && left.en === right.en;
}

function r2Sha256(object: R2Object): string | undefined {
  return object.checksums.toJSON().sha256;
}

function assertJudgeObject(object: R2Object | null, descriptor: RepositoryObjectDescriptor): void {
  if (
    !object
    || object.size !== descriptor.bytes
    || r2Sha256(object) !== descriptor.sha256
  ) throw new Error("R2 judge package disagrees with its content identity.");
}

export async function ensureJudgeCacheObject(
  env: WasmOjWorkerEnv,
  descriptor: RepositoryObjectDescriptor,
  bytes: Uint8Array,
): Promise<void> {
  const key = `judge-packages/v2/${descriptor.sha256}`;
  const existing = await env.JUDGE_BUCKET.head(key);
  if (existing) {
    assertJudgeObject(existing, descriptor);
    return;
  }
  const created = await env.JUDGE_BUCKET.put(key, bytes, {
    onlyIf: { etagDoesNotMatch: "*" },
    sha256: digestBytes(descriptor.sha256),
    httpMetadata: { contentType: "application/octet-stream" },
  });
  assertJudgeObject(created ?? await env.JUDGE_BUCKET.head(key), descriptor);
}

async function readDescriptor(
  repository: AuthorizedCatalogRepository,
  tree: ReadonlyMap<string, ExactGitBlob>,
  descriptor: RepositoryObjectDescriptor,
  maximumBytes: number,
): Promise<Uint8Array> {
  const blob = declaredBlob(tree, descriptor.path, descriptor.bytes, maximumBytes);
  return readVerifiedBlob(repository, blob, descriptor.sha256, maximumBytes);
}

async function validateProblem(
  env: WasmOjWorkerEnv,
  repository: AuthorizedCatalogRepository,
  tree: ReadonlyMap<string, ExactGitBlob>,
  problem: RepositoryProblem,
): Promise<ValidatedCatalogProblem> {
  const [practiceBytes, contestBytes, judgeBytes] = await Promise.all([
    readDescriptor(repository, tree, problem.practiceBundle, MAX_PUBLIC_BUNDLE_BYTES),
    readDescriptor(repository, tree, problem.contestBundle, MAX_PUBLIC_BUNDLE_BYTES),
    readDescriptor(repository, tree, problem.judgePackage, MAX_JUDGE_PACKAGE_BYTES),
  ]);
  const practiceValue = parseJson(practiceBytes, `problem '${problem.slug}' practice projection`);
  const contestValue = parseJson(contestBytes, `problem '${problem.slug}' contest projection`);
  const practice = parseStandaloneProblemBundle(practiceValue);
  const contest = parseContestPublicProblemProjection(contestValue);
  if (
    practice.id !== problem.slug
    || practice.number !== problem.order
    || !sameLocalizedText(practice.title, problem.title)
  ) throw new TypeError(`Problem '${problem.slug}' manifest metadata disagrees with its public projection.`);
  if (!bytesEqual(jsonBytes(deriveContestPublic(practice)), jsonBytes(contest.problem))) {
    throw new TypeError(`Problem '${problem.slug}' contest projection is not the required redaction.`);
  }
  const validated = await validateJudgePackage(judgeBytes, {
    expectedBytes: problem.judgePackage.bytes,
    expectedSha256: problem.judgePackage.sha256,
  });
  const languages = Object.keys(validated.manifest.allowedProfiles).sort() as BuiltinLanguage[];
  assertJudgeDataMatchesPracticePublic(validated.judgeData, practice, languages);
  await ensureJudgeCacheObject(env, problem.judgePackage, judgeBytes);
  return { source: problem, allowedProfilesJson: JSON.stringify(validated.manifest.allowedProfiles) };
}

async function syncContext(env: WasmOjWorkerEnv, jobId: string): Promise<CatalogSyncContext> {
  const row = await env.DB.prepare(`SELECT jobs.id AS jobId, jobs.catalog_id AS catalogId,
      catalogs.github_repository_id AS githubRepositoryId, jobs.commit_sha AS commitSha,
      jobs.requested_by AS requestedBy, jobs.state
    FROM catalog_sync_jobs AS jobs JOIN catalogs ON catalogs.id=jobs.catalog_id WHERE jobs.id=?`)
    .bind(jobId).first<CatalogSyncContext>();
  if (!row) throw new Error("Catalog sync job does not exist.");
  return row;
}

async function runSync(env: WasmOjWorkerEnv, opaque: unknown): Promise<{ readonly commitSha: string }> {
  const parameters = parseCatalogWorkflowParameters(opaque);
  const context = await syncContext(env, parameters.syncJobId);
  if (context.state === "succeeded") return { commitSha: context.commitSha };
  if (context.state !== "running") throw new Error(`Catalog sync job is not runnable from '${context.state}'.`);
  const repository = await catalogRepositoryById(env, context.githubRepositoryId);
  const tree = await exactCommitTree(repository, context.commitSha);
  const rootBlob = boundedDeclaredBlob(tree, REPOSITORY_ROOT_PATH, MAX_REPOSITORY_MANIFEST_BYTES);
  const root = parseRepositoryRoot(await readBoundedBlob(repository, rootBlob, MAX_REPOSITORY_MANIFEST_BYTES));
  const problemsBlob = boundedDeclaredBlob(tree, root.problems, MAX_REPOSITORY_MANIFEST_BYTES);
  const contestsBlob = boundedDeclaredBlob(tree, root.contests, MAX_REPOSITORY_MANIFEST_BYTES);
  const problems = parseRepositoryProblems(await readBoundedBlob(repository, problemsBlob, MAX_REPOSITORY_MANIFEST_BYTES));
  const contests = parseRepositoryContests(await readBoundedBlob(repository, contestsBlob, MAX_REPOSITORY_MANIFEST_BYTES));
  validateRepositoryCatalog(root, problems, contests);
  const validated: ValidatedCatalogProblem[] = [];
  for (const problem of problems.problems) validated.push(await validateProblem(env, repository, tree, problem));
  await persistCatalogSync(env, context, validated, contests.contests);
  return { commitSha: context.commitSha };
}

export class CatalogWorkflow extends WorkflowEntrypoint<WasmOjWorkerEnv, CatalogWorkflowParameters> {
  async run(event: WorkflowEvent<CatalogWorkflowParameters>, step: WorkflowStep): Promise<unknown> {
    const parameters = parseCatalogWorkflowParameters(event.payload);
    try {
      return await step.do("sync exact commit catalog", () => runSync(this.env, parameters));
    } catch (error) {
      await step.do("record catalog sync failure", () => failCatalogSync(this.env, parameters.syncJobId, error));
      throw error;
    } finally {
      try { await step.do("dispatch next catalog sync", () => dispatchCatalogJobs(this.env)); }
      catch {
        operationalLog("warn", {
          event: "workflow.delivery-deferred", outcome: "deferred", code: "catalog-sync-terminal-dispatch",
          aggregateType: "catalog", aggregateId: parameters.syncJobId,
        });
      }
    }
  }
}
