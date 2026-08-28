import { isBuiltinLanguage, type BuiltinLanguage, type OptimizationLevel, type TargetAbi } from "../../../core/types";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const MAX_SAFE_TEXT = 16 * 1024 * 1024;

export type PromptAttemptState = "reserved" | "generating" | "source-ready" | "submitted" | "failed" | "cancelled";
export type PromptAttemptQuotaState = "reserved" | "consumed" | "released" | "invalid";

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

export interface PromptAttemptDetail extends PromptAttemptHistoryItem {
  readonly entrantId: string;
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
  readonly quota: {
    readonly slot: number;
    readonly limit: number;
    readonly state: PromptAttemptQuotaState;
    readonly settlementReason: string | null;
  };
  readonly generatedSourceId: string | null;
  readonly generatedSourceSha256: string | null;
  readonly admittedLogicalSeconds: number;
  readonly evidenceLogicalSeconds: number | null;
  readonly responseReceivedAt: string | null;
  readonly sourceReadyAt: string | null;
  readonly terminalAt: string | null;
  readonly providerDurationMs: number | null;
  readonly invalidationReason: string | null;
  readonly erasedAt: string | null;
}

export interface GeneratedSourceFile {
  readonly path: string;
  readonly encoding: "utf8";
  readonly content: string;
}

export interface GeneratedSource {
  readonly sourceDigest: string;
  readonly request: {
    readonly language: BuiltinLanguage;
    readonly target: TargetAbi;
    readonly optimization: OptimizationLevel;
    readonly entry: string;
    readonly sourceFiles: readonly GeneratedSourceFile[];
  };
}

