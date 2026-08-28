import { compareCanonicalPaths, assertSafeRelativePath } from "../core/project-files.ts";
import { sha256Hex } from "../core/sha256.ts";
import { isBuiltinLanguage, type BuiltinLanguage, type OptimizationLevel, type TargetAbi } from "../core/types.ts";
import { SUBMISSION_SOURCE_LIMITS, type OfficialSourceFile } from "./contracts.ts";
import { isUnicodeScalarString } from "./unicode-scalar.ts";

/**
 * Provider-neutral boundary for turning one UTF-8 prompt plus exact public
 * problem context into locked official submission sources.
 */

export const PROMPT_COMPILER_HARD_LIMITS = Object.freeze({
  promptBytes: 16 * 1024,
  outputFiles: SUBMISSION_SOURCE_LIMITS.maximumFiles,
  outputBytesPerFile: SUBMISSION_SOURCE_LIMITS.fileBytes,
  outputBytes: SUBMISSION_SOURCE_LIMITS.totalBytes,
});

export type PromptCompilerAttemptDisposition = "not-reserved" | "release" | "consume";

export type PromptCompilerErrorCode =
  | "prompt-compiler-unavailable"
  | "prompt-compiler-config-invalid"
  | "prompt-compiler-config-mismatch"
  | "prompt-invalid"
  | "prompt-context-integrity"
  | "prompt-provider-failure"
  | "prompt-response-invalid";

export class PromptCompilerError extends Error {
  readonly code: PromptCompilerErrorCode;
  readonly status: 400 | 409 | 502 | 503;
  readonly retryable: boolean;
  readonly attemptDisposition: PromptCompilerAttemptDisposition;

  constructor(
    message: string,
    options: {
      readonly code: PromptCompilerErrorCode;
      readonly status: 400 | 409 | 502 | 503;
      readonly retryable: boolean;
      readonly attemptDisposition: PromptCompilerAttemptDisposition;
      readonly cause?: unknown;
    },
  ) {
    super(message, { cause: options.cause });
    this.name = "PromptCompilerError";
    this.code = options.code;
    this.status = options.status;
    this.retryable = options.retryable;
    this.attemptDisposition = options.attemptDisposition;
  }
}

/** A safe adapter-declared failure that occurred before any model response. */
export class PromptCompilerAdapterError extends Error {
  constructor(message: string, readonly retryable: boolean, options?: ErrorOptions) {
    super(message, options);
    if (typeof message !== "string" || !message || message.length > 500) {
      throw new TypeError("Prompt compiler adapter error message must contain 1 to 500 characters.");
    }
    if (typeof retryable !== "boolean") throw new TypeError("Prompt compiler adapter retryable must be a boolean.");
    this.name = "PromptCompilerAdapterError";
  }
}

export interface PromptCompilerOutputProfile {
  readonly language: BuiltinLanguage;
  readonly target: TargetAbi;
  readonly optimization: OptimizationLevel;
  readonly entry: string;
}

export interface PromptCompilerLimits {
  readonly promptBytes: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly generatedSourceBytes: number;
  readonly timeoutSeconds: number;
}

export interface PromptCompilerConfig {
  readonly compilerConfigId: string;
  readonly compilerConfigDigest: string;
  readonly adapterId: string;
}

export interface PromptCompilerPublicContext {
  readonly content: string;
  readonly sha256: string;
}

export interface PromptCompilerAdapterRequest {
  readonly config: PromptCompilerConfig;
  readonly output: PromptCompilerOutputProfile;
  readonly limits: PromptCompilerLimits;
  readonly publicContext: PromptCompilerPublicContext;
  readonly prompt: string;
  readonly signal?: AbortSignal;
}

export interface PromptCompilerAdapter {
  readonly id: string;
  /**
   * Reject only when no model response was received. After any model response,
   * resolve its structured-source candidate (including malformed candidates)
   * so the registry can preserve consume-vs-release accounting.
   *
   * The adapter must enforce the invocation's model-specific token budgets.
   * The host independently enforces the wall-time boundary. The core supplies no tools, browsing, credentials,
   * or hidden judge inputs.
   */
  compile(request: PromptCompilerAdapterRequest): Promise<unknown>;
}

