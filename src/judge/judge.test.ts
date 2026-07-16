import { describe, expect, it } from "vitest";
import { decodeSolvedProgress, evaluateRun, normalizeJudgeOutput, submissionVerdict } from "./judge";

describe("browser-local judge", () => {
  it("normalizes line endings and trailing whitespace without hiding leading differences", () => {
    expect(normalizeJudgeOutput("answer  \r\n\r\n")).toBe("answer");
    expect(normalizeJudgeOutput(" answer\n")).toBe(" answer");
  });

  it("classifies accepted, wrong, and runtime-error executions", () => {
    const accepted = evaluateRun(1, "42\n", { code: 0, stdout: "42  \r\n", stderr: "", durationMs: 3 });
    const wrong = evaluateRun(2, "42\n", { code: 0, stdout: "41\n", stderr: "", durationMs: 4 });
    const runtime = evaluateRun(3, "42\n", { code: 1, stdout: "42\n", stderr: "trap", durationMs: 5 });
    expect(accepted.verdict).toBe("accepted");
    expect(wrong.verdict).toBe("wrong-answer");
    expect(runtime.verdict).toBe("runtime-error");
    expect(submissionVerdict([accepted, wrong])).toBe("wrong-answer");
  });

  it("accepts only known problem ids from local progress", () => {
    expect([...decodeSolvedProgress('["sum-pair","unknown"]', new Set(["sum-pair"]))]).toEqual(["sum-pair"]);
    expect(() => decodeSolvedProgress('{"sum-pair":true}', new Set(["sum-pair"]))).toThrow("Stored judge progress is invalid.");
  });
});
