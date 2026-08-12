import { describe, expect, it } from "vitest";
import { sampleOutputMatches } from "./sample-output";

describe("public sample output comparison", () => {
  it("uses line-normalized output and still requires a successful process", () => {
    expect(sampleOutputMatches({ termination: "exited", code: 0, stdout: "42  \n" }, "42\n")).toBe(true);
    expect(sampleOutputMatches({ termination: "exited", code: 0, stdout: "41\n" }, "42\n")).toBe(false);
    expect(sampleOutputMatches({ termination: "trap", code: 1, stdout: "42\n" }, "42\n")).toBe(false);
  });
});
