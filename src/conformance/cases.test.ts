import { describe, expect, it } from "vitest";
import {
  CPP_STDLIB_CONFORMANCE_CASE,
  DEFAULT_CONFORMANCE_CASES,
  FULL_CONFORMANCE_CASES,
} from "./cases";

describe("canonical conformance cases", () => {
  it("deeply freezes the exported evidence panel", () => {
    expect(Object.isFrozen(DEFAULT_CONFORMANCE_CASES)).toBe(true);
    expect(Object.isFrozen(FULL_CONFORMANCE_CASES)).toBe(true);
    expect(Object.isFrozen(CPP_STDLIB_CONFORMANCE_CASE)).toBe(true);
    expect(Object.isFrozen(DEFAULT_CONFORMANCE_CASES[0]?.input.files)).toBe(true);
    expect(Object.isFrozen(DEFAULT_CONFORMANCE_CASES[0]?.expect)).toBe(true);

    expect(() => {
      (DEFAULT_CONFORMANCE_CASES[0]!.input.files as Record<string, string>)["attacker.c"] = "";
    }).toThrow(TypeError);
  });
});
