import { describe, expect, it, vi } from "vitest";
import { BROWSER_PROBLEM_SCHEMA } from "../judge/problem-catalog-loader";
import { PROBLEMS } from "../judge/problems";
import {
  ManagedProblemCollectionError,
  createOfficialSubmissionRequest,
  loadManagedProblemCollection,
  managedProblemContentApiPath,
  managedProblemMetadataApiPath,
  managedProblemWorkspacePath,
  normalizeManagedProblemContext,
} from "./managed-problem-collection";

const PROBLEM_VERSION_ID = "11111111-1111-4111-8111-111111111111";
const SERIES_ID = "22222222-2222-4222-8222-222222222222";
const PUBLICATION_ID = "33333333-3333-4333-8333-333333333333";
const CONTEST_ID = "44444444-4444-4444-8444-444444444444";
const PRACTICE_DIGEST = "d".repeat(64);
const authoredProblem = PROBLEMS[0]!;
const practiceProblem = {
  ...authoredProblem,
  judgeCases: authoredProblem.judgeCases.filter((testCase) => testCase.kind === "sample"),
};
const contestProblem = {
  ...practiceProblem,
  editorial: { "zh-TW": "", en: "" },
};
const allowedProfiles = Object.fromEntries(Object.keys(practiceProblem.starterTemplates).map((language) => [
  language,
  { target: "wasip1", optimization: "release" },
]));

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function managedResponses(options: {
  readonly contest?: boolean;
  readonly contentValue?: unknown;
  readonly metadataPatch?: Record<string, unknown>;
  readonly contentPatch?: Record<string, unknown>;
}) {
  const contest = options.contest ?? false;
  const context = contest
    ? { problemVersionId: PROBLEM_VERSION_ID, contestId: CONTEST_ID }
    : { problemVersionId: PROBLEM_VERSION_ID };
  const contentValue = options.contentValue ?? (contest
    ? { schema: "wasm-oj-platform/contest-public-problem-projection/v1", problem: contestProblem, digest: PRACTICE_DIGEST }
    : { schema: BROWSER_PROBLEM_SCHEMA, problem: practiceProblem });
  const contentText = JSON.stringify(contentValue);
  const contentUrl = managedProblemContentApiPath(context);
  const metadata = {
    schema: "wasm-oj-platform/problem-content-pointer/v2",
    problemVersionId: PROBLEM_VERSION_ID,
    problemSeriesId: SERIES_ID,
    catalogPublicationId: PUBLICATION_ID,
    mode: contest ? "contest" : "official-practice",
    problemSlug: practiceProblem.id,
    problemNumber: practiceProblem.number,
    title: practiceProblem.title,
    difficulty: practiceProblem.difficulty,
    tags: practiceProblem.tags,
    trackId: practiceProblem.trackId,
    track: practiceProblem.track,
    allowedProfiles,
    maximumScore: 100,
    executionSemanticDigest: "e".repeat(64),
    content: {
      role: contest ? "contest-public" : "practice",
      bytes: new TextEncoder().encode(contentText).byteLength,
      sha256: await sha256Hex(contentText),
      url: contentUrl,
      ...options.contentPatch,
    },
    ...options.metadataPatch,
  };
  return {
    context,
    contentUrl,
    metadataUrl: managedProblemMetadataApiPath(context),
    metadataResponse: new Response(JSON.stringify(metadata), { headers: { "content-type": "application/json" } }),
    contentResponse: new Response(contentText, { headers: { "content-type": "application/json" } }),
  };
}

