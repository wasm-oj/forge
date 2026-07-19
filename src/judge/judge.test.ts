import { describe, expect, it } from "vitest";
import { decodeSolvedProgress } from "./judge";

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
});
