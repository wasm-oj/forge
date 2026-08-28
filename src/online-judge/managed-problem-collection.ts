import type { BuiltinLanguage, OptimizationLevel, TargetAbi } from "../core/types";
import {
  BROWSER_COLLECTION_SCHEMA,
  BROWSER_PROBLEM_SCHEMA,
  parseStandaloneProblemBundle,
} from "../judge/problem-catalog-loader";
import {
  PROBLEM_LOCALES,
  type JudgeProblem,
  type JudgeProblemSummary,
} from "../judge/problem-model";
import { parseJudgeAllowedProfiles, type JudgeAllowedProfiles } from "./compile-profiles";
import {
  parseOfficialSubmissionRequest,
  type OfficialSourceFile,
  type OfficialSubmissionRequest,
  type ContestSubmissionContext,
} from "./contracts";
import {
  parseContestPublicProblemProjection,
} from "./public-projection";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const JSON_CONTENT_TYPE = /^application\/json(?:\s*;\s*charset=utf-8)?$/i;
const MAX_METADATA_BYTES = 64 * 1024;
const MAX_PUBLIC_CONTENT_BYTES = 8 * 1024 * 1024;
const COMMIT_PATTERN = /^[0-9a-f]{40}$/;
const METADATA_SCHEMA = "wasm-oj-platform/problem-content-pointer/v2";
type ManagedPublicProjectionMode = "official-practice" | "contest";

export interface ManagedProblemContext {
  readonly problemId: string;
  readonly contestId?: string;
}

export interface ManagedProblemCollectionSource extends ManagedProblemContext {
  readonly provider: "managed";
  readonly mode: ManagedPublicProjectionMode;
  readonly catalogCommit: string;
  readonly metadataUrl: string;
  readonly contentUrl: string;
  readonly contentSha256: string;
  readonly allowedProfiles: JudgeAllowedProfiles;
  readonly aiAssistAvailable: boolean;
  readonly assistContextSha256: string | null;
  readonly contestAdmission?: Pick<ContestSubmissionContext, "timelineGeneration" | "ruleEpoch" | "problemEpoch">;
  readonly promptContextSha256?: string;
}

export interface ManagedProblemCollectionEntry extends JudgeProblemSummary {
  readonly bundle: {
    readonly kind: "managed-content";
    readonly sha256: string;
    readonly bytes: number;
  };
}

export interface LoadedManagedProblemCollection {
  readonly source: ManagedProblemCollectionSource;
  readonly sourceKey: string;
  readonly index: {
    readonly schema: typeof BROWSER_COLLECTION_SCHEMA;
    readonly problemSchema: typeof BROWSER_PROBLEM_SCHEMA;
    readonly revision: string;
    readonly localization: {
      readonly defaultLocale: "zh-TW";
      readonly supportedLocales: typeof PROBLEM_LOCALES;
    };
    readonly problems: readonly ManagedProblemCollectionEntry[];
  };
  readonly origin: "managed-content";
  loadProblem(id: string, signal?: AbortSignal): Promise<JudgeProblem>;
}

export interface LoadManagedProblemCollectionOptions {
  readonly fetch?: typeof fetch;
  readonly signal?: AbortSignal;
}

export interface OfficialSubmissionSourceInput {
  readonly language: BuiltinLanguage;
  readonly target: TargetAbi;
  readonly optimization: OptimizationLevel;
  readonly entry: string;
  readonly sourceFiles: readonly OfficialSourceFile[];
  readonly idempotencyKey: string;
}

interface ManagedProblemContentPointer {
  readonly problemId: string;
  readonly catalogCommit: string;
  readonly problemSlug: string;
  readonly problemNumber: number;
  readonly title: Readonly<Record<"zh-TW" | "en", string>>;
  readonly allowedProfiles: JudgeAllowedProfiles;
  readonly maximumScore: 100;
  readonly judgeDigest: string;
  readonly aiAssistAvailable: boolean;
  readonly assistContextSha256: string | null;
  readonly contestAdmission?: Pick<ContestSubmissionContext, "timelineGeneration" | "ruleEpoch" | "problemEpoch">;
  readonly promptContextSha256?: string;
  readonly content: {
    readonly role: "practice" | "contest";
    readonly bytes: number;
    readonly sha256: string;
    readonly url: string;
  };
}

export class ManagedProblemCollectionError extends Error {
  constructor(
    message: string,
    readonly kind: "configuration" | "network" | "unavailable" | "integrity" | "schema",
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ManagedProblemCollectionError";
  }
}

