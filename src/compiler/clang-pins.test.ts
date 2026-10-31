import { describe, expect, it } from "vitest";
import { instantiateClangLink } from "./clang-pins";
import { toolchainCacheIdentity } from "../core/toolchains";

describe("Clang stack policy", () => {
  it("reserves an 8 MiB stack before static data", () => {
    expect(instantiateClangLink(["O", "S", "-lc"], {
      input: "I", output: "O", mainFileName: "M", objects: "S",
    }, ["/project/main.o"], "/project/app.wasm")).toEqual([
      "/project/app.wasm", "/project/main.o", "-lc",
      "--stack-first", "-z", "stack-size=8388608",
    ]);
  });

  it.each(["c", "cpp"])("invalidates pre-policy %s artifacts", (language) => {
    expect(toolchainCacheIdentity(language)).toHaveProperty("linkerFlags", [
      "--stack-first", "-z", "stack-size=8388608",
    ]);
  });

  it("does not change non-Clang artifact identities", () => {
    expect(toolchainCacheIdentity("rust")).not.toHaveProperty("linkerFlags");
  });
});
