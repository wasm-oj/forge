import { isBuiltinLanguage, type BuiltinLanguage } from "../src/core/types";
import { parseJudgeAllowedProfiles } from "../src/online-judge/compile-profiles";
import {
  PromptCompilerError,
  promptCompilerResultToAssistDraft,
  verifyPromptCompilerPublicContext,
  type PromptAssistDraft,
  type PromptCompilerOutputProfile,
  type PromptCompilerPublicContext,
  type PromptCompilerRegistry,
} from "../src/online-judge/prompt-compiler";
import { requireBrowserOrBearerMutationSession } from "./auth";
import { loadContestRuntimeSnapshot } from "./contest-runtime";
import { sha256Hex } from "./crypto";
import type { AuthenticatedSession, WasmOjWorkerEnv } from "./env";
import { ApiError, jsonResponse, readJsonBody } from "./http";
import {
  hostPromptAssistPolicy,
  hostPromptCompilerRegistry,
  type HostPromptAssistPolicy,
} from "./prompt-compiler-registry";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const COMMIT = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const UTF8 = new TextEncoder();

export interface PracticePromptAssistContext {
  readonly kind: "practice";
  readonly problemId: string;
  readonly catalogCommit: string;
  readonly publicContextSha256: string;
}

export interface ContestPromptAssistContext {
  readonly kind: "contest";
  readonly contestId: string;
  readonly problemId: string;
  readonly contentCommit: string;
  readonly timelineGeneration: number;
  readonly ruleEpoch: number;
  readonly problemEpoch: number;
  readonly publicContextSha256: string;
}

export type PromptAssistContext = PracticePromptAssistContext | ContestPromptAssistContext;

export interface PromptAssistRequest {
  readonly context: PromptAssistContext;
  readonly language: BuiltinLanguage;
  readonly entry: string;
  readonly prompt: string;
}

export interface PromptAssistResponse extends PromptAssistDraft {
  readonly schema: "wasm-oj-platform/prompt-assist-result/v1";
  readonly context: PromptAssistContext;
}

interface PromptAssistPublicContextDescriptor {
  readonly sha256: string;
  readonly bytes: number;
  readonly storageKey: string;
}

type PromptAssistAdmissionGuard =
  | {
      readonly kind: "practice";
      readonly catalogCommit: string;
      readonly practiceBundleSha256: string;
    }
  | {
      readonly kind: "contest";
      readonly entrantId: string;
      readonly rulesCommit: string;
      readonly rulesDigest: string;
      readonly timelineGeneration: number;
      readonly ruleEpoch: number;
      readonly problemEpoch: number;
      readonly contentEpoch: number;
      readonly contentCommit: string;
    };

export interface PromptAssistAdmission {
  readonly context: PromptAssistContext;
  readonly output: PromptCompilerOutputProfile;
  readonly publicContext: PromptAssistPublicContextDescriptor;
  readonly guard: PromptAssistAdmissionGuard;
}

export interface PromptAssistHost {
  loadAdmission(input: PromptAssistRequest): Promise<PromptAssistAdmission>;
  loadPublicContext(descriptor: PromptAssistPublicContextDescriptor): Promise<PromptCompilerPublicContext>;
}

function exactObject(value: unknown, keys: readonly string[], label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ApiError(400, "prompt-assist-request-invalid", `${label} must be an object.`);
  }
  const record = value as Record<string, unknown>;
  const actual = Object.keys(record).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new ApiError(400, "prompt-assist-request-invalid", `${label} has an invalid shape.`);
  }
  return record;
}

function uuid(value: unknown, label: string): string {
  if (typeof value !== "string" || !UUID.test(value)) {
    throw new ApiError(400, "prompt-assist-request-invalid", `${label} must be a UUID.`);
  }
  return value;
}

function commit(value: unknown, label: string): string {
  if (typeof value !== "string" || !COMMIT.test(value)) {
    throw new ApiError(400, "prompt-assist-request-invalid", `${label} must be a lowercase Git commit SHA.`);
  }
  return value;
}

function digest(value: unknown, label: string): string {
  if (typeof value !== "string" || !SHA256.test(value)) {
    throw new ApiError(400, "prompt-assist-request-invalid", `${label} must be a lowercase SHA-256 digest.`);
  }
  return value;
}

function epoch(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new ApiError(400, "prompt-assist-request-invalid", `${label} must be a positive integer.`);
  }
  return value as number;
}

