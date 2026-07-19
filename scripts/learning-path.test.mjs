import assert from "node:assert/strict";
import test from "node:test";
import { applyLearningPath } from "./learning-path.mjs";

const problem = (id) => ({ id, number: 99 });
const title = { "zh-TW": "入門", en: "Foundations" };
const path = (problems) => ({
  schema: "wasm-oj-learning-path-v1",
  localization: { defaultLocale: "zh-TW", supportedLocales: ["zh-TW", "en"] },
  tracks: [{ id: "foundations", title, problems }],
});

test("assigns contiguous display numbers while preserving problem identities", () => {
  assert.deepEqual(applyLearningPath(path(["second", "first"]), [problem("first"), problem("second")]), [
    { id: "second", number: 1, trackId: "foundations", track: title },
    { id: "first", number: 2, trackId: "foundations", track: title },
  ]);
});

test("rejects duplicate, unknown, and omitted problems", () => {
  assert.throws(() => applyLearningPath(path(["first", "first"]), [problem("first")]), /repeats problem/);
  assert.throws(() => applyLearningPath(path(["missing"]), [problem("first")]), /unknown problem/);
  assert.throws(() => applyLearningPath(path(["first"]), [problem("first"), problem("second")]), /omits problems/);
});
