import {
  MAX_LOGICAL_TIME_LIMIT_MS,
  MAX_MEMORY_LIMIT_BYTES,
  MAX_WALL_TIME_LIMIT_MS,
  WASM_MEMORY_PAGE_BYTES,
} from "../core/resources.ts";
import { isBuiltinLanguage, type BuiltinLanguage } from "../core/types.ts";
import type { JudgeProblem, ProblemPolicyLimits } from "../judge/problem-model.ts";
import { isUnicodeScalarString } from "./unicode-scalar.ts";

export const WASM_OJ_JUDGE_DATA_SCHEMA = "wasm-oj-v2/judge-data";

const CASE_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const POLICY_IDS = ["baseline", "efficient", "optimal"] as const;
const CALIBRATION_METHOD = "wasm-oj-v2/compiled-average-optimal-rounded/v1";

export interface JudgeDataCase {
  readonly id: string;
  readonly input: string;
  readonly output: string;
}

export interface JudgePolicy {
  readonly id: typeof POLICY_IDS[number];
  readonly points: number;
  readonly limits: ProblemPolicyLimits;
}

export interface JudgeData {
  readonly schema: typeof WASM_OJ_JUDGE_DATA_SCHEMA;
  readonly cases: readonly JudgeDataCase[];
  readonly scoring: {
    readonly maximumPoints: 100;
    readonly calibration: {
      readonly method: typeof CALIBRATION_METHOD;
      readonly profiles: Readonly<Partial<Record<BuiltinLanguage, string>>>;
    };
    readonly policies: readonly JudgePolicy[];
    readonly safetyLimits: { readonly wallTimeLimitMs: number };
  };
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${label} must be an object.`);
  return value as Record<string, unknown>;
}

function exact(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  if (JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...keys].sort())) throw new TypeError(`${label} has an invalid shape.`);
}

function positiveInteger(value: unknown, label: string, maximum = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > maximum) throw new TypeError(`${label} is outside its limit.`);
  return value as number;
}

function limits(value: unknown, policyId: string): ProblemPolicyLimits {
  const input = record(value, `judge data policy '${policyId}' limits`);
  const keys = Object.keys(input).sort();
  const expected = keys.includes("logicalTimeLimitMs")
    ? ["instructionBudget", "logicalTimeLimitMs", "memoryLimitBytes"]
    : ["instructionBudget", "memoryLimitBytes"];
  if (JSON.stringify(keys) !== JSON.stringify(expected)) throw new TypeError(`Judge data policy '${policyId}' limits have an invalid shape.`);
  const memoryLimitBytes = positiveInteger(input.memoryLimitBytes, `judge data policy '${policyId}' memoryLimitBytes`, MAX_MEMORY_LIMIT_BYTES);
  if (memoryLimitBytes < WASM_MEMORY_PAGE_BYTES || memoryLimitBytes % WASM_MEMORY_PAGE_BYTES !== 0) {
    throw new TypeError(`Judge data policy '${policyId}' memoryLimitBytes must be a positive number of Wasm pages.`);
  }
  return {
    instructionBudget: positiveInteger(input.instructionBudget, `judge data policy '${policyId}' instructionBudget`),
    memoryLimitBytes,
    ...(input.logicalTimeLimitMs === undefined ? {} : {
      logicalTimeLimitMs: positiveInteger(input.logicalTimeLimitMs, `judge data policy '${policyId}' logicalTimeLimitMs`, MAX_LOGICAL_TIME_LIMIT_MS),
    }),
  };
}

function allowedLanguageSet(allowedLanguages: readonly BuiltinLanguage[]): BuiltinLanguage[] {
  const result = [...allowedLanguages].sort();
  if (result.length < 1 || new Set(result).size !== result.length || result.some((language) => !isBuiltinLanguage(language))) {
    throw new TypeError("Judge data allowed languages are invalid.");
  }
  return result;
}

/** Derive only execution-significant data; statement, editorial, titles, and slug never enter the package digest. */
export function deriveJudgeData(practice: JudgeProblem, allowedLanguages: readonly BuiltinLanguage[]): JudgeData {
  const languages = allowedLanguageSet(allowedLanguages);
  return parseJudgeData({
    schema: WASM_OJ_JUDGE_DATA_SCHEMA,
    cases: practice.judgeCases.map((testCase) => ({ id: testCase.id, input: testCase.input, output: testCase.output })),
    scoring: {
      maximumPoints: practice.scoring.maximumPoints,
      calibration: {
        method: practice.scoring.calibration.method,
        profiles: Object.fromEntries(languages.map((language) => [language, practice.scoring.calibration.profiles[language]])),
      },
      policies: practice.scoring.policies.map((policy) => ({ id: policy.id, points: policy.points, limits: structuredClone(policy.limits) })),
      safetyLimits: structuredClone(practice.scoring.safetyLimits),
    },
  }, languages);
}

/**
 * Bind an execution package to the public contract without requiring hidden
 * data to appear in the public bundle. Scoring/resources must match exactly,
 * and every published sample must be an exact case in the private package.
 */
export function assertJudgeDataMatchesPracticePublic(
  judgeData: JudgeData,
  practice: JudgeProblem,
  allowedLanguages: readonly BuiltinLanguage[],
): void {
  if (practice.judgeCases.some((testCase) => testCase.kind !== "sample")) {
    throw new TypeError("Practice bundle contains hidden judge data.");
  }
  const publicContract = deriveJudgeData(practice, allowedLanguages);
  if (JSON.stringify(judgeData.scoring) !== JSON.stringify(publicContract.scoring)) {
    throw new TypeError("Judge package scoring/resources disagree with the practice-public contract.");
  }
  const cases = new Map(judgeData.cases.map((testCase) => [testCase.id, testCase]));
  for (const sample of publicContract.cases) {
    const packaged = cases.get(sample.id);
    if (!packaged || packaged.input !== sample.input || packaged.output !== sample.output) {
      throw new TypeError(`Judge package does not contain the exact public sample '${sample.id}'.`);
    }
  }
}

export function parseJudgeData(value: unknown, allowedLanguages: readonly BuiltinLanguage[]): JudgeData {
  const languages = allowedLanguageSet(allowedLanguages);
  const data = record(value, "judge data");
  exact(data, ["cases", "schema", "scoring"], "judge data");
  if (data.schema !== WASM_OJ_JUDGE_DATA_SCHEMA) throw new TypeError(`Judge data schema must be '${WASM_OJ_JUDGE_DATA_SCHEMA}'.`);
  if (!Array.isArray(data.cases) || data.cases.length < 1 || data.cases.length > 10_000) throw new TypeError("Judge data must contain between 1 and 10000 cases.");
  const caseIds = new Set<string>();
  const cases = data.cases.map((candidate, index): JudgeDataCase => {
    const testCase = record(candidate, `judge data case ${index + 1}`);
    exact(testCase, ["id", "input", "output"], `judge data case ${index + 1}`);
    if (typeof testCase.id !== "string" || !CASE_ID.test(testCase.id) || caseIds.has(testCase.id)) throw new TypeError(`Judge data case ${index + 1} has an invalid or duplicate id.`);
    if (
      typeof testCase.input !== "string"
      || typeof testCase.output !== "string"
      || !isUnicodeScalarString(testCase.input)
      || !isUnicodeScalarString(testCase.output)
    ) throw new TypeError(`Judge data case '${testCase.id}' input and output must be Unicode scalar strings.`);
    caseIds.add(testCase.id);
    return { id: testCase.id, input: testCase.input, output: testCase.output };
  });

  const scoring = record(data.scoring, "judge data scoring");
  exact(scoring, ["calibration", "maximumPoints", "policies", "safetyLimits"], "judge data scoring");
  if (scoring.maximumPoints !== 100) throw new TypeError("Judge data maximumPoints must be 100.");
  const calibration = record(scoring.calibration, "judge data calibration");
  exact(calibration, ["method", "profiles"], "judge data calibration");
  if (calibration.method !== CALIBRATION_METHOD) throw new TypeError("Judge data calibration method is unsupported.");
  const profilesInput = record(calibration.profiles, "judge data calibration profiles");
  if (JSON.stringify(Object.keys(profilesInput).sort()) !== JSON.stringify(languages)) throw new TypeError("Judge data calibration profiles must exactly match allowedProfiles.");
  const profiles: Partial<Record<BuiltinLanguage, string>> = {};
  for (const language of languages) {
    const profile = profilesInput[language];
    if (
      typeof profile !== "string"
      || !profile
      || profile !== profile.trim()
      || profile.length > 4_096
      || !isUnicodeScalarString(profile)
    ) throw new TypeError(`Judge data calibration profile '${language}' is invalid.`);
    profiles[language] = profile;
  }

  if (!Array.isArray(scoring.policies) || scoring.policies.length !== POLICY_IDS.length) throw new TypeError("Judge data scoring policies are invalid.");
  const policies = scoring.policies.map((candidate, index): JudgePolicy => {
    const policy = record(candidate, `judge data policy ${index + 1}`);
    exact(policy, ["id", "limits", "points"], `judge data policy ${index + 1}`);
    const expectedId = POLICY_IDS[index]!;
    if (policy.id !== expectedId) throw new TypeError(`Judge data policy ${index + 1} must be '${expectedId}'.`);
    return { id: expectedId, points: positiveInteger(policy.points, `judge data policy '${expectedId}' points`, 100), limits: limits(policy.limits, expectedId) };
  });
  if (policies.reduce((total, policy) => total + policy.points, 0) !== 100) throw new TypeError("Judge data policy points must sum to 100.");
  for (let index = 1; index < policies.length; index += 1) {
    const broad = policies[index - 1]!.limits;
    const strict = policies[index]!.limits;
    const logicalInvalid = broad.logicalTimeLimitMs !== undefined
      && (strict.logicalTimeLimitMs === undefined || strict.logicalTimeLimitMs > broad.logicalTimeLimitMs);
    const anyStricter = strict.instructionBudget < broad.instructionBudget
      || strict.memoryLimitBytes < broad.memoryLimitBytes
      || (broad.logicalTimeLimitMs === undefined && strict.logicalTimeLimitMs !== undefined)
      || (broad.logicalTimeLimitMs !== undefined && strict.logicalTimeLimitMs !== undefined && strict.logicalTimeLimitMs < broad.logicalTimeLimitMs);
    if (strict.instructionBudget > broad.instructionBudget || strict.memoryLimitBytes > broad.memoryLimitBytes || logicalInvalid || !anyStricter) {
      throw new TypeError("Judge data policies must be ordered broad-to-strict.");
    }
  }
  const safetyLimits = record(scoring.safetyLimits, "judge data safetyLimits");
  exact(safetyLimits, ["wallTimeLimitMs"], "judge data safetyLimits");
  return {
    schema: WASM_OJ_JUDGE_DATA_SCHEMA,
    cases,
    scoring: {
      maximumPoints: 100,
      calibration: { method: CALIBRATION_METHOD, profiles },
      policies,
      safetyLimits: { wallTimeLimitMs: positiveInteger(safetyLimits.wallTimeLimitMs, "judge data wallTimeLimitMs", MAX_WALL_TIME_LIMIT_MS) },
    },
  };
}
