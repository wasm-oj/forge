import { describe, expect, it } from "vitest";
import { javaMainClass, parseJavaDiagnostics } from "./java-toolchain";

describe("Java toolchain helpers", () => {
  it("derives the entry class from its package declaration", () => {
    expect(javaMainClass("src/example/Main.java", "package example;\npublic class Main {}"))
      .toBe("example.Main");
  });

  it("maps compiler diagnostics to project-relative source locations", () => {
    expect(parseJavaDiagnostics("/project/Main.java:3:7: error: ';' expected", "Main.java"))
      .toEqual([{
        severity: "error",
        message: "';' expected",
        file: "Main.java",
        line: 3,
        column: 7,
        source: "java",
      }]);
  });
});
