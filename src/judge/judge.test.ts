import { describe, expect, it } from "vitest";
import { decodeSolvedProgress } from "./judge";

describe("browser-local judge", () => {
  it("accepts only known problem ids from local progress", () => {
    expect([...decodeSolvedProgress('["sum-pair","unknown"]', new Set(["sum-pair"]))]).toEqual(["sum-pair"]);
    expect(() => decodeSolvedProgress('{"sum-pair":true}', new Set(["sum-pair"]))).toThrow("Stored judge progress is invalid.");
  });
});
