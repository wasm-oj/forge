import { describe, expect, it } from "vitest";
import { LANGUAGES } from "../core/types";
import {
  buildControlTimeoutMs,
  CLANG_BUILD_CONTROL_TIMEOUT_MS,
  DEFAULT_BUILD_CONTROL_TIMEOUT_MS,
  GO_BUILD_CONTROL_TIMEOUT_MS,
  RUST_BUILD_CONTROL_TIMEOUT_MS,
} from "./build-timeout-policy";

describe("compiler build control deadlines", () => {
  it("keeps browser and server fast-path languages on the bounded deadline", () => {
    for (const language of LANGUAGES) {
      const expected = language === "rust"
        ? RUST_BUILD_CONTROL_TIMEOUT_MS
        : language === "go"
          ? GO_BUILD_CONTROL_TIMEOUT_MS
          : language === "c" || language === "cpp"
            ? CLANG_BUILD_CONTROL_TIMEOUT_MS
            : DEFAULT_BUILD_CONTROL_TIMEOUT_MS;
      expect(buildControlTimeoutMs(language)).toBe(expected);
    }
  });

  it("rejects extension languages at the built-in compiler boundary", () => {
    expect(() => buildControlTimeoutMs("zig")).toThrow("does not support language 'zig'");
  });
});