export interface PromptCompilerInvocation {
  readonly compilerConfigId: string;
  readonly compilerConfigDigest: string;
  readonly output: PromptCompilerOutputProfile;
  readonly limits: PromptCompilerLimits;
  readonly publicContext: PromptCompilerPublicContext;
  readonly prompt: string;
  readonly signal?: AbortSignal;
}

export interface PromptCompilerGeneratedSource {
  readonly output: PromptCompilerOutputProfile;
  readonly entry: string;
  readonly sourceFiles: readonly (OfficialSourceFile & { readonly encoding: "utf8" })[];
}

export interface PromptCompilerResult extends PromptCompilerGeneratedSource {
  readonly compilerConfigId: string;
  readonly compilerConfigDigest: string;
  readonly publicContextSha256: string;
  readonly attemptDisposition: "consume";
}

/**
 * Assist is intentionally not an official input identity. It receives a deep,
 * mutable copy that an editor may change before creating an ordinary code
 * submission; Prompt Program callers keep using the frozen compiler result.
 */
export interface PromptAssistDraft {
  output: PromptCompilerOutputProfile;
  entry: string;
  sourceFiles: Array<{ path: string; encoding: "utf8"; content: string }>;
}

export function promptCompilerResultToAssistDraft(
  generated: PromptCompilerGeneratedSource,
): PromptAssistDraft {
  const parsed = parsePromptCompilerGeneratedSourceResponse(
    { sourceFiles: generated.sourceFiles },
    generated.output,
    {
      promptBytes: 1,
      inputTokens: 1,
      outputTokens: 1,
      generatedSourceBytes: PROMPT_COMPILER_HARD_LIMITS.outputBytes,
      timeoutSeconds: 1,
    },
  );
  return {
    output: { ...parsed.output },
    entry: parsed.entry,
    sourceFiles: parsed.sourceFiles.map((file) => ({ ...file })),
  };
}

export function parsePromptCompilerConfig(value: unknown): PromptCompilerConfig {
  const config = configRecord(value, "Prompt compiler config");
  exactKeys(
    config,
    ["adapterId", "compilerConfigDigest", "compilerConfigId"],
    "Prompt compiler config",
  );
  const compilerConfigId = configIdentifier(config.compilerConfigId, "compilerConfigId");
  const compilerConfigDigest = configDigest(config.compilerConfigDigest, "compilerConfigDigest");
  const adapterId = configIdentifier(config.adapterId, "adapterId");
  return Object.freeze({
    compilerConfigId,
    compilerConfigDigest,
    adapterId,
  });
}

export function validatePromptCompilerPrompt(prompt: unknown, maximumBytes: number): string {
  if (!positiveSafeInteger(maximumBytes) || maximumBytes > PROMPT_COMPILER_HARD_LIMITS.promptBytes) {
    throw configFailure(
      `Prompt byte limit must be between 1 and ${PROMPT_COMPILER_HARD_LIMITS.promptBytes}.`,
    );
  }
  if (typeof prompt !== "string" || prompt.length === 0) {
    throw promptFailure("Prompt must be one non-empty UTF-8 string.");
  }
  if (!isUnicodeScalarString(prompt)) throw promptFailure("Prompt must contain only Unicode scalar values.");
  if (UTF8_ENCODER.encode(prompt).byteLength > maximumBytes) {
    throw promptFailure(`Prompt exceeds its ${maximumBytes}-byte UTF-8 limit.`);
  }
  return prompt;
}