export function normalizeManagedProblemContext(value: unknown): ManagedProblemContext {
  if (!isRecord(value)) throw configurationError("Managed problem context must be an object.");
  const keys = Object.keys(value).sort();
  const expected = Object.hasOwn(value, "contestId")
    ? ["contestId", "problemId"]
    : ["problemId"];
  if (!sameStrings(keys, expected)) throw configurationError("Managed problem context has an invalid shape.");
  const problemId = uuid(value.problemId, "problemId");
  const contestId = Object.hasOwn(value, "contestId") ? uuid(value.contestId, "contestId") : undefined;
  return { problemId, ...(contestId ? { contestId } : {}) };
}

export function managedProblemMetadataApiPath(contextValue: ManagedProblemContext): string {
  const context = normalizeManagedProblemContext(contextValue);
  const path = `/api/problems/${encodeURIComponent(context.problemId)}`;
  if (!context.contestId) return path;
  return `${path}?${new URLSearchParams({ contestId: context.contestId })}`;
}

export function managedProblemContentApiPath(contextValue: ManagedProblemContext, catalogCommit: string): string {
  const context = normalizeManagedProblemContext(contextValue);
  if (!COMMIT_PATTERN.test(catalogCommit)) throw configurationError("catalogCommit must be an exact lowercase Git commit.");
  const role = context.contestId ? "contest" : "practice";
  const parameters = new URLSearchParams({ role, commit: catalogCommit });
  if (context.contestId) parameters.set("contestId", context.contestId);
  return `/api/problems/${encodeURIComponent(context.problemId)}/content?${parameters}`;
}

export function managedProblemWorkspacePath(contextValue: ManagedProblemContext): string {
  const context = normalizeManagedProblemContext(contextValue);
  return context.contestId
    ? `/contests/${encodeURIComponent(context.contestId)}/problems/${encodeURIComponent(context.problemId)}`
    : `/problems/${encodeURIComponent(context.problemId)}`;
}

export function createOfficialSubmissionRequest(
  contextValue: ManagedProblemContext & {
    readonly catalogCommit: string;
    readonly contestAdmission?: Pick<ContestSubmissionContext, "timelineGeneration" | "ruleEpoch" | "problemEpoch">;
  },
  source: OfficialSubmissionSourceInput,
): OfficialSubmissionRequest {
  const context = normalizeManagedProblemContext({ problemId: contextValue.problemId, ...(contextValue.contestId ? { contestId: contextValue.contestId } : {}) });
  if (!COMMIT_PATTERN.test(contextValue.catalogCommit)) throw configurationError("catalogCommit must be an exact lowercase Git commit.");
  if (context.contestId && !contextValue.contestAdmission) {
    throw configurationError("Contest admission epochs are unavailable; reload the contest problem before submitting.");
  }
  return parseOfficialSubmissionRequest({
    context: context.contestId
      ? {
          kind: "contest",
          contestId: context.contestId,
          problemId: context.problemId,
          contentCommit: contextValue.catalogCommit,
          ...contextValue.contestAdmission!,
        }
      : { kind: "practice", problemId: context.problemId, catalogCommit: contextValue.catalogCommit },
    language: source.language,
    target: source.target,
    optimization: source.optimization,
    entry: source.entry,
    sourceFiles: source.sourceFiles,
    idempotencyKey: source.idempotencyKey,
  });
}

