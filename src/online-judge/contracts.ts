import { assertLanguageIdentifier, isBuiltinLanguage, type BuiltinLanguage, type OptimizationLevel, type TargetAbi } from "../core/types.ts";

export const SUBMISSION_SOURCE_LIMITS = Object.freeze({
  totalBytes: 1024 * 1024,
  maximumFiles: 128,
  fileBytes: 256 * 1024,
});

export const SUBMISSION_STATES = [
  "admitting",
  "queued",
  "preparing",
  "compiling",
  "running",
  "finalizing",
  "completed",
  "compile-error",
  "judge-error",
  "infrastructure-error",
  "cancelled",
] as const;

export type SubmissionState = typeof SUBMISSION_STATES[number];
export type SubmissionVisibility = "private" | "public";
export const SUBMISSION_VERDICTS = [
  "accepted",
  "wrong-answer",
  "runtime-error",
  "instruction-limit",
  "memory-limit",
  "output-limit",
  "filesystem-limit",
  "logical-time-limit",
  "wall-time-limit",
  "compile-error",
  "judge-error",
  "cancelled",
] as const;
export type SubmissionVerdict = typeof SUBMISSION_VERDICTS[number];

const TERMINAL_STATES = new Set<SubmissionState>([
  "completed",
  "compile-error",
  "judge-error",
  "infrastructure-error",
  "cancelled",
]);

const STATE_TRANSITIONS: Readonly<Record<SubmissionState, ReadonlySet<SubmissionState>>> = {
  admitting: new Set(["queued", "cancelled", "infrastructure-error"]),
  queued: new Set(["preparing", "cancelled", "infrastructure-error"]),
  preparing: new Set(["compiling", "cancelled", "judge-error", "infrastructure-error"]),
  compiling: new Set(["running", "compile-error", "cancelled", "judge-error", "infrastructure-error"]),
  running: new Set(["finalizing", "cancelled", "judge-error", "infrastructure-error"]),
  finalizing: new Set(["completed", "judge-error", "infrastructure-error"]),
  completed: new Set(),
  "compile-error": new Set(),
  "judge-error": new Set(),
  "infrastructure-error": new Set(),
  cancelled: new Set(),
};

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$/;
const SOURCE_PATH_PATTERN = /^(?!\/)(?!.*(?:^|\/)\.{1,2}(?:\/|$))(?!.*\/\/)(?!.*\\)(?!.*\/$)[^\u0000]+$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;

export interface OfficialSourceFile {
  readonly path: string;
  readonly encoding: "utf8" | "base64";
  readonly content: string;
}

export interface OfficialSubmissionRequest {
  readonly problemId: string;
  readonly catalogCommit: string;
  readonly contestId?: string;
  readonly language: BuiltinLanguage;
  readonly target: TargetAbi;
  readonly optimization: OptimizationLevel;
  readonly entry: string;
  readonly sourceFiles: readonly OfficialSourceFile[];
  readonly idempotencyKey: string;
}

export interface SubmissionEventPayload {
  readonly kind:
    | "state"
    | "compile-progress"
    | "case-progress"
    | "verdict"
    | "resource-summary"
    | "error";
  readonly state?: SubmissionState;
  readonly phase?: string;
  readonly completedCases?: number;
  readonly totalCases?: number;
  readonly verdict?: SubmissionVerdict;
  readonly score?: number;
  readonly fullyPassedCases?: number;
  readonly deterministicCost?: number;
  readonly peakMemoryBytes?: number;
  readonly message?: string;
  readonly retryable?: boolean;
}

export interface SequencedSubmissionEvent extends SubmissionEventPayload {
  readonly sequence: number;
  readonly timestamp: string;
}

export interface SubmissionEventReplay {
  readonly events: readonly SequencedSubmissionEvent[];
  readonly nextCursor: number;
  readonly summary: SubmissionEventSummary;
}

export interface SubmissionEventSummary {
  readonly state: SubmissionState;
  readonly verdict: SubmissionVerdict | null;
  readonly score: number | null;
  readonly fullyPassedCases: number | null;
  readonly deterministicCost: number | null;
  readonly peakMemoryBytes: number | null;
  readonly updatedAt: string;
  readonly completedAt: string | null;
}

