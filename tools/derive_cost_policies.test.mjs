import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  COMPILED_LANGUAGES,
  METHOD,
  POLICY_IDS,
  assertManifestPolicies,
  assertMeasuredCase,
  derivePolicyInstructionBudgets,
} from "./derive_cost_policies.mjs";

const ALL_LANGUAGES = [
  "c",
  "cpp",
  "rust",
  "go",
  "python",
  "javascript",
  "typescript",
];

function candidates(costs) {
  return ALL_LANGUAGES.map((language) => ({
    language,
    maximumCost: costs[language],
    maximumCaseIds: [`${language}-worst`],
  }));
}

describe("compiled-language policy derivation", () => {
  it("uses the four compiled-language average plus 5% for optimal", () => {
    const derived = derivePolicyInstructionBudgets(candidates({
      c: 100,
      cpp: 200,
      rust: 300,
      go: 400,
      python: 1_000,
      javascript: 2_000,
      typescript: 3_000,
    }));

    assert.equal(METHOD, "forge-v1-compiled-average-optimal-rounded-v1");
    assert.deepEqual(COMPILED_LANGUAGES, ["c", "cpp", "rust", "go"]);
    assert.deepEqual(POLICY_IDS, ["baseline", "efficient", "optimal"]);
    assert.equal(
      derived.policyDerivations.optimal.measuredWorstCaseCostNumerator,
      "1000",
    );
    assert.equal(
      derived.policyDerivations.optimal.measuredWorstCaseCostDenominator,
      4,
    );
    assert.equal(derived.policyDerivations.optimal.unroundedInstructionBudget, 263);
    assert.equal(derived.instructionBudgets.optimal, 300);
  });

  it("keeps cumulative tiers relaxed-to-strict", () => {
    const derived = derivePolicyInstructionBudgets(candidates({
      c: 100,
      cpp: 200,
      rust: 300,
      go: 400,
      python: 1_000,
      javascript: 2_000,
      typescript: 3_000,
    }));

    assert.equal(derived.instructionBudgets.baseline, 3_500);
    assert.equal(derived.instructionBudgets.efficient, 450);
    assert.equal(derived.instructionBudgets.optimal, 300);
    assert.ok(
      derived.instructionBudgets.baseline
      >= derived.instructionBudgets.efficient,
    );
    assert.ok(
      derived.instructionBudgets.efficient
      >= derived.instructionBudgets.optimal,
    );
  });

  it("fails closed when a required language is missing", () => {
    const incomplete = candidates({
      c: 100,
      cpp: 200,
      rust: 300,
      go: 400,
      python: 1_000,
      javascript: 2_000,
      typescript: 3_000,
    }).filter((candidate) => candidate.language !== "go");

    assert.throws(
      () => derivePolicyInstructionBudgets(incomplete),
      /missing go/,
    );
  });

  it("rounds safe integers exactly without Number addition", () => {
    const derived = derivePolicyInstructionBudgets(candidates({
      c: 8_571_428_571_428_571,
      cpp: 0,
      rust: 0,
      go: 0,
      python: 0,
      javascript: 0,
      typescript: 0,
    }));

    assert.equal(
      derived.policyDerivations.baseline.unroundedInstructionBudget,
      9_000_000_000_000_000,
    );
    assert.equal(
      derived.instructionBudgets.baseline,
      9_000_000_000_000_000,
    );
  });

  it("keeps a large compiled-language sum exact until after division", () => {
    const derived = derivePolicyInstructionBudgets(candidates({
      c: 3_000_000_000_000_000,
      cpp: 3_000_000_000_000_000,
      rust: 3_000_000_000_000_000,
      go: 3_000_000_000_000_000,
      python: 0,
      javascript: 0,
      typescript: 0,
    }));

    assert.equal(
      derived.policyDerivations.optimal.measuredWorstCaseCostNumerator,
      "12000000000000000",
    );
    assert.equal(
      derived.policyDerivations.optimal.unroundedInstructionBudget,
      3_150_000_000_000_000,
    );
    assert.equal(
      derived.instructionBudgets.optimal,
      3_500_000_000_000_000,
    );
  });

  it("retains every maximum-cost witness on ties", () => {
    const derived = derivePolicyInstructionBudgets(candidates({
      c: 100,
      cpp: 400,
      rust: 300,
      go: 400,
      python: 1_000,
      javascript: 3_000,
      typescript: 3_000,
    }));

    assert.deepEqual(
      derived.policyDerivations.efficient.witnesses.map(({ language }) => language),
      ["cpp", "go"],
    );
    assert.deepEqual(
      derived.policyDerivations.baseline.witnesses.map(({ language }) => language),
      ["javascript", "typescript"],
    );
  });

  it("requires the exact cumulative policy set and order", () => {
    const manifest = {
      scoring: {
        policies: POLICY_IDS.map((id) => ({ id })),
      },
    };
    assert.equal(assertManifestPolicies(manifest, 1).length, 3);
    assert.throws(
      () => assertManifestPolicies({
        scoring: { policies: [{ id: "baseline" }, { id: "optimal" }] },
      }, 1),
      /must be exactly/,
    );
    assert.throws(
      () => assertManifestPolicies({
        scoring: { policies: [{ id: "baseline" }, { id: "optimal" }, { id: "efficient" }] },
      }, 1),
      /must be exactly/,
    );
  });

  it("rejects negative raw and baseline evidence metrics", () => {
    const valid = {
      id: "case-01",
      inputSha256: "input",
      outputSha256: "output",
      cost: 10,
      rawCost: 20,
      baselineCost: 10,
      costModel: "weighted",
      costProfile: "profile",
    };
    assert.doesNotThrow(() => assertMeasuredCase(valid, "1:c", "profile"));
    assert.throws(
      () => assertMeasuredCase({ ...valid, cost: 1, rawCost: -1, baselineCost: -2 }, "1:c", "profile"),
      /invalid measured case/,
    );
    assert.throws(
      () => assertMeasuredCase({ ...valid, cost: 0, rawCost: 0, baselineCost: -1 }, "1:c", "profile"),
      /invalid measured case/,
    );
  });
});
