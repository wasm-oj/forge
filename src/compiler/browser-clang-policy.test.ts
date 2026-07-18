import { describe, expect, it } from "vitest";
import { createSdkProject } from "../sdk/project";
import {
  MAX_OUTPUT_READY_CLANG_STAGES_PER_WORKER,
  assertOutputReadyClangStageBudget,
  maximumOutputReadyClangStages,
  observedOutputReadyClangStages,
  usesOutputReadyClang,
} from "./browser-clang-policy";

describe("browser Clang policy", () => {
  it("selects C and C++ projects for both supported runtime targets", () => {
    const project = (language: "c" | "cpp" | "rust", target: "wasip1" | "wasix") => createSdkProject({
      language,
      target,
      entry: language === "c" ? "main.c" : language === "cpp" ? "main.cpp" : "main.rs",
      files: {
        [language === "c" ? "main.c" : language === "cpp" ? "main.cpp" : "main.rs"]: "int main(){}",
      },
    });

    expect(usesOutputReadyClang(project("c", "wasip1"))).toBe(true);
    expect(usesOutputReadyClang(project("cpp", "wasip1"))).toBe(true);
    expect(usesOutputReadyClang(project("c", "wasix"))).toBe(true);
    expect(usesOutputReadyClang(project("rust", "wasip1"))).toBe(false);
    const cProject = project("c", "wasip1");
    expect(maximumOutputReadyClangStages(cProject)).toBe(3);
    expect(MAX_OUTPUT_READY_CLANG_STAGES_PER_WORKER).toBe(8);
    expect(observedOutputReadyClangStages({
      success: true,
      artifact: {} as never,
      diagnostics: [],
      stdout: "",
      stderr: "",
      cacheHit: false,
      buildGraph: {
        hits: { object: 1 },
        misses: { object: 1, "link-result": 1 },
        stores: { object: 1, "link-result": 1 },
      },
    }, 3)).toBe(2);

    const oversized = createSdkProject({
      language: "c",
      target: "wasip1",
      entry: "src/main.c",
      files: Object.fromEntries(
        Array.from({ length: 15 }, (_, index) => [
          index === 0 ? "src/main.c" : `src/unit-${index}.c`,
          "int value(void){return 0;}",
        ]),
      ),
    });
    expect(maximumOutputReadyClangStages(oversized)).toBe(17);
    expect(() => assertOutputReadyClangStageBudget(oversized))
      .toThrow("requires 17 compiler stages");

    const pchProject = createSdkProject({
      language: "cpp",
      entry: "src/main.cpp",
      files: {
        "src/forge.pch.hpp": "#include <array>\n",
        "src/main.cpp": "int main(){}",
      },
    });
    expect(maximumOutputReadyClangStages(pchProject)).toBe(4);
  });
});