export async function verifyPromptCompilerPublicContext(
  value: unknown,
): Promise<PromptCompilerPublicContext> {
  const context = contextRecord(value);
  exactContextKeys(context, ["content", "sha256"]);
  if (typeof context.content !== "string" || !isUnicodeScalarString(context.content)) {
    throw contextFailure("Prompt compiler public context must be a Unicode scalar string.");
  }
  if (typeof context.sha256 !== "string" || !SHA256_PATTERN.test(context.sha256)) {
    throw contextFailure("Prompt compiler public context sha256 must be a lowercase SHA-256 digest.");
  }
  const actualDigest = await sha256Hex(UTF8_ENCODER.encode(context.content));
  if (actualDigest !== context.sha256) {
    throw contextFailure("Prompt compiler public context failed SHA-256 integrity verification.");
  }
  return Object.freeze({ content: context.content, sha256: context.sha256 });
}

export function parsePromptCompilerGeneratedSourceResponse(
  value: unknown,
  output: PromptCompilerOutputProfile,
  limits: PromptCompilerLimits,
): PromptCompilerGeneratedSource {
  const fixedOutput = parseOutputProfile(output);
  const fixedLimits = parsePromptCompilerLimits(limits);
  const response = responseRecord(value, "Prompt compiler response");
  exactResponseKeys(response, ["sourceFiles"], "Prompt compiler response");
  if (
    !Array.isArray(response.sourceFiles)
    || response.sourceFiles.length < 1
    || response.sourceFiles.length > PROMPT_COMPILER_HARD_LIMITS.outputFiles
  ) {
    throw responseFailure(
      `Prompt compiler response sourceFiles must contain between 1 and ${PROMPT_COMPILER_HARD_LIMITS.outputFiles} files.`,
    );
  }

  const paths = new Set<string>();
  let totalBytes = 0;
  const sourceFiles = response.sourceFiles.map((candidate, index) => {
    const label = `Prompt compiler response sourceFiles[${index}]`;
    const file = responseRecord(candidate, label);
    exactResponseKeys(file, ["content", "encoding", "path"], label);
    const path = responsePath(file.path, `${label}.path`);
    if (paths.has(path)) throw responseFailure(`Prompt compiler response repeats source path '${path}'.`);
    paths.add(path);
    if (file.encoding !== "utf8") {
      throw responseFailure(`Prompt compiler response source file '${path}' must use utf8 encoding.`);
    }
    if (typeof file.content !== "string" || !isUnicodeScalarString(file.content)) {
      throw responseFailure(`Prompt compiler response source file '${path}' must contain UTF-8 text.`);
    }
    const bytes = UTF8_ENCODER.encode(file.content).byteLength;
    if (bytes > PROMPT_COMPILER_HARD_LIMITS.outputBytesPerFile) {
      throw responseFailure(
        `Prompt compiler response source file '${path}' exceeds ${PROMPT_COMPILER_HARD_LIMITS.outputBytesPerFile} bytes.`,
      );
    }
    totalBytes += bytes;
    if (totalBytes > fixedLimits.generatedSourceBytes || totalBytes > PROMPT_COMPILER_HARD_LIMITS.outputBytes) {
      throw responseFailure(
        `Prompt compiler response sources exceed the ${fixedLimits.generatedSourceBytes}-byte generated source limit.`,
      );
    }
    return Object.freeze({ path, encoding: "utf8" as const, content: file.content });
  }).sort((left, right) => compareCanonicalPaths(left.path, right.path));

  if (!paths.has(fixedOutput.entry)) {
    throw responseFailure(`Prompt compiler response must contain fixed entry '${fixedOutput.entry}'.`);
  }
  return Object.freeze({
    output: fixedOutput,
    entry: fixedOutput.entry,
    sourceFiles: Object.freeze(sourceFiles),
  });
}

export class PromptCompilerRegistry {
  readonly #registrations = new Map<string, PromptCompilerRegistration>();

