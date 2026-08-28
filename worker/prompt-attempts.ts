import {
  PromptCompilerError,
  type PromptCompilerGeneratedSource,
  type PromptCompilerPublicContext,
  type PromptCompilerRegistry,
  parsePromptCompilerLimits,
  validatePromptCompilerPrompt,
  verifyPromptCompilerPublicContext,
} from "../src/online-judge/prompt-compiler";
import { isBuiltinLanguage, type BuiltinLanguage, type OptimizationLevel, type TargetAbi } from "../src/core/types";
import { sha256Hex } from "./crypto";
import { ApiError } from "./http";

export type PromptAttemptState =
  | "reserved"
  | "generating"
  | "source-ready"
  | "submitted"
  | "failed"
  | "cancelled";

export type PromptAttemptQuotaState = "reserved" | "consumed" | "released" | "invalid";

export type PromptAttemptEventType =
  | "reserved"
  | "generation-started"
  | "response-received"
  | "source-ready"
  | "submission-created"
  | "failed"
  | "cancelled"
  | "quota-released"
  | "invalidated"
  | "reconciled"
  | "erased";

export interface CreatePromptAttemptInput {
  readonly ownerUserId: string;
  readonly contestId: string;
  readonly problemId: string;
  readonly timelineGeneration: number;
  readonly rulesEpoch: number;
  readonly problemEpoch: number;
  readonly publicContextSha256: string;
  readonly prompt: string;
  readonly idempotencyKey: string;
}

export interface PromptAttemptReservation {
  readonly attempt: PromptAttemptDetail;
  readonly created: boolean;
}

