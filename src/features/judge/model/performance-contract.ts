import { isBuiltinLanguage, type BuiltinLanguage } from "../../../core/types";
import {
  SUBMISSION_STATES,
  SUBMISSION_VERDICTS,
  type SubmissionState,
  type SubmissionVerdict,
} from "../../../online-judge/contracts";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const PARTICIPANT_ID_PATTERN = /^participant-[0-9a-f]{24}$|^participant-unavailable$/;
const MAX_FRONTIER_POINTS = 100;
const MAX_EVOLUTION_POINTS = 200;
const MAX_CASES = 10_000;

export type PerformanceParticipantKind = "profile" | "anonymous" | "deleted";

export interface PerformanceParticipant {
  readonly id: string;
  readonly kind: PerformanceParticipantKind;
  readonly label: string;
  readonly login?: string;
  readonly avatarUrl?: string;
}

export interface PerformanceFrontierPoint {
  readonly submissionId: string;
  readonly participant: PerformanceParticipant;
  readonly language: BuiltinLanguage;
  readonly score: number;
  readonly fullyPassedCases: number;
  readonly deterministicCost: number;
  readonly peakMemoryBytes: number;
  readonly achievedAt: string;
  readonly isPareto: boolean;
}

export interface PerformanceEvolutionPoint {
  readonly submissionId: string;
  readonly attemptNumber: number;
  readonly language: BuiltinLanguage;
  readonly state: SubmissionState;
  readonly verdict: SubmissionVerdict | null;
  readonly score: number | null;
  readonly fullyPassedCases: number | null;
  readonly deterministicCost: number | null;
  readonly peakMemoryBytes: number | null;
  readonly createdAt: string;
  readonly completedAt: string | null;
  readonly policySummaryAvailable: boolean;
}

export interface ProblemPerformanceResponse {
  readonly context: {
    readonly problemVersionId: string;
    readonly contestId: string | null;
    readonly frozen: boolean;
    readonly availableLanguages: readonly BuiltinLanguage[];
    readonly selectedLanguage: BuiltinLanguage | null;
    readonly myEvolutionTruncated: boolean;
  };
  readonly frontier: readonly PerformanceFrontierPoint[];
  readonly myEvolution: readonly PerformanceEvolutionPoint[] | null;
}

export type PerformancePolicyId = "baseline" | "efficient" | "optimal";

export interface PerformancePolicyLevel {
  readonly id: PerformancePolicyId;
  readonly earnedCases: number;
  readonly costExceededCases: number;
  readonly memoryExceededCases: number;
  readonly logicalTimeExceededCases: number;
}

export interface SubmissionPolicySummaryResponse {
  readonly submissionId: string;
  readonly policySummary: {
    readonly totalCases: number;
    readonly outputAcceptedCases: number;
    readonly policies: readonly [PerformancePolicyLevel, PerformancePolicyLevel, PerformancePolicyLevel];
  };
}

export interface ExpectedPerformanceContext {
  readonly problemVersionId: string;
  readonly contestId?: string;
  readonly language: BuiltinLanguage | "all";
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, required: readonly string[], optional: readonly string[], label: string): void {
  const allowed = new Set([...required, ...optional]);
  if (
    required.some((key) => !Object.hasOwn(value, key))
    || Object.keys(value).some((key) => !allowed.has(key))
  ) throw new TypeError(`${label} has an invalid shape.`);
}

function uuid(value: unknown, label: string): string {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) throw new TypeError(`${label} must be a UUID.`);
  return value;
}

function timestamp(value: unknown, label: string): string {
  if (typeof value !== "string" || Number.isNaN(Date.parse(value)) || new Date(value).toISOString() !== value) {
    throw new TypeError(`${label} must be a canonical ISO timestamp.`);
  }
  return value;
}

function boundedText(value: unknown, maximumLength: number, label: string): string {
  if (typeof value !== "string" || value.length < 1 || value.length > maximumLength || value !== value.trim()) {
    throw new TypeError(`${label} is invalid.`);
  }
  return value;
}

function nonnegativeInteger(value: unknown, maximum: number, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > maximum) {
    throw new TypeError(`${label} must be a bounded non-negative integer.`);
  }
  return value as number;
}

function nullableNonnegativeInteger(value: unknown, maximum: number, label: string): number | null {
  return value === null ? null : nonnegativeInteger(value, maximum, label);
}

function score(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1_000_000) {
    throw new TypeError(`${label} must be a bounded non-negative number.`);
  }
  return value;
}

function nullableScore(value: unknown, label: string): number | null {
  return value === null ? null : score(value, label);
}

