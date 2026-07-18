import { describe, expect, it } from "vitest";
import { DEFAULT_DETERMINISM } from "../core/determinism";
import { createSdkProject } from "./project";

describe("SDK project facade", () => {
  it("creates a complete compiler project from a file map", () => {
    const project = createSdkProject({
      language: "typescript",
      entry: "src/main.ts",
      files: {
        "src/main.ts": 'import { answer } from "./answer.js";\nconsole.log(answer);\n',
        "src/answer.ts": "export const answer: number = 42;\n",
      },
    });
    expect(project.config).toMatchObject({
      language: "typescript",
      target: "wasip1",
      optimization: "release",
      entry: "src/main.ts",
      determinism: DEFAULT_DETERMINISM,
    });
    expect(project.files.map((file) => file.path)).toEqual(["src/answer.ts", "src/main.ts"]);
  });

  it("rejects paths outside the virtual project", () => {
    expect(() => createSdkProject({
      language: "c",
      entry: "../main.c",
      files: { "../main.c": "int main(void) {}" },
    })).toThrow("cannot escape");
  });

  it.each([
    ["./main.c", { "./main.c": "int main(void) {}" }],
    ["src\\main.c", { "src\\main.c": "int main(void) {}" }],
    [" main.c", { " main.c": "int main(void) {}" }],
  ])("rejects non-canonical entry path %s instead of rewriting it", (entry, files) => {
    expect(() => createSdkProject({ language: "c", entry, files })).toThrow("Entry file");
  });

  it("rejects non-canonical source paths even when the entry is canonical", () => {
    expect(() => createSdkProject({
      language: "c",
      entry: "main.c",
      files: { "main.c": "int main(void) {}", "./header.h": "" },
    })).toThrow("Source file path");
  });

  it.each([
    { name: "" },
    { name: " padded" },
    { projectId: "" },
    { projectId: "padded " },
  ])("rejects explicitly invalid metadata rather than replacing it: %j", (metadata) => {
    expect(() => createSdkProject({
      language: "c",
      entry: "main.c",
      files: { "main.c": "int main(void) {}" },
      ...metadata,
    })).toThrow("must be a non-empty, trimmed string");
  });

  it("rejects invalid target and optimization values at the public boundary", () => {
    const source = { language: "zig", entry: "main.zig", files: { "main.zig": "" } };
    expect(() => createSdkProject({ ...source, target: "wasi" as never })).toThrow("Unsupported target");
    expect(() => createSdkProject({ ...source, optimization: "fast" as never })).toThrow("Unsupported optimization");
  });

  it("preserves downstream language identities for custom ForgeCompiler implementations", () => {
    const project = createSdkProject({
      language: "zig",
      target: "wasip1",
      entry: "src/main.zig",
      files: { "src/main.zig": "pub fn main() void {}\n" },
    });
    expect(project.config.language).toBe("zig");
    expect(project.files[0]).toMatchObject({ language: "zig", path: "src/main.zig" });
  });
});
