import { describe, expect, it } from "vitest";
import { submissionCostPresentation } from "./submission-cost";

describe("submission cost presentation", () => {
  it("formats an available deterministic cost", () => {
    expect(submissionCostPresentation({ state: "completed", deterministicCost: 134_268 }, "zh-TW")).toEqual({
      label: "指令成本",
      value: "134,268",
    });
  });

  it("marks a legitimately missing terminal measurement as unavailable", () => {
    expect(submissionCostPresentation({ state: "compile-error", deterministicCost: null }, "en")).toEqual({
      label: "Deterministic cost",
      value: "Unavailable",
    });
  });

  it("distinguishes an unfinished submission from a missing terminal measurement", () => {
    expect(submissionCostPresentation({ state: "running", deterministicCost: null }, "zh-TW")).toEqual({
      label: "指令成本",
      value: "待定",
    });
  });
});
