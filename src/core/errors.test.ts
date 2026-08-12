import { describe, expect, it } from "vitest";
import {
  asWasmOjError,
  WasmOjError,
  WASM_OJ_ERROR_CODES,
  WASM_OJ_ERROR_STAGES,
} from "./errors";

describe("WasmOjError", () => {
  it("serializes only the stable error contract", () => {
    const error = new WasmOjError("Compiler unavailable.", {
      code: "compiler-failure",
      stage: "compile",
      retryable: true,
      operationId: "submission-1",
      details: { compiler: "clang", exitCode: 1 },
      cause: new Error("host detail"),
    });

    expect(error.toJSON()).toEqual({
      name: "WasmOjError",
      message: "Compiler unavailable.",
      code: "compiler-failure",
      stage: "compile",
      retryable: true,
      operationId: "submission-1",
      details: { compiler: "clang", exitCode: 1 },
    });
    expect(JSON.stringify(error)).not.toContain("host detail");
  });

  it("preserves an existing WasmOjError identity", () => {
    const original = new WasmOjError("Invalid project.", {
      code: "invalid-input",
      stage: "compile",
    });

    expect(asWasmOjError(original, {
      code: "internal-failure",
      stage: "operation",
    })).toBe(original);
  });

  it("adds a missing operation identity without replacing stable failure coordinates", () => {
    const original = new WasmOjError("Compilation failed.", {
      code: "compiler-failure",
      stage: "compile",
      retryable: true,
      details: { compiler: "clang" },
    });

    expect(asWasmOjError(original, {
      code: "internal-failure",
      stage: "operation",
      operationId: "submission-1",
    }).toJSON()).toEqual({
      name: "WasmOjError",
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
    const error = new WasmOjError("Storage failed.", {
      code: "storage-failure",
      stage: "storage",
      details: source,
    });
    source.attempt = 3;

    expect(WASM_OJ_ERROR_CODES).toContain(error.code);
    expect(WASM_OJ_ERROR_STAGES).toContain(error.stage);
    expect(error.details).toEqual({ attempt: 2 });
    expect(Object.isFrozen(error.details)).toBe(true);
  });
});
