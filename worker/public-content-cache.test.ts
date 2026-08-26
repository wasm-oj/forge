import { beforeEach, describe, expect, it, vi } from "vitest";

const github = vi.hoisted(() => ({
  repository: vi.fn(async () => ({ githubRepositoryId: 42 })),
  read: vi.fn<() => Promise<Uint8Array>>(),
}));

vi.mock("./catalog-github", async (importOriginal) => ({
  ...await importOriginal<typeof import("./catalog-github")>(),
  catalogRepositoryById: github.repository,
  readExactCommitContents: github.read,
}));

import { sha256Hex } from "./crypto";
import type { WasmOjWorkerEnv } from "./env";
import { publicProblemContent } from "./catalog";

const PROBLEM_ID = "11111111-1111-4111-8111-111111111111";
const COMMIT = "a".repeat(40);
const bytes = new TextEncoder().encode('{"schema":"test"}\n');

function object(contents: Uint8Array, digest: string) {
  return {
    size: contents.byteLength,
    checksums: { toJSON: () => ({ sha256: digest }) },
    arrayBuffer: async () => contents.slice().buffer,
  };
}

async function fixture(options: { cached?: ReturnType<typeof object> | null } = {}) {
  const digest = await sha256Hex(bytes);
  const get = vi.fn(async () => options.cached ?? null);
  const put = vi.fn(async () => object(bytes, digest));
  const head = vi.fn(async () => object(bytes, digest));
  const env = {
    DB: {
      prepare: vi.fn(() => ({ bind: () => ({ first: async () => ({
        github_repository_id: 42,
        commit_sha: COMMIT,
        path: "collection/problems/001-test.practice.json",
        bytes: bytes.byteLength,
        sha256: digest,
      }) }) })),
    },
    JUDGE_BUCKET: { get, put, head },
  } as unknown as WasmOjWorkerEnv;
  const request = new Request(`https://wasm-oj.test/api/problems/${PROBLEM_ID}/content?role=practice&commit=${COMMIT}`);
  return { digest, env, get, head, put, request };
}

beforeEach(() => {
  github.repository.mockClear();
  github.read.mockReset();
});

describe("exact-commit public content cache", () => {
  it("serves a verified content-addressed hit without contacting GitHub", async () => {
    const digest = await sha256Hex(bytes);
    const value = await fixture({ cached: object(bytes, digest) });
    const response = await publicProblemContent(value.request, value.env, PROBLEM_ID);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
    expect(value.get).toHaveBeenCalledWith(`public-content/v1/${digest}`);
    expect(github.repository).not.toHaveBeenCalled();
    expect(value.put).not.toHaveBeenCalled();
  });

  it("fills a miss only from the descriptor path at the exact commit", async () => {
    const value = await fixture();
    github.read.mockResolvedValueOnce(bytes.slice());
    await expect(publicProblemContent(value.request, value.env, PROBLEM_ID)).resolves.toBeInstanceOf(Response);
    expect(github.read).toHaveBeenCalledWith(
      expect.anything(),
      COMMIT,
      "collection/problems/001-test.practice.json",
      bytes.byteLength,
      8 * 1024 * 1024,
    );
    expect(value.put).toHaveBeenCalledWith(`public-content/v1/${value.digest}`, bytes, expect.objectContaining({
      onlyIf: { etagDoesNotMatch: "*" },
    }));
  });

  it("fails closed on cold-cache GitHub failure or digest mismatch", async () => {
    const unavailable = await fixture();
    github.read.mockRejectedValueOnce(new Error("upstream unavailable"));
    await expect(publicProblemContent(unavailable.request, unavailable.env, PROBLEM_ID))
      .rejects.toMatchObject({ status: 503, code: "github-content-unavailable" });
    expect(unavailable.put).not.toHaveBeenCalled();

    const corrupt = await fixture();
    github.read.mockResolvedValueOnce(new TextEncoder().encode('{"schema":"wrong"}\n'));
    await expect(publicProblemContent(corrupt.request, corrupt.env, PROBLEM_ID))
      .rejects.toMatchObject({ status: 503, code: "github-content-invalid" });
    expect(corrupt.put).not.toHaveBeenCalled();
  });

  it("rejects a corrupt cache object instead of bypassing it", async () => {
    const value = await fixture({ cached: object(bytes, "b".repeat(64)) });
    await expect(publicProblemContent(value.request, value.env, PROBLEM_ID))
      .rejects.toMatchObject({ status: 503, code: "content-cache-invalid" });
    expect(github.repository).not.toHaveBeenCalled();
  });
});
