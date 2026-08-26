import { afterEach, describe, expect, it, vi } from "vitest";
import { exactCommitTree, resolveExactCommit, type AuthorizedCatalogRepository } from "./catalog-github";

const COMMIT_SHA = "1".repeat(40);
const TREE_SHA = "2".repeat(40);
const BLOB_SHA = "3".repeat(40);

const repository: AuthorizedCatalogRepository = {
  githubRepositoryId: 42,
  installationId: 7,
  owner: "wasm-oj",
  repository: "problems",
  isPrivate: true,
  token: "github-installation-token",
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("exactCommitTree", () => {
  it("resolves a requested ref through exactly one commit lookup", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ sha: COMMIT_SHA }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(resolveExactCommit(repository, "main")).resolves.toBe(COMMIT_SHA);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe("https://api.github.com/repos/wasm-oj/problems/commits/main");
  });

  it("resolves the commit object to its exact tree before listing blobs", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ tree: { sha: TREE_SHA } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        truncated: false,
        tree: [{ path: "collection/index.json", mode: "100644", type: "blob", sha: BLOB_SHA, size: 123 }],
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }));
    vi.stubGlobal("fetch", fetchMock);

    const tree = await exactCommitTree(repository, COMMIT_SHA);

    expect([...tree.values()]).toEqual([{
      path: "collection/index.json",
      gitSha: BLOB_SHA,
      bytes: 123,
    }]);
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      `https://api.github.com/repos/wasm-oj/problems/git/commits/${COMMIT_SHA}`,
      `https://api.github.com/repos/wasm-oj/problems/git/trees/${TREE_SHA}?recursive=1`,
    ]);
  });

  it("fails closed when GitHub does not return an exact tree identity", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ tree: {} }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })));

    await expect(exactCommitTree(repository, COMMIT_SHA)).rejects.toMatchObject({
      status: 502,
      code: "github-commit-invalid",
    });
  });
});
