import assert from "node:assert/strict";
import test from "node:test";
import { caseProgressDecision } from "./progress.mjs";

function emittedCases(total) {
  const emitted = [];
  let lastBucket = -1;
  for (let completed = 1; completed <= total; completed += 1) {
    const decision = caseProgressDecision(completed, total, lastBucket);
    if (!decision.emit) continue;
    lastBucket = decision.bucket;
    emitted.push({ completed, bucket: decision.bucket });
  }
  return emitted;
}

test("ten thousand cases emit at most one hundred case updates", () => {
  const emitted = emittedCases(10_000);
  assert.equal(emitted.length, 100);
  assert.deepEqual(emitted[0], { completed: 1, bucket: 1 });
  assert.deepEqual(emitted.at(-1), { completed: 10_000, bucket: 100 });
  assert.equal(1 + emitted.length, 101, "compile plus case progress must remain within the per-attempt cap");
});

test("small runs retain exact first and final progress", () => {
  assert.deepEqual(emittedCases(1), [{ completed: 1, bucket: 100 }]);
  assert.deepEqual(emittedCases(3).map(({ completed }) => completed), [1, 2, 3]);
  assert.throws(() => caseProgressDecision(0, 1, -1), /invalid/);
});
