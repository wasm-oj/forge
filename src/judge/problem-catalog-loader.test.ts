import { describe, expect, it, vi } from "vitest";
import { PROBLEMS } from "./problems";
import {
  BROWSER_COLLECTION_SCHEMA,
  BROWSER_PROBLEM_SCHEMA,
  DEFAULT_PROBLEM_COLLECTION_SOURCE,
  MemoryProblemCollectionCache,
  ProblemCollectionError,
  clearProblemCollectionCache,
  githubRawContentUrl,
  loadProblemCollection,
  normalizeProblemCollectionSource,
  parseProblemBundle,
  parseProblemCollectionIndex,
} from "./problem-catalog-loader";

const encoder = new TextEncoder();

async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes.slice().buffer);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function fixture() {
  const problem = PROBLEMS[0];
  const bundleBytes = encoder.encode(`${JSON.stringify({ schema: BROWSER_PROBLEM_SCHEMA, problem })}\n`);
  const digest = await sha256(bundleBytes);
  const entry = {
    id: problem.id,
    number: problem.number,
    title: problem.title,
    trackId: problem.trackId,
    track: problem.track,
    difficulty: problem.difficulty,
    tags: problem.tags,
    caseCount: problem.judgeCases.length,
    bundle: {
      path: `problems/001-${problem.id}.${digest}.json`,
      sha256: digest,
      bytes: bundleBytes.byteLength,
    },
  };
  const index = {
    schema: BROWSER_COLLECTION_SCHEMA,
    problemSchema: BROWSER_PROBLEM_SCHEMA,
    revision: await sha256(encoder.encode(`1\0${digest}\n`)),
    localization: { defaultLocale: "zh-TW", supportedLocales: ["zh-TW", "en"] },
    problems: [entry],
  };
  return { problem, bundleBytes, entry, index, indexBytes: encoder.encode(`${JSON.stringify(index)}\n`) };
}

