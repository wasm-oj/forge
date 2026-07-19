import { describe, expect, it } from "vitest";
import { decodeSolvedProgress, judgeProblemProgressId, judgeProgressKey } from "./judge";

describe("browser-local judge", () => {
  it("accepts only known problem ids from local progress", () => {
    expect([
      ...decodeSolvedProgress(
        '["weighted-opcode-scale","unknown"]',
        new Set(["weighted-opcode-scale"]),
      ),
    ]).toEqual(["weighted-opcode-scale"]);
    expect(() => decodeSolvedProgress(
      '{"weighted-opcode-scale":true}',
      new Set(["weighted-opcode-scale"]),
    )).toThrow("Stored judge progress is invalid.");
  });

  it("namespaces solved progress by collection source", () => {
    expect(judgeProgressKey("github:wasm-oj/problems@main:collection/index.json"))
      .not.toBe(judgeProgressKey("github:other/problems@main:collection/index.json"));
  });

  it("isolates progress only when a problem bundle changes", () => {
    expect(judgeProblemProgressId("same-problem", "a".repeat(64)))
      .not.toBe(judgeProblemProgressId("same-problem", "b".repeat(64)));
  });
});
