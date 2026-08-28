import { describe, expect, it } from "vitest";
import {
  parseRepositoryContestsValue,
  parseRepositoryProblems,
  parseRepositoryProblemsValue,
  parseRepositoryRoot,
  validateRepositoryCatalog,
} from "./repository-contract";

const digest = "a".repeat(64);

function problem(slug = "sum"): Record<string, unknown> {
  return {
    slug,
    order: 1,
    title: { "zh-TW": "加總", en: "Sum" },
    summary: { "zh-TW": "計算總和", en: "Compute a sum" },
    practiceEnabled: true,
    practiceBundle: { path: `public/${slug}.practice.json`, bytes: 10, sha256: digest },
    contestBundle: { path: `public/${slug}.contest.json`, bytes: 9, sha256: "b".repeat(64) },
    judgePackage: { path: `judge/${slug}.woj`, bytes: 20, sha256: "c".repeat(64) },
  };
}

function codeRules(problemSlugs = ["sum"]): Record<string, unknown> {
  return {
    clock: {
      kind: "global",
      registrationOpensAt: "2025-12-01T00:00:00Z",
      registrationClosesAt: "2026-01-01T00:00:00Z",
      startsAt: "2026-01-01T00:00:00Z",
      durationSeconds: 3_600,
    },
    officialTrack: { kind: "code", aiAssist: "allowed" },
    evidenceAt: "input-admitted",
    problems: problemSlugs.map((slug) => ({
      slug,
      batch: 1,
      releaseAfterSeconds: 0,
      submissionClosesAfterSeconds: 3_600,
      points: 100,
      attemptLimit: 10,
    })),
    scoring: { kind: "score", tieBreaks: ["deterministic-cost", "final-best-achieved-at"] },
    checkpoints: [],
    leaderboard: { kind: "live" },
  };
}

it("accepts ordinary non-canonical UTF-8 JSON", () => {
  expect(parseRepositoryRoot(new TextEncoder().encode(`{\n  "problems": "collection/problems.json",\n  "schema": "wasm-oj-platform/repository/v1",\n  "contests": "collection/contests.json"\n}`))).toEqual({
    schema: "wasm-oj-platform/repository/v1",
    problems: "collection/problems.json",
    contests: "collection/contests.json",
  });
  expect(parseRepositoryProblems(new TextEncoder().encode(JSON.stringify({ problems: [problem()], schema: "wasm-oj-platform/problems/v1" }, null, 2))).problems).toHaveLength(1);
});

describe("repository catalog validation", () => {
  it("rejects bad paths, sizes, digests, and duplicate object paths", () => {
    expect(() => parseRepositoryProblemsValue({ schema: "wasm-oj-platform/problems/v1", problems: [{ ...problem(), practiceBundle: { path: "../x", bytes: 10, sha256: digest } }] })).toThrow("normalized");
    expect(() => parseRepositoryProblemsValue({ schema: "wasm-oj-platform/problems/v1", problems: [{ ...problem(), judgePackage: { path: "judge/x", bytes: 0, sha256: digest } }] })).toThrow("bytes");
    expect(() => parseRepositoryProblemsValue({ schema: "wasm-oj-platform/problems/v1", problems: [{ ...problem(), judgePackage: { path: "judge/x", bytes: 1, sha256: "A".repeat(64) } }] })).toThrow("SHA-256");
    const duplicate = problem();
    duplicate.contestBundle = duplicate.practiceBundle;
    expect(() => parseRepositoryProblemsValue({ schema: "wasm-oj-platform/problems/v1", problems: [duplicate] })).toThrow("more than once");
  });

  it("rejects unknown contest problem references", () => {
    const root = parseRepositoryRoot(new TextEncoder().encode(JSON.stringify({ schema: "wasm-oj-platform/repository/v1", problems: "collection/problems.json", contests: "collection/contests.json" })));
    const problems = parseRepositoryProblemsValue({ schema: "wasm-oj-platform/problems/v1", problems: [problem()] });
    const contests = parseRepositoryContestsValue({
      schema: "wasm-oj-platform/contests/v2",
      contests: [{
        slug: "weekly-1", status: "published", title: "Weekly 1", description: "",
        accessMode: "public", rules: codeRules(["missing"]),
      }],
    });
    expect(() => validateRepositoryCatalog(root, problems, contests)).toThrow("unknown problem");
  });

  it("accepts only the exact contests/v2 shape", () => {
    expect(() => parseRepositoryContestsValue({ schema: "wasm-oj-platform/contests/v1", contests: [] })).toThrow("contests/v2");
    expect(() => parseRepositoryContestsValue({
      schema: "wasm-oj-platform/contests/v2",
      contests: [{
        slug: "weekly-1", status: "published", title: "Weekly 1", description: "", accessMode: "public",
        rules: codeRules(), startsAt: "2026-01-01T00:00:00Z",
      }],
    })).toThrow("invalid shape");
  });
});