export function parsePromptAssistRequest(value: unknown): PromptAssistRequest {
  const input = exactObject(value, ["context", "entry", "language", "prompt"], "Prompt Assist request");
  if (typeof input.language !== "string" || !isBuiltinLanguage(input.language)) {
    throw new ApiError(400, "prompt-assist-request-invalid", "language is unsupported.");
  }
  if (typeof input.entry !== "string") {
    throw new ApiError(400, "prompt-assist-request-invalid", "entry must be a normalized relative source path.");
  }
  if (typeof input.prompt !== "string") {
    throw new ApiError(400, "prompt-assist-request-invalid", "prompt must be one UTF-8 string.");
  }
  const rawContext = exactObject(
    input.context,
    input.context && typeof input.context === "object" && !Array.isArray(input.context)
      && (input.context as Record<string, unknown>).kind === "practice"
      ? ["catalogCommit", "kind", "problemId", "publicContextSha256"]
      : [
          "contentCommit", "contestId", "kind", "problemEpoch", "problemId",
          "publicContextSha256", "ruleEpoch", "timelineGeneration",
        ],
    "Prompt Assist context",
  );
  let context: PromptAssistContext;
  if (rawContext.kind === "practice") {
    context = {
      kind: "practice",
      problemId: uuid(rawContext.problemId, "context.problemId"),
      catalogCommit: commit(rawContext.catalogCommit, "context.catalogCommit"),
      publicContextSha256: digest(rawContext.publicContextSha256, "context.publicContextSha256"),
    };
  } else if (rawContext.kind === "contest") {
    context = {
      kind: "contest",
      contestId: uuid(rawContext.contestId, "context.contestId"),
      problemId: uuid(rawContext.problemId, "context.problemId"),
      contentCommit: commit(rawContext.contentCommit, "context.contentCommit"),
      timelineGeneration: epoch(rawContext.timelineGeneration, "context.timelineGeneration"),
      ruleEpoch: epoch(rawContext.ruleEpoch, "context.ruleEpoch"),
      problemEpoch: epoch(rawContext.problemEpoch, "context.problemEpoch"),
      publicContextSha256: digest(rawContext.publicContextSha256, "context.publicContextSha256"),
    };
  } else {
    throw new ApiError(400, "prompt-assist-request-invalid", "context.kind must be practice or contest.");
  }
  return { context, language: input.language, entry: input.entry, prompt: input.prompt };
}

function sameValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function assertAdmission(input: PromptAssistRequest, admission: PromptAssistAdmission): void {
  if (!sameValue(admission.context, input.context)) {
    throw new ApiError(409, "assist-context-stale", "Prompt Assist context changed before generation began.");
  }
  if (admission.output.language !== input.language || admission.output.entry !== input.entry) {
    throw new ApiError(409, "assist-context-stale", "Prompt Assist output profile changed before generation began.");
  }
  if (admission.publicContext.sha256 !== input.context.publicContextSha256) {
    throw new ApiError(409, "assist-context-stale", "Prompt Assist public context changed before generation began.");
  }
}

function compilerError(error: PromptCompilerError): ApiError {
  return new ApiError(error.status, error.code, error.message, {
    retryable: error.retryable,
  });
}

export class PromptAssistService {
  constructor(
    private readonly registry: PromptCompilerRegistry,
    private readonly policy: HostPromptAssistPolicy | null,
    private readonly host: PromptAssistHost,
  ) {}

