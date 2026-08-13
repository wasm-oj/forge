import { describe, expect, it } from "vitest";
import { CliError } from "./errors";
import { parseCli } from "./parser";

describe("woj CLI parser", () => {
  it("parses globals before a leaf and preserves repeatable values", () => {
    const result = parseCli(["--offline", "--json", "run", "--arg", "one", "--arg=two"]);
    expect(result).toMatchObject({
      kind: "command",
      command: {
        global: { offline: true, json: true },
        options: { arg: ["one", "two"] },
      },
    });
  });

  it("treats command groups as contextual help", () => {
    expect(parseCli(["organizer", "collection"])).toEqual({ kind: "help", prefix: ["organizer", "collection"] });
  });

  it("rejects unknown commands and options with usage exit code", () => {
    for (const arguments_ of [["magic"], ["build", "--guess"]]) {
      try {
        parseCli(arguments_);
        throw new Error("expected parsing to fail");
      } catch (error) {
        expect(error).toBeInstanceOf(CliError);
        expect((error as CliError).exitCode).toBe(2);
      }
    }
  });
});