describe("managed problem v2 content adapter", () => {
  it("loads D1 contest metadata, then its authorized exact-commit redacted content", async () => {
    const responses = await managedResponses({ contest: true });
    const fetchMock = vi.fn(async (url: string | URL | Request) => (
      String(url) === responses.metadataUrl ? responses.metadataResponse : responses.contentResponse
    )) as unknown as typeof fetch;

    const collection = await loadManagedProblemCollection(responses.context, { fetch: fetchMock });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenNthCalledWith(1, responses.metadataUrl, expect.objectContaining({
      method: "GET", credentials: "same-origin", redirect: "error", headers: { accept: "application/json" },
    }));
    expect(fetchMock).toHaveBeenNthCalledWith(2, responses.contentUrl, expect.objectContaining({
      method: "GET", credentials: "same-origin", redirect: "error", headers: { accept: "application/json" },
    }));
    expect(collection.source).toMatchObject({
      provider: "managed",
      mode: "contest",
      problemVersionId: PROBLEM_VERSION_ID,
      contestId: CONTEST_ID,
      metadataUrl: responses.metadataUrl,
      contentUrl: responses.contentUrl,
    });
    expect(collection.origin).toBe("managed-content");
    expect(collection.index.problems[0]?.bundle.kind).toBe("managed-content");
    expect(await collection.loadProblem(practiceProblem.id)).toEqual(contestProblem);
    expect(JSON.stringify(await collection.loadProblem(practiceProblem.id))).not.toContain(
      authoredProblem.judgeCases.find((testCase) => testCase.kind !== "sample")?.input,
    );
  });

  it("loads a practice standalone bundle only after its pointer digest and identity match", async () => {
    const responses = await managedResponses({
      metadataPatch: { allowedProfiles: { c: { target: "wasip1", optimization: "release" } } },
    });
    const fetchMock = vi.fn(async (url: string | URL | Request) => (
      String(url) === responses.metadataUrl ? responses.metadataResponse : responses.contentResponse
    )) as unknown as typeof fetch;
    const collection = await loadManagedProblemCollection(responses.context, { fetch: fetchMock });
    expect(collection.source.mode).toBe("official-practice");
    expect(collection.source.allowedProfiles).toEqual({ c: { target: "wasip1", optimization: "release" } });
    expect(collection.source.contentUrl).toBe(`/api/problems/${PROBLEM_VERSION_ID}/content?role=practice`);
    expect(await collection.loadProblem(practiceProblem.id)).toEqual(practiceProblem);
    await expect(collection.loadProblem("wrong-problem")).rejects.toThrow("Unknown managed problem");
  });

  it("compares localized metadata by locale rather than JSON property order", async () => {
    const contentProblem = {
      ...practiceProblem,
      title: { en: practiceProblem.title.en, "zh-TW": practiceProblem.title["zh-TW"] },
      track: { en: practiceProblem.track.en, "zh-TW": practiceProblem.track["zh-TW"] },
    };
    const responses = await managedResponses({
      contentValue: { schema: BROWSER_PROBLEM_SCHEMA, problem: contentProblem },
      metadataPatch: {
        title: { "zh-TW": practiceProblem.title["zh-TW"], en: practiceProblem.title.en },
        track: { "zh-TW": practiceProblem.track["zh-TW"], en: practiceProblem.track.en },
      },
    });
    const fetchMock = vi.fn(async (url: string | URL | Request) => (
      String(url) === responses.metadataUrl ? responses.metadataResponse : responses.contentResponse
    )) as unknown as typeof fetch;

    const collection = await loadManagedProblemCollection(responses.context, { fetch: fetchMock });

    expect(await collection.loadProblem(practiceProblem.id)).toEqual(contentProblem);

    const changedTitle = await managedResponses({
      contentValue: { schema: BROWSER_PROBLEM_SCHEMA, problem: contentProblem },
      metadataPatch: {
        title: { "zh-TW": practiceProblem.title["zh-TW"], en: `${practiceProblem.title.en} changed` },
      },
    });
    await expect(loadManagedProblemCollection(changedTitle.context, {
      fetch: (async (url) => String(url) === changedTitle.metadataUrl
        ? changedTitle.metadataResponse
        : changedTitle.contentResponse) as typeof fetch,
    })).rejects.toMatchObject({ kind: "integrity" } satisfies Partial<ManagedProblemCollectionError>);
  });

  it("rejects wrong identifiers before network access", async () => {
    const fetchMock = vi.fn();
    await expect(loadManagedProblemCollection({ problemVersionId: "not-a-uuid" }, {
      fetch: fetchMock as unknown as typeof fetch,
    })).rejects.toMatchObject({ kind: "configuration" });
    await expect(loadManagedProblemCollection({ problemVersionId: PROBLEM_VERSION_ID, contestId: "not-a-uuid" }, {
      fetch: fetchMock as unknown as typeof fetch,
    })).rejects.toMatchObject({ kind: "configuration" });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(() => normalizeManagedProblemContext({ problemVersionId: PROBLEM_VERSION_ID, repository: "fake/repo" }))
      .toThrow("invalid shape");
  });

  it("fails closed on a mismatched content URL, digest, or hidden case", async () => {
    const wrongUrl = await managedResponses({ contentPatch: { url: "https://attacker.invalid/problem.json" } });
    await expect(loadManagedProblemCollection(wrongUrl.context, {
      fetch: (async () => wrongUrl.metadataResponse) as typeof fetch,
    })).rejects.toMatchObject({ kind: "schema" } satisfies Partial<ManagedProblemCollectionError>);

    const wrongDigest = await managedResponses({ contentPatch: { sha256: "0".repeat(64) } });
    await expect(loadManagedProblemCollection(wrongDigest.context, {
      fetch: (async (url) => String(url) === wrongDigest.metadataUrl ? wrongDigest.metadataResponse : wrongDigest.contentResponse) as typeof fetch,
    })).rejects.toThrow("SHA-256");

    const hidden = await managedResponses({ contentValue: { schema: BROWSER_PROBLEM_SCHEMA, problem: authoredProblem } });
    await expect(loadManagedProblemCollection(hidden.context, {
      fetch: (async (url) => String(url) === hidden.metadataUrl ? hidden.metadataResponse : hidden.contentResponse) as typeof fetch,
    })).rejects.toThrow("hidden judge cases");
  });

  it("fails closed on HTTP, media-type, and declared-byte errors", async () => {
    await expect(loadManagedProblemCollection({ problemVersionId: PROBLEM_VERSION_ID }, {
      fetch: async () => new Response("missing", { status: 404 }),
    })).rejects.toMatchObject({ kind: "unavailable" } satisfies Partial<ManagedProblemCollectionError>);
    await expect(loadManagedProblemCollection({ problemVersionId: PROBLEM_VERSION_ID }, {
      fetch: async () => new Response("{}", { headers: { "content-type": "text/plain" } }),
    })).rejects.toMatchObject({ kind: "schema" } satisfies Partial<ManagedProblemCollectionError>);
    const oversized = await managedResponses({ contentPatch: { bytes: 8 * 1024 * 1024 + 1 } });
    await expect(loadManagedProblemCollection(oversized.context, {
      fetch: (async () => oversized.metadataResponse) as typeof fetch,
    })).rejects.toMatchObject({ kind: "schema" } satisfies Partial<ManagedProblemCollectionError>);
  });
});

