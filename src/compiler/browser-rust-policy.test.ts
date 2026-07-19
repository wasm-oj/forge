import { describe, expect, it } from "vitest";
import { createSdkProject } from "../sdk/project";
import {
  MAX_OUTPUT_READY_RUST_STAGES_PER_WORKER,
  OUTPUT_READY_RUST_STAGES_PER_BUILD,
  maximumOutputReadyRustStages,
  usesOutputReadyRust,
} from "./browser-rust-policy";

describe("browser Rust process budget", () => {
  it("reserves one rustc and one linker stage per build", () => {
    const rust = createSdkProject({
      language: "rust",
      entry: "src/main.rs",
      files: { "src/main.rs": "fn main() {}\n" },
    });
    const javascript = createSdkProject({
      language: "javascript",
      entry: "src/main.js",
      files: { "src/main.js": "\n" },
    });

    expect(usesOutputReadyRust(rust)).toBe(true);
    expect(maximumOutputReadyRustStages(rust)).toBe(OUTPUT_READY_RUST_STAGES_PER_BUILD);
    expect(usesOutputReadyRust(javascript)).toBe(false);
    expect(maximumOutputReadyRustStages(javascript)).toBe(0);
    expect(MAX_OUTPUT_READY_RUST_STAGES_PER_WORKER).toBe(4);
    expect(MAX_OUTPUT_READY_RUST_STAGES_PER_WORKER % OUTPUT_READY_RUST_STAGES_PER_BUILD).toBe(0);
  });
});