  register(configValue: unknown, adapter: PromptCompilerAdapter): PromptCompilerConfig {
    const config = parsePromptCompilerConfig(configValue);
    if (!adapter || typeof adapter !== "object" || Array.isArray(adapter) || typeof adapter.compile !== "function") {
      throw configFailure("Prompt compiler adapter must be an object with a compile method.");
    }
    const adapterId = configIdentifier(adapter.id, "Prompt compiler adapter id");
    if (adapterId !== config.adapterId) {
      throw configFailure(
        `Prompt compiler config adapterId '${config.adapterId}' does not match adapter '${adapterId}'.`,
      );
    }
    if (this.#registrations.has(config.compilerConfigId)) {
      throw configFailure(`Prompt compiler config '${config.compilerConfigId}' is already registered.`);
    }
    this.#registrations.set(config.compilerConfigId, Object.freeze({ config, adapter }));
    return config;
  }

  isAvailable(compilerConfigId: string, compilerConfigDigest: string): boolean {
    if (!validConfigIdentifier(compilerConfigId) || !SHA256_PATTERN.test(compilerConfigDigest)) return false;
    return this.#registrations.get(compilerConfigId)?.config.compilerConfigDigest === compilerConfigDigest;
  }

  async compile(invocation: PromptCompilerInvocation): Promise<PromptCompilerResult> {
    const input = invocationRecord(invocation);
    exactInvocationKeys(input);
    const compilerConfigId = invocationIdentifier(input.compilerConfigId, "compilerConfigId");
    const compilerConfigDigest = invocationDigest(input.compilerConfigDigest, "compilerConfigDigest");
    const registration = this.#registrations.get(compilerConfigId);
    if (!registration) {
      throw new PromptCompilerError(
        `Prompt compiler config '${compilerConfigId}' is unavailable.`,
        {
          code: "prompt-compiler-unavailable",
          status: 503,
          retryable: true,
          attemptDisposition: "not-reserved",
        },
      );
    }
    if (registration.config.compilerConfigDigest !== compilerConfigDigest) {
      throw new PromptCompilerError(
        `Prompt compiler config '${compilerConfigId}' digest does not match its registered immutable config.`,
        {
          code: "prompt-compiler-config-mismatch",
          status: 409,
          retryable: false,
          attemptDisposition: "not-reserved",
        },
      );
    }
    const limits = parsePromptCompilerLimits(input.limits);
    const prompt = validatePromptCompilerPrompt(input.prompt, limits.promptBytes);
    const publicContext = await verifyPromptCompilerPublicContext(input.publicContext);
    const output = parseOutputProfile(input.output);
    let response: unknown;
    try {
      response = await invokePromptCompilerAdapter(
        registration,
        output,
        limits,
        publicContext,
        prompt,
        input.signal as AbortSignal | undefined,
      );
    } catch (cause) {
      const declaredFailure = cause instanceof PromptCompilerAdapterError;
      throw new PromptCompilerError(
        declaredFailure
          ? cause.message
          : "Prompt compiler provider failed before returning a response.",
        {
          code: "prompt-provider-failure",
          status: 502,
          retryable: declaredFailure ? cause.retryable : true,
          attemptDisposition: "release",
          cause,
        },
      );
    }

    const generated = parsePromptCompilerGeneratedSourceResponse(
      response,
      output,
      limits,
    );
    return Object.freeze({
      compilerConfigId,
      compilerConfigDigest,
      publicContextSha256: publicContext.sha256,
      attemptDisposition: "consume",
      output: generated.output,
      entry: generated.entry,
      sourceFiles: generated.sourceFiles,
    });
  }
}

interface PromptCompilerRegistration {
  readonly config: PromptCompilerConfig;
  readonly adapter: PromptCompilerAdapter;
}