  async generate(value: unknown, signal?: AbortSignal): Promise<PromptAssistResponse> {
    const input = parsePromptAssistRequest(value);
    const policy = this.policy;
    if (!policy || !this.registry.isAvailable(policy.compilerConfigId, policy.compilerConfigDigest)) {
      throw new ApiError(503, "prompt-compiler-unavailable", "Prompt Assist is unavailable on this deployment.");
    }
    const admission = await this.host.loadAdmission(input);
    assertAdmission(input, admission);
    const publicContext = await this.host.loadPublicContext(admission.publicContext);
    let verifiedContext: PromptCompilerPublicContext;
    try {
      verifiedContext = await verifyPromptCompilerPublicContext(publicContext);
    } catch {
      throw new ApiError(503, "prompt-context-unavailable", "Prompt Assist public context failed integrity verification.");
    }
    if (
      verifiedContext.sha256 !== admission.publicContext.sha256
      || UTF8.encode(verifiedContext.content).byteLength !== admission.publicContext.bytes
    ) {
      throw new ApiError(503, "prompt-context-unavailable", "Prompt Assist public context does not match its catalog descriptor.");
    }
    let generated;
    try {
      generated = await this.registry.compile({
        compilerConfigId: policy.compilerConfigId,
        compilerConfigDigest: policy.compilerConfigDigest,
        output: admission.output,
        limits: policy.limits,
        publicContext: verifiedContext,
        prompt: input.prompt,
        ...(signal ? { signal } : {}),
      });
    } catch (error) {
      if (error instanceof PromptCompilerError) throw compilerError(error);
      throw error;
    }
    const current = await this.host.loadAdmission(input);
    assertAdmission(input, current);
    if (!sameValue(current.guard, admission.guard)
      || !sameValue(current.publicContext, admission.publicContext)
      || !sameValue(current.output, admission.output)) {
      throw new ApiError(409, "assist-context-stale", "Prompt Assist context changed while source was generated.");
    }
    const draft = promptCompilerResultToAssistDraft(generated);
    return {
      schema: "wasm-oj-platform/prompt-assist-result/v1",
      context: input.context,
      output: draft.output,
      entry: draft.entry,
      sourceFiles: draft.sourceFiles,
    };
  }
}

interface PracticeAdmissionRow {
  readonly problem_id: string;
  readonly active_commit_sha: string;
  readonly practice_enabled: number;
  readonly practice_bundle_sha256: string;
  readonly allowed_profiles_json: string;
  readonly context_bytes: number | null;
  readonly context_storage_key: string | null;
}

interface ContestAdmissionRow {
  readonly rules_commit: string;
  readonly rules_sha256: string;
  readonly status: "draft" | "published" | "archived";
  readonly official_track: "code" | "prompt-program";
  readonly ai_assist: "allowed" | "disabled" | null;
  readonly runtime_state: "scheduled" | "running" | "paused" | "ended";
  readonly timeline_generation: number;
  readonly rules_epoch: number;
  readonly entrant_id: string;
  readonly entrant_state: "joined" | "active" | "eliminated" | "completed";
  readonly entrant_state_generation: number;
  readonly problem_epoch: number;
  readonly content_epoch: number;
  readonly content_commit: string;
  readonly allowed_profiles_json: string;
  readonly public_context_sha256: string | null;
  readonly context_bytes: number | null;
  readonly context_storage_key: string | null;
  readonly reveal_eligible: number;
}

function outputProfile(
  allowedProfilesJson: string,
  language: BuiltinLanguage,
  entry: string,
): PromptCompilerOutputProfile {
  let profiles;
  try {
    profiles = parseJudgeAllowedProfiles(JSON.parse(allowedProfilesJson) as unknown, "stored problem allowedProfiles");
  } catch {
    throw new ApiError(503, "prompt-output-profile-invalid", "Published compile profiles are invalid.");
  }
  const profile = profiles[language];
  if (!profile) throw new ApiError(400, "prompt-output-profile-invalid", `The problem does not allow ${language}.`);
  return { language, target: profile.target, optimization: profile.optimization, entry };
}

async function practiceAdmission(
  env: WasmOjWorkerEnv,
  input: PromptAssistRequest & { readonly context: PracticePromptAssistContext },
): Promise<PromptAssistAdmission> {
  const row = await env.DB.prepare(`SELECT problems.id AS problem_id,
      catalogs.active_commit_sha, revisions.practice_enabled,
      revisions.practice_bundle_sha256, revisions.allowed_profiles_json,
      contexts.bytes AS context_bytes, contexts.storage_key AS context_storage_key
    FROM problem_series AS problems
    JOIN catalogs ON catalogs.id=problems.catalog_id
    JOIN problem_revisions AS revisions
      ON revisions.problem_id=problems.id AND revisions.commit_sha=catalogs.active_commit_sha
    LEFT JOIN prompt_public_contexts AS contexts
      ON contexts.sha256=revisions.practice_bundle_sha256
    WHERE problems.id=?`)
    .bind(input.context.problemId).first<PracticeAdmissionRow>();
  if (!row || row.practice_enabled !== 1) {
    throw new ApiError(404, "prompt-assist-not-found", "Active practice problem was not found.");
  }
  if (row.active_commit_sha !== input.context.catalogCommit
    || row.practice_bundle_sha256 !== input.context.publicContextSha256) {
    throw new ApiError(409, "assist-context-stale", "Practice content changed; reload the problem before using Assist.");
  }
  if (row.context_bytes === null || row.context_storage_key === null) {
    throw new ApiError(503, "prompt-context-unavailable", "Practice Prompt Assist context is unavailable.");
  }
  return {
    context: input.context,
    output: outputProfile(row.allowed_profiles_json, input.language, input.entry),
    publicContext: {
      sha256: input.context.publicContextSha256,
      bytes: row.context_bytes,
      storageKey: row.context_storage_key,
    },
    guard: {
      kind: "practice",
      catalogCommit: row.active_commit_sha,
      practiceBundleSha256: row.practice_bundle_sha256,
    },
  };
}

