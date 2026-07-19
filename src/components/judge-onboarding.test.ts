import { describe, expect, it } from "vitest";
import {
  completeJudgeOnboarding,
  isJudgeOnboardingComplete,
  JUDGE_ONBOARDING_STORAGE_KEY,
} from "./judge-onboarding-storage";

describe("judge onboarding persistence", () => {
  it("opens for a browser that has not completed this tutorial version", () => {
    const storage = { getItem: () => null };
    expect(isJudgeOnboardingComplete(storage)).toBe(false);
  });

  it("recognizes only the explicit completed marker", () => {
    expect(isJudgeOnboardingComplete({ getItem: () => "dismissed" })).toBe(false);
    expect(isJudgeOnboardingComplete({ getItem: () => "completed" })).toBe(true);
  });

  it("writes the versioned completion marker", () => {
    const writes: Array<[string, string]> = [];
    completeJudgeOnboarding({ setItem: (key, value) => { writes.push([key, value]); } });
    expect(writes).toEqual([[JUDGE_ONBOARDING_STORAGE_KEY, "completed"]]);
  });
});