export async function loadManagedProblemCollection(
  contextValue: ManagedProblemContext,
  options: LoadManagedProblemCollectionOptions = {},
): Promise<LoadedManagedProblemCollection> {
  const context = normalizeManagedProblemContext(contextValue);
  const mode: ManagedPublicProjectionMode = context.contestId ? "contest" : "official-practice";
  const metadataUrl = managedProblemMetadataApiPath(context);
  const fetchImplementation = options.fetch ?? globalThis.fetch;
  if (!fetchImplementation) throw new ManagedProblemCollectionError("Fetch is unavailable in this browser.", "network");

  const metadataResponse = await fetchJson(fetchImplementation, metadataUrl, options.signal, "metadata");
  const metadataBytes = await readBoundedBody(metadataResponse, MAX_METADATA_BYTES, undefined, "metadata");
  const metadata = parseContentPointer(parseUtf8Json(metadataBytes, "metadata"), context);

  const contentResponse = await fetchJson(fetchImplementation, metadata.content.url, options.signal, "content");
  const contentBytes = await readBoundedBody(
    contentResponse,
    MAX_PUBLIC_CONTENT_BYTES,
    metadata.content.bytes,
    "content",
  );
  if (await sha256Hex(contentBytes) !== metadata.content.sha256) {
    throw new ManagedProblemCollectionError("The exact-commit problem content failed SHA-256 verification.", "integrity");
  }

  const contentValue = parseUtf8Json(contentBytes, "content");
  let problem: JudgeProblem;
  try {
    if (mode === "official-practice") {
      problem = parseStandaloneProblemBundle(contentValue);
    } else {
      problem = parseContestPublicProblemProjection(contentValue).problem;
    }
  } catch (error) {
    throw new ManagedProblemCollectionError(
      error instanceof Error ? error.message : "The managed problem content has an invalid schema.",
      "schema",
      { cause: error },
    );
  }
  assertMetadataMatchesProblem(metadata, problem);

  const entry: ManagedProblemCollectionEntry = {
    id: problem.id,
    number: problem.number,
    title: problem.title,
    trackId: problem.trackId,
    track: problem.track,
    difficulty: problem.difficulty,
    tags: problem.tags,
    caseCount: problem.judgeCases.length,
    bundle: {
      kind: "managed-content",
      sha256: metadata.content.sha256,
      bytes: metadata.content.bytes,
    },
  };
  const source: ManagedProblemCollectionSource = {
    provider: "managed",
    mode,
    problemId: context.problemId,
    catalogCommit: metadata.catalogCommit,
    ...(context.contestId ? { contestId: context.contestId } : {}),
    metadataUrl,
    contentUrl: metadata.content.url,
    contentSha256: metadata.content.sha256,
    allowedProfiles: metadata.allowedProfiles,
    aiAssistAvailable: metadata.aiAssistAvailable,
    assistContextSha256: metadata.assistContextSha256,
    ...(metadata.contestAdmission ? { contestAdmission: metadata.contestAdmission } : {}),
    ...(metadata.promptContextSha256 ? { promptContextSha256: metadata.promptContextSha256 } : {}),
  };
  const sourceKey = context.contestId
    ? `repository:contest:${context.contestId}:${context.problemId}:${metadata.catalogCommit}:${metadata.content.sha256}`
    : `repository:practice:${context.problemId}:${metadata.catalogCommit}:${metadata.content.sha256}`;

  return {
    source,
    sourceKey,
    index: {
      schema: BROWSER_COLLECTION_SCHEMA,
      problemSchema: BROWSER_PROBLEM_SCHEMA,
      revision: metadata.content.sha256,
      localization: { defaultLocale: "zh-TW", supportedLocales: PROBLEM_LOCALES },
      problems: [entry],
    },
    origin: "managed-content",
    loadProblem(id, signal) {
      if (signal?.aborted) return Promise.reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
      if (id !== problem.id) {
        return Promise.reject(new ManagedProblemCollectionError(`Unknown managed problem '${id}'.`, "configuration"));
      }
      return Promise.resolve(problem);
    },
  };
}

async function fetchJson(
  fetchImplementation: typeof fetch,
  url: string,
  signal: AbortSignal | undefined,
  label: "metadata" | "content",
): Promise<Response> {
  let response: Response;
  try {
    response = await fetchImplementation(url, {
      method: "GET",
      credentials: "same-origin",
      headers: { accept: "application/json" },
      redirect: "error",
      signal,
    });
  } catch (error) {
    if (isAbortError(error)) throw error;
    throw new ManagedProblemCollectionError(`The managed problem ${label} could not be reached.`, "network", { cause: error });
  }
  if (!response.ok) {
    throw new ManagedProblemCollectionError(
      response.status === 404
        ? `The managed problem ${label} is unavailable in this practice or contest context.`
        : `The managed problem ${label} request failed with HTTP ${response.status}.`,
      "unavailable",
    );
  }
  if (!JSON_CONTENT_TYPE.test(response.headers.get("content-type") ?? "")) {
    throw new ManagedProblemCollectionError(`The managed problem ${label} is not JSON.`, "schema");
  }
  return response;
}