async function invokePromptCompilerAdapter(
  registration: PromptCompilerRegistration,
  output: PromptCompilerOutputProfile,
  limits: PromptCompilerLimits,
  publicContext: PromptCompilerPublicContext,
  prompt: string,
  callerSignal: AbortSignal | undefined,
): Promise<unknown> {
  const controller = new AbortController();
  let rejectBoundary!: (reason: PromptCompilerAdapterError) => void;
  const boundary = new Promise<never>((_resolve, reject) => { rejectBoundary = reject; });
  const cancel = (): void => {
    controller.abort(callerSignal?.reason);
    rejectBoundary(new PromptCompilerAdapterError("Prompt compiler invocation was cancelled before a response.", true));
  };
  if (callerSignal?.aborted) cancel();
  else callerSignal?.addEventListener("abort", cancel, { once: true });
  const timeout = setTimeout(() => {
    controller.abort(new DOMException("Prompt compiler deadline exceeded.", "TimeoutError"));
    rejectBoundary(new PromptCompilerAdapterError("Prompt compiler timed out before a response.", true));
  }, limits.timeoutSeconds * 1_000);
  try {
    return await Promise.race([
      Promise.resolve().then(() => registration.adapter.compile(Object.freeze({
        config: registration.config,
        output,
        limits,
        publicContext,
        prompt,
        signal: controller.signal,
      }))),
      boundary,
    ]);
  } finally {
    clearTimeout(timeout);
    callerSignal?.removeEventListener("abort", cancel);
  }
}

const UTF8_ENCODER = new TextEncoder();
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const CONFIG_IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const OFFICIAL_SOURCE_PATH_MAX_CHARACTERS = 512;

function positiveSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

function validConfigIdentifier(value: unknown): value is string {
  return typeof value === "string" && CONFIG_IDENTIFIER_PATTERN.test(value);
}

function configFailure(message: string, cause?: unknown): PromptCompilerError {
  return new PromptCompilerError(message, {
    code: "prompt-compiler-config-invalid",
    status: 400,
    retryable: false,
    attemptDisposition: "not-reserved",
    cause,
  });
}

function promptFailure(message: string): PromptCompilerError {
  return new PromptCompilerError(message, {
    code: "prompt-invalid",
    status: 400,
    retryable: false,
    attemptDisposition: "not-reserved",
  });
}

function contextFailure(message: string): PromptCompilerError {
  return new PromptCompilerError(message, {
    code: "prompt-context-integrity",
    status: 409,
    retryable: false,
    attemptDisposition: "not-reserved",
  });
}

function responseFailure(message: string, cause?: unknown): PromptCompilerError {
  return new PromptCompilerError(message, {
    code: "prompt-response-invalid",
    status: 502,
    retryable: false,
    attemptDisposition: "consume",
    cause,
  });
}

function configRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw configFailure(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function contextRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw contextFailure("Prompt compiler public context must be an object.");
  }
  return value as Record<string, unknown>;
}

function responseRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw responseFailure(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[], label: string): void {
  const actual = Object.keys(value).sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw configFailure(`${label} has an invalid shape.`);
  }
}

function exactContextKeys(value: Record<string, unknown>, expected: readonly string[]): void {
  const actual = Object.keys(value).sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw contextFailure("Prompt compiler public context has an invalid shape.");
  }
}

function exactResponseKeys(value: Record<string, unknown>, expected: readonly string[], label: string): void {
  const actual = Object.keys(value).sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw responseFailure(`${label} has an invalid shape.`);
  }
}

function configIdentifier(value: unknown, label: string): string {
  if (!validConfigIdentifier(value)) {
    throw configFailure(`${label} must be a 1 to 128 character portable identifier.`);
  }
  return value;
}

function invocationIdentifier(value: unknown, label: string): string {
  if (!validConfigIdentifier(value)) {
    throw configFailure(`${label} must be a 1 to 128 character portable identifier.`);
  }
  return value;
}

function configDigest(value: unknown, label: string): string {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
    throw configFailure(`${label} must be a lowercase SHA-256 digest.`);
  }
  return value;
}

function invocationDigest(value: unknown, label: string): string {
  return configDigest(value, label);
}

function parseOutputProfile(value: unknown): PromptCompilerOutputProfile {
  const output = configRecord(value, "Prompt compiler output profile");
  exactKeys(output, ["entry", "language", "optimization", "target"], "Prompt compiler output profile");
  if (typeof output.language !== "string" || !isBuiltinLanguage(output.language)) {
    throw configFailure("Prompt compiler output language is unsupported.");
  }
  if (output.target !== "wasip1" && output.target !== "wasix") {
    throw configFailure("Prompt compiler output target is unsupported.");
  }
  if (output.optimization !== "debug" && output.optimization !== "release") {
    throw configFailure("Prompt compiler output optimization is unsupported.");
  }
  const entry = configPath(output.entry, "Prompt compiler output entry");
  return Object.freeze({
    language: output.language,
    target: output.target,
    optimization: output.optimization,
    entry,
  });
}

