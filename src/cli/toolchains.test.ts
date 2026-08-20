import { describe, expect, it } from "vitest";
import { descriptor as clang } from "@wasm-oj/toolchain-clang";
import { descriptor as go } from "@wasm-oj/toolchain-go";
import { descriptor as java } from "@wasm-oj/toolchain-java";
import { descriptor as javascript } from "@wasm-oj/toolchain-javascript";
import { descriptor as python } from "@wasm-oj/toolchain-python";
import { descriptor as rust } from "@wasm-oj/toolchain-rust";
import { CLI_TOOLCHAIN_DESCRIPTORS } from "./toolchains";

describe("woj lightweight toolchain catalog", () => {
  it("exactly matches every public package descriptor without importing package assets in production", () => {
    expect(CLI_TOOLCHAIN_DESCRIPTORS).toEqual([clang, go, java, javascript, python, rust]);
  });
});