async function contestAdmission(
  env: WasmOjWorkerEnv,
  session: AuthenticatedSession,
  input: PromptAssistRequest & { readonly context: ContestPromptAssistContext },
): Promise<PromptAssistAdmission> {
  const snapshot = await loadContestRuntimeSnapshot(env, input.context.contestId, session);
  if (snapshot.rules.officialTrack.kind !== "code" || snapshot.rules.officialTrack.aiAssist !== "allowed") {
    throw new ApiError(409, "assist-not-allowed", "This contest does not allow Prompt Assist.");
  }
  if (snapshot.state !== "running") {
    throw new ApiError(409, "assist-problem-not-open", "The contest is not accepting new Prompt Assist requests.");
  }
  if (!snapshot.entrant || snapshot.entrant.state !== "active") {
    throw new ApiError(409, "contest-entrant-ineligible", "Join and start the contest before using Prompt Assist.");
  }
  const runtimeProblem = snapshot.problems.find((problem) => problem.problemId === input.context.problemId);
  const projectedProblem = runtimeProblem
    ? snapshot.projection.problems.find((problem) => problem.slug === runtimeProblem.problemSlug)
    : undefined;
  if (!runtimeProblem || !projectedProblem) {
    throw new ApiError(404, "prompt-assist-not-found", "Contest problem was not found.");
  }
  if (snapshot.epochs.timelineGeneration !== input.context.timelineGeneration
    || snapshot.epochs.ruleEpoch !== input.context.ruleEpoch
    || runtimeProblem.problemEpoch !== input.context.problemEpoch
    || runtimeProblem.contentCommit !== input.context.contentCommit) {
    throw new ApiError(409, "assist-context-stale", "Contest content epochs changed; reload the problem before using Assist.");
  }
  if (projectedProblem.availability !== "open") {
    throw new ApiError(409, "assist-problem-not-open", "The contest problem is not open for Prompt Assist.");
  }
  const row = await env.DB.prepare(`SELECT runtime.active_rules_commit AS rules_commit,
      runtime.active_rules_sha256 AS rules_sha256, rules.status,
      rules.official_track, rules.ai_assist, runtime.state AS runtime_state,
      runtime.timeline_generation, runtime.rules_epoch,
      entrants.id AS entrant_id, entrants.state AS entrant_state,
      entrants.state_timeline_generation AS entrant_state_generation,
      epochs.problem_epoch, epochs.content_epoch, epochs.content_commit,
      revisions.allowed_profiles_json,
      epoch_context.public_context_sha256,
      contexts.bytes AS context_bytes, contexts.storage_key AS context_storage_key,
      EXISTS (SELECT 1 FROM contest_reveal_grants AS grants
        WHERE grants.contest_id=runtime.contest_id AND grants.entrant_id=entrants.id
          AND grants.problem_id=epochs.problem_id
          AND grants.timeline_generation=runtime.timeline_generation
          AND grants.rules_epoch=runtime.rules_epoch
          AND grants.content_epoch=epochs.content_epoch
          AND grants.eligibility='eligible') AS reveal_eligible
    FROM contest_runtimes AS runtime
    JOIN contest_rule_revisions AS rules
      ON rules.contest_id=runtime.contest_id
     AND rules.rules_commit=runtime.active_rules_commit
     AND rules.rules_sha256=runtime.active_rules_sha256
    JOIN contest_rule_problems AS selected
      ON selected.contest_id=runtime.contest_id
     AND selected.rules_commit=runtime.active_rules_commit
     AND selected.problem_id=?
    JOIN contest_entrants AS entrants
      ON entrants.contest_id=runtime.contest_id AND entrants.kind='account'
     AND entrants.owner_user_id=?
    JOIN contest_problem_epochs AS epochs
      ON epochs.contest_id=runtime.contest_id
     AND epochs.problem_id=selected.problem_id AND epochs.state='effective'
    JOIN problem_revisions AS revisions
      ON revisions.problem_id=epochs.problem_id AND revisions.commit_sha=epochs.content_commit
    LEFT JOIN contest_problem_prompt_contexts AS epoch_context
      ON epoch_context.contest_id=epochs.contest_id
     AND epoch_context.problem_id=epochs.problem_id
     AND epoch_context.content_epoch=epochs.content_epoch
    LEFT JOIN prompt_public_contexts AS contexts
      ON contexts.sha256=epoch_context.public_context_sha256
    WHERE runtime.contest_id=?`)
    .bind(input.context.problemId, session.userId, input.context.contestId)
    .first<ContestAdmissionRow>();
  if (!row) throw new ApiError(404, "prompt-assist-not-found", "Contest problem or entrant was not found.");
  if (row.status !== "published" || row.official_track !== "code" || row.ai_assist !== "allowed") {
    throw new ApiError(409, "assist-not-allowed", "This contest does not allow Prompt Assist.");
  }
  if (row.runtime_state !== "running" || row.entrant_state !== "active"
    || row.entrant_state_generation !== row.timeline_generation || row.reveal_eligible !== 1) {
    throw new ApiError(409, "assist-problem-not-open", "Contest admission changed before Prompt Assist generation.");
  }
  if (row.timeline_generation !== input.context.timelineGeneration
    || row.rules_epoch !== input.context.ruleEpoch
    || row.problem_epoch !== input.context.problemEpoch
    || row.content_commit !== input.context.contentCommit
    || row.public_context_sha256 !== input.context.publicContextSha256) {
    throw new ApiError(409, "assist-context-stale", "Contest content epochs changed; reload the problem before using Assist.");
  }
  if (row.context_bytes === null || row.context_storage_key === null) {
    throw new ApiError(503, "prompt-context-unavailable", "Contest Prompt Assist context is unavailable.");
  }
  return {
    context: input.context,
    output: outputProfile(row.allowed_profiles_json, input.language, input.entry),
    publicContext: {
      sha256: input.context.publicContextSha256,
      bytes: row.context_bytes,
      storageKey: row.context_storage_key,
    },
    guard: {
      kind: "contest",
      entrantId: row.entrant_id,
      rulesCommit: row.rules_commit,
      rulesDigest: row.rules_sha256,
      timelineGeneration: row.timeline_generation,
      ruleEpoch: row.rules_epoch,
      problemEpoch: row.problem_epoch,
      contentEpoch: row.content_epoch,
      contentCommit: row.content_commit,
    },
  };
}