describe("managed workspace and Official Submit context", () => {
  it("builds metadata, content, and page routes with an explicit contest context", () => {
    expect(managedProblemMetadataApiPath({ problemVersionId: PROBLEM_VERSION_ID }))
      .toBe(`/api/problems/${PROBLEM_VERSION_ID}`);
    expect(managedProblemMetadataApiPath({ problemVersionId: PROBLEM_VERSION_ID, contestId: CONTEST_ID }))
      .toBe(`/api/problems/${PROBLEM_VERSION_ID}?contestId=${CONTEST_ID}`);
    expect(managedProblemContentApiPath({ problemVersionId: PROBLEM_VERSION_ID }))
      .toBe(`/api/problems/${PROBLEM_VERSION_ID}/content?role=practice`);
    expect(managedProblemContentApiPath({ problemVersionId: PROBLEM_VERSION_ID, contestId: CONTEST_ID }))
      .toBe(`/api/problems/${PROBLEM_VERSION_ID}/content?role=contest-public&contestId=${CONTEST_ID}`);
    expect(managedProblemWorkspacePath({ problemVersionId: PROBLEM_VERSION_ID }))
      .toBe(`/problems/${PROBLEM_VERSION_ID}`);
    expect(managedProblemWorkspacePath({ problemVersionId: PROBLEM_VERSION_ID, contestId: CONTEST_ID }))
      .toBe(`/contests/${CONTEST_ID}/problems/${PROBLEM_VERSION_ID}`);
  });

  it("includes contestId in the exact formal request and omits it for official practice", () => {
    const source = {
      language: "c" as const,
      target: "wasip1" as const,
      optimization: "release" as const,
      entry: "main.c",
      sourceFiles: [{ path: "main.c", encoding: "utf8" as const, content: "int main(void) { return 0; }" }],
      idempotencyKey: "browser:55555555-5555-4555-8555-555555555555",
    };
    expect(createOfficialSubmissionRequest({ problemVersionId: PROBLEM_VERSION_ID, contestId: CONTEST_ID }, source))
      .toEqual({ problemVersionId: PROBLEM_VERSION_ID, contestId: CONTEST_ID, ...source });
    expect(createOfficialSubmissionRequest({ problemVersionId: PROBLEM_VERSION_ID }, source))
      .not.toHaveProperty("contestId");
  });
});