async function readBoundedBody(
  response: Response,
  maximumBytes: number,
  expectedBytes: number | undefined,
  label: "metadata" | "content",
): Promise<Uint8Array> {
  const declaredLength = response.headers.get("content-length");
  if (declaredLength !== null) {
    if (!/^(?:0|[1-9][0-9]*)$/.test(declaredLength)) {
      throw new ManagedProblemCollectionError(`The managed problem ${label} Content-Length is invalid.`, "integrity");
    }
    const length = Number(declaredLength);
    if (!Number.isSafeInteger(length) || length < 1 || length > maximumBytes || (expectedBytes !== undefined && length !== expectedBytes)) {
      throw new ManagedProblemCollectionError(`The managed problem ${label} length disagrees with its pointer.`, "integrity");
    }
  }
  if (!response.body) throw new ManagedProblemCollectionError(`The managed problem ${label} has no body.`, "integrity");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > maximumBytes || (expectedBytes !== undefined && length > expectedBytes)) {
        try { await reader.cancel("managed problem body exceeds declared limit"); } catch { /* integrity error remains authoritative */ }
        throw new ManagedProblemCollectionError(`The managed problem ${label} exceeds its declared limit.`, "integrity");
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof ManagedProblemCollectionError || isAbortError(error)) throw error;
    throw new ManagedProblemCollectionError(`The managed problem ${label} body was interrupted.`, "network", { cause: error });
  } finally {
    reader.releaseLock();
  }
  if (length < 1 || (expectedBytes !== undefined && length !== expectedBytes)) {
    throw new ManagedProblemCollectionError(`The managed problem ${label} length disagrees with its pointer.`, "integrity");
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function parseContentPointer(
  value: unknown,
  context: ManagedProblemContext,
): ManagedProblemContentPointer {
  const hasPromptContext = isRecord(value) && Object.hasOwn(value, "promptContextSha256");
  const pointer = exactRecord(value, [
    "aiAssistAvailable", "allowedProfiles", "assistContextSha256", "catalogCommit", "content", "judgeDigest", "maximumScore", "problemId",
    "problemNumber", "problemSlug", "practiceEnabled", "schema", "summary", "title",
    ...(context.contestId ? ["contestAdmission"] : []),
    ...(hasPromptContext ? ["promptContextSha256"] : []),
  ], "managed problem metadata");
  if (pointer.schema !== METADATA_SCHEMA) schemaFailure(`Managed problem metadata schema must be '${METADATA_SCHEMA}'.`);
  if (pointer.problemId !== context.problemId || !UUID_PATTERN.test(String(pointer.problemId))) schemaFailure("Managed problem metadata has the wrong problem identity.");
  if (typeof pointer.catalogCommit !== "string" || !COMMIT_PATTERN.test(pointer.catalogCommit)) schemaFailure("Managed problem metadata has an invalid catalog commit.");
  if (typeof pointer.problemSlug !== "string" || !SLUG_PATTERN.test(pointer.problemSlug)
    || !Number.isSafeInteger(pointer.problemNumber) || (pointer.problemNumber as number) < 1) {
    schemaFailure("Managed problem metadata contains an invalid problem identity.");
  }
  const title = localized(pointer.title, "title");
  localized(pointer.summary, "summary");
  if (typeof pointer.practiceEnabled !== "boolean") schemaFailure("Managed problem metadata practiceEnabled is invalid.");
  let allowedProfiles: JudgeAllowedProfiles;
  try { allowedProfiles = parseJudgeAllowedProfiles(pointer.allowedProfiles, "managed problem metadata allowedProfiles"); }
  catch (error) { throw new ManagedProblemCollectionError(error instanceof Error ? error.message : "Allowed profiles are invalid.", "schema", { cause: error }); }
  if (pointer.maximumScore !== 100 || typeof pointer.judgeDigest !== "string" || !SHA256_PATTERN.test(pointer.judgeDigest)) {
    schemaFailure("Managed problem metadata execution identity is invalid.");
  }
  if (typeof pointer.aiAssistAvailable !== "boolean"
    || (pointer.assistContextSha256 !== null
      && (typeof pointer.assistContextSha256 !== "string" || !SHA256_PATTERN.test(pointer.assistContextSha256)))
    || (pointer.aiAssistAvailable && pointer.assistContextSha256 === null)
    || (!pointer.aiAssistAvailable && pointer.assistContextSha256 !== null)) {
    schemaFailure("Managed problem metadata Prompt Assist availability is invalid.");
  }
  let contestAdmission: ManagedProblemContentPointer["contestAdmission"];
  if (context.contestId) {
    const admission = exactRecord(pointer.contestAdmission, ["problemEpoch", "ruleEpoch", "timelineGeneration"], "contest admission");
    const values = [admission.timelineGeneration, admission.ruleEpoch, admission.problemEpoch];
    if (values.some((candidate) => !Number.isSafeInteger(candidate) || (candidate as number) < 1)) {
      schemaFailure("Contest admission epochs must be positive integers.");
    }
    contestAdmission = {
      timelineGeneration: admission.timelineGeneration as number,
      ruleEpoch: admission.ruleEpoch as number,
      problemEpoch: admission.problemEpoch as number,
    };
  }
  if (hasPromptContext && (!context.contestId
    || typeof pointer.promptContextSha256 !== "string"
    || !SHA256_PATTERN.test(pointer.promptContextSha256))) {
    schemaFailure("Managed problem metadata prompt context identity is invalid.");
  }
  const content = exactRecord(pointer.content, ["bytes", "role", "sha256", "url"], "managed problem content pointer");
  const expectedRole = context.contestId ? "contest" : "practice";
  const expectedContentUrl = managedProblemContentApiPath(context, pointer.catalogCommit);
  if (content.role !== expectedRole || content.url !== expectedContentUrl) {
    schemaFailure("Managed problem content pointer does not match its authorized context.");
  }
  if (!Number.isSafeInteger(content.bytes) || (content.bytes as number) < 1 || (content.bytes as number) > MAX_PUBLIC_CONTENT_BYTES
    || typeof content.sha256 !== "string" || !SHA256_PATTERN.test(content.sha256)) {
    schemaFailure("Managed problem content pointer size or digest is invalid.");
  }
  return {
    problemId: pointer.problemId as string,
    catalogCommit: pointer.catalogCommit,
    problemSlug: pointer.problemSlug,
    problemNumber: pointer.problemNumber as number,
    title,
    allowedProfiles,
    maximumScore: 100,
    judgeDigest: pointer.judgeDigest,
    aiAssistAvailable: pointer.aiAssistAvailable,
    assistContextSha256: pointer.assistContextSha256 as string | null,
    ...(contestAdmission ? { contestAdmission } : {}),
    ...(hasPromptContext ? { promptContextSha256: pointer.promptContextSha256 as string } : {}),
    content: {
      role: expectedRole,
      bytes: content.bytes as number,
      sha256: content.sha256,
      url: content.url,
    },
  };
}

function assertMetadataMatchesProblem(metadata: ManagedProblemContentPointer, problem: JudgeProblem): void {
  const metadataLanguages = Object.keys(metadata.allowedProfiles).sort();
  const problemLanguages = new Set(Object.keys(problem.starterTemplates));
  if (
    problem.id !== metadata.problemSlug
    || problem.number !== metadata.problemNumber
    || !sameLocalizedText(problem.title, metadata.title)
    || metadataLanguages.some((language) => (
      !problemLanguages.has(language) || typeof problem.scoring.calibration.profiles[language] !== "string"
    ))
    || problem.scoring.maximumPoints !== metadata.maximumScore
  ) throw new ManagedProblemCollectionError("D1 metadata disagrees with the exact-commit problem content.", "integrity");
  if (problem.judgeCases.some((testCase) => testCase.kind !== "sample")) {
    throw new ManagedProblemCollectionError("Managed public content contains hidden judge cases.", "integrity");
  }
}

function sameLocalizedText(
  left: Readonly<Record<"zh-TW" | "en", string>>,
  right: Readonly<Record<"zh-TW" | "en", string>>,
): boolean {
  return PROBLEM_LOCALES.every((locale) => left[locale] === right[locale]);
}

function localized(value: unknown, label: string): Readonly<Record<"zh-TW" | "en", string>> {
  const record = exactRecord(value, ["en", "zh-TW"], `managed problem ${label}`);
  if (typeof record["zh-TW"] !== "string" || typeof record.en !== "string") {
    schemaFailure(`Managed problem ${label} is invalid.`);
  }
  return { "zh-TW": record["zh-TW"] as string, en: record.en as string };
}

function exactRecord(value: unknown, expectedKeys: readonly string[], label: string): Record<string, unknown> {
  if (!isRecord(value) || !sameStrings(Object.keys(value).sort(), [...expectedKeys].sort())) {
    schemaFailure(`${label} has an invalid shape.`);
  }
  return value as Record<string, unknown>;
}

function parseUtf8Json(bytes: Uint8Array, label: "metadata" | "content"): unknown {
  let text: string;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch (error) { throw new ManagedProblemCollectionError(`The managed problem ${label} is not valid UTF-8.`, "integrity", { cause: error }); }
  try { return JSON.parse(text) as unknown; }
  catch (error) { throw new ManagedProblemCollectionError(`The managed problem ${label} is not valid JSON.`, "schema", { cause: error }); }
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", Uint8Array.from(bytes));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function uuid(value: unknown, label: string): string {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) throw configurationError(`${label} must be a canonical UUID.`);
  return value;
}

function configurationError(message: string): ManagedProblemCollectionError {
  return new ManagedProblemCollectionError(message, "configuration");
}

function schemaFailure(message: string): never {
  throw new ManagedProblemCollectionError(message, "schema");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}
