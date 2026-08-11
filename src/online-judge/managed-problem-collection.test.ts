import { describe, expect, it, vi } from "vitest";
import { PROBLEMS } from "../judge/problems";
import {
  ManagedProblemCollectionError,
  createOfficialSubmissionRequest,
  loadManagedProblemCollection,
  managedCollectionAllowsFullLocalJudge,
  managedProblemProjectionApiPath,
  managedProblemWorkspacePath,
  normalizeManagedProblemContext,
} from "./managed-problem-collection";

const PROBLEM_VERSION_ID = "11111111-1111-4111-8111-111111111111";
const CONTEST_ID = "22222222-2222-4222-8222-222222222222";
const DIGEST = "a".repeat(64);
const problem = PROBLEMS[0]!;
const contestProblem = {
  ...problem,
  editorial: { "zh-TW": "", en: "" },
  judgeCases: problem.judgeCases.filter((testCase) => testCase.kind === "sample"),
};

function projectionResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("managed problem collection adapter", () => {
  it("loads the exact contest-public projection into a real managed one-problem collection", async () => {
    const fetchMock = vi.fn(async () => projectionResponse({
      schema: "forge-contest-public-problem-projection-v1",
      problem: contestProblem,
      digest: DIGEST,
    })) as unknown as typeof fetch;

    const collection = await loadManagedProblemCollection({
      problemVersionId: PROBLEM_VERSION_ID,
      contestId: CONTEST_ID,
    }, { fetch: fetchMock });

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledWith(
      `/api/problems/${PROBLEM_VERSION_ID}?contestId=${CONTEST_ID}`,
      expect.objectContaining({
        method: "GET",
        credentials: "same-origin",
        redirect: "error",
        headers: { accept: "application/json" },
      }),
    );
    expect(collection.source).toEqual({
      provider: "managed",
      mode: "contest",
      problemVersionId: PROBLEM_VERSION_ID,
      contestId: CONTEST_ID,
      projectionUrl: `/api/problems/${PROBLEM_VERSION_ID}?contestId=${CONTEST_ID}`,
    });
    expect(collection.source).not.toHaveProperty("owner");
    expect(collection.source).not.toHaveProperty("repository");
    expect(collection.sourceKey).toBe(`managed:contest:${CONTEST_ID}:${PROBLEM_VERSION_ID}:${DIGEST}`);
    expect(collection.index.problems).toHaveLength(1);
    expect(collection.index.problems[0]).not.toHaveProperty("statementPaths");
    expect(await collection.loadProblem(problem.id)).toEqual(contestProblem);
    expect((await collection.loadProblem(problem.id)).judgeCases.every((testCase) => testCase.kind === "sample")).toBe(true);
    const hiddenCase = problem.judgeCases.find((testCase) => testCase.kind !== "sample");
    if (!hiddenCase) throw new Error("The generated problem fixture must include a non-sample case.");
    expect(JSON.stringify(await collection.loadProblem(problem.id))).not.toContain(hiddenCase.input);
    await expect(collection.loadProblem("wrong-problem")).rejects.toThrow("Unknown managed problem");
  });

  it("loads official practice without inventing a contest or GitHub identity", async () => {
    const collection = await loadManagedProblemCollection({ problemVersionId: PROBLEM_VERSION_ID }, {
      fetch: async () => projectionResponse({
        schema: "forge-practice-problem-projection-v1",
        problem,
        digest: DIGEST,
      }),
    });
    expect(collection.source).toEqual({
      provider: "managed",
      mode: "official-practice",
      problemVersionId: PROBLEM_VERSION_ID,
      projectionUrl: `/api/problems/${PROBLEM_VERSION_ID}`,
    });
    expect(collection.sourceKey).toBe(`managed:official-practice:${PROBLEM_VERSION_ID}:${DIGEST}`);
    expect(await collection.loadProblem(problem.id)).toEqual(problem);
  });

  it("rejects wrong identifiers before network access", async () => {
    const fetchMock = vi.fn();
    await expect(loadManagedProblemCollection({ problemVersionId: "not-a-uuid" }, {
      fetch: fetchMock as unknown as typeof fetch,
    })).rejects.toMatchObject({ kind: "configuration" });
    await expect(loadManagedProblemCollection({
      problemVersionId: PROBLEM_VERSION_ID,
      contestId: "not-a-uuid",
    }, { fetch: fetchMock as unknown as typeof fetch })).rejects.toMatchObject({ kind: "configuration" });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(() => normalizeManagedProblemContext({
      problemVersionId: PROBLEM_VERSION_ID,
      repository: "fake/repo",
    })).toThrow("invalid shape");
  });

  it("rejects a projection with the wrong semantic role or any hidden case", async () => {
    await expect(loadManagedProblemCollection({
      problemVersionId: PROBLEM_VERSION_ID,
      contestId: CONTEST_ID,
    }, {
      fetch: async () => projectionResponse({
        schema: "forge-practice-problem-projection-v1",
        problem,
        digest: DIGEST,
      }),
    })).rejects.toThrow("wrong semantic role");

    await expect(loadManagedProblemCollection({
      problemVersionId: PROBLEM_VERSION_ID,
      contestId: CONTEST_ID,
    }, {
      fetch: async () => projectionResponse({
        schema: "forge-contest-public-problem-projection-v1",
        problem: { ...contestProblem, judgeCases: problem.judgeCases },
        digest: DIGEST,
      }),
    })).rejects.toThrow("non-public");
  });

  it("fails closed on HTTP, media-type, and byte-integrity errors", async () => {
    await expect(loadManagedProblemCollection({ problemVersionId: PROBLEM_VERSION_ID }, {
      fetch: async () => new Response("missing", { status: 404 }),
    })).rejects.toMatchObject({ kind: "unavailable" } satisfies Partial<ManagedProblemCollectionError>);
    await expect(loadManagedProblemCollection({ problemVersionId: PROBLEM_VERSION_ID }, {
      fetch: async () => new Response("{}", { status: 200, headers: { "content-type": "text/plain" } }),
    })).rejects.toMatchObject({ kind: "schema" } satisfies Partial<ManagedProblemCollectionError>);
    await expect(loadManagedProblemCollection({ problemVersionId: PROBLEM_VERSION_ID }, {
      fetch: async () => new Response("{}", {
        status: 200,
        headers: { "content-type": "application/json", "content-length": String(32 * 1024 * 1024 + 1) },
      }),
    })).rejects.toMatchObject({ kind: "integrity" } satisfies Partial<ManagedProblemCollectionError>);
  });
});

