import { canonicalJsonBytes } from "../core/canonical-json.ts";
import type { JudgeProblem } from "../judge/problem-model.ts";

export const CONTEST_PUBLIC_PROJECTION_SCHEMA = "wasm-oj-platform/contest-public-problem-projection/v1";

const SHA256 = /^[0-9a-f]{64}$/;

export interface ContestPublicProjection {
  readonly schema: typeof CONTEST_PUBLIC_PROJECTION_SCHEMA;
  readonly problem: JudgeProblem;
  readonly digest: string;
}

/**
 * The bundle referenced by collection/index.json is safe to fetch for every
 * practice visitor. Hidden cases and their expected answers exist only in the
 * immutable judge package built from the authoring source.
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

export function createContestPublicProjection(practice: JudgeProblem, problemBundleSha256: string): ContestPublicProjection {
  if (typeof problemBundleSha256 !== "string" || !SHA256.test(problemBundleSha256)) {
    throw new TypeError("Contest-public projection digest must be a lowercase SHA-256 digest.");
  }
  return {
    schema: CONTEST_PUBLIC_PROJECTION_SCHEMA,
    problem: deriveContestPublic(practice),
    digest: problemBundleSha256,
  };
}

export function contestPublicProjectionBytes(practice: JudgeProblem, problemBundleSha256: string): Uint8Array {
  return canonicalJsonBytes(createContestPublicProjection(practice, problemBundleSha256));
}
