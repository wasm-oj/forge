import { describe, expect, it } from "vitest";
import {
  asForgeError,
  ForgeError,
  FORGE_ERROR_CODES,
  FORGE_ERROR_STAGES,
} from "./errors";

describe("ForgeError", () => {
  it("serializes only the stable error contract", () => {
    const error = new ForgeError("Compiler unavailable.", {
      code: "compiler-failure",
      stage: "compile",
      retryable: true,
      operationId: "submission-1",
      details: { compiler: "clang", exitCode: 1 },
      cause: new Error("host detail"),
    });

    expect(error.toJSON()).toEqual({
      name: "ForgeError",
      message: "Compiler unavailable.",
      code: "compiler-failure",
      stage: "compile",
      retryable: true,
      operationId: "submission-1",
      details: { compiler: "clang", exitCode: 1 },
    });
    expect(JSON.stringify(error)).not.toContain("host detail");
  });

  it("preserves an existing ForgeError identity", () => {
    const original = new ForgeError("Invalid project.", {
      code: "invalid-input",
      stage: "compile",
    });

    expect(asForgeError(original, {
      code: "internal-failure",
      stage: "operation",
    })).toBe(original);
  });

  it("adds a missing operation identity without replacing stable failure coordinates", () => {
    const original = new ForgeError("Compilation failed.", {
      code: "compiler-failure",
      stage: "compile",
      retryable: true,
      details: { compiler: "clang" },
    });

    expect(asForgeError(original, {
      code: "internal-failure",
      stage: "operation",
      operationId: "submission-1",
    }).toJSON()).toEqual({
      name: "ForgeError",
      message: "Compilation failed.",
      code: "compiler-failure",
      stage: "compile",
      retryable: true,
      operationId: "submission-1",
      details: { compiler: "clang" },
    });
  });

  it("publishes closed runtime vocabularies and immutable bounded details", () => {
    const source = { attempt: 2 };
    const error = new ForgeError("Storage failed.", {
      code: "storage-failure",
      stage: "storage",
      details: source,
    });
    source.attempt = 3;

    expect(FORGE_ERROR_CODES).toContain(error.code);
    expect(FORGE_ERROR_STAGES).toContain(error.stage);
    expect(error.details).toEqual({ attempt: 2 });
    expect(Object.isFrozen(error.details)).toBe(true);
  });
});