export interface PromptAttemptAccepted {
  readonly promptAttemptId: string;
  readonly state: PromptAttemptState;
  readonly replayed: boolean;
  readonly detailUrl: string;
  readonly eventsUrl: string;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${label} must be an object.`);
  return value as Record<string, unknown>;
}

function exact(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  if (JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...keys].sort())) {
    throw new TypeError(`${label} has an invalid shape.`);
  }
}

function text(value: unknown, maximum: number, label: string, allowEmpty = false): string {
  if (typeof value !== "string" || value.length > maximum || (!allowEmpty && value.length === 0)) {
    throw new TypeError(`${label} is invalid.`);
  }
  return value;
}

function nullableText(value: unknown, maximum: number, label: string): string | null {
  return value === null ? null : text(value, maximum, label);
}

function uuid(value: unknown, label: string): string {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) throw new TypeError(`${label} must be a UUID.`);
  return value;
}

function sha256(value: unknown, label: string): string {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) throw new TypeError(`${label} must be a SHA-256 digest.`);
  return value;
}

function nullableSha256(value: unknown, label: string): string | null {
  return value === null ? null : sha256(value, label);
}

function integer(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new TypeError(`${label} must be a non-negative integer.`);
  return value as number;
}

function positiveInteger(value: unknown, label: string): number {
  const result = integer(value, label);
  if (result < 1) throw new TypeError(`${label} must be a positive integer.`);
  return result;
}

function nullableInteger(value: unknown, label: string): number | null {
  return value === null ? null : integer(value, label);
}

function timestamp(value: unknown, label: string): string {
  if (typeof value !== "string" || Number.isNaN(Date.parse(value)) || new Date(value).toISOString() !== value) {
    throw new TypeError(`${label} must be a canonical timestamp.`);
  }
  return value;
}

function nullableTimestamp(value: unknown, label: string): string | null {
  return value === null ? null : timestamp(value, label);
}

function attemptState(value: unknown, label: string): PromptAttemptState {
  if (value !== "reserved" && value !== "generating" && value !== "source-ready"
    && value !== "submitted" && value !== "failed" && value !== "cancelled") {
    throw new TypeError(`${label} is invalid.`);
  }
  return value;
}

function quotaState(value: unknown, label: string): PromptAttemptQuotaState {
  if (value !== "reserved" && value !== "consumed" && value !== "released" && value !== "invalid") {
    throw new TypeError(`${label} is invalid.`);
  }
  return value;
}

function nullableUuid(value: unknown, label: string): string | null {
  return value === null ? null : uuid(value, label);
}

function historyItem(value: unknown, label: string): PromptAttemptHistoryItem {
  const item = record(value, label);
  exact(item, [
    "attemptId", "contestId", "problemId", "state", "quotaState", "submissionId", "failureCode",
    "eligibility", "createdAt", "updatedAt",
  ], label);
  if (item.eligibility !== "eligible" && item.eligibility !== "invalid") throw new TypeError(`${label}.eligibility is invalid.`);
  return {
    attemptId: uuid(item.attemptId, `${label}.attemptId`),
    contestId: uuid(item.contestId, `${label}.contestId`),
    problemId: uuid(item.problemId, `${label}.problemId`),
    state: attemptState(item.state, `${label}.state`),
    quotaState: quotaState(item.quotaState, `${label}.quotaState`),
    submissionId: nullableUuid(item.submissionId, `${label}.submissionId`),
    failureCode: nullableText(item.failureCode, 160, `${label}.failureCode`),
    eligibility: item.eligibility,
    createdAt: timestamp(item.createdAt, `${label}.createdAt`),
    updatedAt: timestamp(item.updatedAt, `${label}.updatedAt`),
  };
}

export function parsePromptAttemptHistoryResponse(value: unknown): readonly PromptAttemptHistoryItem[] {
  const wrapper = record(value, "Prompt attempt history response");
  exact(wrapper, ["promptAttempts"], "Prompt attempt history response");
  if (!Array.isArray(wrapper.promptAttempts) || wrapper.promptAttempts.length > 100) {
    throw new TypeError("Prompt attempt history is invalid.");
  }
  return wrapper.promptAttempts.map((item, index) => historyItem(item, `promptAttempts[${index}]`));
}

export function parsePromptAttemptAccepted(value: unknown): PromptAttemptAccepted {
  const item = record(value, "Prompt attempt acceptance");
  exact(item, ["promptAttemptId", "state", "replayed", "detailUrl", "eventsUrl"], "Prompt attempt acceptance");
  const state = attemptState(item.state, "Prompt attempt acceptance state");
  if (typeof item.replayed !== "boolean") throw new TypeError("Prompt attempt replayed flag is invalid.");
  const promptAttemptId = uuid(item.promptAttemptId, "Prompt attempt acceptance ID");
  const expectedDetail = `/api/prompt-attempts/${promptAttemptId}`;
  const detail = new URL(text(item.detailUrl, 2_048, "Prompt attempt detail URL"), "https://wasm-oj.invalid");
  const events = new URL(text(item.eventsUrl, 2_048, "Prompt attempt events URL"), "https://wasm-oj.invalid");
  if (detail.pathname !== expectedDetail || detail.search || events.pathname !== `${expectedDetail}/events` || events.search) {
    throw new TypeError("Prompt attempt response URLs do not match its identity.");
  }
  return {
    promptAttemptId,
    state,
    replayed: item.replayed,
    detailUrl: item.detailUrl as string,
    eventsUrl: item.eventsUrl as string,
  };
}

export function parsePromptAttemptDetailResponse(value: unknown): PromptAttemptDetail {
  const wrapper = record(value, "Prompt attempt detail response");
  exact(wrapper, ["promptAttempt"], "Prompt attempt detail response");
  const item = record(wrapper.promptAttempt, "Prompt attempt");
  exact(item, [
    "attemptId", "contestId", "entrantId", "problemId", "timelineGeneration", "rulesEpoch", "problemEpoch", "contentEpoch",
    "judgeEpoch", "compilerConfigId", "compilerConfigDigest", "publicContextSha256", "prompt", "promptBytes",
    "promptSha256", "output", "state", "quota", "generatedSourceId", "generatedSourceSha256", "submissionId",
    "admittedLogicalSeconds", "evidenceLogicalSeconds", "responseReceivedAt", "sourceReadyAt", "terminalAt",
    "providerDurationMs", "failureCode", "eligibility", "invalidationReason", "erasedAt", "createdAt", "updatedAt",
  ], "Prompt attempt");
  const output = record(item.output, "Prompt attempt output");
  exact(output, ["language", "target", "optimization", "entry"], "Prompt attempt output");
  if (typeof output.language !== "string" || !isBuiltinLanguage(output.language)) throw new TypeError("Prompt attempt output language is invalid.");
  if (output.target !== "wasip1" && output.target !== "wasix") throw new TypeError("Prompt attempt output target is invalid.");
  if (output.optimization !== "debug" && output.optimization !== "release") throw new TypeError("Prompt attempt output optimization is invalid.");
  const quota = record(item.quota, "Prompt attempt quota");
  exact(quota, ["slot", "limit", "state", "settlementReason"], "Prompt attempt quota");
  if (item.eligibility !== "eligible" && item.eligibility !== "invalid") throw new TypeError("Prompt attempt eligibility is invalid.");
  const invalidationReason = nullableText(item.invalidationReason, 160, "Prompt attempt invalidation reason");
  if ((item.eligibility === "eligible") !== (invalidationReason === null)) throw new TypeError("Prompt attempt eligibility facts disagree.");
  const prompt = nullableText(item.prompt, 16 * 1024, "Prompt attempt prompt");
  const promptBytes = nullableInteger(item.promptBytes, "Prompt attempt prompt bytes");
  if ((prompt === null) !== (promptBytes === null) || (prompt === null) !== (item.promptSha256 === null)) {
    throw new TypeError("Prompt attempt prompt provenance is incomplete.");
  }
  return {
    attemptId: uuid(item.attemptId, "Prompt attempt ID"),
    contestId: uuid(item.contestId, "Prompt attempt contest ID"),
    entrantId: uuid(item.entrantId, "Prompt attempt entrant ID"),
    problemId: uuid(item.problemId, "Prompt attempt problem ID"),
    timelineGeneration: positiveInteger(item.timelineGeneration, "Prompt attempt timeline generation"),
    rulesEpoch: positiveInteger(item.rulesEpoch, "Prompt attempt rules epoch"),
    problemEpoch: positiveInteger(item.problemEpoch, "Prompt attempt problem epoch"),
    contentEpoch: positiveInteger(item.contentEpoch, "Prompt attempt content epoch"),
    judgeEpoch: positiveInteger(item.judgeEpoch, "Prompt attempt judge epoch"),
    compilerConfigId: text(item.compilerConfigId, 128, "Prompt compiler config ID"),
    compilerConfigDigest: sha256(item.compilerConfigDigest, "Prompt compiler config digest"),
    publicContextSha256: sha256(item.publicContextSha256, "Prompt public context digest"),
    prompt,
    promptBytes,
    promptSha256: nullableSha256(item.promptSha256, "Prompt digest"),
    output: {
      language: output.language,
      target: output.target,
      optimization: output.optimization,
      entry: text(output.entry, 1_024, "Prompt output entry"),
    },
    state: attemptState(item.state, "Prompt attempt state"),
    quota: {
      slot: positiveInteger(quota.slot, "Prompt quota slot"),
      limit: positiveInteger(quota.limit, "Prompt quota limit"),
      state: quotaState(quota.state, "Prompt quota state"),
      settlementReason: nullableText(quota.settlementReason, 160, "Prompt quota settlement reason"),
    },
    generatedSourceId: nullableUuid(item.generatedSourceId, "Generated source ID"),
    generatedSourceSha256: nullableSha256(item.generatedSourceSha256, "Generated source digest"),
    submissionId: nullableUuid(item.submissionId, "Prompt submission ID"),
    admittedLogicalSeconds: integer(item.admittedLogicalSeconds, "Prompt admission logical time"),
    evidenceLogicalSeconds: nullableInteger(item.evidenceLogicalSeconds, "Prompt evidence logical time"),
    responseReceivedAt: nullableTimestamp(item.responseReceivedAt, "Prompt response timestamp"),
    sourceReadyAt: nullableTimestamp(item.sourceReadyAt, "Generated source timestamp"),
    terminalAt: nullableTimestamp(item.terminalAt, "Prompt terminal timestamp"),
    providerDurationMs: nullableInteger(item.providerDurationMs, "Prompt provider duration"),
    failureCode: nullableText(item.failureCode, 160, "Prompt failure code"),
    eligibility: item.eligibility,
    invalidationReason,
    erasedAt: nullableTimestamp(item.erasedAt, "Prompt erasure timestamp"),
    createdAt: timestamp(item.createdAt, "Prompt creation timestamp"),
    updatedAt: timestamp(item.updatedAt, "Prompt update timestamp"),
    quotaState: quotaState(quota.state, "Prompt quota state"),
  };
}

export function parseGeneratedSource(value: unknown): GeneratedSource {
  const wrapper = record(value, "Generated source");
  exact(wrapper, ["schema", "sourceDigest", "request"], "Generated source");
  if (wrapper.schema !== "wasm-oj-platform/official-source/v1") throw new TypeError("Generated source schema is invalid.");
  const request = record(wrapper.request, "Generated source request");
  exact(request, ["language", "target", "optimization", "entry", "sourceFiles"], "Generated source request");
  if (typeof request.language !== "string" || !isBuiltinLanguage(request.language)) throw new TypeError("Generated source language is invalid.");
  if (request.target !== "wasip1" && request.target !== "wasix") throw new TypeError("Generated source target is invalid.");
  if (request.optimization !== "debug" && request.optimization !== "release") throw new TypeError("Generated source optimization is invalid.");
  if (!Array.isArray(request.sourceFiles) || request.sourceFiles.length < 1 || request.sourceFiles.length > 128) {
    throw new TypeError("Generated source files are invalid.");
  }
  const sourceFiles = request.sourceFiles.map((candidate, index) => {
    const file = record(candidate, `Generated source file ${index}`);
    exact(file, ["path", "encoding", "content"], `Generated source file ${index}`);
    if (file.encoding !== "utf8") throw new TypeError(`Generated source file ${index} encoding is invalid.`);
    return {
      path: text(file.path, 1_024, `Generated source file ${index} path`),
      encoding: "utf8" as const,
      content: text(file.content, MAX_SAFE_TEXT, `Generated source file ${index} content`, true),
    };
  });
  return {
    sourceDigest: sha256(wrapper.sourceDigest, "Generated source digest"),
    request: {
      language: request.language,
      target: request.target,
      optimization: request.optimization,
      entry: text(request.entry, 1_024, "Generated source entry"),
      sourceFiles,
    },
  };
}

export function promptUtf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

export function isPromptAttemptTerminal(state: PromptAttemptState): boolean {
  return state === "submitted" || state === "failed" || state === "cancelled";
}