describe("remote problem collection", () => {
  it("isolates the v3 verified cache namespace from incompatible collection schemas", async () => {
    const deleteCache = vi.fn(async () => true);
    vi.stubGlobal("caches", { delete: deleteCache });
    try {
      await clearProblemCollectionCache();
      expect(deleteCache).toHaveBeenCalledWith("wasm-oj-verified-problem-collections-v3");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("loads the small index first and verifies a problem bundle on demand", async () => {
    const data = await fixture();
    const requests: string[] = [];
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      requests.push(url);
      return new Response(url.endsWith("index.json") ? data.indexBytes : data.bundleBytes, { status: 200 });
    }) as unknown as typeof fetch;

    const collection = await loadProblemCollection(DEFAULT_PROBLEM_COLLECTION_SOURCE, {
      fetch: fetchMock,
      cache: new MemoryProblemCollectionCache(),
    });
    expect(collection.index.problems).toHaveLength(1);
    expect(requests).toHaveLength(1);
    await expect(collection.loadProblem(data.problem.id)).resolves.toEqual(data.problem);
    expect(requests).toHaveLength(2);
  });

  it("reuses a digest-keyed verified bundle across collection loads", async () => {
    const data = await fixture();
    const cache = new MemoryProblemCollectionCache();
    let bundleRequests = 0;
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      if (String(input).endsWith("index.json")) return new Response(data.indexBytes);
      bundleRequests += 1;
      return new Response(data.bundleBytes);
    }) as unknown as typeof fetch;
    const first = await loadProblemCollection(DEFAULT_PROBLEM_COLLECTION_SOURCE, { fetch: fetchMock, cache });
    await first.loadProblem(data.problem.id);
    const second = await loadProblemCollection(DEFAULT_PROBLEM_COLLECTION_SOURCE, { fetch: fetchMock, cache });
    await second.loadProblem(data.problem.id);
    expect(bundleRequests).toBe(1);
  });

  it("treats persistent cache failures as an optimization failure", async () => {
    const data = await fixture();
    const unavailableCache = {
      async getIndex() { throw new Error("cache unavailable"); },
      async putIndex() { throw new Error("quota"); },
      async getBundle() { throw new Error("cache unavailable"); },
      async putBundle() { throw new Error("quota"); },
      async deleteBundle() { throw new Error("cache unavailable"); },
    };
    const fetchMock = vi.fn(async (input: string | URL | Request) => new Response(
      String(input).endsWith("index.json") ? data.indexBytes : data.bundleBytes,
    )) as unknown as typeof fetch;
    const collection = await loadProblemCollection(DEFAULT_PROBLEM_COLLECTION_SOURCE, {
      fetch: fetchMock,
      cache: unavailableCache,
    });
    await expect(collection.loadProblem(data.problem.id)).resolves.toEqual(data.problem);
  });

  it("uses only a previously validated index when the network is unavailable", async () => {
    const data = await fixture();
    const cache = new MemoryProblemCollectionCache();
    await loadProblemCollection(DEFAULT_PROBLEM_COLLECTION_SOURCE, {
      fetch: vi.fn(async () => new Response(data.indexBytes)) as unknown as typeof fetch,
      cache,
    });
    const offline = await loadProblemCollection(DEFAULT_PROBLEM_COLLECTION_SOURCE, {
      fetch: vi.fn(async () => { throw new TypeError("offline"); }) as unknown as typeof fetch,
      cache,
    });
    expect(offline.origin).toBe("verified-cache");
  });

  it("normalizes an interrupted index stream and uses the exact verified cache", async () => {
    const data = await fixture();
    const cache = new MemoryProblemCollectionCache();
    await loadProblemCollection(DEFAULT_PROBLEM_COLLECTION_SOURCE, {
      fetch: vi.fn(async () => new Response(data.indexBytes)) as unknown as typeof fetch,
      cache,
    });
    const interrupted = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(data.indexBytes.slice(0, 10));
        controller.error(new TypeError("stream disconnected"));
      },
    });
    const offline = await loadProblemCollection(DEFAULT_PROBLEM_COLLECTION_SOURCE, {
      fetch: vi.fn(async () => new Response(interrupted)) as unknown as typeof fetch,
      cache,
    });
    expect(offline.origin).toBe("verified-cache");
  });

  it("recomputes and rejects a forged collection revision", async () => {
    const data = await fixture();
    const forged = encoder.encode(`${JSON.stringify({ ...data.index, revision: "b".repeat(64) })}\n`);
    await expect(loadProblemCollection(DEFAULT_PROBLEM_COLLECTION_SOURCE, {
      fetch: vi.fn(async () => new Response(forged)) as unknown as typeof fetch,
      cache: new MemoryProblemCollectionCache(),
    })).rejects.toMatchObject({ kind: "integrity" });
  });

  it("fails closed when bundle bytes do not match the declared digest", async () => {
    const data = await fixture();
    const tampered = data.bundleBytes.slice();
    tampered[tampered.length - 2] ^= 1;
    const fetchMock = vi.fn(async (input: string | URL | Request) => new Response(
      String(input).endsWith("index.json") ? data.indexBytes : tampered,
    )) as unknown as typeof fetch;
    const collection = await loadProblemCollection(DEFAULT_PROBLEM_COLLECTION_SOURCE, {
      fetch: fetchMock,
      cache: new MemoryProblemCollectionCache(),
    });
    await expect(collection.loadProblem(data.problem.id)).rejects.toMatchObject({
      kind: "integrity",
    });
  });

  it("does not mask an explicit HTTP or schema failure with cached data", async () => {
    const data = await fixture();
    const cache = new MemoryProblemCollectionCache();
    await loadProblemCollection(DEFAULT_PROBLEM_COLLECTION_SOURCE, {
      fetch: vi.fn(async () => new Response(data.indexBytes)) as unknown as typeof fetch,
      cache,
    });
    await expect(loadProblemCollection(DEFAULT_PROBLEM_COLLECTION_SOURCE, {
      fetch: vi.fn(async () => new Response("missing", { status: 404 })) as unknown as typeof fetch,
      cache,
    })).rejects.toMatchObject({ kind: "configuration" });
  });

  it("rejects traversal, unsupported providers, and malformed index ordering", async () => {
    expect(() => normalizeProblemCollectionSource({
      ...DEFAULT_PROBLEM_COLLECTION_SOURCE,
      indexPath: "../catalog.json",
    })).toThrow(ProblemCollectionError);
    expect(() => normalizeProblemCollectionSource({
      ...DEFAULT_PROBLEM_COLLECTION_SOURCE,
      provider: "url",
    })).toThrow("Only GitHub");
    const data = await fixture();
    expect(() => parseProblemCollectionIndex({
      ...data.index,
      problems: [{ ...data.entry, number: 2 }],
    })).toThrow("invalid identity");
  });

  it("rejects a validly shaped bundle whose identity disagrees with the index", async () => {
    const data = await fixture();
    expect(() => parseProblemBundle({
      schema: BROWSER_PROBLEM_SCHEMA,
      problem: { ...data.problem, id: "different-problem" },
    }, data.entry)).toThrow("disagrees");
  });

  it("rejects policy resource values outside the runtime contract", async () => {
    const data = await fixture();
    const withPolicyLimits = (overrides: Record<string, number>) => ({
      ...data.problem,
      scoring: {
        ...data.problem.scoring,
        policies: data.problem.scoring.policies.map((policy) => ({
          ...policy,
          limits: { ...policy.limits, ...overrides },
        })),
      },
    });

    for (const invalidProblem of [
      withPolicyLimits({ memoryLimitBytes: 1 }),
      withPolicyLimits({ memoryLimitBytes: 5 * 1024 ** 3 }),
      withPolicyLimits({ memoryLimitBytes: 65_537 }),
      withPolicyLimits({ logicalTimeLimitMs: 9_007_199_255 }),
      withPolicyLimits({ instructionBudget: Number.MAX_SAFE_INTEGER + 1 }),
    ]) {
      expect(() => parseProblemBundle({
        schema: BROWSER_PROBLEM_SCHEMA,
        problem: invalidProblem,
      }, data.entry)).toThrow("invalid resource values");
    }
  });

  it("accepts the core wall-time minimum and rejects values above its maximum", async () => {
    const data = await fixture();
    expect(parseProblemBundle({
      schema: BROWSER_PROBLEM_SCHEMA,
      problem: {
        ...data.problem,
        scoring: {
          ...data.problem.scoring,
          safetyLimits: { wallTimeLimitMs: 1 },
        },
      },
    }, data.entry).scoring.safetyLimits.wallTimeLimitMs).toBe(1);
    expect(() => parseProblemBundle({
      schema: BROWSER_PROBLEM_SCHEMA,
      problem: {
        ...data.problem,
        scoring: {
          ...data.problem.scoring,
          safetyLimits: { wallTimeLimitMs: Number.MAX_SAFE_INTEGER },
        },
      },
    }, data.entry)).toThrow("invalid safety limits");
  });

  it("constructs raw GitHub URLs without accepting absolute paths", () => {
    expect(githubRawContentUrl(DEFAULT_PROBLEM_COLLECTION_SOURCE, "collection/index.json")).toBe(
      "https://raw.githubusercontent.com/wasm-oj/problems/main/collection/index.json",
    );
    expect(() => githubRawContentUrl(DEFAULT_PROBLEM_COLLECTION_SOURCE, "https://evil.invalid/x"))
      .toThrow("normalized relative path");
  });
});