function language(value: unknown, label: string): BuiltinLanguage {
  if (typeof value !== "string" || !isBuiltinLanguage(value)) throw new TypeError(`${label} is unsupported.`);
  return value;
}

function participant(value: unknown, label: string): PerformanceParticipant {
  const item = record(value, label);
  exactKeys(item, ["id", "kind", "label"], ["login", "avatarUrl"], label);
  if (typeof item.id !== "string" || !PARTICIPANT_ID_PATTERN.test(item.id)) throw new TypeError(`${label}.id is invalid.`);
  if (item.kind !== "profile" && item.kind !== "anonymous" && item.kind !== "deleted") {
    throw new TypeError(`${label}.kind is invalid.`);
  }
  const labelText = boundedText(item.label, 160, `${label}.label`);
  const login = item.login === undefined ? undefined : boundedText(item.login, 39, `${label}.login`);
  let avatarUrl: string | undefined;
  if (item.avatarUrl !== undefined) {
    const raw = boundedText(item.avatarUrl, 2_048, `${label}.avatarUrl`);
    let parsed: URL;
    try {
      parsed = new URL(raw);
    } catch {
      throw new TypeError(`${label}.avatarUrl is invalid.`);
    }
    if (parsed.protocol !== "https:") throw new TypeError(`${label}.avatarUrl must use HTTPS.`);
    avatarUrl = raw;
  }
  if (item.kind === "profile" && (!login || !avatarUrl)) throw new TypeError(`${label} profile details are incomplete.`);
  if (item.kind !== "profile" && (login || avatarUrl)) throw new TypeError(`${label} private details must be redacted.`);
  return { id: item.id, kind: item.kind, label: labelText, ...(login ? { login } : {}), ...(avatarUrl ? { avatarUrl } : {}) };
}

function frontierPoint(value: unknown, index: number): PerformanceFrontierPoint {
  const label = `frontier[${index}]`;
  const item = record(value, label);
  exactKeys(item, [
    "submissionId", "participant", "language", "score", "fullyPassedCases", "deterministicCost",
    "peakMemoryBytes", "achievedAt", "isPareto",
  ], [], label);
  if (typeof item.isPareto !== "boolean") throw new TypeError(`${label}.isPareto must be boolean.`);
  return {
    submissionId: uuid(item.submissionId, `${label}.submissionId`),
    participant: participant(item.participant, `${label}.participant`),
    language: language(item.language, `${label}.language`),
    score: score(item.score, `${label}.score`),
    fullyPassedCases: nonnegativeInteger(item.fullyPassedCases, MAX_CASES, `${label}.fullyPassedCases`),
    deterministicCost: nonnegativeInteger(item.deterministicCost, Number.MAX_SAFE_INTEGER, `${label}.deterministicCost`),
    peakMemoryBytes: nonnegativeInteger(item.peakMemoryBytes, Number.MAX_SAFE_INTEGER, `${label}.peakMemoryBytes`),
    achievedAt: timestamp(item.achievedAt, `${label}.achievedAt`),
    isPareto: item.isPareto,
  };
}

function evolutionPoint(value: unknown, index: number): PerformanceEvolutionPoint {
  const label = `myEvolution[${index}]`;
  const item = record(value, label);
  exactKeys(item, [
    "submissionId", "attemptNumber", "language", "state", "verdict", "score", "fullyPassedCases",
    "deterministicCost", "peakMemoryBytes", "createdAt", "completedAt", "policySummaryAvailable",
  ], [], label);
  if (typeof item.state !== "string" || !(SUBMISSION_STATES as readonly string[]).includes(item.state)) {
    throw new TypeError(`${label}.state is invalid.`);
  }
  if (item.verdict !== null && (typeof item.verdict !== "string" || !(SUBMISSION_VERDICTS as readonly string[]).includes(item.verdict))) {
    throw new TypeError(`${label}.verdict is invalid.`);
  }
  if (typeof item.policySummaryAvailable !== "boolean") throw new TypeError(`${label}.policySummaryAvailable must be boolean.`);
  const completedAt = item.completedAt === null ? null : timestamp(item.completedAt, `${label}.completedAt`);
  const attemptNumber = nonnegativeInteger(item.attemptNumber, Number.MAX_SAFE_INTEGER, `${label}.attemptNumber`);
  if (attemptNumber < 1) throw new TypeError(`${label}.attemptNumber must be positive.`);
  if (item.policySummaryAvailable && item.state !== "completed") throw new TypeError(`${label} exposes a policy summary before completion.`);
  const parsedScore = nullableScore(item.score, `${label}.score`);
  const fullyPassedCases = nullableNonnegativeInteger(item.fullyPassedCases, MAX_CASES, `${label}.fullyPassedCases`);
  const deterministicCost = nullableNonnegativeInteger(item.deterministicCost, Number.MAX_SAFE_INTEGER, `${label}.deterministicCost`);
  const peakMemoryBytes = nullableNonnegativeInteger(item.peakMemoryBytes, Number.MAX_SAFE_INTEGER, `${label}.peakMemoryBytes`);
  if (item.state === "completed") {
    if (
      parsedScore === null
      || fullyPassedCases === null
      || deterministicCost === null
      || peakMemoryBytes === null
      || completedAt === null
      || !item.policySummaryAvailable
    ) throw new TypeError(`${label} completed metrics are incomplete.`);
  } else if ([parsedScore, fullyPassedCases, deterministicCost, peakMemoryBytes].some((metric) => metric !== null)) {
    throw new TypeError(`${label} exposes performance coordinates before completion.`);
  }
  return {
    submissionId: uuid(item.submissionId, `${label}.submissionId`),
    attemptNumber,
    language: language(item.language, `${label}.language`),
    state: item.state as SubmissionState,
    verdict: item.verdict as SubmissionVerdict | null,
    score: parsedScore,
    fullyPassedCases,
    deterministicCost,
    peakMemoryBytes,
    createdAt: timestamp(item.createdAt, `${label}.createdAt`),
    completedAt,
    policySummaryAvailable: item.policySummaryAvailable,
  };
}

