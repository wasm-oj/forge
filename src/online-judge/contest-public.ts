import { canonicalJsonBytes } from "../core/canonical-json.ts";
import type { JudgeProblem } from "../judge/problem-model.ts";

export const CONTEST_PUBLIC_PROJECTION_SCHEMA = "wasm-oj-platform/contest-public-problem-projection/v1";

export interface ContestPublicProjection {
  readonly schema: typeof CONTEST_PUBLIC_PROJECTION_SCHEMA;
  readonly problem: JudgeProblem;
}

/**
 * The repository practice bundle is safe to fetch for every practice visitor.
 * Hidden cases and their expected answers exist only in the immutable judge
 * package built from the authoring source.
 */
export function derivePracticePublic(authored: JudgeProblem): JudgeProblem {
  return {
    ...structuredClone(authored),
    judgeCases: authored.judgeCases
      .filter((testCase) => testCase.kind === "sample")
      .map((testCase) => structuredClone(testCase)),
  };
}

/** The single deterministic hidden-data redaction used by author CI and platform validation. */
export function deriveContestPublic(practice: JudgeProblem): JudgeProblem {
  if (practice.judgeCases.some((testCase) => testCase.kind !== "sample")) {
    throw new TypeError("Practice-public input contains non-sample judge data.");
  }
  return {
    ...structuredClone(practice),
    editorial: { "zh-TW": "", en: "" },
    judgeCases: practice.judgeCases
      .filter((testCase) => testCase.kind === "sample")
      .map((testCase) => structuredClone(testCase)),
  };
}

export function createContestPublicProjection(practice: JudgeProblem): ContestPublicProjection {
  return {
    schema: CONTEST_PUBLIC_PROJECTION_SCHEMA,
    problem: deriveContestPublic(practice),
  };
}

export function contestPublicProjectionBytes(practice: JudgeProblem): Uint8Array {
  return canonicalJsonBytes(createContestPublicProjection(practice));
}
