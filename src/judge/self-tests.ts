import { FORGE_CONTRACT_ID } from "../core/contract";

export const MAX_SELF_TEST_CASES = 20;
const SELF_TEST_SCHEMA = `${FORGE_CONTRACT_ID}/self-tests`;
const SELF_TEST_KEY = `${FORGE_CONTRACT_ID}:self-tests`;

export interface SelfTestCase {
  readonly id: string;
  readonly name: string;
  readonly input: string;
}

export function selfTestStorageKey(collectionKey: string, problemProgressId: string): string {
  return `${SELF_TEST_KEY}:${encodeURIComponent(collectionKey)}:${problemProgressId}`;
}

export function defaultSelfTestCases(sampleInput: string): SelfTestCase[] {
  return [{ id: "case-1", name: "Case 1", input: sampleInput }];
}

export function encodeSelfTestCases(cases: readonly SelfTestCase[]): string {
  validateSelfTestCases(cases);
  return JSON.stringify({ schema: SELF_TEST_SCHEMA, cases });
}

export function decodeSelfTestCases(raw: string | null, sampleInput: string): SelfTestCase[] {
  if (raw === null) return defaultSelfTestCases(sampleInput);
  const parsed: unknown = JSON.parse(raw);
  if (!isRecord(parsed) || !hasExactKeys(parsed, ["schema", "cases"]) || parsed.schema !== SELF_TEST_SCHEMA) {
    throw new Error("Stored self-test workspace has an invalid schema.");
  }
  validateSelfTestCases(parsed.cases);
  return parsed.cases.map((testCase) => ({ ...testCase }));
}

function validateSelfTestCases(value: unknown): asserts value is SelfTestCase[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_SELF_TEST_CASES) {
    throw new Error(`Self-test workspace must contain between 1 and ${MAX_SELF_TEST_CASES} cases.`);
  }
  const ids = new Set<string>();
  for (const testCase of value) {
    if (!isRecord(testCase)
      || !hasExactKeys(testCase, ["id", "name", "input"])
      || typeof testCase.id !== "string"
      || testCase.id.length < 1
      || testCase.id.length > 128
      || ids.has(testCase.id)
      || typeof testCase.name !== "string"
      || testCase.name.length > 80
      || typeof testCase.input !== "string") {
      throw new Error("Stored self-test workspace contains an invalid case.");
    }
    ids.add(testCase.id);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  return actual.length === expected.length && actual.every((key, index) => key === [...expected].sort()[index]);
}