describe("managed workspace and Official Submit context", () => {
  it("builds the exact API and page routes", () => {
    expect(managedProblemProjectionApiPath({ problemVersionId: PROBLEM_VERSION_ID }))
      .toBe(`/api/problems/${PROBLEM_VERSION_ID}`);
    expect(managedProblemProjectionApiPath({ problemVersionId: PROBLEM_VERSION_ID, contestId: CONTEST_ID }))
      .toBe(`/api/problems/${PROBLEM_VERSION_ID}?contestId=${CONTEST_ID}`);
    expect(managedProblemWorkspacePath({ problemVersionId: PROBLEM_VERSION_ID }))
      .toBe(`/problems/${PROBLEM_VERSION_ID}`);
    expect(managedProblemWorkspacePath({ problemVersionId: PROBLEM_VERSION_ID, contestId: CONTEST_ID }))
      .toBe(`/contests/${CONTEST_ID}/problems/${PROBLEM_VERSION_ID}`);
  });

  it("allows a full local judge only for a full official-practice projection", () => {
    expect(managedCollectionAllowsFullLocalJudge({ problemVersionId: PROBLEM_VERSION_ID })).toBe(true);
    expect(managedCollectionAllowsFullLocalJudge({
      problemVersionId: PROBLEM_VERSION_ID,
      contestId: CONTEST_ID,
    })).toBe(false);
  });

  it("includes contestId in the exact formal request and omits it for official practice", () => {
    const source = {
      language: "c" as const,
      target: "wasip1" as const,
      optimization: "release" as const,
      entry: "main.c",
      sourceFiles: [{ path: "main.c", encoding: "utf8" as const, content: "int main(void) { return 0; }" }],
      idempotencyKey: "browser:33333333-3333-4333-8333-333333333333",
    };
    expect(createOfficialSubmissionRequest({
      problemVersionId: PROBLEM_VERSION_ID,
      contestId: CONTEST_ID,
    }, source)).toEqual({
      managedProblemVersionId: PROBLEM_VERSION_ID,
      contestId: CONTEST_ID,
      ...source,
    });
    expect(createOfficialSubmissionRequest({ problemVersionId: PROBLEM_VERSION_ID }, source))
      .not.toHaveProperty("contestId");
  });
});