export interface LeaderboardEntry {
  readonly userId: string;
  readonly score: number;
  readonly fullyPassedCases: number;
  readonly deterministicCost: number;
  readonly peakMemoryBytes: number;
  readonly achievedAt: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[],
  label: string,
): void {
  const allowed = new Set([...required, ...optional]);
  const missing = required.filter((key) => !Object.hasOwn(value, key));
  const unexpected = Object.keys(value).filter((key) => !allowed.has(key));
  if (missing.length > 0 || unexpected.length > 0) {
    throw new TypeError(`${label} has an invalid shape.`);
  }
}

function uuid(value: unknown, label: string): string {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) throw new TypeError(`${label} must be a UUID.`);
  return value;
}

function normalizedSourcePath(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length > 512 || !SOURCE_PATH_PATTERN.test(value)) {
    throw new TypeError(`${label} must be a normalized relative POSIX path.`);
  }
  return value;
}

function decodedSourceBytes(file: OfficialSourceFile): number {
  if (file.encoding === "utf8") return new TextEncoder().encode(file.content).byteLength;
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(file.content)) {
    throw new TypeError(`Source file '${file.path}' is not canonical base64.`);
  }
  const padding = file.content.endsWith("==") ? 2 : file.content.endsWith("=") ? 1 : 0;
  return (file.content.length / 4) * 3 - padding;
}

export function parseOfficialSubmissionRequest(value: unknown): OfficialSubmissionRequest {
  if (!isRecord(value)) throw new TypeError("Submission request must be an object.");
  exactKeys(value, [
    "problemId",
    "catalogCommit",
    "language",
    "target",
    "optimization",
    "entry",
    "sourceFiles",
    "idempotencyKey",
  ], ["contestId"], "Submission request");
  const problemId = uuid(value.problemId, "problemId");
  if (typeof value.catalogCommit !== "string" || !/^[0-9a-f]{40}$/.test(value.catalogCommit)) {
    throw new TypeError("catalogCommit must be a 40-character lowercase Git commit SHA.");
  }
  const contestId = value.contestId === undefined ? undefined : uuid(value.contestId, "contestId");
  assertLanguageIdentifier(value.language);
  if (!isBuiltinLanguage(value.language)) throw new TypeError("language is unsupported for official judging.");
  const language = value.language;
  if (value.target !== "wasip1" && value.target !== "wasix") throw new TypeError("target is unsupported.");
  if (value.optimization !== "debug" && value.optimization !== "release") throw new TypeError("optimization is unsupported.");
  const entry = normalizedSourcePath(value.entry, "entry");
  if (!Array.isArray(value.sourceFiles) || value.sourceFiles.length < 1 || value.sourceFiles.length > SUBMISSION_SOURCE_LIMITS.maximumFiles) {
    throw new TypeError(`sourceFiles must contain between 1 and ${SUBMISSION_SOURCE_LIMITS.maximumFiles} files.`);
  }
  const paths = new Set<string>();
  let totalBytes = 0;
  const sourceFiles = value.sourceFiles.map((fileValue, index): OfficialSourceFile => {
    if (!isRecord(fileValue)) throw new TypeError(`sourceFiles[${index}] must be an object.`);
    exactKeys(fileValue, ["path", "encoding", "content"], [], `sourceFiles[${index}]`);
    const path = normalizedSourcePath(fileValue.path, `sourceFiles[${index}].path`);
    if (paths.has(path)) throw new TypeError(`Source path '${path}' is duplicated.`);
    paths.add(path);
    if (fileValue.encoding !== "utf8" && fileValue.encoding !== "base64") throw new TypeError(`Source file '${path}' has an unsupported encoding.`);
    if (typeof fileValue.content !== "string") throw new TypeError(`Source file '${path}' content must be a string.`);
    const file: OfficialSourceFile = { path, encoding: fileValue.encoding, content: fileValue.content };
    const bytes = decodedSourceBytes(file);
    if (bytes > SUBMISSION_SOURCE_LIMITS.fileBytes) throw new TypeError(`Source file '${path}' exceeds 256 KiB.`);
    totalBytes += bytes;
    return file;
  });
  if (!paths.has(entry)) throw new TypeError("entry must identify one submitted source file.");
  if (totalBytes > SUBMISSION_SOURCE_LIMITS.totalBytes) throw new TypeError("Submitted source exceeds 1 MiB.");
  if (typeof value.idempotencyKey !== "string" || !IDEMPOTENCY_KEY_PATTERN.test(value.idempotencyKey)) {
    throw new TypeError("idempotencyKey is invalid.");
  }
  return {
    problemId,
    catalogCommit: value.catalogCommit,
    ...(contestId ? { contestId } : {}),
    language,
    target: value.target,
    optimization: value.optimization,
    entry,
    sourceFiles,
    idempotencyKey: value.idempotencyKey,
  };
}

