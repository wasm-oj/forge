import { BROWSER_PROBLEM_SCHEMA, parseStandaloneProblemBundle } from "../judge/problem-catalog-loader";
import type { JudgeProblem } from "../judge/problem-model";

const DIGEST = /^[0-9a-f]{64}$/;

export type ManagedPublicProjectionMode = "official-practice" | "contest";

export interface ManagedPublicProblemProjection {
  readonly schema: "wasm-oj-platform/practice-problem-projection/v1" | "wasm-oj-platform/contest-public-problem-projection/v1";
  readonly problem: JudgeProblem;
  readonly digest: string;
}

export function parseManagedPublicProblemProjection(
  value: unknown,
  mode: ManagedPublicProjectionMode,
  expectedBundleDigest: string,
): ManagedPublicProblemProjection {
  if (!DIGEST.test(expectedBundleDigest)) throw new TypeError("Managed problem bundle digest is invalid.");
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("Managed public projection must be an object.");
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).length !== 3
    || !Object.hasOwn(record, "schema")
    || !Object.hasOwn(record, "problem")
    || !Object.hasOwn(record, "digest")
    || record.digest !== expectedBundleDigest
  ) throw new TypeError("Managed public projection is not bound to its problem bundle.");
  const expectedSchema = mode === "contest"
    ? "wasm-oj-platform/contest-public-problem-projection/v1"
    : "wasm-oj-platform/practice-problem-projection/v1";
  if (record.schema !== expectedSchema) throw new TypeError("Managed public projection has the wrong semantic role.");
  let problem: JudgeProblem;
  if (mode === "contest") {
    if (!record.problem || typeof record.problem !== "object" || Array.isArray(record.problem)) throw new TypeError("Contest-public projection contains an invalid problem.");
    const rawProblem = record.problem as Record<string, unknown>;
    const editorial = rawProblem.editorial;
    if (
      !editorial || typeof editorial !== "object" || Array.isArray(editorial)
      || Object.keys(editorial).length !== 2
      || (editorial as Record<string, unknown>)["zh-TW"] !== ""
      || (editorial as Record<string, unknown>).en !== ""
    ) throw new TypeError("Contest-public projection contains non-public problem data.");
    const parsed = parseStandaloneProblemBundle({
      schema: BROWSER_PROBLEM_SCHEMA,
      problem: { ...rawProblem, editorial: { "zh-TW": "redacted", en: "redacted" } },
    });
    if (parsed.judgeCases.some((testCase) => testCase.kind !== "sample")) throw new TypeError("Contest-public projection contains non-public problem data.");
    problem = { ...parsed, editorial: { "zh-TW": "", en: "" } };
  } else {
    problem = parseStandaloneProblemBundle({ schema: BROWSER_PROBLEM_SCHEMA, problem: record.problem });
  }
  return { schema: expectedSchema, problem, digest: expectedBundleDigest };
}
