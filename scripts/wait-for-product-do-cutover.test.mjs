import assert from "node:assert/strict";
import test from "node:test";
import { parseD1Rows, waitForProductDoCutover } from "./wait-for-product-do-cutover.mjs";

test("cutover requires two consecutive empty authoritative observations", async () => {
  const observations = [2, 0, 1, 0, 0];
  let calls = 0;
  await waitForProductDoCutover({
    fetchRows: async () => [{ kind: "submission", active: observations[calls++] }],
    sleep: async () => {},
    intervalMilliseconds: 0,
    maximumAttempts: observations.length,
  });
  assert.equal(calls, 5);
});

test("D1 response parsing rejects ambiguous counts", () => {
  assert.deepEqual(parseD1Rows({ success: true, result: [{ results: [{ kind: "submission", active: 0 }] }] }), [
    { kind: "submission", active: 0 },
  ]);
  assert.throws(() => parseD1Rows({ success: true, result: [{ results: [{ kind: "submission", active: "0" }] }] }));
});
