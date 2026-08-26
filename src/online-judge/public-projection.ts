import { BROWSER_PROBLEM_SCHEMA, parseStandaloneProblemBundle } from "../judge/problem-catalog-loader";
import type { JudgeProblem } from "../judge/problem-model";
import { CONTEST_PUBLIC_PROJECTION_SCHEMA, type ContestPublicProjection } from "./contest-public";

/** Parses the redacted contest object. Its repository descriptor supplies the content identity. */
export function parseContestPublicProblemProjection(value: unknown): ContestPublicProjection {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Contest-public projection must be an object.");
  }
  const record = value as Record<string, unknown>;
  if (Object.keys(record).sort().join("\0") !== "problem\0schema"
    || record.schema !== CONTEST_PUBLIC_PROJECTION_SCHEMA) {
    throw new TypeError("Contest-public projection has an invalid shape or schema.");
  }
  if (!record.problem || typeof record.problem !== "object" || Array.isArray(record.problem)) {
    throw new TypeError("Contest-public projection contains an invalid problem.");
  }
  const rawProblem = record.problem as Record<string, unknown>;
  const editorial = rawProblem.editorial;
  if (!editorial || typeof editorial !== "object" || Array.isArray(editorial)
    || Object.keys(editorial).sort().join("\0") !== "en\0zh-TW"
    || (editorial as Record<string, unknown>)["zh-TW"] !== ""
    || (editorial as Record<string, unknown>).en !== "") {
    throw new TypeError("Contest-public projection contains non-public problem data.");
  }
  const parsed = parseStandaloneProblemBundle({
    schema: BROWSER_PROBLEM_SCHEMA,
    problem: { ...rawProblem, editorial: { "zh-TW": "redacted", en: "redacted" } },
  });
  if (parsed.judgeCases.some((testCase) => testCase.kind !== "sample")) {
    throw new TypeError("Contest-public projection contains non-public problem data.");
  }
  const problem: JudgeProblem = { ...parsed, editorial: { "zh-TW": "", en: "" } };
  return { schema: CONTEST_PUBLIC_PROJECTION_SCHEMA, problem };
}
