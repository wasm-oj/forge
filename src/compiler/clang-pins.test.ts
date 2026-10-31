import { describe, expect, it } from "vitest";
import { instantiateClangLink } from "./clang-pins";

const placeholders = { input: "I", output: "O", mainFileName: "M", objects: "S" };

describe("Clang stack size", () => {
  it("preserves the toolchain default when no size is requested", () => {
    expect(instantiateClangLink(["O", "S", "-lc"], placeholders, ["main.o"], "app.wasm"))
      .toEqual(["app.wasm", "main.o", "-lc"]);
  });

  it.each([1024 * 1024, 8 * 1024 * 1024])("links the requested %i-byte stack before static data", (size) => {
    expect(instantiateClangLink(["O", "S", "-lc"], placeholders, ["main.o"], "app.wasm", size))
      .toEqual(["app.wasm", "main.o", "-lc", "--stack-first", "-z", `stack-size=${size}`]);
  });
});