function uniqueSubmissionIds(points: readonly { readonly submissionId: string }[], label: string): void {
  if (new Set(points.map((point) => point.submissionId)).size !== points.length) {
    throw new TypeError(`${label} contains duplicate submission IDs.`);
  }
}

export function parseProblemPerformanceResponse(value: unknown, expected: ExpectedPerformanceContext): ProblemPerformanceResponse {
  const root = record(value, "Performance response");
  exactKeys(root, ["context", "frontier", "myEvolution"], [], "Performance response");
  const context = record(root.context, "Performance context");
  exactKeys(context, [
    "problemVersionId", "contestId", "frozen", "availableLanguages", "selectedLanguage", "myEvolutionTruncated",
  ], [], "Performance context");
  const problemVersionId = uuid(context.problemVersionId, "Performance context problemVersionId");
  const contestId = context.contestId === null ? null : uuid(context.contestId, "Performance context contestId");
  if (problemVersionId !== expected.problemVersionId || contestId !== (expected.contestId ?? null)) {
    throw new TypeError("Performance context does not match the requested problem.");
  }
  if (typeof context.frozen !== "boolean") throw new TypeError("Performance context frozen must be boolean.");
  if (typeof context.myEvolutionTruncated !== "boolean") throw new TypeError("Performance context myEvolutionTruncated must be boolean.");
  if (!Array.isArray(context.availableLanguages) || context.availableLanguages.length > 7) {
    throw new TypeError("Performance context languages are invalid.");
  }
  const availableLanguages = context.availableLanguages.map((item, index) => language(item, `availableLanguages[${index}]`));
  if (new Set(availableLanguages).size !== availableLanguages.length) throw new TypeError("Performance context languages are duplicated.");
  const selectedLanguage = context.selectedLanguage === null ? null : language(context.selectedLanguage, "selectedLanguage");
  const expectedLanguage = expected.language === "all" ? null : expected.language;
  if (selectedLanguage !== expectedLanguage || (selectedLanguage !== null && !availableLanguages.includes(selectedLanguage))) {
    throw new TypeError("Performance context language does not match the request.");
  }
  if (!Array.isArray(root.frontier) || root.frontier.length > MAX_FRONTIER_POINTS) throw new TypeError("Performance frontier is invalid.");
  const frontier = root.frontier.map(frontierPoint);
  uniqueSubmissionIds(frontier, "Performance frontier");
  let myEvolution: readonly PerformanceEvolutionPoint[] | null;
  if (root.myEvolution === null) {
    myEvolution = null;
  } else {
    if (!Array.isArray(root.myEvolution) || root.myEvolution.length > MAX_EVOLUTION_POINTS) throw new TypeError("Performance evolution is invalid.");
    myEvolution = root.myEvolution.map(evolutionPoint);
    uniqueSubmissionIds(myEvolution, "Performance evolution");
    for (let index = 0; index < myEvolution.length; index += 1) {
      if (index > 0 && myEvolution[index - 1]!.attemptNumber >= myEvolution[index]!.attemptNumber) {
        throw new TypeError("Performance evolution attempt order is invalid.");
      }
      if (index > 0 && myEvolution[index - 1]!.createdAt > myEvolution[index]!.createdAt) {
        throw new TypeError("Performance evolution is not chronological.");
      }
    }
  }
  if (myEvolution === null && context.myEvolutionTruncated) throw new TypeError("Anonymous performance evolution cannot be truncated.");
  const returnedLanguages = [...frontier.map((point) => point.language), ...(myEvolution ?? []).map((point) => point.language)];
  if (returnedLanguages.some((item) => !availableLanguages.includes(item))) {
    throw new TypeError("Performance points contain an unavailable language.");
  }
  if (selectedLanguage !== null && returnedLanguages.some((item) => item !== selectedLanguage)) {
    throw new TypeError("Performance points do not match the selected language.");
  }
  return {
    context: {
      problemVersionId,
      contestId,
      frozen: context.frozen,
      availableLanguages,
      selectedLanguage,
      myEvolutionTruncated: context.myEvolutionTruncated,
    },
    frontier,
    myEvolution,
  };
}

