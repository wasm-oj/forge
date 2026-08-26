import assert from "node:assert/strict";
import test from "node:test";
import { renderProductionSources } from "./render-production-config.mjs";

test("renders one exact Git build ID into Worker and Container inputs", () => {
  const buildId = "a".repeat(40);
  const rendered = renderProductionSources(
    '{"vars":{"WASM_OJ_BUILD_ID":"__WASM_OJ_BUILD_ID__"}}\n',
    "FROM scratch\nARG WASM_OJ_BUILD_ID=0000000000000000000000000000000000000000\n",
    buildId,
  );
  assert.match(rendered.config, new RegExp(buildId));
  assert.match(rendered.dockerfile, new RegExp(`ARG WASM_OJ_BUILD_ID=${buildId}`));
  assert.doesNotMatch(`${rendered.config}\n${rendered.dockerfile}`, /__WASM_OJ_BUILD_ID__/u);
});

test("rejects ambiguous placeholders and non-commit build IDs", () => {
  assert.throws(() => renderProductionSources("__WASM_OJ_BUILD_ID____WASM_OJ_BUILD_ID__", "ARG WASM_OJ_BUILD_ID=x\n", "a".repeat(40)));
  assert.throws(() => renderProductionSources("__WASM_OJ_BUILD_ID__", "ARG WASM_OJ_BUILD_ID=x\n", "main"));
});