export function parsePromptCompilerLimits(value: unknown): PromptCompilerLimits {
  const limits = configRecord(value, "Prompt compiler limits");
  exactKeys(
    limits,
    ["generatedSourceBytes", "inputTokens", "outputTokens", "promptBytes", "timeoutSeconds"],
    "Prompt compiler limits",
  );
  if (!positiveSafeInteger(limits.promptBytes) || limits.promptBytes > PROMPT_COMPILER_HARD_LIMITS.promptBytes) {
    throw configFailure(
      `Prompt compiler promptBytes must be between 1 and ${PROMPT_COMPILER_HARD_LIMITS.promptBytes}.`,
    );
  }
  if (!positiveSafeInteger(limits.inputTokens)) {
    throw configFailure("Prompt compiler inputTokens must be a positive safe integer.");
  }
  if (!positiveSafeInteger(limits.outputTokens)) {
    throw configFailure("Prompt compiler outputTokens must be a positive safe integer.");
  }
  if (
    !positiveSafeInteger(limits.generatedSourceBytes)
    || limits.generatedSourceBytes > PROMPT_COMPILER_HARD_LIMITS.outputBytes
  ) {
    throw configFailure(
      `Prompt compiler generatedSourceBytes must be between 1 and ${PROMPT_COMPILER_HARD_LIMITS.outputBytes}.`,
    );
  }
  if (!positiveSafeInteger(limits.timeoutSeconds) || limits.timeoutSeconds > 3_600) {
    throw configFailure("Prompt compiler timeoutSeconds must be between 1 and 3600.");
  }
  return Object.freeze({
    promptBytes: limits.promptBytes,
    inputTokens: limits.inputTokens,
    outputTokens: limits.outputTokens,
    generatedSourceBytes: limits.generatedSourceBytes,
    timeoutSeconds: limits.timeoutSeconds,
  });
}

function configPath(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length > OFFICIAL_SOURCE_PATH_MAX_CHARACTERS) {
    throw configFailure(`${label} must be a normalized relative POSIX path.`);
  }
  try {
    assertSafeRelativePath(value, label);
  } catch (cause) {
    throw configFailure(`${label} must be a normalized relative POSIX path.`, cause);
  }
  return value;
}

function responsePath(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length > OFFICIAL_SOURCE_PATH_MAX_CHARACTERS) {
    throw responseFailure(`${label} must be a normalized relative POSIX path.`);
  }
  try {
    assertSafeRelativePath(value, label);
  } catch (cause) {
    throw responseFailure(`${label} must be a normalized relative POSIX path.`, cause);
  }
  return value;
}

function invocationRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw configFailure("Prompt compiler invocation must be an object.");
  }
  return value as Record<string, unknown>;
}

function exactInvocationKeys(value: Record<string, unknown>): void {
  const hasSignal = Object.hasOwn(value, "signal");
  const expected = hasSignal
    ? ["compilerConfigDigest", "compilerConfigId", "limits", "output", "prompt", "publicContext", "signal"]
    : ["compilerConfigDigest", "compilerConfigId", "limits", "output", "prompt", "publicContext"];
  const actual = Object.keys(value).sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw configFailure("Prompt compiler invocation has an invalid shape.");
  }
  if (hasSignal && value.signal !== undefined && !abortSignal(value.signal)) {
    throw configFailure("Prompt compiler invocation signal must be an AbortSignal.");
  }
}

function abortSignal(value: unknown): value is AbortSignal {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Partial<AbortSignal>;
  return typeof candidate.aborted === "boolean"
    && typeof candidate.addEventListener === "function"
    && typeof candidate.removeEventListener === "function";
}