function policyLevel(value: unknown, index: number, outputAcceptedCases: number): PerformancePolicyLevel {
  const label = `policies[${index}]`;
  const item = record(value, label);
  exactKeys(item, [
    "id", "earnedCases", "costExceededCases", "memoryExceededCases", "logicalTimeExceededCases",
  ], [], label);
  const expectedIds = ["baseline", "efficient", "optimal"] as const;
  if (item.id !== expectedIds[index]) throw new TypeError("Policy levels are not in canonical order.");
  return {
    id: expectedIds[index]!,
    earnedCases: nonnegativeInteger(item.earnedCases, outputAcceptedCases, `${label}.earnedCases`),
    costExceededCases: nonnegativeInteger(item.costExceededCases, outputAcceptedCases, `${label}.costExceededCases`),
    memoryExceededCases: nonnegativeInteger(item.memoryExceededCases, outputAcceptedCases, `${label}.memoryExceededCases`),
    logicalTimeExceededCases: nonnegativeInteger(item.logicalTimeExceededCases, outputAcceptedCases, `${label}.logicalTimeExceededCases`),
  };
}

export function parseSubmissionPolicySummaryResponse(value: unknown, expectedSubmissionId: string): SubmissionPolicySummaryResponse {
  if (new TextEncoder().encode(JSON.stringify(value)).byteLength > 2_048) throw new TypeError("Policy summary response is oversized.");
  const root = record(value, "Policy summary response");
  exactKeys(root, ["submissionId", "policySummary"], [], "Policy summary response");
  const submissionId = uuid(root.submissionId, "Policy summary submissionId");
  if (submissionId !== expectedSubmissionId) throw new TypeError("Policy summary does not match the selected submission.");
  const summary = record(root.policySummary, "Policy summary");
  exactKeys(summary, ["totalCases", "outputAcceptedCases", "policies"], [], "Policy summary");
  const totalCases = nonnegativeInteger(summary.totalCases, MAX_CASES, "Policy summary totalCases");
  if (totalCases < 1) throw new TypeError("Policy summary totalCases must be positive.");
  const outputAcceptedCases = nonnegativeInteger(summary.outputAcceptedCases, totalCases, "Policy summary outputAcceptedCases");
  if (!Array.isArray(summary.policies) || summary.policies.length !== 3) throw new TypeError("Policy summary levels are invalid.");
  const policies = summary.policies.map((item, index) => policyLevel(item, index, outputAcceptedCases)) as unknown as readonly [
    PerformancePolicyLevel,
    PerformancePolicyLevel,
    PerformancePolicyLevel,
  ];
  for (const policy of policies) {
    if (
      policy.earnedCases + policy.costExceededCases > outputAcceptedCases
      || policy.earnedCases + policy.memoryExceededCases > outputAcceptedCases
      || policy.earnedCases + policy.logicalTimeExceededCases > outputAcceptedCases
    ) throw new TypeError("Policy summary resource counts are inconsistent with accepted output.");
  }
  return { submissionId, policySummary: { totalCases, outputAcceptedCases, policies } };
}

export function problemPerformanceApiPath(
  problemVersionId: string,
  languageFilter: BuiltinLanguage | "all",
  contestId?: string,
): string {
  const parameters = new URLSearchParams();
  if (languageFilter !== "all") parameters.set("language", languageFilter);
  if (contestId) parameters.set("contestId", contestId);
  const query = parameters.toString();
  return `/api/problems/${encodeURIComponent(problemVersionId)}/performance${query ? `?${query}` : ""}`;
}

export function submissionPolicySummaryApiPath(submissionId: string): string {
  return `/api/submissions/${encodeURIComponent(submissionId)}/policy-summary`;
}
