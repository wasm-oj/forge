import type { BuiltinLanguage, OptimizationLevel, TargetAbi } from "../core/types";
import {
  BROWSER_COLLECTION_SCHEMA,
  BROWSER_PROBLEM_SCHEMA,
} from "../judge/problem-catalog-loader";
import {
  PROBLEM_LOCALES,
  type JudgeProblem,
  type JudgeProblemSummary,
} from "../judge/problem-model";
import {
  parseOfficialSubmissionRequest,
  type OfficialSourceFile,
  type OfficialSubmissionRequest,
} from "./contracts";
import {
  parseManagedPublicProblemProjection,
  type ManagedPublicProjectionMode,
} from "./public-projection";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const MAX_MANAGED_PROJECTION_BYTES = 32 * 1024 * 1024;
const JSON_CONTENT_TYPE = /^application\/json(?:\s*;\s*charset=utf-8)?$/i;

export interface ManagedProblemContext {
  readonly problemVersionId: string;
  readonly contestId?: string;
}

export interface ManagedProblemCollectionSource extends ManagedProblemContext {
  readonly provider: "managed";
  readonly mode: ManagedPublicProjectionMode;
  readonly projectionUrl: string;
}

export interface ManagedProblemCollectionEntry extends JudgeProblemSummary {
  readonly bundle: {
    readonly kind: "managed-projection";
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
  readonly origin: "managed-projection";
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
  const expected = (Object.hasOwn(value, "contestId")
    ? ["contestId", "problemVersionId"]
    : ["problemVersionId"]);
  if (!sameStrings(keys, expected)) throw configurationError("Managed problem context has an invalid shape.");
  const problemVersionId = uuid(value.problemVersionId, "problemVersionId");
  const contestId = Object.hasOwn(value, "contestId") ? uuid(value.contestId, "contestId") : undefined;
  return { problemVersionId, ...(contestId ? { contestId } : {}) };
}

export function managedProblemProjectionApiPath(contextValue: ManagedProblemContext): string {
  const context = normalizeManagedProblemContext(contextValue);
  const path = `/api/problems/${encodeURIComponent(context.problemVersionId)}`;
  if (!context.contestId) return path;
  const parameters = new URLSearchParams({ contestId: context.contestId });
  return `${path}?${parameters.toString()}`;
}

export function managedProblemWorkspacePath(contextValue: ManagedProblemContext): string {
  const context = normalizeManagedProblemContext(contextValue);
  return context.contestId
    ? `/contests/${encodeURIComponent(context.contestId)}/problems/${encodeURIComponent(context.problemVersionId)}`
    : `/problems/${encodeURIComponent(context.problemVersionId)}`;
}

export function managedCollectionAllowsFullLocalJudge(contextValue: ManagedProblemContext): boolean {
  return normalizeManagedProblemContext(contextValue).contestId === undefined;
}

export function createOfficialSubmissionRequest(
  contextValue: ManagedProblemContext,
  source: OfficialSubmissionSourceInput,
): OfficialSubmissionRequest {
  const context = normalizeManagedProblemContext(contextValue);
  return parseOfficialSubmissionRequest({
    managedProblemVersionId: context.problemVersionId,
    ...(context.contestId ? { contestId: context.contestId } : {}),
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
  const projectionUrl = managedProblemProjectionApiPath(context);
  const fetchImplementation = options.fetch ?? globalThis.fetch;
  if (!fetchImplementation) throw new ManagedProblemCollectionError("Fetch is unavailable in this browser.", "network");

  let response: Response;
  try {
    response = await fetchImplementation(projectionUrl, {
      method: "GET",
      credentials: "same-origin",
      headers: { accept: "application/json" },
      redirect: "error",
      signal: options.signal,
    });
  } catch (error) {
    if (isAbortError(error)) throw error;
    throw new ManagedProblemCollectionError("The managed problem projection could not be reached.", "network", { cause: error });
  }
  if (!response.ok) {
    throw new ManagedProblemCollectionError(
      response.status === 404
        ? "The managed problem is unavailable in this practice or contest context."
        : `The managed problem projection request failed with HTTP ${response.status}.`,
      "unavailable",
    );
  }
  if (!JSON_CONTENT_TYPE.test(response.headers.get("content-type") ?? "")) {
    throw new ManagedProblemCollectionError("The managed problem projection is not JSON.", "schema");
  }

  const bytes = await readBoundedProjection(response);
  const value = parseUtf8Json(bytes);
  const digest = projectionDigest(value);
  let projection: ReturnType<typeof parseManagedPublicProblemProjection>;
  try {
    projection = parseManagedPublicProblemProjection(value, mode, digest);
  } catch (error) {
    throw new ManagedProblemCollectionError(
      error instanceof Error ? error.message : "The managed problem projection has an invalid schema.",
      "schema",
      { cause: error },
    );
  }

  const problem = projection.problem;
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
      kind: "managed-projection",
      sha256: projection.digest,
      bytes: bytes.byteLength,
    },
  };
  const source: ManagedProblemCollectionSource = {
    provider: "managed",
    mode,
    problemVersionId: context.problemVersionId,
    ...(context.contestId ? { contestId: context.contestId } : {}),
    projectionUrl,
  };
  const sourceKey = context.contestId
    ? `managed:contest:${context.contestId}:${context.problemVersionId}:${projection.digest}`
    : `managed:official-practice:${context.problemVersionId}:${projection.digest}`;

  return {
    source,
    sourceKey,
    index: {
      schema: BROWSER_COLLECTION_SCHEMA,
      problemSchema: BROWSER_PROBLEM_SCHEMA,
      revision: projection.digest,
      localization: { defaultLocale: "zh-TW", supportedLocales: PROBLEM_LOCALES },
      problems: [entry],
    },
    origin: "managed-projection",
    loadProblem(id, signal) {
      if (signal?.aborted) return Promise.reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
      if (id !== problem.id) {
        return Promise.reject(new ManagedProblemCollectionError(`Unknown managed problem '${id}'.`, "configuration"));
      }
      return Promise.resolve(problem);
    },
  };
}

async function readBoundedProjection(response: Response): Promise<Uint8Array> {
  const declaredLength = response.headers.get("content-length");
  if (declaredLength !== null) {
    if (!/^(?:0|[1-9][0-9]*)$/.test(declaredLength)) {
      throw new ManagedProblemCollectionError("The managed projection Content-Length is invalid.", "integrity");
    }
    const expectedLength = Number(declaredLength);
    if (!Number.isSafeInteger(expectedLength) || expectedLength < 1 || expectedLength > MAX_MANAGED_PROJECTION_BYTES) {
      throw new ManagedProblemCollectionError("The managed problem projection exceeds the browser size limit.", "integrity");
    }
  }
  if (!response.body) throw new ManagedProblemCollectionError("The managed problem projection has no body.", "integrity");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > MAX_MANAGED_PROJECTION_BYTES) {
        try {
          await reader.cancel("managed projection exceeds browser size limit");
        } catch {
          // The bounded-reader integrity failure remains authoritative.
        }
        throw new ManagedProblemCollectionError("The managed problem projection exceeds the browser size limit.", "integrity");
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof ManagedProblemCollectionError || isAbortError(error)) throw error;
    throw new ManagedProblemCollectionError("The managed problem projection body was interrupted.", "network", { cause: error });
  } finally {
    reader.releaseLock();
  }
  if (length < 1) {
    throw new ManagedProblemCollectionError("The managed problem projection is empty.", "integrity");
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function projectionDigest(value: unknown): string {
  if (!isRecord(value) || typeof value.digest !== "string" || !SHA256_PATTERN.test(value.digest)) {
    throw new ManagedProblemCollectionError("The managed problem projection digest is invalid.", "schema");
  }
  return value.digest;
}

function parseUtf8Json(bytes: Uint8Array): unknown {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    throw new ManagedProblemCollectionError("The managed problem projection is not valid UTF-8.", "integrity", { cause: error });
  }
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw new ManagedProblemCollectionError("The managed problem projection is not valid JSON.", "schema", { cause: error });
  }
}

function uuid(value: unknown, label: string): string {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) throw configurationError(`${label} must be a canonical UUID.`);
  return value;
}

function configurationError(message: string): ManagedProblemCollectionError {
  return new ManagedProblemCollectionError(message, "configuration");
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