export function createPromptAssistHost(
  env: WasmOjWorkerEnv,
  session: AuthenticatedSession,
): PromptAssistHost {
  return {
    loadAdmission(input) {
      return input.context.kind === "practice"
        ? practiceAdmission(env, input as PromptAssistRequest & { readonly context: PracticePromptAssistContext })
        : contestAdmission(env, session, input as PromptAssistRequest & { readonly context: ContestPromptAssistContext });
    },
    async loadPublicContext(descriptor) {
      const object = await env.JUDGE_BUCKET.get(descriptor.storageKey);
      if (!object || object.size !== descriptor.bytes || object.size < 1) {
        throw new ApiError(503, "prompt-context-unavailable", "Prompt Assist public context object is unavailable.");
      }
      const bytes = new Uint8Array(await object.arrayBuffer());
      if (await sha256Hex(bytes) !== descriptor.sha256) {
        throw new ApiError(503, "prompt-context-unavailable", "Prompt Assist public context object failed its digest fence.");
      }
      let content: string;
      try {
        content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      } catch {
        throw new ApiError(503, "prompt-context-unavailable", "Prompt Assist public context object is not UTF-8.");
      }
      return { content, sha256: descriptor.sha256 };
    },
  };
}

export async function createPromptAssistDraft(request: Request, env: WasmOjWorkerEnv): Promise<Response> {
  const session = await requireBrowserOrBearerMutationSession(request, env);
  const service = new PromptAssistService(
    hostPromptCompilerRegistry(),
    hostPromptAssistPolicy(),
    createPromptAssistHost(env, session),
  );
  const result = await service.generate(await readJsonBody(request, 128 * 1024), request.signal);
  return jsonResponse(result, 200);
}