export interface PromptAttemptDetail {
  readonly attemptId: string;
  readonly contestId: string;
  readonly entrantId: string;
  readonly problemId: string;
  readonly timelineGeneration: number;
  readonly rulesEpoch: number;
  readonly problemEpoch: number;
  readonly contentEpoch: number;
  readonly judgeEpoch: number;
  readonly compilerConfigId: string;
  readonly compilerConfigDigest: string;
  readonly publicContextSha256: string;
  readonly prompt: string | null;
  readonly promptBytes: number | null;
  readonly promptSha256: string | null;
  readonly output: {
    readonly language: BuiltinLanguage;
    readonly target: TargetAbi;
    readonly optimization: OptimizationLevel;
    readonly entry: string;
  };
  readonly state: PromptAttemptState;
  readonly quota: {
    readonly slot: number;
    readonly limit: number;
    readonly state: PromptAttemptQuotaState;
    readonly settlementReason: string | null;
  };
  readonly generatedSourceId: string | null;
  readonly generatedSourceSha256: string | null;
  readonly submissionId: string | null;
  readonly admittedLogicalSeconds: number;
  readonly evidenceLogicalSeconds: number | null;
  readonly responseReceivedAt: string | null;
  readonly sourceReadyAt: string | null;
  readonly terminalAt: string | null;
  readonly providerDurationMs: number | null;
  readonly failureCode: string | null;
  readonly eligibility: "eligible" | "invalid";
  readonly invalidationReason: string | null;
  readonly erasedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface PromptAttemptHistoryItem {
  readonly attemptId: string;
  readonly contestId: string;
  readonly problemId: string;
  readonly state: PromptAttemptState;
  readonly quotaState: PromptAttemptQuotaState;
  readonly submissionId: string | null;
  readonly failureCode: string | null;
  readonly eligibility: "eligible" | "invalid";
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface PromptAttemptHistoryQuery {
  readonly ownerUserId: string;
  readonly contestId: string;
  readonly problemId?: string;
  readonly before?: { readonly createdAt: string; readonly attemptId: string };
  readonly limit?: number;
}

export interface PromptAttemptEvent {
  readonly sequence: number;
  readonly type: PromptAttemptEventType;
  readonly payload: Readonly<Record<string, string | number | boolean | null>>;
  readonly timestamp: string;
}

export interface PromptAttemptEventsQuery {
  readonly ownerUserId: string;
  readonly attemptId: string;
  readonly after?: number;
  readonly limit?: number;
}

export interface PromptAttemptPublicContextRequest {
  readonly contestId: string;
  readonly problemId: string;
  readonly contentCommit: string;
  readonly contentEpoch: number;
  readonly sha256: string;
  readonly storageKey: string;
}

export interface PromptGeneratedSubmissionRequest {
  readonly attemptId: string;
  readonly ownerUserId: string;
  readonly contestId: string;
  readonly entrantId: string;
  readonly problemId: string;
  readonly timelineGeneration: number;
  readonly rulesEpoch: number;
  readonly problemEpoch: number;
  readonly contentEpoch: number;
  readonly judgeEpoch: number;
  readonly contentCommit: string;
  readonly judgeDigest: string;
  readonly admittedLogicalSeconds: number;
  /** Null only when an already-admitted generation finishes after its official timeline was invalidated. */
  readonly sourceReadyLogicalSeconds: number | null;
  readonly timelineDisposition: "current" | "invalid-history";
  readonly evidenceAt: "input-admitted" | "generated-source-ready" | "judge-terminal";
  readonly eligibility: "eligible" | "invalid";
  readonly invalidatedAt: string | null;
  readonly invalidationReason: string | null;
  readonly generatedSource: PromptCompilerGeneratedSource;
}

export interface PromptGeneratedSubmissionResult {
  readonly sourceId: string;
  readonly sourceSha256: string;
  readonly submissionId: string;
}

/**
 * The host owns storage and the existing Official Submission pipeline. The
 * callback must be idempotent by attemptId and atomically create a ready,
 * owned `prompt-generated` source, its normal submission, and the matching v2
 * contest submission sidecar before resolving.
 */
export interface PromptAttemptHost {
  loadPublicContext(request: PromptAttemptPublicContextRequest): Promise<PromptCompilerPublicContext>;
  admitGeneratedSource(request: PromptGeneratedSubmissionRequest): Promise<PromptGeneratedSubmissionResult>;
}

export interface PromptAttemptServiceOptions {
  readonly database: D1Database;
  readonly registry: PromptCompilerRegistry;
  readonly host: PromptAttemptHost;
  readonly now?: () => Date;
  readonly randomUUID?: () => string;
  readonly monotonicNow?: () => number;
}

interface AdmissionRow {
  readonly contest_id: string;
  readonly entrant_id: string;
  readonly owner_user_id: string;
  readonly problem_id: string;
  readonly rules_commit: string;
  readonly runtime_state: "scheduled" | "running" | "paused" | "ended";
  readonly timeline_generation: number;
  readonly rules_epoch: number;
  readonly wall_anchor_at: string | null;
  readonly logical_anchor_seconds: number;
  readonly clock_kind: "global" | "individual";
  readonly duration_seconds: number;
  readonly official_track: "code" | "prompt-program";
  readonly evidence_at: "input-admitted" | "generated-source-ready" | "judge-terminal";
  readonly compiler_config_id: string | null;
  readonly compiler_config_sha256: string | null;
  readonly prompt_max_bytes: number | null;
  readonly input_tokens: number | null;
  readonly output_tokens: number | null;
  readonly generated_source_bytes: number | null;
  readonly timeout_seconds: number | null;
  readonly release_after_seconds: number;
  readonly submission_closes_after_seconds: number;
  readonly attempt_limit: number;
  readonly output_language: string | null;
  readonly output_target: string | null;
  readonly output_optimization: string | null;
  readonly output_entry_path: string | null;
  readonly entrant_state: "joined" | "active" | "eliminated" | "completed";
  readonly entrant_state_generation: number;
  readonly entrant_started_at: string | null;
  readonly entrant_wall_anchor_at: string | null;
  readonly entrant_logical_anchor_seconds: number;
  readonly problem_epoch: number;
  readonly content_epoch: number;
  readonly judge_epoch: number;
  readonly content_commit: string;
  readonly judge_digest: string;
  readonly reveal_eligible: number;
  readonly context_bytes: number | null;
  readonly context_storage_key: string | null;
}

interface SubmissionEligibility {
  readonly eligibility: "eligible" | "invalid";
  readonly invalidatedAt: string | null;
  readonly invalidationReason: string | null;
}

type PromptResponseDisposition = "current" | "invalid-history";

interface PromptAttemptRow {
  readonly id: string;
  readonly contest_id: string;
  readonly entrant_id: string;
  readonly problem_id: string;
  readonly timeline_generation: number;
  readonly rules_epoch: number;
  readonly problem_epoch: number;
  readonly content_epoch: number;
  readonly judge_epoch: number;
  readonly compiler_config_id: string;
  readonly compiler_config_sha256: string;
  readonly public_context_sha256: string;
  readonly prompt_text: string | null;
  readonly prompt_bytes: number | null;
  readonly prompt_sha256: string | null;
  readonly output_language: string;
  readonly output_target: string;
  readonly output_optimization: string;
  readonly output_entry_path: string;
  readonly state: PromptAttemptState;
  readonly generated_source_id: string | null;
  readonly generated_source_sha256: string | null;
  readonly submission_id: string | null;
  readonly admitted_logical_seconds: number;
  readonly evidence_logical_seconds: number | null;
  readonly response_received_at: string | null;
  readonly source_ready_at: string | null;
  readonly terminal_at: string | null;
  readonly provider_duration_ms: number | null;
  readonly failure_code: string | null;
  readonly eligibility: "eligible" | "invalid";
  readonly invalidation_reason: string | null;
  readonly erased_at: string | null;
  readonly created_at: string;
  readonly updated_at: string;
  readonly quota_slot: number;
  readonly configured_limit: number;
  readonly quota_state: PromptAttemptQuotaState;
  readonly settlement_reason: string | null;
}

interface LogicalRow {
  readonly runtime_state: "scheduled" | "running" | "paused" | "ended";
  readonly timeline_generation: number;
  readonly duration_seconds: number;
  readonly clock_kind: "global" | "individual";
  readonly wall_anchor_at: string | null;
  readonly logical_anchor_seconds: number;
  readonly entrant_wall_anchor_at: string | null;
  readonly entrant_logical_anchor_seconds: number;
}

interface PromptIdempotencyRow {
  readonly request_sha256: string;
  readonly prompt_attempt_id: string;
}

interface DurablePromptProduct {
  readonly product: PromptGeneratedSubmissionResult;
  readonly evidenceLogicalSeconds: number | null;
  readonly eligibility: SubmissionEligibility;
  readonly sourceReadyAt: string;
  readonly ready: boolean;
}

interface ReconciledPromptProductRow {
  readonly attempt_id: string;
  readonly submission_id: string;
  readonly source_id: string;
  readonly source_sha256: string;
  readonly source_ready_at: string;
  readonly evidence_logical_seconds: number | null;
  readonly eligibility: "eligible" | "invalid";
  readonly invalidated_at: string | null;
  readonly invalidation_reason: string | null;
}

interface ReservedPromptWork extends AdmissionRow {
  readonly attempt_id: string;
  readonly attempt_state: PromptAttemptState;
  readonly quota_state: PromptAttemptQuotaState;
  readonly public_context_sha256: string;
  readonly prompt_text: string | null;
  readonly admitted_logical_seconds: number;
}

interface EventRow {
  readonly id: number;
  readonly event_type: string;
  readonly payload_json: string;
  readonly created_at: string;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$/;
const EVENT_TYPES = new Set<PromptAttemptEventType>([
  "reserved",
  "generation-started",
  "response-received",
  "source-ready",
  "submission-created",
  "failed",
  "cancelled",
  "quota-released",
  "invalidated",
  "reconciled",
  "erased",
]);
const UTF8_ENCODER = new TextEncoder();

export class PromptAttemptService {
  readonly #database: D1Database;
  readonly #registry: PromptCompilerRegistry;
  readonly #host: PromptAttemptHost;
  readonly #now: () => Date;
  readonly #randomUUID: () => string;
  readonly #monotonicNow: () => number;

  constructor(options: PromptAttemptServiceOptions) {
    if (!options || typeof options !== "object") throw new TypeError("Prompt attempt service options are required.");
    this.#database = options.database;
    this.#registry = options.registry;
    this.#host = options.host;
    this.#now = options.now ?? (() => new Date());
    this.#randomUUID = options.randomUUID ?? (() => crypto.randomUUID());
    this.#monotonicNow = options.monotonicNow ?? (() => performance.now());
  }

  /** Validate every admission fence and durably reserve quota before returning. */
  async reserve(inputValue: CreatePromptAttemptInput, attemptIdValue?: string): Promise<PromptAttemptReservation> {
    const input = parseCreateInput(inputValue);
    const requestSha256 = await promptAttemptRequestSha256(input);
    const replay = await this.#idempotency(input.ownerUserId, input.idempotencyKey);
    if (replay) {
      if (replay.request_sha256 !== requestSha256) {
        throw new ApiError(409, "prompt-idempotency-conflict", "idempotencyKey was already used for another prompt attempt request.");
      }
      return { attempt: await this.detail(replay.prompt_attempt_id, input.ownerUserId), created: false };
    }
    const admission = await this.#loadAdmission(input);
    this.#assertAdmission(admission, input);
    if (!admission.compiler_config_id || !admission.compiler_config_sha256) {
      throw new ApiError(503, "prompt-compiler-config-invalid", "Prompt compiler config is incomplete.");
    }
    if (!this.#registry.isAvailable(admission.compiler_config_id, admission.compiler_config_sha256)) {
      throw new ApiError(
        503,
        "prompt-compiler-unavailable",
        "The contest's Prompt Compiler is unavailable.",
      );
    }
    let compilerLimits;
    try {
      compilerLimits = parsePromptCompilerLimits({
        promptBytes: admission.prompt_max_bytes,
        inputTokens: admission.input_tokens,
        outputTokens: admission.output_tokens,
        generatedSourceBytes: admission.generated_source_bytes,
        timeoutSeconds: admission.timeout_seconds,
      });
    } catch {
      throw new ApiError(503, "prompt-compiler-config-invalid", "Prompt compiler limits are incomplete or invalid.");
    }
    let prompt: string;
    try {
      prompt = validatePromptCompilerPrompt(input.prompt, compilerLimits.promptBytes);
    } catch (error) {
      if (error instanceof PromptCompilerError) throw new ApiError(error.status, error.code, error.message);
      throw error;
    }
    if (admission.context_bytes === null || admission.context_storage_key === null) {
      throw new ApiError(503, "prompt-context-unavailable", "Prompt compiler public context is unavailable.");
    }
    let publicContext: PromptCompilerPublicContext;
    try {
      const loaded = await this.#host.loadPublicContext({
        contestId: admission.contest_id,
        problemId: admission.problem_id,
        contentCommit: admission.content_commit,
        contentEpoch: admission.content_epoch,
        sha256: input.publicContextSha256,
        storageKey: admission.context_storage_key,
      });
      publicContext = await verifyPromptCompilerPublicContext(loaded);
    } catch (error) {
      throw new ApiError(503, "prompt-context-unavailable", "Prompt compiler public context failed integrity verification.", {
        reason: publicFailureCode(error),
      });
    }
    if (
      publicContext.sha256 !== input.publicContextSha256
      || UTF8_ENCODER.encode(publicContext.content).byteLength !== admission.context_bytes
    ) {
      throw new ApiError(503, "prompt-context-unavailable", "Prompt compiler public context does not match its catalog descriptor.");
    }

    const admittedAt = validNow(this.#now());
    const admittedLogicalSeconds = logicalSeconds(admission, admittedAt);
    if (
      admittedLogicalSeconds < admission.release_after_seconds
      || admittedLogicalSeconds >= admission.submission_closes_after_seconds
      || admittedLogicalSeconds >= admission.duration_seconds
    ) {
      throw new ApiError(409, "prompt-attempt-window-closed", "The problem is not accepting Prompt Program attempts.");
    }
    const attemptId = attemptIdValue ?? this.#randomUUID();
    assertUuid(attemptId, "Generated prompt attempt ID");
    const promptBytes = UTF8_ENCODER.encode(prompt).byteLength;
    const promptSha256 = await sha256Hex(prompt);
    const created = await this.#reserve({
      attemptId,
      input,
      admission,
      prompt,
      promptBytes,
      promptSha256,
      admittedLogicalSeconds,
      requestSha256,
      timestamp: admittedAt.toISOString(),
    });
    const reservedAttemptId = created ? attemptId : (await this.#idempotency(input.ownerUserId, input.idempotencyKey))!.prompt_attempt_id;
    return { attempt: await this.detail(reservedAttemptId, input.ownerUserId), created };
  }

  /**
   * Resume one already-reserved attempt. Only the transition from `reserved`
   * to `generating` owns the provider invocation, so workflow replay or a
   * duplicate runner never calls the model twice.
   */
  async runReserved(attemptId: string): Promise<PromptAttemptDetail> {
    assertUuid(attemptId, "Prompt attempt ID");
    const work = await this.#loadReservedWork(attemptId);
    if (!work) throw new ApiError(404, "prompt-attempt-not-found", "Prompt attempt does not exist.");
    if (work.attempt_state !== "reserved" || work.quota_state !== "reserved") {
      return this.detail(attemptId, work.owner_user_id);
    }
    if (!work.compiler_config_id || !work.compiler_config_sha256
      || !this.#registry.isAvailable(work.compiler_config_id, work.compiler_config_sha256)) {
      await this.#releaseReservedFailure(attemptId, "prompt-compiler-unavailable", validNow(this.#now()).toISOString());
      return this.detail(attemptId, work.owner_user_id);
    }
    let compilerLimits;
    try {
      compilerLimits = parsePromptCompilerLimits({
        promptBytes: work.prompt_max_bytes,
        inputTokens: work.input_tokens,
        outputTokens: work.output_tokens,
        generatedSourceBytes: work.generated_source_bytes,
        timeoutSeconds: work.timeout_seconds,
      });
    } catch {
      await this.#releaseReservedFailure(attemptId, "prompt-compiler-config-invalid", validNow(this.#now()).toISOString());
      return this.detail(attemptId, work.owner_user_id);
    }
    if (work.prompt_text === null || work.context_bytes === null || work.context_storage_key === null) {
      await this.#releaseReservedFailure(attemptId, "prompt-context-unavailable", validNow(this.#now()).toISOString());
      return this.detail(attemptId, work.owner_user_id);
    }
    const generationStartedAt = validNow(this.#now()).toISOString();
    if (!await this.#beginGeneration(attemptId, generationStartedAt)) {
      return this.detail(attemptId, work.owner_user_id);
    }
    let publicContext: PromptCompilerPublicContext;
    try {
      publicContext = await verifyPromptCompilerPublicContext(await this.#host.loadPublicContext({
        contestId: work.contest_id,
        problemId: work.problem_id,
        contentCommit: work.content_commit,
        contentEpoch: work.content_epoch,
        sha256: work.public_context_sha256,
        storageKey: work.context_storage_key,
      }));
      if (publicContext.sha256 !== work.public_context_sha256
        || UTF8_ENCODER.encode(publicContext.content).byteLength !== work.context_bytes) {
        throw new Error("Prompt compiler public context does not match its durable descriptor.");
      }
    } catch (error) {
      await this.#releaseFailure(
        attemptId,
        publicFailureCode(error) === "prompt-provider-failure" ? "prompt-context-unavailable" : publicFailureCode(error),
        0,
        validNow(this.#now()).toISOString(),
      );
      return this.detail(attemptId, work.owner_user_id);
    }

    const started = this.#monotonicNow();
    let generated: Awaited<ReturnType<PromptCompilerRegistry["compile"]>>;
    try {
      generated = await this.#registry.compile({
        compilerConfigId: work.compiler_config_id,
        compilerConfigDigest: work.compiler_config_sha256,
        output: {
          language: work.output_language as BuiltinLanguage,
          target: work.output_target as TargetAbi,
          optimization: work.output_optimization as OptimizationLevel,
          entry: work.output_entry_path!,
        },
        limits: compilerLimits,
        publicContext,
        prompt: work.prompt_text,
      });
    } catch (error) {
      const duration = elapsedMilliseconds(started, this.#monotonicNow());
      const timestamp = validNow(this.#now()).toISOString();
      if (error instanceof PromptCompilerError && error.attemptDisposition === "consume") {
        await this.#consumeFailure(attemptId, error.code, duration, timestamp);
      } else {
        await this.#releaseFailure(attemptId, publicFailureCode(error), duration, timestamp);
      }
      return this.detail(attemptId, work.owner_user_id);
    }
    const providerDurationMs = elapsedMilliseconds(started, this.#monotonicNow());
    if (!sameOutput(generated.output, work)) {
      await this.#consumeFailure(
        attemptId,
        "prompt-output-profile-mismatch",
        providerDurationMs,
        validNow(this.#now()).toISOString(),
      );
      return this.detail(attemptId, work.owner_user_id);
    }
    const responseAt = validNow(this.#now());
    let timelineDisposition = await this.#recordResponse(
      attemptId,
      providerDurationMs,
      responseAt.toISOString(),
    );
    if (timelineDisposition === null) {
      await this.#invalidate(attemptId, "timeline-changed-during-generation", responseAt.toISOString());
      return this.detail(attemptId, work.owner_user_id);
    }
    let sourceReadyLogicalSeconds: number | null = null;
    let submissionEligibility: SubmissionEligibility | null = null;
    if (timelineDisposition === "current") {
      sourceReadyLogicalSeconds = await this.#currentLogicalSeconds(attemptId, responseAt);
      if (sourceReadyLogicalSeconds !== null) {
        submissionEligibility = generatedSourceEligibility(
          work,
          sourceReadyLogicalSeconds,
          responseAt.toISOString(),
        );
      } else {
        submissionEligibility = await this.#invalidHistoryEligibility(attemptId);
        if (submissionEligibility) timelineDisposition = "invalid-history";
      }
    } else {
      submissionEligibility = await this.#invalidHistoryEligibility(attemptId);
    }
    if (!submissionEligibility) {
      await this.#invalidate(attemptId, "timeline-changed-during-generation", responseAt.toISOString());
      return this.detail(attemptId, work.owner_user_id);
    }

    let product = await this.#admitExactProduct(
      attemptId,
      work,
      generated,
      sourceReadyLogicalSeconds,
      timelineDisposition,
      submissionEligibility,
    );
    if (!product && timelineDisposition === "current") {
      const invalidEligibility = await this.#invalidHistoryEligibility(attemptId);
      if (invalidEligibility) {
        timelineDisposition = "invalid-history";
        sourceReadyLogicalSeconds = null;
        submissionEligibility = invalidEligibility;
        product = await this.#admitExactProduct(
          attemptId,
          work,
          generated,
          sourceReadyLogicalSeconds,
          timelineDisposition,
          submissionEligibility,
        );
      }
    }
    if (!product) {
      if (timelineDisposition === "invalid-history") {
        await this.#settleInvalidHistoryFailure(
          attemptId,
          await this.#durableAttemptProduct(attemptId, work.owner_user_id),
          validNow(this.#now()).toISOString(),
        );
        return this.detail(attemptId, work.owner_user_id);
      }
      const released = await this.#hostFailure(attemptId, validNow(this.#now()).toISOString());
      if (!released) {
        const invalidEligibility = await this.#invalidHistoryEligibility(attemptId);
        if (invalidEligibility) {
          timelineDisposition = "invalid-history";
          sourceReadyLogicalSeconds = null;
          submissionEligibility = invalidEligibility;
          product = await this.#admitExactProduct(
            attemptId,
            work,
            generated,
            sourceReadyLogicalSeconds,
            timelineDisposition,
            submissionEligibility,
          );
          if (!product) {
            await this.#settleInvalidHistoryFailure(
              attemptId,
              await this.#durableAttemptProduct(attemptId, work.owner_user_id),
              validNow(this.#now()).toISOString(),
            );
            return this.detail(attemptId, work.owner_user_id);
          }
        } else {
          const racedProduct = await this.#durableHostProduct(
            attemptId,
            work.owner_user_id,
            work,
            work.admitted_logical_seconds,
            sourceReadyLogicalSeconds,
            submissionEligibility,
          );
          if (racedProduct) product = racedProduct;
          else {
            const pendingProduct = await this.#durableAttemptProduct(attemptId, work.owner_user_id);
            if (pendingProduct) await this.#retainDurableProductFailure(attemptId, validNow(this.#now()).toISOString());
            return this.detail(attemptId, work.owner_user_id);
          }
        }
      } else {
        return this.detail(attemptId, work.owner_user_id);
      }
    }
    const completedAt = validNow(this.#now()).toISOString();
    const completed = timelineDisposition === "invalid-history"
      ? await this.#completeInvalidHistory(
        attemptId,
        product,
        evidenceLogicalSeconds(work.evidence_at, work.admitted_logical_seconds, sourceReadyLogicalSeconds),
        submissionEligibility,
        responseAt.toISOString(),
        completedAt,
      )
      : await this.#complete(
        attemptId,
        product,
        evidenceLogicalSeconds(work.evidence_at, work.admitted_logical_seconds, sourceReadyLogicalSeconds),
        submissionEligibility,
        responseAt.toISOString(),
        completedAt,
      );
    if (!completed) {
      const invalidEligibility = await this.#invalidHistoryEligibility(attemptId);
      const durable = await this.#durableAttemptProduct(attemptId, work.owner_user_id);
      if (invalidEligibility && durable?.ready) {
        await this.#completeInvalidHistory(
          attemptId,
          durable.product,
          durable.evidenceLogicalSeconds,
          durable.eligibility,
          durable.sourceReadyAt,
          completedAt,
        );
      } else if (invalidEligibility) {
        await this.#settleInvalidHistoryFailure(attemptId, durable, completedAt);
      } else {
        await this.#invalidate(attemptId, "timeline-changed-during-submission-admission", completedAt);
      }
    }
    return this.detail(attemptId, work.owner_user_id);
  }

  /** Convenience wrapper used by tests and non-Workflow hosts. */
  async create(inputValue: CreatePromptAttemptInput): Promise<PromptAttemptDetail> {
    const reserved = await this.reserve(inputValue);
    return this.runReserved(reserved.attempt.attemptId);
  }

  /** Settle a workflow-dispatch failure without making the durable attempt disappear. */
  async failWorkflowDispatch(attemptId: string): Promise<void> {
    assertUuid(attemptId, "Prompt attempt ID");
    await this.#releaseReservedFailure(
      attemptId,
      "prompt-workflow-unavailable",
      validNow(this.#now()).toISOString(),
      true,
    );
  }

  async markWorkflowDispatched(attemptId: string): Promise<void> {
    assertUuid(attemptId, "Prompt attempt ID");
    const timestamp = validNow(this.#now()).toISOString();
    await this.#database.prepare(`UPDATE prompt_attempt_dispatches
      SET state='delivered', settled_at=?, last_error=NULL, updated_at=?
      WHERE prompt_attempt_id=? AND state='pending'`)
      .bind(timestamp, timestamp, attemptId).run();
  }

  /** Terminal settlement used when the durable Workflow step itself fails. */
  async failWorkflowExecution(attemptId: string): Promise<PromptAttemptDetail> {
    assertUuid(attemptId, "Prompt attempt ID");
    const work = await this.#loadReservedWork(attemptId);
    if (!work) throw new ApiError(404, "prompt-attempt-not-found", "Prompt attempt does not exist.");
    const timestamp = validNow(this.#now()).toISOString();
    if (work.attempt_state === "reserved" && work.quota_state === "reserved") {
      await this.#releaseReservedFailure(attemptId, "prompt-workflow-execution-failure", timestamp);
    } else if (work.attempt_state === "generating") {
      if (work.quota_state === "reserved") {
        await this.#releaseFailure(attemptId, "prompt-workflow-execution-failure", 0, timestamp);
      } else if (work.quota_state === "consumed") {
        let durable = await this.#durableAttemptProduct(attemptId, work.owner_user_id);
        if (!durable) {
          const released = await this.#hostFailure(attemptId, timestamp);
          if (!released) durable = await this.#durableAttemptProduct(attemptId, work.owner_user_id);
        }
        if (durable?.ready) {
          const completed = await this.#complete(
            attemptId,
            durable.product,
            durable.evidenceLogicalSeconds,
            durable.eligibility,
            durable.sourceReadyAt,
            timestamp,
          );
          if (!completed) await this.#invalidate(attemptId, "timeline-changed-during-submission-admission", timestamp);
        } else if (durable) {
          await this.#retainDurableProductFailure(attemptId, timestamp);
        }
      } else if (work.quota_state === "invalid") {
        await this.#settleInvalidHistoryFailure(
          attemptId,
          await this.#durableAttemptProduct(attemptId, work.owner_user_id),
          timestamp,
        );
      }
    }
    return this.detail(attemptId, work.owner_user_id);
  }

  async detail(attemptId: string, ownerUserId: string): Promise<PromptAttemptDetail> {
    assertUuid(attemptId, "Prompt attempt ID");
    assertOwner(ownerUserId);
    const row = await this.#database.prepare(`${PROMPT_ATTEMPT_SELECT}
      WHERE attempts.id=? AND entrants.owner_user_id=?`)
      .bind(attemptId, ownerUserId).first<PromptAttemptRow>();
    if (!row) throw new ApiError(404, "prompt-attempt-not-found", "Prompt attempt does not exist.");
    return detailFromRow(row);
  }

  async events(queryValue: PromptAttemptEventsQuery): Promise<readonly PromptAttemptEvent[]> {
    const query = parseEventsQuery(queryValue);
    const rows = await this.#database.prepare(`SELECT events.id, events.event_type,
        events.payload_json, events.created_at
      FROM prompt_attempt_events AS events
      JOIN prompt_attempts AS attempts ON attempts.id=events.prompt_attempt_id
      JOIN contest_entrants AS entrants
        ON entrants.id=attempts.entrant_id AND entrants.contest_id=attempts.contest_id
      WHERE attempts.id=? AND entrants.owner_user_id=? AND events.id>?
      ORDER BY events.id ASC LIMIT ?`)
      .bind(query.attemptId, query.ownerUserId, query.after, query.limit).all<EventRow>();
    if (rows.results.length === 0) {
      const owned = await this.#database.prepare(`SELECT 1 AS owned
        FROM prompt_attempts AS attempts
        JOIN contest_entrants AS entrants
          ON entrants.id=attempts.entrant_id AND entrants.contest_id=attempts.contest_id
        WHERE attempts.id=? AND entrants.owner_user_id=?`)
        .bind(query.attemptId, query.ownerUserId).first<{ readonly owned: number }>();
      if (!owned) throw new ApiError(404, "prompt-attempt-not-found", "Prompt attempt does not exist.");
    }
    return rows.results.map(eventFromRow);
  }

  async history(queryValue: PromptAttemptHistoryQuery): Promise<readonly PromptAttemptHistoryItem[]> {
    const query = parseHistoryQuery(queryValue);
    const problemClause = query.problemId === undefined ? "" : " AND attempts.problem_id=?";
    const cursorClause = query.before === undefined
      ? ""
      : " AND (attempts.created_at<? OR (attempts.created_at=? AND attempts.id<?))";
    const rows = await this.#database.prepare(`SELECT attempts.id, attempts.contest_id,
        attempts.problem_id, attempts.state, quota.state AS quota_state,
        attempts.submission_id, attempts.failure_code, attempts.eligibility,
        attempts.created_at, attempts.updated_at
      FROM prompt_attempts AS attempts
      JOIN contest_entrants AS entrants
        ON entrants.id=attempts.entrant_id AND entrants.contest_id=attempts.contest_id
      JOIN prompt_attempt_quota AS quota ON quota.prompt_attempt_id=attempts.id
      WHERE entrants.owner_user_id=? AND attempts.contest_id=?${problemClause}${cursorClause}
      ORDER BY attempts.created_at DESC, attempts.id DESC LIMIT ?`)
      .bind(
        query.ownerUserId,
        query.contestId,
        ...(query.problemId === undefined ? [] : [query.problemId]),
        ...(query.before === undefined
          ? []
          : [query.before.createdAt, query.before.createdAt, query.before.attemptId]),
        query.limit,
      ).all<{
        readonly id: string;
        readonly contest_id: string;
        readonly problem_id: string;
        readonly state: PromptAttemptState;
        readonly quota_state: PromptAttemptQuotaState;
        readonly submission_id: string | null;
        readonly failure_code: string | null;
        readonly eligibility: "eligible" | "invalid";
        readonly created_at: string;
        readonly updated_at: string;
      }>();
    return rows.results.map((row) => ({
      attemptId: row.id,
      contestId: row.contest_id,
      problemId: row.problem_id,
      state: row.state,
      quotaState: row.quota_state,
      submissionId: row.submission_id,
      failureCode: row.failure_code,
      eligibility: row.eligibility,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
  }

  async #loadAdmission(input: CreatePromptAttemptInput): Promise<AdmissionRow> {
    const row = await this.#database.prepare(`SELECT runtime.contest_id,
        entrants.id AS entrant_id, entrants.owner_user_id, rule_problems.problem_id,
        revisions.rules_commit, runtime.state AS runtime_state,
        runtime.timeline_generation, runtime.rules_epoch, runtime.wall_anchor_at,
        runtime.logical_anchor_seconds, revisions.clock_kind, revisions.duration_seconds,
        revisions.official_track, revisions.evidence_at,
        revisions.prompt_compiler_config_id AS compiler_config_id,
        revisions.prompt_compiler_config_sha256 AS compiler_config_sha256,
        revisions.prompt_max_bytes, revisions.prompt_input_tokens AS input_tokens,
        revisions.prompt_output_tokens AS output_tokens,
        revisions.prompt_generated_source_bytes AS generated_source_bytes,
        revisions.prompt_timeout_seconds AS timeout_seconds,
        rule_problems.release_after_seconds, rule_problems.submission_closes_after_seconds,
        rule_problems.attempt_limit, rule_problems.output_language,
        rule_problems.output_target, rule_problems.output_optimization,
        rule_problems.output_entry_path,
        entrants.state AS entrant_state,
        entrants.state_timeline_generation AS entrant_state_generation,
        entrants.started_at AS entrant_started_at,
        entrants.individual_wall_anchor_at AS entrant_wall_anchor_at,
        entrants.individual_logical_anchor_seconds AS entrant_logical_anchor_seconds,
        epochs.problem_epoch, epochs.content_epoch, epochs.judge_epoch,
        epochs.content_commit, epochs.judge_digest,
        EXISTS (SELECT 1 FROM contest_reveal_grants AS grants
          WHERE grants.contest_id=runtime.contest_id AND grants.entrant_id=entrants.id
            AND grants.problem_id=rule_problems.problem_id
            AND grants.timeline_generation=runtime.timeline_generation
            AND grants.rules_epoch=runtime.rules_epoch
            AND grants.problem_epoch=epochs.problem_epoch
            AND grants.content_epoch=epochs.content_epoch
            AND grants.eligibility='eligible') AS reveal_eligible,
        contexts.bytes AS context_bytes, contexts.storage_key AS context_storage_key
      FROM contest_runtimes AS runtime
      JOIN contest_rule_revisions AS revisions
        ON revisions.contest_id=runtime.contest_id
       AND revisions.rules_commit=runtime.active_rules_commit
       AND revisions.rules_sha256=runtime.active_rules_sha256
      JOIN contest_rule_problems AS rule_problems
        ON rule_problems.contest_id=runtime.contest_id
       AND rule_problems.rules_commit=runtime.active_rules_commit
      JOIN contest_entrants AS entrants
        ON entrants.contest_id=runtime.contest_id AND entrants.kind='account'
       AND entrants.owner_user_id=?
      JOIN contest_problem_epochs AS epochs
        ON epochs.contest_id=runtime.contest_id
       AND epochs.problem_id=rule_problems.problem_id AND epochs.state='effective'
      JOIN contest_problem_prompt_contexts AS epoch_context
        ON epoch_context.contest_id=epochs.contest_id
       AND epoch_context.problem_id=epochs.problem_id
       AND epoch_context.content_epoch=epochs.content_epoch
      JOIN prompt_public_contexts AS contexts
        ON contexts.sha256=epoch_context.public_context_sha256 AND contexts.sha256=?
      WHERE runtime.contest_id=? AND rule_problems.problem_id=?`)
      .bind(input.ownerUserId, input.publicContextSha256, input.contestId, input.problemId)
      .first<AdmissionRow>();
    if (!row) throw new ApiError(404, "prompt-program-not-found", "Prompt Program problem or entrant was not found.");
    return row;
  }

  #assertAdmission(row: AdmissionRow, input: CreatePromptAttemptInput): void {
    if (row.timeline_generation !== input.timelineGeneration
      || row.rules_epoch !== input.rulesEpoch
      || row.problem_epoch !== input.problemEpoch) {
      throw new ApiError(409, "contest-epoch-stale", "Prompt Program admission epochs are stale.");
    }
    if (row.official_track !== "prompt-program") {
      throw new ApiError(409, "prompt-program-disabled", "This contest does not use Prompt Program submissions.");
    }
    if (row.runtime_state !== "running") {
      throw new ApiError(409, "contest-not-accepting-submissions", "The contest is not accepting new submissions.");
    }
    if (!(["joined", "active"] as const).includes(row.entrant_state as "joined" | "active")) {
      throw new ApiError(409, "contest-entrant-ineligible", "The entrant cannot create Prompt Program attempts.");
    }
    if (row.entrant_state_generation !== row.timeline_generation) {
      throw new ApiError(409, "contest-timeline-stale", "The entrant state belongs to another contest timeline.");
    }
    if (row.clock_kind === "individual" && (row.entrant_started_at === null || row.entrant_wall_anchor_at === null)) {
      throw new ApiError(409, "contest-not-started", "Start the individual contest clock before creating an attempt.");
    }
    if (row.reveal_eligible !== 1) {
      throw new ApiError(409, "contest-problem-locked", "The problem is not revealed in this timeline.");
    }
    if (
      row.output_language === null
      || !isBuiltinLanguage(row.output_language)
      || (row.output_target !== "wasip1" && row.output_target !== "wasix")
      || (row.output_optimization !== "debug" && row.output_optimization !== "release")
      || !row.output_entry_path
    ) {
      throw new ApiError(503, "prompt-output-profile-invalid", "Prompt Program output profile is invalid.");
    }
  }

  async #loadReservedWork(attemptId: string): Promise<ReservedPromptWork | null> {
    return this.#database.prepare(`SELECT attempts.id AS attempt_id,
        attempts.contest_id, attempts.entrant_id, entrants.owner_user_id,
        attempts.problem_id, rule_epoch.rules_commit,
        runtime.state AS runtime_state, attempts.timeline_generation,
        attempts.rules_epoch, runtime.wall_anchor_at, runtime.logical_anchor_seconds,
        revisions.clock_kind, revisions.duration_seconds, revisions.official_track,
        revisions.evidence_at, attempts.compiler_config_id,
        attempts.compiler_config_sha256, revisions.prompt_max_bytes,
        revisions.prompt_input_tokens AS input_tokens,
        revisions.prompt_output_tokens AS output_tokens,
        revisions.prompt_generated_source_bytes AS generated_source_bytes,
        revisions.prompt_timeout_seconds AS timeout_seconds,
        rule_problems.release_after_seconds,
        rule_problems.submission_closes_after_seconds,
        rule_problems.attempt_limit, attempts.output_language,
        attempts.output_target, attempts.output_optimization,
        attempts.output_entry_path, entrants.state AS entrant_state,
        entrants.state_timeline_generation AS entrant_state_generation,
        entrants.started_at AS entrant_started_at,
        entrants.individual_wall_anchor_at AS entrant_wall_anchor_at,
        entrants.individual_logical_anchor_seconds AS entrant_logical_anchor_seconds,
        attempts.problem_epoch, attempts.content_epoch, attempts.judge_epoch,
        problem_epoch.content_commit, problem_epoch.judge_digest,
        1 AS reveal_eligible, contexts.bytes AS context_bytes,
        contexts.storage_key AS context_storage_key,
        attempts.state AS attempt_state, quota.state AS quota_state,
        attempts.public_context_sha256, attempts.prompt_text,
        attempts.admitted_logical_seconds
      FROM prompt_attempts AS attempts
      JOIN prompt_attempt_quota AS quota ON quota.prompt_attempt_id=attempts.id
      JOIN contest_entrants AS entrants
        ON entrants.id=attempts.entrant_id AND entrants.contest_id=attempts.contest_id
      JOIN contest_runtimes AS runtime ON runtime.contest_id=attempts.contest_id
      JOIN contest_rule_epochs AS rule_epoch
        ON rule_epoch.contest_id=attempts.contest_id
       AND rule_epoch.rules_epoch=attempts.rules_epoch
      JOIN contest_rule_revisions AS revisions
        ON revisions.contest_id=rule_epoch.contest_id
       AND revisions.rules_commit=rule_epoch.rules_commit
       AND revisions.rules_sha256=rule_epoch.rules_sha256
      JOIN contest_rule_problems AS rule_problems
        ON rule_problems.contest_id=attempts.contest_id
       AND rule_problems.rules_commit=rule_epoch.rules_commit
       AND rule_problems.problem_id=attempts.problem_id
      JOIN contest_problem_epochs AS problem_epoch
        ON problem_epoch.contest_id=attempts.contest_id
       AND problem_epoch.problem_id=attempts.problem_id
       AND problem_epoch.problem_epoch=attempts.problem_epoch
       AND problem_epoch.content_epoch=attempts.content_epoch
       AND problem_epoch.judge_epoch=attempts.judge_epoch
      JOIN prompt_public_contexts AS contexts
        ON contexts.sha256=attempts.public_context_sha256
      WHERE attempts.id=?`)
      .bind(attemptId).first<ReservedPromptWork>();
  }

  async #idempotency(ownerUserId: string, idempotencyKey: string): Promise<PromptIdempotencyRow | null> {
    return this.#database.prepare(`SELECT request_sha256, prompt_attempt_id
      FROM prompt_attempt_idempotency WHERE owner_user_id=? AND idempotency_key=?`)
      .bind(ownerUserId, idempotencyKey).first<PromptIdempotencyRow>();
  }

  async #reserve(input: {
    readonly attemptId: string;
    readonly input: CreatePromptAttemptInput;
    readonly admission: AdmissionRow;
    readonly prompt: string;
    readonly promptBytes: number;
    readonly promptSha256: string;
    readonly admittedLogicalSeconds: number;
    readonly requestSha256: string;
    readonly timestamp: string;
  }): Promise<boolean> {
      const attempt = this.#database.prepare(`INSERT INTO prompt_attempts
        (id, contest_id, entrant_id, problem_id, timeline_generation, rules_epoch,
         problem_epoch, content_epoch, judge_epoch, compiler_config_id, compiler_config_sha256,
         public_context_sha256, prompt_text, prompt_bytes, prompt_sha256,
         output_language, output_target, output_optimization, output_entry_path,
         state, generated_source_id, generated_source_sha256, submission_id,
         admitted_logical_seconds, evidence_logical_seconds,
         response_received_at, source_ready_at, terminal_at, provider_duration_ms,
         failure_code, eligibility, invalidated_at, invalidation_reason, erased_at,
         created_at, updated_at)
      SELECT ?, runtime.contest_id, entrants.id, rule_problems.problem_id,
        runtime.timeline_generation, runtime.rules_epoch, epochs.problem_epoch, epochs.content_epoch,
        epochs.judge_epoch, revisions.prompt_compiler_config_id,
        revisions.prompt_compiler_config_sha256, contexts.sha256, ?, ?, ?,
        rule_problems.output_language, rule_problems.output_target,
        rule_problems.output_optimization, rule_problems.output_entry_path,
        'reserved', NULL, NULL, NULL, ?,
        CASE WHEN revisions.evidence_at='input-admitted' THEN ? ELSE NULL END,
        NULL, NULL, NULL, NULL, NULL, 'eligible', NULL, NULL, NULL, ?, ?
      FROM contest_runtimes AS runtime
      JOIN contest_rule_revisions AS revisions
        ON revisions.contest_id=runtime.contest_id
       AND revisions.rules_commit=runtime.active_rules_commit
       AND revisions.rules_sha256=runtime.active_rules_sha256
      JOIN contest_rule_problems AS rule_problems
        ON rule_problems.contest_id=runtime.contest_id
       AND rule_problems.rules_commit=runtime.active_rules_commit
      JOIN contest_entrants AS entrants
        ON entrants.contest_id=runtime.contest_id AND entrants.id=?
       AND entrants.owner_user_id=? AND entrants.kind='account'
      JOIN contest_problem_epochs AS epochs
        ON epochs.contest_id=runtime.contest_id
       AND epochs.problem_id=rule_problems.problem_id AND epochs.state='effective'
      JOIN contest_problem_prompt_contexts AS epoch_context
        ON epoch_context.contest_id=epochs.contest_id
       AND epoch_context.problem_id=epochs.problem_id
       AND epoch_context.content_epoch=epochs.content_epoch
      JOIN prompt_public_contexts AS contexts
        ON contexts.sha256=epoch_context.public_context_sha256 AND contexts.sha256=?
      WHERE runtime.contest_id=? AND rule_problems.problem_id=?
        AND runtime.active_rules_commit=?
        AND runtime.timeline_generation=? AND runtime.rules_epoch=?
        AND runtime.state='running'
        AND runtime.wall_anchor_at IS ? AND runtime.logical_anchor_seconds=?
        AND revisions.official_track='prompt-program'
        AND revisions.prompt_compiler_config_id=?
        AND revisions.prompt_compiler_config_sha256=?
        AND entrants.state IN ('joined','active')
        AND entrants.state_timeline_generation=runtime.timeline_generation
        AND entrants.individual_wall_anchor_at IS ?
        AND entrants.individual_logical_anchor_seconds=?
        AND epochs.problem_epoch=? AND epochs.content_epoch=? AND epochs.judge_epoch=?
        AND contexts.bytes=? AND contexts.storage_key=?
        AND EXISTS (SELECT 1 FROM contest_reveal_grants AS grants
          WHERE grants.contest_id=runtime.contest_id AND grants.entrant_id=entrants.id
            AND grants.problem_id=rule_problems.problem_id
            AND grants.timeline_generation=runtime.timeline_generation
            AND grants.rules_epoch=runtime.rules_epoch
            AND grants.problem_epoch=epochs.problem_epoch
            AND grants.content_epoch=epochs.content_epoch AND grants.eligibility='eligible')
        AND ?>=rule_problems.release_after_seconds
        AND ?<rule_problems.submission_closes_after_seconds
        AND NOT EXISTS (
          SELECT 1 FROM contest_rule_checkpoints AS checkpoint
          WHERE checkpoint.contest_id=runtime.contest_id
            AND checkpoint.rules_commit=runtime.active_rules_commit
            AND checkpoint.at_seconds<=?
            AND NOT EXISTS (
              SELECT 1 FROM contest_checkpoint_runs AS checkpoint_run
              JOIN contest_checkpoint_decisions AS decision
                ON decision.checkpoint_run_id=checkpoint_run.id
               AND decision.entrant_id=entrants.id
               AND decision.decision='advanced'
              WHERE checkpoint_run.contest_id=runtime.contest_id
                AND checkpoint_run.checkpoint_id=checkpoint.checkpoint_id
                AND checkpoint_run.timeline_generation=runtime.timeline_generation
                AND checkpoint_run.rules_epoch=runtime.rules_epoch
                AND checkpoint_run.state IN ('provisional','final')
            )
        )
        AND (SELECT COUNT(*) FROM prompt_attempt_quota AS quota
          JOIN prompt_attempts AS prior ON prior.id=quota.prompt_attempt_id
          WHERE quota.contest_id=runtime.contest_id AND quota.entrant_id=entrants.id
            AND quota.problem_id=rule_problems.problem_id
            AND prior.eligibility='eligible'
            AND quota.state IN ('reserved','consumed')) < rule_problems.attempt_limit`)
      .bind(
        input.attemptId,
        input.prompt,
        input.promptBytes,
        input.promptSha256,
        input.admittedLogicalSeconds,
        input.admittedLogicalSeconds,
        input.timestamp,
        input.timestamp,
        input.admission.entrant_id,
        input.input.ownerUserId,
        input.input.publicContextSha256,
        input.input.contestId,
        input.input.problemId,
        input.admission.rules_commit,
        input.admission.timeline_generation,
        input.admission.rules_epoch,
        input.admission.wall_anchor_at,
        input.admission.logical_anchor_seconds,
        input.admission.compiler_config_id,
        input.admission.compiler_config_sha256,
        input.admission.entrant_wall_anchor_at,
        input.admission.entrant_logical_anchor_seconds,
        input.admission.problem_epoch,
        input.admission.content_epoch,
        input.admission.judge_epoch,
        input.admission.context_bytes,
        input.admission.context_storage_key,
        input.admittedLogicalSeconds,
        input.admittedLogicalSeconds,
        input.admittedLogicalSeconds,
      );
    const quota = this.#database.prepare(`WITH RECURSIVE slots(slot) AS (
        VALUES(1)
        UNION ALL
        SELECT slot+1 FROM slots
        WHERE slot < (SELECT rules.attempt_limit
          FROM prompt_attempts AS attempts
          JOIN contest_runtimes AS runtime ON runtime.contest_id=attempts.contest_id
          JOIN contest_rule_problems AS rules
            ON rules.contest_id=attempts.contest_id
           AND rules.rules_commit=runtime.active_rules_commit
           AND rules.problem_id=attempts.problem_id
          WHERE attempts.id=?)
      ), available(slot) AS (
        SELECT MIN(slots.slot) FROM slots
        WHERE NOT EXISTS (SELECT 1 FROM prompt_attempt_quota AS existing
          JOIN prompt_attempts AS attempt ON attempt.id=?
          WHERE existing.contest_id=attempt.contest_id
            AND existing.entrant_id=attempt.entrant_id
            AND existing.problem_id=attempt.problem_id
            AND existing.timeline_generation=attempt.timeline_generation
            AND existing.quota_slot=slots.slot
            AND existing.state IN ('reserved','consumed'))
      )
      INSERT INTO prompt_attempt_quota
        (prompt_attempt_id, contest_id, entrant_id, problem_id, timeline_generation,
         quota_slot, configured_limit, state, reserved_at, settled_at, settlement_reason)
      SELECT attempts.id, attempts.contest_id, attempts.entrant_id, attempts.problem_id,
        attempts.timeline_generation, available.slot, rules.attempt_limit,
        'reserved', ?, NULL, NULL
      FROM prompt_attempts AS attempts
      JOIN contest_runtimes AS runtime ON runtime.contest_id=attempts.contest_id
      JOIN contest_rule_problems AS rules
        ON rules.contest_id=attempts.contest_id
       AND rules.rules_commit=runtime.active_rules_commit
       AND rules.problem_id=attempts.problem_id
      CROSS JOIN available
      WHERE attempts.id=?`)
      .bind(input.attemptId, input.attemptId, input.timestamp, input.attemptId);
    const event = eventInsert(
      this.#database,
      input.attemptId,
      "lifecycle:reserved",
      "reserved",
      {
        timelineGeneration: input.admission.timeline_generation,
        rulesEpoch: input.admission.rules_epoch,
        problemEpoch: input.admission.problem_epoch,
        contentEpoch: input.admission.content_epoch,
        judgeEpoch: input.admission.judge_epoch,
      },
      input.timestamp,
      "reserved",
    );
    const idempotency = this.#database.prepare(`INSERT INTO prompt_attempt_idempotency
        (owner_user_id, idempotency_key, request_sha256, prompt_attempt_id, created_at)
      SELECT ?, ?, ?, id, ? FROM prompt_attempts WHERE id=?`)
      .bind(
        input.input.ownerUserId,
        input.input.idempotencyKey,
        input.requestSha256,
        input.timestamp,
        input.attemptId,
      );
    const dispatch = this.#database.prepare(`INSERT INTO prompt_attempt_dispatches
        (prompt_attempt_id, state, attempts, last_error, created_at, updated_at, settled_at)
      SELECT id, 'pending', 0, NULL, ?, ?, NULL FROM prompt_attempts WHERE id=?`)
      .bind(input.timestamp, input.timestamp, input.attemptId);
    let results: readonly D1Result[];
    try {
      results = await this.#database.batch([attempt, quota, idempotency, dispatch, event]);
    } catch {
      const replay = await this.#idempotency(input.input.ownerUserId, input.input.idempotencyKey);
      if (replay) {
        if (replay.request_sha256 !== input.requestSha256) {
          throw new ApiError(409, "prompt-idempotency-conflict", "idempotencyKey was already used for another prompt attempt request.");
        }
        return false;
      }
      return this.#throwReservationFailure(input);
    }
    if (results[0]?.meta.changes === 1 && results[1]?.meta.changes === 1
      && results[2]?.meta.changes === 1 && results[3]?.meta.changes === 1
      && results[4]?.meta.changes === 1) return true;
    return this.#throwReservationFailure(input);
  }

  async #throwReservationFailure(input: {
    readonly input: CreatePromptAttemptInput;
    readonly admission: AdmissionRow;
    readonly admittedLogicalSeconds: number;
  }): Promise<never> {
    const live = await this.#database.prepare(`SELECT COUNT(*) AS count
      FROM prompt_attempt_quota AS quota
      JOIN prompt_attempts AS attempts ON attempts.id=quota.prompt_attempt_id
      WHERE quota.contest_id=? AND quota.entrant_id=? AND quota.problem_id=?
        AND attempts.eligibility='eligible' AND quota.state IN ('reserved','consumed')`)
      .bind(
        input.input.contestId,
        input.admission.entrant_id,
        input.input.problemId,
      ).first<{ readonly count: number }>();
    if ((live?.count ?? 0) >= input.admission.attempt_limit) {
      throw new ApiError(409, "prompt-attempt-limit", "The Prompt Program attempt limit has been reached.");
    }
    const checkpointBlocked = await this.#database.prepare(`SELECT 1 AS blocked
      FROM contest_rule_checkpoints AS checkpoint
      WHERE checkpoint.contest_id=? AND checkpoint.rules_commit=?
        AND checkpoint.at_seconds<=?
        AND NOT EXISTS (
          SELECT 1 FROM contest_checkpoint_runs AS checkpoint_run
          JOIN contest_checkpoint_decisions AS decision
            ON decision.checkpoint_run_id=checkpoint_run.id
           AND decision.entrant_id=? AND decision.decision='advanced'
          WHERE checkpoint_run.contest_id=checkpoint.contest_id
            AND checkpoint_run.checkpoint_id=checkpoint.checkpoint_id
            AND checkpoint_run.timeline_generation=?
            AND checkpoint_run.rules_epoch=?
            AND checkpoint_run.state IN ('provisional','final')
        ) LIMIT 1`)
      .bind(
        input.input.contestId,
        input.admission.rules_commit,
        input.admittedLogicalSeconds,
        input.admission.entrant_id,
        input.admission.timeline_generation,
        input.admission.rules_epoch,
      ).first<{ readonly blocked: number }>();
    if (checkpointBlocked) {
      throw new ApiError(409, "contest-checkpoint-not-advanced", "A due contest checkpoint has not advanced this entrant.");
    }
    throw new ApiError(409, "prompt-attempt-admission-changed", "Prompt attempt admission changed before reservation.");
  }

  async #beginGeneration(attemptId: string, timestamp: string): Promise<boolean> {
    const [updated] = await this.#database.batch([
      this.#database.prepare(`UPDATE prompt_attempts SET state='generating', updated_at=?
        WHERE id=? AND state='reserved' AND eligibility='eligible'
          AND EXISTS (SELECT 1 FROM prompt_attempt_quota
            WHERE prompt_attempt_id=prompt_attempts.id AND state='reserved')`)
        .bind(timestamp, attemptId),
      eventInsert(
        this.#database,
        attemptId,
        "lifecycle:generation-started",
        "generation-started",
        {},
        timestamp,
        "generating",
      ),
    ]);
    return updated?.meta.changes === 1;
  }

  async #releaseReservedFailure(
    attemptId: string,
    failureCode: string,
    timestamp: string,
    settleDispatch = false,
  ): Promise<boolean> {
    const [updated, quota, dispatch] = await this.#database.batch([
      this.#database.prepare(`UPDATE prompt_attempts
        SET state='failed', failure_code=?, terminal_at=?, updated_at=?
        WHERE id=? AND state='reserved'
          AND EXISTS (SELECT 1 FROM prompt_attempt_quota
            WHERE prompt_attempt_id=prompt_attempts.id AND state='reserved')`)
        .bind(failureCode, timestamp, timestamp, attemptId),
      this.#database.prepare(`UPDATE prompt_attempt_quota
        SET state='released', settled_at=?, settlement_reason=?
        WHERE prompt_attempt_id=? AND state='reserved'
          AND EXISTS (SELECT 1 FROM prompt_attempts
            WHERE id=prompt_attempt_id AND state='failed' AND failure_code=?)`)
        .bind(timestamp, failureCode, attemptId, failureCode),
      this.#database.prepare(`UPDATE prompt_attempt_dispatches
        SET state='failed', settled_at=?, last_error=?, updated_at=?
        WHERE prompt_attempt_id=? AND state='pending' AND ?=1`)
        .bind(timestamp, failureCode, timestamp, attemptId, settleDispatch ? 1 : 0),
      eventInsert(this.#database, attemptId, `lifecycle:failed:${failureCode}`, "failed", {
        code: failureCode,
        attemptDisposition: "release",
      }, timestamp, "failed"),
      eventInsert(this.#database, attemptId, `quota:released:${failureCode}`, "quota-released", {
        reason: failureCode,
      }, timestamp, "failed"),
    ]);
    if (updated?.meta.changes === 1 && quota?.meta.changes === 1
      && (!settleDispatch || dispatch?.meta.changes === 1)) return true;
    const settled = await this.#database.prepare(`SELECT 1 AS settled
      FROM prompt_attempts AS attempts
      JOIN prompt_attempt_quota AS quota ON quota.prompt_attempt_id=attempts.id
      WHERE attempts.id=? AND attempts.state='failed' AND attempts.failure_code=?
        AND quota.state='released' AND quota.settlement_reason=?`)
      .bind(attemptId, failureCode, failureCode).first<{ readonly settled: number }>();
    return Boolean(settled);
  }

  async #releaseFailure(attemptId: string, failureCode: string, durationMs: number, timestamp: string): Promise<void> {
    const [updated] = await this.#database.batch([
      this.#database.prepare(`UPDATE prompt_attempts
        SET state='failed', provider_duration_ms=?, failure_code=?, terminal_at=?, updated_at=?
        WHERE id=? AND state='generating'
          AND EXISTS (SELECT 1 FROM prompt_attempt_quota
            WHERE prompt_attempt_id=prompt_attempts.id AND state='reserved')`)
        .bind(durationMs, failureCode, timestamp, timestamp, attemptId),
      this.#database.prepare(`UPDATE prompt_attempt_quota
        SET state='released', settled_at=?, settlement_reason=?
        WHERE prompt_attempt_id=? AND state='reserved'`)
        .bind(timestamp, failureCode, attemptId),
      eventInsert(this.#database, attemptId, "lifecycle:failed", "failed", {
        code: failureCode,
        attemptDisposition: "release",
      }, timestamp, "failed"),
      eventInsert(this.#database, attemptId, "quota:released", "quota-released", {
        reason: failureCode,
      }, timestamp, "failed"),
    ]);
    if (updated?.meta.changes !== 1) throw new ApiError(409, "prompt-attempt-state-conflict", "Prompt attempt failure lost its quota fence.");
  }

  async #consumeFailure(attemptId: string, failureCode: string, durationMs: number, timestamp: string): Promise<void> {
    const [updated] = await this.#database.batch([
      this.#database.prepare(`UPDATE prompt_attempts
        SET state='failed', response_received_at=?, provider_duration_ms=?,
            failure_code=?, terminal_at=?, updated_at=?
        WHERE id=? AND state='generating'
          AND EXISTS (SELECT 1 FROM prompt_attempt_quota
            WHERE prompt_attempt_id=prompt_attempts.id AND state='reserved')`)
        .bind(timestamp, durationMs, failureCode, timestamp, timestamp, attemptId),
      this.#database.prepare(`UPDATE prompt_attempt_quota
        SET state='consumed', settled_at=?, settlement_reason='model-response-received'
        WHERE prompt_attempt_id=? AND state='reserved'`)
        .bind(timestamp, attemptId),
      eventInsert(this.#database, attemptId, "provider:response-received", "response-received", {
        providerDurationMs: durationMs,
      }, timestamp, "failed"),
      eventInsert(this.#database, attemptId, "lifecycle:failed", "failed", {
        code: failureCode,
        attemptDisposition: "consume",
      }, timestamp, "failed"),
    ]);
    if (updated?.meta.changes !== 1) throw new ApiError(409, "prompt-attempt-state-conflict", "Prompt attempt response lost its quota fence.");
  }

  async #recordResponse(
    attemptId: string,
    durationMs: number,
    timestamp: string,
  ): Promise<PromptResponseDisposition | null> {
    const [updated, quota, invalidHistory] = await this.#database.batch([
      this.#database.prepare(`UPDATE prompt_attempts
        SET response_received_at=?, provider_duration_ms=?, updated_at=?
        WHERE id=? AND state='generating' AND eligibility='eligible'
          AND timeline_generation=(SELECT timeline_generation FROM contest_runtimes
            WHERE contest_id=prompt_attempts.contest_id)
          AND EXISTS (SELECT 1 FROM prompt_attempt_quota
            WHERE prompt_attempt_id=prompt_attempts.id AND state='reserved')`)
        .bind(timestamp, durationMs, timestamp, attemptId),
      this.#database.prepare(`UPDATE prompt_attempt_quota
        SET state='consumed', settled_at=?, settlement_reason='model-response-received'
        WHERE prompt_attempt_id=? AND state='reserved'
          AND EXISTS (SELECT 1 FROM prompt_attempts
            WHERE id=prompt_attempt_id AND state='generating' AND eligibility='eligible')`)
        .bind(timestamp, attemptId),
      this.#database.prepare(`UPDATE prompt_attempts
        SET response_received_at=COALESCE(response_received_at, ?),
            provider_duration_ms=COALESCE(provider_duration_ms, ?), updated_at=?
        WHERE id=? AND state='generating' AND eligibility='invalid'
          AND EXISTS (SELECT 1 FROM prompt_attempt_quota
            WHERE prompt_attempt_id=prompt_attempts.id AND state='invalid')`)
        .bind(timestamp, durationMs, timestamp, attemptId),
      eventInsert(this.#database, attemptId, "provider:response-received", "response-received", {
        providerDurationMs: durationMs,
      }, timestamp, "generating"),
    ]);
    if (updated?.meta.changes === 1 && quota?.meta.changes === 1) return "current";
    if (invalidHistory?.meta.changes === 1 && updated?.meta.changes === 0 && quota?.meta.changes === 0) {
      return "invalid-history";
    }
    return null;
  }

  async #currentLogicalSeconds(attemptId: string, now: Date): Promise<number | null> {
    const row = await this.#database.prepare(`SELECT runtime.state AS runtime_state,
        runtime.timeline_generation, revisions.duration_seconds, revisions.clock_kind,
        runtime.wall_anchor_at, runtime.logical_anchor_seconds,
        entrants.individual_wall_anchor_at AS entrant_wall_anchor_at,
        entrants.individual_logical_anchor_seconds AS entrant_logical_anchor_seconds
      FROM prompt_attempts AS attempts
      JOIN contest_runtimes AS runtime ON runtime.contest_id=attempts.contest_id
      JOIN contest_rule_epochs AS rule_epoch
        ON rule_epoch.contest_id=attempts.contest_id
       AND rule_epoch.rules_epoch=attempts.rules_epoch
      JOIN contest_rule_revisions AS revisions
        ON revisions.contest_id=rule_epoch.contest_id
       AND revisions.rules_commit=rule_epoch.rules_commit
       AND revisions.rules_sha256=rule_epoch.rules_sha256
      JOIN contest_entrants AS entrants
        ON entrants.id=attempts.entrant_id AND entrants.contest_id=attempts.contest_id
      WHERE attempts.id=? AND attempts.eligibility='eligible'
        AND attempts.timeline_generation=runtime.timeline_generation`)
      .bind(attemptId).first<LogicalRow>();
    return row ? logicalSeconds(row, now) : null;
  }

  async #invalidHistoryEligibility(attemptId: string): Promise<SubmissionEligibility | null> {
    const row = await this.#database.prepare(`SELECT attempts.invalidated_at,
        attempts.invalidation_reason
      FROM prompt_attempts AS attempts
      JOIN prompt_attempt_quota AS quota ON quota.prompt_attempt_id=attempts.id
      WHERE attempts.id=? AND attempts.state='generating'
        AND attempts.eligibility='invalid' AND attempts.invalidated_at IS NOT NULL
        AND attempts.invalidation_reason IS NOT NULL AND quota.state='invalid'`)
      .bind(attemptId).first<{
        readonly invalidated_at: string;
        readonly invalidation_reason: string;
      }>();
    return row ? {
      eligibility: "invalid",
      invalidatedAt: row.invalidated_at,
      invalidationReason: row.invalidation_reason,
    } : null;
  }

  async #admitExactProduct(
    attemptId: string,
    work: ReservedPromptWork,
    generatedSource: PromptCompilerGeneratedSource,
    sourceReadyLogicalSeconds: number | null,
    timelineDisposition: PromptResponseDisposition,
    eligibility: SubmissionEligibility,
  ): Promise<PromptGeneratedSubmissionResult | null> {
    try {
      const product = validateHostProduct(await this.#host.admitGeneratedSource({
        attemptId,
        ownerUserId: work.owner_user_id,
        contestId: work.contest_id,
        entrantId: work.entrant_id,
        problemId: work.problem_id,
        timelineGeneration: work.timeline_generation,
        rulesEpoch: work.rules_epoch,
        problemEpoch: work.problem_epoch,
        contentEpoch: work.content_epoch,
        judgeEpoch: work.judge_epoch,
        contentCommit: work.content_commit,
        judgeDigest: work.judge_digest,
        admittedLogicalSeconds: work.admitted_logical_seconds,
        sourceReadyLogicalSeconds,
        timelineDisposition,
        evidenceAt: work.evidence_at,
        ...eligibility,
        generatedSource,
      }));
      await this.#verifyHostProduct(
        attemptId,
        product,
        work.owner_user_id,
        work,
        work.admitted_logical_seconds,
        sourceReadyLogicalSeconds,
        eligibility,
      );
      return product;
    } catch {
      return this.#durableHostProduct(
        attemptId,
        work.owner_user_id,
        work,
        work.admitted_logical_seconds,
        sourceReadyLogicalSeconds,
        eligibility,
      );
    }
  }

  async #verifyHostProduct(
    attemptId: string,
    product: PromptGeneratedSubmissionResult,
    ownerUserId: string,
    admission: AdmissionRow,
    admittedLogicalSeconds: number,
    sourceReadyLogicalSeconds: number | null,
    eligibility: SubmissionEligibility,
  ): Promise<void> {
    const expectedEvidence = evidenceLogicalSeconds(
      admission.evidence_at,
      admittedLogicalSeconds,
      sourceReadyLogicalSeconds,
    );
    const row = await this.#database.prepare(`SELECT 1 AS valid
      FROM submission_sources AS sources
      JOIN submissions
        ON submissions.id=? AND submissions.source_id=sources.id
      JOIN contest_submission_records AS records
        ON records.submission_id=submissions.id
      WHERE sources.id=? AND sources.source_kind='prompt-generated'
        AND sources.state='ready' AND sources.owner_user_id=?
        AND sources.content_sha256=?
        AND submissions.user_id=? AND submissions.contest_id=?
        AND submissions.problem_id=? AND submissions.catalog_commit=?
        AND submissions.judge_digest=? AND submissions.language=?
        AND submissions.target=? AND submissions.optimization=?
        AND submissions.entry_path=?
        AND records.contest_id=? AND records.entrant_id=?
        AND records.timeline_generation=? AND records.rules_epoch=?
        AND records.content_epoch=? AND records.judge_epoch=?
        AND records.prompt_attempt_id=?
        AND records.admitted_logical_seconds=? AND records.evidence_at=?
        AND records.evidence_logical_seconds IS ? AND records.eligibility=?
        AND records.invalidated_at IS ? AND records.invalidation_reason IS ?`)
      .bind(
        product.submissionId,
        product.sourceId,
        ownerUserId,
        product.sourceSha256,
        ownerUserId,
        admission.contest_id,
        admission.problem_id,
        admission.content_commit,
        admission.judge_digest,
        admission.output_language,
        admission.output_target,
        admission.output_optimization,
        admission.output_entry_path,
        admission.contest_id,
        admission.entrant_id,
        admission.timeline_generation,
        admission.rules_epoch,
        admission.content_epoch,
        admission.judge_epoch,
        attemptId,
        admittedLogicalSeconds,
        admission.evidence_at,
        expectedEvidence,
        eligibility.eligibility,
        eligibility.invalidatedAt,
        eligibility.invalidationReason,
      ).first<{ readonly valid: number }>();
    if (!row) throw new Error("Prompt submission host did not create the exact fenced normal submission product.");
  }

  async #durableHostProduct(
    attemptId: string,
    ownerUserId: string,
    admission: AdmissionRow,
    admittedLogicalSeconds: number,
    sourceReadyLogicalSeconds: number | null,
    eligibility: SubmissionEligibility,
  ): Promise<PromptGeneratedSubmissionResult | null> {
    const expectedEvidence = evidenceLogicalSeconds(
      admission.evidence_at,
      admittedLogicalSeconds,
      sourceReadyLogicalSeconds,
    );
    const row = await this.#database.prepare(`SELECT submissions.id AS submission_id,
        sources.id AS source_id, sources.content_sha256 AS source_sha256
      FROM contest_submission_records AS records
      JOIN submissions ON submissions.id=records.submission_id
      JOIN submission_sources AS sources ON sources.id=submissions.source_id
      WHERE records.prompt_attempt_id=?
        AND sources.source_kind='prompt-generated' AND sources.owner_user_id=?
        AND sources.state='ready' AND sources.content_sha256 IS NOT NULL
        AND submissions.user_id=? AND submissions.contest_id=?
        AND submissions.problem_id=? AND submissions.catalog_commit=?
        AND submissions.judge_digest=? AND submissions.language=?
        AND submissions.target=? AND submissions.optimization=?
        AND submissions.entry_path=?
        AND records.contest_id=? AND records.entrant_id=?
        AND records.timeline_generation=? AND records.rules_epoch=?
        AND records.content_epoch=? AND records.judge_epoch=?
        AND records.admitted_logical_seconds=? AND records.evidence_at=?
        AND records.evidence_logical_seconds IS ? AND records.eligibility=?
        AND records.invalidated_at IS ? AND records.invalidation_reason IS ?`)
      .bind(
        attemptId,
        ownerUserId,
        ownerUserId,
        admission.contest_id,
        admission.problem_id,
        admission.content_commit,
        admission.judge_digest,
        admission.output_language,
        admission.output_target,
        admission.output_optimization,
        admission.output_entry_path,
        admission.contest_id,
        admission.entrant_id,
        admission.timeline_generation,
        admission.rules_epoch,
        admission.content_epoch,
        admission.judge_epoch,
        admittedLogicalSeconds,
        admission.evidence_at,
        expectedEvidence,
        eligibility.eligibility,
        eligibility.invalidatedAt,
        eligibility.invalidationReason,
      ).first<{
        readonly submission_id: string;
        readonly source_id: string;
        readonly source_sha256: string;
      }>();
    return row ? validateHostProduct({
      sourceId: row.source_id,
      sourceSha256: row.source_sha256,
      submissionId: row.submission_id,
    }) : null;
  }

  async #durableAttemptProduct(attemptId: string, ownerUserId: string): Promise<DurablePromptProduct | null> {
    const row = await this.#database.prepare(`SELECT submissions.id AS submission_id,
        sources.id AS source_id, sources.content_sha256 AS source_sha256,
        sources.state AS source_state,
        records.evidence_logical_seconds, records.eligibility,
        records.invalidated_at, records.invalidation_reason,
        records.created_at AS source_ready_at
      FROM prompt_attempts AS attempts
      JOIN contest_submission_records AS records
        ON records.prompt_attempt_id=attempts.id
       AND records.contest_id=attempts.contest_id
       AND records.entrant_id=attempts.entrant_id
       AND records.timeline_generation=attempts.timeline_generation
       AND records.rules_epoch=attempts.rules_epoch
       AND records.content_epoch=attempts.content_epoch
       AND records.judge_epoch=attempts.judge_epoch
      JOIN submissions
        ON submissions.id=records.submission_id
       AND submissions.contest_id=attempts.contest_id
       AND submissions.problem_id=attempts.problem_id
       AND submissions.user_id=?
      JOIN submission_sources AS sources
        ON sources.id=submissions.source_id
       AND sources.owner_user_id=?
       AND sources.source_kind='prompt-generated'
       AND sources.content_sha256 IS NOT NULL
      WHERE attempts.id=?`)
      .bind(ownerUserId, ownerUserId, attemptId).first<{
        readonly submission_id: string;
        readonly source_id: string;
        readonly source_sha256: string;
        readonly source_state: string;
        readonly evidence_logical_seconds: number | null;
        readonly eligibility: "eligible" | "invalid";
        readonly invalidated_at: string | null;
        readonly invalidation_reason: string | null;
        readonly source_ready_at: string;
      }>();
    if (!row) return null;
    return {
      product: validateHostProduct({
        sourceId: row.source_id,
        sourceSha256: row.source_sha256,
        submissionId: row.submission_id,
      }),
      evidenceLogicalSeconds: row.evidence_logical_seconds,
      eligibility: {
        eligibility: row.eligibility,
        invalidatedAt: row.invalidated_at,
        invalidationReason: row.invalidation_reason,
      },
      sourceReadyAt: row.source_ready_at,
      ready: row.source_state === "ready",
    };
  }

  async #retainDurableProductFailure(attemptId: string, timestamp: string): Promise<void> {
    await this.#database.batch([
      this.#database.prepare(`UPDATE prompt_attempts
        SET state='failed', failure_code='prompt-submission-reconciliation-required',
            terminal_at=?, updated_at=?
        WHERE id=? AND state='generating'
          AND EXISTS (SELECT 1 FROM prompt_attempt_quota
            WHERE prompt_attempt_id=prompt_attempts.id AND state='consumed')
          AND EXISTS (SELECT 1 FROM contest_submission_records
            WHERE prompt_attempt_id=prompt_attempts.id)`)
        .bind(timestamp, timestamp, attemptId),
      eventInsert(this.#database, attemptId, "lifecycle:submission-reconciliation-required", "failed", {
        code: "prompt-submission-reconciliation-required",
        attemptDisposition: "consume",
      }, timestamp, "failed"),
    ]);
  }

  async #hostFailure(attemptId: string, timestamp: string): Promise<boolean> {
    const [updated, quota] = await this.#database.batch([
      this.#database.prepare(`UPDATE prompt_attempts
        SET state='failed', failure_code='prompt-submission-host-failure',
            terminal_at=?, updated_at=?
        WHERE id=? AND state='generating'
          AND EXISTS (SELECT 1 FROM prompt_attempt_quota
            WHERE prompt_attempt_id=prompt_attempts.id AND state='consumed')
          AND NOT EXISTS (SELECT 1 FROM contest_submission_records
            WHERE prompt_attempt_id=prompt_attempts.id)`)
        .bind(timestamp, timestamp, attemptId),
      this.#database.prepare(`UPDATE prompt_attempt_quota
        SET state='released', settled_at=?, settlement_reason='prompt-submission-host-failure'
        WHERE prompt_attempt_id=? AND state='consumed'
          AND EXISTS (SELECT 1 FROM prompt_attempts
            WHERE id=prompt_attempt_id AND state='failed'
              AND failure_code='prompt-submission-host-failure')
          AND NOT EXISTS (SELECT 1 FROM contest_submission_records
            WHERE prompt_attempt_id=?)`)
        .bind(timestamp, attemptId, attemptId),
      eventInsert(this.#database, attemptId, "lifecycle:failed", "failed", {
        code: "prompt-submission-host-failure",
        attemptDisposition: "release",
      }, timestamp, "failed"),
      eventInsert(this.#database, attemptId, "quota:released", "quota-released", {
        reason: "prompt-submission-host-failure",
      }, timestamp, "failed"),
    ]);
    return updated?.meta.changes === 1 && quota?.meta.changes === 1;
  }

  async #complete(
    attemptId: string,
    product: PromptGeneratedSubmissionResult,
    evidenceSeconds: number | null,
    eligibility: SubmissionEligibility,
    sourceReadyTimestamp: string,
    completedTimestamp: string,
  ): Promise<boolean> {
    const statements = [
      this.#database.prepare(`UPDATE prompt_attempts
        SET state='submitted', generated_source_id=?, generated_source_sha256=?,
            submission_id=?, evidence_logical_seconds=?, source_ready_at=?,
            terminal_at=?, eligibility=?, invalidated_at=?, invalidation_reason=?,
            updated_at=?
        WHERE id=? AND state='generating' AND eligibility='eligible'
          AND timeline_generation=(SELECT timeline_generation FROM contest_runtimes
            WHERE contest_id=prompt_attempts.contest_id)
          AND EXISTS (SELECT 1 FROM prompt_attempt_quota
            WHERE prompt_attempt_id=prompt_attempts.id AND state='consumed')`)
        .bind(
          product.sourceId,
          product.sourceSha256,
          product.submissionId,
          evidenceSeconds,
          sourceReadyTimestamp,
          completedTimestamp,
          eligibility.eligibility,
          eligibility.invalidatedAt,
          eligibility.invalidationReason,
          completedTimestamp,
          attemptId,
        ),
      eventInsert(this.#database, attemptId, "lifecycle:source-ready", "source-ready", {
        sourceId: product.sourceId,
        sourceSha256: product.sourceSha256,
      }, completedTimestamp, "submitted"),
      eventInsert(this.#database, attemptId, "lifecycle:submission-created", "submission-created", {
        submissionId: product.submissionId,
      }, completedTimestamp, "submitted"),
    ];
    if (eligibility.eligibility === "invalid") {
      statements.push(eventInsert(
        this.#database,
        attemptId,
        "eligibility:generated-source-ready-after-close",
        "invalidated",
        { reason: eligibility.invalidationReason },
        completedTimestamp,
        "submitted",
      ));
    }
    const [updated] = await this.#database.batch(statements);
    return updated?.meta.changes === 1;
  }

  async #completeInvalidHistory(
    attemptId: string,
    product: PromptGeneratedSubmissionResult,
    evidenceSeconds: number | null,
    eligibility: SubmissionEligibility,
    sourceReadyTimestamp: string,
    completedTimestamp: string,
  ): Promise<boolean> {
    if (eligibility.eligibility !== "invalid"
      || eligibility.invalidatedAt === null
      || eligibility.invalidationReason === null) return false;
    const [updated] = await this.#database.batch([
      this.#database.prepare(`UPDATE prompt_attempts
        SET state='cancelled', generated_source_id=?, generated_source_sha256=?,
            submission_id=?, evidence_logical_seconds=?, source_ready_at=?,
            terminal_at=COALESCE(terminal_at, ?), updated_at=?
        WHERE id=? AND state='generating' AND eligibility='invalid'
          AND invalidated_at=? AND invalidation_reason=?
          AND EXISTS (SELECT 1 FROM prompt_attempt_quota
            WHERE prompt_attempt_id=prompt_attempts.id AND state='invalid')
          AND EXISTS (SELECT 1 FROM contest_submission_records
            WHERE prompt_attempt_id=prompt_attempts.id AND submission_id=?
              AND eligibility='invalid' AND invalidated_at=? AND invalidation_reason=?)`)
        .bind(
          product.sourceId,
          product.sourceSha256,
          product.submissionId,
          evidenceSeconds,
          sourceReadyTimestamp,
          completedTimestamp,
          completedTimestamp,
          attemptId,
          eligibility.invalidatedAt,
          eligibility.invalidationReason,
          product.submissionId,
          eligibility.invalidatedAt,
          eligibility.invalidationReason,
        ),
      eventInsert(this.#database, attemptId, "lifecycle:invalid-source-ready", "source-ready", {
        sourceId: product.sourceId,
        sourceSha256: product.sourceSha256,
      }, completedTimestamp, "cancelled"),
      eventInsert(this.#database, attemptId, "lifecycle:invalid-submission-created", "submission-created", {
        submissionId: product.submissionId,
      }, completedTimestamp, "cancelled"),
      eventInsert(this.#database, attemptId, "lifecycle:cancelled-after-invalid-source", "cancelled", {
        reason: eligibility.invalidationReason,
      }, completedTimestamp, "cancelled"),
    ]);
    return updated?.meta.changes === 1;
  }

  async #settleInvalidHistoryFailure(
    attemptId: string,
    durable: DurablePromptProduct | null,
    timestamp: string,
  ): Promise<void> {
    if (durable?.ready && await this.#completeInvalidHistory(
      attemptId,
      durable.product,
      durable.evidenceLogicalSeconds,
      durable.eligibility,
      durable.sourceReadyAt,
      timestamp,
    )) return;
    const failureCode = durable
      ? "prompt-submission-reconciliation-required"
      : "prompt-submission-host-failure";
    await this.#database.batch([
      this.#database.prepare(`UPDATE prompt_attempts
        SET state='cancelled', failure_code=?, terminal_at=COALESCE(terminal_at, ?), updated_at=?
        WHERE id=? AND state='generating' AND eligibility='invalid'
          AND EXISTS (SELECT 1 FROM prompt_attempt_quota
            WHERE prompt_attempt_id=prompt_attempts.id AND state='invalid')`)
        .bind(failureCode, timestamp, timestamp, attemptId),
      eventInsert(this.#database, attemptId, `lifecycle:invalid-history:${failureCode}`, "failed", {
        code: failureCode,
        attemptDisposition: "invalid",
      }, timestamp, "cancelled"),
      eventInsert(this.#database, attemptId, "lifecycle:cancelled-invalid-history", "cancelled", {
        reason: failureCode,
      }, timestamp, "cancelled"),
    ]);
  }

  async #invalidate(attemptId: string, reason: string, timestamp: string): Promise<void> {
    await this.#database.batch([
      this.#database.prepare(`UPDATE prompt_attempts
        SET state='cancelled', eligibility='invalid', invalidated_at=COALESCE(invalidated_at, ?),
            invalidation_reason=COALESCE(invalidation_reason, ?), terminal_at=COALESCE(terminal_at, ?),
            updated_at=?
        WHERE id=? AND state IN ('reserved','generating','source-ready')`)
        .bind(timestamp, reason, timestamp, timestamp, attemptId),
      this.#database.prepare(`UPDATE prompt_attempt_quota
        SET state='invalid', settled_at=COALESCE(settled_at, ?), settlement_reason=?
        WHERE prompt_attempt_id=? AND state IN ('reserved','consumed')`)
        .bind(timestamp, reason, attemptId),
      eventInsert(this.#database, attemptId, "timeline:invalidated", "invalidated", { reason }, timestamp, "cancelled"),
      eventInsert(this.#database, attemptId, "lifecycle:cancelled", "cancelled", { reason }, timestamp, "cancelled"),
    ]);
  }
}

/**
 * Finish the Prompt attempt side of an Official Submission whose source
 * admission became durable after the original host call returned uncertainly.
 * The exact sidecar link is the reconciliation identity; this transition never
 * invokes the compiler and never changes timeline eligibility or quota.
 */
export async function reconcilePromptAttemptProduct(
  database: D1Database,
  submissionId: string,
  now = new Date(),
): Promise<boolean> {
  assertUuid(submissionId, "Submission ID");
  const timestamp = validNow(now).toISOString();
  const product = await database.prepare(`SELECT attempts.id AS attempt_id,
      submissions.id AS submission_id, sources.id AS source_id,
      sources.content_sha256 AS source_sha256, sources.ready_at AS source_ready_at,
      records.evidence_logical_seconds, records.eligibility,
      records.invalidated_at, records.invalidation_reason
    FROM prompt_attempts AS attempts
    JOIN prompt_attempt_quota AS quota
      ON quota.prompt_attempt_id=attempts.id AND quota.state='consumed'
    JOIN contest_submission_records AS records
      ON records.prompt_attempt_id=attempts.id
     AND records.contest_id=attempts.contest_id
     AND records.entrant_id=attempts.entrant_id
     AND records.timeline_generation=attempts.timeline_generation
     AND records.rules_epoch=attempts.rules_epoch
     AND records.content_epoch=attempts.content_epoch
     AND records.judge_epoch=attempts.judge_epoch
    JOIN contest_entrants AS entrants
      ON entrants.id=attempts.entrant_id AND entrants.contest_id=attempts.contest_id
    JOIN submissions
      ON submissions.id=? AND submissions.id=records.submission_id
     AND submissions.origin_submission_id=submissions.id
     AND submissions.contest_id=attempts.contest_id
     AND submissions.problem_id=attempts.problem_id
     AND submissions.user_id=entrants.owner_user_id
    JOIN submission_sources AS sources
      ON sources.id=submissions.source_id
     AND sources.owner_user_id=entrants.owner_user_id
     AND sources.source_kind='prompt-generated'
     AND sources.state='ready' AND sources.ready_at IS NOT NULL
     AND sources.content_sha256 IS NOT NULL
    WHERE attempts.state='failed'
      AND attempts.failure_code='prompt-submission-reconciliation-required'
      AND (attempts.generated_source_id IS NULL OR attempts.generated_source_id=sources.id)
      AND (attempts.generated_source_sha256 IS NULL
        OR attempts.generated_source_sha256=sources.content_sha256)
      AND (attempts.submission_id IS NULL OR attempts.submission_id=submissions.id)
      AND attempts.eligibility=records.eligibility
      AND attempts.invalidated_at IS records.invalidated_at
      AND attempts.invalidation_reason IS records.invalidation_reason`)
    .bind(submissionId).first<ReconciledPromptProductRow>();
  if (!product) return false;

  const [updated] = await database.batch([
    database.prepare(`UPDATE prompt_attempts
      SET state='submitted', generated_source_id=?, generated_source_sha256=?,
          submission_id=?, evidence_logical_seconds=?,
          source_ready_at=COALESCE(source_ready_at, ?), failure_code=NULL, updated_at=?
      WHERE id=? AND state='failed'
        AND failure_code='prompt-submission-reconciliation-required'
        AND eligibility=? AND invalidated_at IS ? AND invalidation_reason IS ?
        AND (generated_source_id IS NULL OR generated_source_id=?)
        AND (generated_source_sha256 IS NULL OR generated_source_sha256=?)
        AND (submission_id IS NULL OR submission_id=?)
        AND EXISTS (SELECT 1 FROM prompt_attempt_quota
          WHERE prompt_attempt_id=prompt_attempts.id AND state='consumed')
        AND EXISTS (SELECT 1
          FROM contest_submission_records AS records
          JOIN contest_entrants AS entrants
            ON entrants.id=prompt_attempts.entrant_id
           AND entrants.contest_id=prompt_attempts.contest_id
          JOIN submissions
            ON submissions.id=records.submission_id
           AND submissions.origin_submission_id=submissions.id
           AND submissions.contest_id=prompt_attempts.contest_id
           AND submissions.problem_id=prompt_attempts.problem_id
           AND submissions.user_id=entrants.owner_user_id
          JOIN submission_sources AS sources
            ON sources.id=submissions.source_id
           AND sources.owner_user_id=entrants.owner_user_id
           AND sources.source_kind='prompt-generated'
           AND sources.state='ready' AND sources.ready_at=?
           AND sources.content_sha256=?
          WHERE records.prompt_attempt_id=prompt_attempts.id
            AND records.submission_id=?
            AND records.contest_id=prompt_attempts.contest_id
            AND records.entrant_id=prompt_attempts.entrant_id
            AND records.timeline_generation=prompt_attempts.timeline_generation
            AND records.rules_epoch=prompt_attempts.rules_epoch
            AND records.content_epoch=prompt_attempts.content_epoch
            AND records.judge_epoch=prompt_attempts.judge_epoch
            AND records.evidence_logical_seconds IS ?
            AND records.eligibility=prompt_attempts.eligibility
            AND records.invalidated_at IS prompt_attempts.invalidated_at
            AND records.invalidation_reason IS prompt_attempts.invalidation_reason)`)
      .bind(
        product.source_id,
        product.source_sha256,
        product.submission_id,
        product.evidence_logical_seconds,
        product.source_ready_at,
        timestamp,
        product.attempt_id,
        product.eligibility,
        product.invalidated_at,
        product.invalidation_reason,
        product.source_id,
        product.source_sha256,
        product.submission_id,
        product.source_ready_at,
        product.source_sha256,
        product.submission_id,
        product.evidence_logical_seconds,
      ),
    eventInsert(
      database,
      product.attempt_id,
      "lifecycle:submission-reconciled",
      "reconciled",
      {
        sourceId: product.source_id,
        sourceSha256: product.source_sha256,
        submissionId: product.submission_id,
      },
      timestamp,
      "submitted",
    ),
  ]);
  return updated?.meta.changes === 1;
}

/** Bounded scheduled closure for a crash after source admission but before the hook above. */
export async function reconcileReadyPromptAttemptProducts(
  database: D1Database,
  now = new Date(),
): Promise<number> {
  const candidates = await database.prepare(`SELECT records.submission_id
    FROM prompt_attempts AS attempts
    JOIN prompt_attempt_quota AS quota
      ON quota.prompt_attempt_id=attempts.id AND quota.state='consumed'
    JOIN contest_submission_records AS records ON records.prompt_attempt_id=attempts.id
    JOIN submissions ON submissions.id=records.submission_id
    JOIN submission_sources AS sources
      ON sources.id=submissions.source_id
     AND sources.source_kind='prompt-generated' AND sources.state='ready'
    WHERE attempts.state='failed'
      AND attempts.failure_code='prompt-submission-reconciliation-required'
    ORDER BY attempts.updated_at, attempts.id LIMIT 25`)
    .all<{ readonly submission_id: string }>();
  let reconciled = 0;
  for (const candidate of candidates.results) {
    if (await reconcilePromptAttemptProduct(database, candidate.submission_id, now)) reconciled += 1;
  }
  return reconciled;
}

const PROMPT_ATTEMPT_SELECT = `SELECT attempts.id, attempts.contest_id,
    attempts.entrant_id, attempts.problem_id, attempts.timeline_generation,
    attempts.rules_epoch, attempts.problem_epoch, attempts.content_epoch, attempts.judge_epoch,
    attempts.compiler_config_id, attempts.compiler_config_sha256,
    attempts.public_context_sha256, attempts.prompt_text, attempts.prompt_bytes,
    attempts.prompt_sha256, attempts.output_language, attempts.output_target,
    attempts.output_optimization, attempts.output_entry_path, attempts.state,
    COALESCE(attempts.generated_source_id, durable_sources.id) AS generated_source_id,
    COALESCE(attempts.generated_source_sha256, durable_sources.content_sha256) AS generated_source_sha256,
    COALESCE(attempts.submission_id, durable_records.submission_id) AS submission_id,
    attempts.admitted_logical_seconds,
    attempts.evidence_logical_seconds, attempts.response_received_at,
    attempts.source_ready_at, attempts.terminal_at, attempts.provider_duration_ms,
    attempts.failure_code, attempts.eligibility, attempts.invalidation_reason,
    attempts.erased_at, attempts.created_at, attempts.updated_at,
    quota.quota_slot, quota.configured_limit, quota.state AS quota_state,
    quota.settlement_reason
  FROM prompt_attempts AS attempts
  JOIN prompt_attempt_quota AS quota ON quota.prompt_attempt_id=attempts.id
  JOIN contest_entrants AS entrants
    ON entrants.id=attempts.entrant_id AND entrants.contest_id=attempts.contest_id
  LEFT JOIN contest_submission_records AS durable_records
    ON durable_records.prompt_attempt_id=attempts.id
  LEFT JOIN submissions AS durable_submissions
    ON durable_submissions.id=durable_records.submission_id
  LEFT JOIN submission_sources AS durable_sources
    ON durable_sources.id=durable_submissions.source_id`;

function eventInsert(
  database: D1Database,
  attemptId: string,
  eventKey: string,
  eventType: PromptAttemptEventType,
  payload: Readonly<Record<string, string | number | boolean | null>>,
  timestamp: string,
  requiredState: PromptAttemptState,
): D1PreparedStatement {
  return database.prepare(`INSERT INTO prompt_attempt_events
      (prompt_attempt_id, event_key, event_type, payload_json, created_at)
    SELECT ?, ?, ?, ?, ? FROM prompt_attempts
    WHERE id=? AND state=?
    ON CONFLICT(prompt_attempt_id, event_key) DO NOTHING`)
    .bind(attemptId, eventKey, eventType, JSON.stringify(payload), timestamp, attemptId, requiredState);
}

function parseCreateInput(value: CreatePromptAttemptInput): CreatePromptAttemptInput {
  exactInput(value, [
    "contestId", "idempotencyKey", "ownerUserId", "problemEpoch", "problemId",
    "prompt", "publicContextSha256", "rulesEpoch", "timelineGeneration",
  ], "Prompt attempt input");
  assertOwner(value.ownerUserId);
  assertUuid(value.contestId, "Contest ID");
  assertUuid(value.problemId, "Problem ID");
  assertPositiveEpoch(value.timelineGeneration, "timelineGeneration");
  assertPositiveEpoch(value.rulesEpoch, "rulesEpoch");
  assertPositiveEpoch(value.problemEpoch, "problemEpoch");
  if (typeof value.publicContextSha256 !== "string" || !SHA256_PATTERN.test(value.publicContextSha256)) {
    throw new ApiError(400, "prompt-context-invalid", "publicContextSha256 must be a lowercase SHA-256 digest.");
  }
  if (typeof value.prompt !== "string") throw new ApiError(400, "prompt-invalid", "Prompt must be a string.");
  if (typeof value.idempotencyKey !== "string" || !IDEMPOTENCY_KEY_PATTERN.test(value.idempotencyKey)) {
    throw new ApiError(400, "prompt-idempotency-key-invalid", "idempotencyKey is invalid.");
  }
  return value;
}

async function promptAttemptRequestSha256(input: CreatePromptAttemptInput): Promise<string> {
  return sha256Hex(JSON.stringify({
    contestId: input.contestId,
    problemId: input.problemId,
    timelineGeneration: input.timelineGeneration,
    rulesEpoch: input.rulesEpoch,
    problemEpoch: input.problemEpoch,
    publicContextSha256: input.publicContextSha256,
    prompt: input.prompt,
  }));
}

function parseEventsQuery(value: PromptAttemptEventsQuery): Required<PromptAttemptEventsQuery> {
  exactInput(value, ["attemptId", "ownerUserId"], ["after", "limit"], "Prompt attempt events query");
  assertOwner(value.ownerUserId);
  assertUuid(value.attemptId, "Prompt attempt ID");
  const after = value.after ?? 0;
  const limit = value.limit ?? 100;
  if (!Number.isSafeInteger(after) || after < 0) throw new ApiError(400, "prompt-event-cursor-invalid", "Event cursor is invalid.");
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new ApiError(400, "prompt-event-limit-invalid", "Event limit must be from 1 to 100.");
  return { ownerUserId: value.ownerUserId, attemptId: value.attemptId, after, limit };
}

function parseHistoryQuery(value: PromptAttemptHistoryQuery): PromptAttemptHistoryQuery & { readonly limit: number } {
  exactInput(value, ["contestId", "ownerUserId"], ["before", "limit", "problemId"], "Prompt attempt history query");
  assertOwner(value.ownerUserId);
  assertUuid(value.contestId, "Contest ID");
  if (value.problemId !== undefined) assertUuid(value.problemId, "Problem ID");
  const limit = value.limit ?? 50;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new ApiError(400, "prompt-history-limit-invalid", "History limit must be from 1 to 100.");
  if (value.before !== undefined) {
    exactInput(value.before, ["attemptId", "createdAt"], "Prompt attempt history cursor");
    assertUuid(value.before.attemptId, "Prompt attempt history cursor ID");
    assertTimestamp(value.before.createdAt, "Prompt attempt history cursor timestamp");
  }
  return { ...value, limit };
}

function exactInput(
  value: unknown,
  required: readonly string[],
  optionalOrLabel: readonly string[] | string,
  maybeLabel?: string,
): asserts value is Record<string, unknown> {
  const optional = typeof optionalOrLabel === "string" ? [] : optionalOrLabel;
  const label = typeof optionalOrLabel === "string" ? optionalOrLabel : maybeLabel!;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ApiError(400, "payload-invalid", `${label} must be an object.`);
  const record = value as Record<string, unknown>;
  const allowed = new Set([...required, ...optional]);
  if (required.some((key) => !Object.hasOwn(record, key)) || Object.keys(record).some((key) => !allowed.has(key))) {
    throw new ApiError(400, "payload-invalid", `${label} has an invalid shape.`);
  }
}

function assertOwner(value: unknown): asserts value is string {
  if (typeof value !== "string" || !value || value.length > 256) throw new ApiError(400, "owner-invalid", "Owner user ID is invalid.");
}

function assertUuid(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) throw new ApiError(400, "identifier-invalid", `${label} must be a UUID.`);
}

function assertPositiveEpoch(value: unknown, label: string): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new ApiError(400, "contest-epoch-invalid", `${label} must be a positive integer.`);
  }
}

function assertTimestamp(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || Number.isNaN(Date.parse(value)) || new Date(value).toISOString() !== value) {
    throw new ApiError(400, "timestamp-invalid", `${label} is invalid.`);
  }
}

function validNow(value: Date): Date {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) throw new TypeError("Prompt attempt clock returned an invalid date.");
  return value;
}

function logicalSeconds(row: AdmissionRow | LogicalRow, now: Date): number {
  if (row.runtime_state === "paused" || row.runtime_state === "ended") {
    return Math.min(row.duration_seconds, row.clock_kind === "global"
      ? row.logical_anchor_seconds
      : row.entrant_logical_anchor_seconds);
  }
  const anchor = row.clock_kind === "global" ? row.wall_anchor_at : row.entrant_wall_anchor_at;
  const base = row.clock_kind === "global" ? row.logical_anchor_seconds : row.entrant_logical_anchor_seconds;
  if (anchor === null) throw new ApiError(409, "contest-not-started", "Contest logical clock is not running.");
  const anchorMilliseconds = Date.parse(anchor);
  if (!Number.isFinite(anchorMilliseconds)) throw new Error("Stored contest logical clock anchor is invalid.");
  const elapsed = Math.max(0, Math.floor((now.getTime() - anchorMilliseconds) / 1_000));
  return Math.min(row.duration_seconds, base + elapsed);
}

function elapsedMilliseconds(started: number, finished: number): number {
  if (!Number.isFinite(started) || !Number.isFinite(finished)) return 0;
  return Math.max(0, Math.round(finished - started));
}

function sameOutput(output: PromptCompilerGeneratedSource["output"], admission: AdmissionRow): boolean {
  return output.language === admission.output_language
    && output.target === admission.output_target
    && output.optimization === admission.output_optimization
    && output.entry === admission.output_entry_path;
}

function evidenceLogicalSeconds(
  evidenceAt: AdmissionRow["evidence_at"],
  admittedLogicalSeconds: number,
  sourceReadyLogicalSeconds: number | null,
): number | null {
  if (evidenceAt === "input-admitted") return admittedLogicalSeconds;
  if (evidenceAt === "generated-source-ready") return sourceReadyLogicalSeconds;
  return null;
}

function generatedSourceEligibility(
  admission: AdmissionRow,
  sourceReadyLogicalSeconds: number,
  sourceReadyAt: string,
): SubmissionEligibility {
  if (
    admission.evidence_at === "generated-source-ready"
    && sourceReadyLogicalSeconds >= admission.submission_closes_after_seconds
  ) {
    return {
      eligibility: "invalid",
      invalidatedAt: sourceReadyAt,
      invalidationReason: "generated-source-ready-after-close",
    };
  }
  return { eligibility: "eligible", invalidatedAt: null, invalidationReason: null };
}

function publicFailureCode(error: unknown): string {
  if (error instanceof PromptCompilerError) return error.code;
  if (error instanceof ApiError) return error.code.slice(0, 100);
  return "prompt-provider-failure";
}

function validateHostProduct(value: PromptGeneratedSubmissionResult): PromptGeneratedSubmissionResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Prompt submission host result is invalid.");
  const record = value as unknown as Record<string, unknown>;
  if (JSON.stringify(Object.keys(record).sort()) !== JSON.stringify(["sourceId", "sourceSha256", "submissionId"])) {
    throw new Error("Prompt submission host result has an invalid shape.");
  }
  assertUuidForHost(value.sourceId, "sourceId");
  assertUuidForHost(value.submissionId, "submissionId");
  if (!SHA256_PATTERN.test(value.sourceSha256)) throw new Error("Prompt submission host sourceSha256 is invalid.");
  return Object.freeze({ ...value });
}

function assertUuidForHost(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) throw new Error(`Prompt submission host ${label} is invalid.`);
}

function detailFromRow(row: PromptAttemptRow): PromptAttemptDetail {
  if (!isBuiltinLanguage(row.output_language)) throw new Error("Stored Prompt Program output language is invalid.");
  if (row.output_target !== "wasip1" && row.output_target !== "wasix") throw new Error("Stored Prompt Program output target is invalid.");
  if (row.output_optimization !== "debug" && row.output_optimization !== "release") throw new Error("Stored Prompt Program output optimization is invalid.");
  return {
    attemptId: row.id,
    contestId: row.contest_id,
    entrantId: row.entrant_id,
    problemId: row.problem_id,
    timelineGeneration: row.timeline_generation,
    rulesEpoch: row.rules_epoch,
    problemEpoch: row.problem_epoch,
    contentEpoch: row.content_epoch,
    judgeEpoch: row.judge_epoch,
    compilerConfigId: row.compiler_config_id,
    compilerConfigDigest: row.compiler_config_sha256,
    publicContextSha256: row.public_context_sha256,
    prompt: row.prompt_text,
    promptBytes: row.prompt_bytes,
    promptSha256: row.prompt_sha256,
    output: {
      language: row.output_language,
      target: row.output_target,
      optimization: row.output_optimization,
      entry: row.output_entry_path,
    },
    state: row.state,
    quota: {
      slot: row.quota_slot,
      limit: row.configured_limit,
      state: row.quota_state,
      settlementReason: row.settlement_reason,
    },
    generatedSourceId: row.generated_source_id,
    generatedSourceSha256: row.generated_source_sha256,
    submissionId: row.submission_id,
    admittedLogicalSeconds: row.admitted_logical_seconds,
    evidenceLogicalSeconds: row.evidence_logical_seconds,
    responseReceivedAt: row.response_received_at,
    sourceReadyAt: row.source_ready_at,
    terminalAt: row.terminal_at,
    providerDurationMs: row.provider_duration_ms,
    failureCode: row.failure_code,
    eligibility: row.eligibility,
    invalidationReason: row.invalidation_reason,
    erasedAt: row.erased_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function eventFromRow(row: EventRow): PromptAttemptEvent {
  if (!EVENT_TYPES.has(row.event_type as PromptAttemptEventType)) throw new Error("Stored prompt attempt event type is invalid.");
  let payload: unknown;
  try {
    payload = JSON.parse(row.payload_json) as unknown;
  } catch (cause) {
    throw new Error("Stored prompt attempt event payload is invalid JSON.", { cause });
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("Stored prompt attempt event payload is invalid.");
  for (const value of Object.values(payload as Record<string, unknown>)) {
    if (value !== null && !["string", "number", "boolean"].includes(typeof value)) {
      throw new Error("Stored prompt attempt event payload value is invalid.");
    }
  }
  assertTimestamp(row.created_at, "Stored prompt attempt event timestamp");
  return {
    sequence: row.id,
    type: row.event_type as PromptAttemptEventType,
    payload: payload as Readonly<Record<string, string | number | boolean | null>>,
    timestamp: row.created_at,
  };
}
