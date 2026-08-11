import assert from "node:assert/strict";
import test from "node:test";
import { runProductionR2Cleanup } from "./cleanup-production-r2.mjs";

const accountId = "b1c3d1b89f9131a84a0f1f6a973232f1";

function fakeR2(initial) {
  const buckets = new Map(Object.entries(initial).map(([bucket, keys]) => [bucket, new Set(keys)]));
  const request = async (rawPath, init = {}) => {
    const url = new URL(`https://api.cloudflare.test${rawPath}`);
    const match = url.pathname.match(/^\/accounts\/[^/]+\/r2\/buckets\/([^/]+)(?:\/objects(?:\/(.*))?)?$/);
    assert.ok(match, `unexpected path ${url.pathname}`);
    const bucket = decodeURIComponent(match[1]);
    const keys = buckets.get(bucket);
    if (!keys) return null;
    if (match[2] === undefined && init.method === "DELETE") {
      assert.equal(keys.size, 0);
      buckets.delete(bucket);
      return { success: true, result: null };
    }
    if (match[2] === undefined && init.method === "GET") {
      const prefix = url.searchParams.get("prefix") ?? "";
      return {
        success: true,
        result: [...keys].filter((key) => key.startsWith(prefix)).slice(0, 2).map((key) => ({ key })),
      };
    }
    if (match[2] !== undefined && init.method === "DELETE") {
      keys.delete(match[2].split("/").map(decodeURIComponent).join("/"));
      return { success: true, result: null };
    }
    throw new Error(`unexpected request ${init.method} ${url.pathname}`);
  };
  return { buckets, request };
}

test("submission reset deletes only source and audit prefixes", async () => {
  const fake = fakeR2({
    "wasm-oj-judge-production": ["sources/a", "sources/b", "audits/a", "snapshots/objects/keep"],
  });
  await runProductionR2Cleanup("reset-submissions", { accountId, request: fake.request, log: () => {} });
  assert.deepEqual([...fake.buckets.get("wasm-oj-judge-production")], ["snapshots/objects/keep"]);
});

test("mirror cleanup empties and deletes only the retired bucket", async () => {
  const fake = fakeR2({
    "wasm-oj-judge-mirror-production": ["a", "nested/b", "nested/c"],
  });
  await runProductionR2Cleanup("delete-mirror", { accountId, request: fake.request, log: () => {} });
  assert.equal(fake.buckets.has("wasm-oj-judge-mirror-production"), false);
});

test("cleanup rejects operations outside the explicit cutover", async () => {
  await assert.rejects(
    runProductionR2Cleanup("delete-primary", { accountId, request: async () => null, log: () => {} }),
    /Unknown production R2 cleanup operation/,
  );
});