export function isTerminalSubmissionState(state: SubmissionState): boolean {
  return TERMINAL_STATES.has(state);
}

export function assertSubmissionTransition(from: SubmissionState, to: SubmissionState): void {
  if (!STATE_TRANSITIONS[from].has(to)) throw new TypeError(`Invalid submission transition '${from}' → '${to}'.`);
}

export function parseSubmissionState(value: unknown): SubmissionState {
  if (!SUBMISSION_STATES.includes(value as SubmissionState)) throw new TypeError("Unknown submission state.");
  return value as SubmissionState;
}

export function publicSubmissionEvent(value: unknown): SubmissionEventPayload {
  if (!isRecord(value) || typeof value.kind !== "string") throw new TypeError("Submission event must be an object.");
  switch (value.kind) {
    case "state":
      exactKeys(value, ["kind", "state"], [], "state event");
      return { kind: "state", state: parseSubmissionState(value.state) };
    case "compile-progress":
      exactKeys(value, ["kind", "phase"], [], "compile event");
      if (typeof value.phase !== "string" || !value.phase || value.phase.length > 80) throw new TypeError("compile phase is invalid.");
      return { kind: "compile-progress", phase: value.phase };
    case "case-progress":
      exactKeys(value, ["kind", "completedCases", "totalCases"], [], "case progress event");
      if (!Number.isSafeInteger(value.completedCases) || !Number.isSafeInteger(value.totalCases) || (value.completedCases as number) < 0 || (value.totalCases as number) < 1 || (value.completedCases as number) > (value.totalCases as number)) {
        throw new TypeError("case progress is invalid.");
      }
      return { kind: "case-progress", completedCases: value.completedCases as number, totalCases: value.totalCases as number };
    case "verdict": {
      exactKeys(value, ["kind", "verdict", "score", "fullyPassedCases"], [], "verdict event");
      if (!SUBMISSION_VERDICTS.includes(value.verdict as SubmissionVerdict)) throw new TypeError("verdict is invalid.");
      if (typeof value.score !== "number" || !Number.isFinite(value.score) || value.score < 0 || value.score > 100 || !Number.isSafeInteger(value.fullyPassedCases) || (value.fullyPassedCases as number) < 0) throw new TypeError("verdict score is invalid.");
      return { kind: "verdict", verdict: value.verdict as SubmissionVerdict, score: value.score, fullyPassedCases: value.fullyPassedCases as number };
    }
    case "resource-summary":
      exactKeys(value, ["kind", "deterministicCost", "peakMemoryBytes"], [], "resource summary event");
      if (!Number.isSafeInteger(value.deterministicCost) || (value.deterministicCost as number) < 0 || !Number.isSafeInteger(value.peakMemoryBytes) || (value.peakMemoryBytes as number) < 0) throw new TypeError("resource summary is invalid.");
      return { kind: "resource-summary", deterministicCost: value.deterministicCost as number, peakMemoryBytes: value.peakMemoryBytes as number };
    case "error":
      exactKeys(value, ["kind", "message", "retryable"], [], "error event");
      if (typeof value.message !== "string" || !value.message || value.message.length > 500 || typeof value.retryable !== "boolean") throw new TypeError("error event is invalid.");
      return { kind: "error", message: value.message, retryable: value.retryable };
    default:
      throw new TypeError("Unknown submission event kind.");
  }
}

export function parseSequencedSubmissionEvent(value: unknown): SequencedSubmissionEvent {
  if (!isRecord(value)) throw new TypeError("Sequenced submission event must be an object.");
  const { sequence, timestamp, ...payload } = value;
  if (!Number.isSafeInteger(sequence) || (sequence as number) < 1) {
    throw new TypeError("Submission event sequence is invalid.");
  }
  if (
    typeof timestamp !== "string"
    || Number.isNaN(Date.parse(timestamp))
    || new Date(timestamp).toISOString() !== timestamp
  ) throw new TypeError("Submission event timestamp is invalid.");
  return {
    ...publicSubmissionEvent(payload),
    sequence: sequence as number,
    timestamp,
  };
}

