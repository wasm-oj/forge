import assert from "node:assert/strict";
import test from "node:test";
import { renderProductionConfig } from "./render-production-config.mjs";

test("renders one exact Git build ID into Worker and prebuilt Container inputs", () => {
  const buildId = "a".repeat(40);
  const rendered = renderProductionConfig(
    '{"vars":{"WASM_OJ_BUILD_ID":"__WASM_OJ_BUILD_ID__"},"containers":[{"image":"registry.cloudflare.com/b1c3d1b89f9131a84a0f1f6a973232f1/wasm-oj-submission-production:__WASM_OJ_BUILD_ID__"}]}\n',
    buildId,
  );
  assert.equal(rendered.split(buildId).length - 1, 2);
  assert.doesNotMatch(rendered, /__WASM_OJ_BUILD_ID__/u);
});

test("rejects ambiguous placeholders and non-commit build IDs", () => {
  assert.throws(() => renderProductionConfig("__WASM_OJ_BUILD_ID__", "a".repeat(40)));
  assert.throws(() => renderProductionConfig("__WASM_OJ_BUILD_ID____WASM_OJ_BUILD_ID__", "main"));
  assert.throws(
    () => renderProductionConfig('{"first":"__WASM_OJ_BUILD_ID__","second":"__WASM_OJ_BUILD_ID__"}', "a".repeat(40)),
    /must bind the Worker and exact Cloudflare Container image/u,
  );
});