export function parseSubmissionEventReplay(value: unknown): SubmissionEventReplay {
  if (!isRecord(value)) throw new TypeError("Submission event replay must be an object.");
  exactKeys(value, ["events", "nextCursor", "summary"], [], "Submission event replay");
  if (!Array.isArray(value.events)) throw new TypeError("Submission event replay events are invalid.");
  if (value.events.length > 100) throw new TypeError("Submission event replay exceeds the 100 event page limit.");
  if (!Number.isSafeInteger(value.nextCursor) || (value.nextCursor as number) < 0) {
    throw new TypeError("Submission event replay cursor is invalid.");
  }
  const events = value.events.map(parseSequencedSubmissionEvent);
  for (let index = 1; index < events.length; index += 1) {
    if (events[index]!.sequence <= events[index - 1]!.sequence) {
      throw new TypeError("Submission replay events are not strictly ordered.");
    }
  }
  if (events.some((event) => event.sequence > (value.nextCursor as number))) {
    throw new TypeError("Submission replay exceeds its next cursor.");
  }
  if (!isRecord(value.summary)) throw new TypeError("Submission event summary must be an object.");
  exactKeys(value.summary, [
    "completedAt",
    "deterministicCost",
    "fullyPassedCases",
    "peakMemoryBytes",
    "score",
    "state",
    "updatedAt",
    "verdict",
  ], [], "Submission event summary");
  const nullableSafeInteger = (candidate: unknown, label: string): number | null => {
    if (candidate === null) return null;
    if (!Number.isSafeInteger(candidate) || (candidate as number) < 0) {
      throw new TypeError(`Submission event summary ${label} is invalid.`);
    }
    return candidate as number;
  };
  const nullableTimestamp = (candidate: unknown, label: string): string | null => {
    if (candidate === null) return null;
    if (typeof candidate !== "string" || Number.isNaN(Date.parse(candidate)) || new Date(candidate).toISOString() !== candidate) {
      throw new TypeError(`Submission event summary ${label} is invalid.`);
    }
    return candidate;
  };
  if (value.summary.verdict !== null && !SUBMISSION_VERDICTS.includes(value.summary.verdict as SubmissionVerdict)) {
    throw new TypeError("Submission event summary verdict is invalid.");
  }
  if (value.summary.score !== null && (
    typeof value.summary.score !== "number"
    || !Number.isFinite(value.summary.score)
    || value.summary.score < 0
    || value.summary.score > 100
  )) throw new TypeError("Submission event summary score is invalid.");
  const updatedAt = nullableTimestamp(value.summary.updatedAt, "updatedAt");
  if (updatedAt === null) throw new TypeError("Submission event summary updatedAt is invalid.");
  return {
    events,
    nextCursor: value.nextCursor as number,
    summary: {
      state: parseSubmissionState(value.summary.state),
      verdict: value.summary.verdict as SubmissionVerdict | null,
      score: value.summary.score as number | null,
      fullyPassedCases: nullableSafeInteger(value.summary.fullyPassedCases, "fullyPassedCases"),
      deterministicCost: nullableSafeInteger(value.summary.deterministicCost, "deterministicCost"),
      peakMemoryBytes: nullableSafeInteger(value.summary.peakMemoryBytes, "peakMemoryBytes"),
      updatedAt,
      completedAt: nullableTimestamp(value.summary.completedAt, "completedAt"),
    },
  };
}

export function compareLeaderboardEntries(left: LeaderboardEntry, right: LeaderboardEntry): number {
  return right.score - left.score
    || right.fullyPassedCases - left.fullyPassedCases
    || left.deterministicCost - right.deterministicCost
    || left.peakMemoryBytes - right.peakMemoryBytes
    || left.achievedAt.localeCompare(right.achievedAt)
    || left.userId.localeCompare(right.userId);
}

export function assertSha256(value: unknown, label: string): string {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) throw new TypeError(`${label} must be a lowercase SHA-256 digest.`);
  return value;
}
