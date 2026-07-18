import { describe, expect, it } from "vitest";
import type { BuildArtifact } from "../core/types";
import {
  DEFAULT_RUNTIME_PREPARATION_TIMEOUT_MS,
  PYTHON_RUNTIME_PREPARATION_TIMEOUT_MS,
  runtimePreparationTimeoutMs,
} from "./preparation-timeout-policy";

describe("runtime preparation control deadlines", () => {
  it("allows the one-time CPython filesystem export without widening other runtimes", () => {
    expect(runtimePreparationTimeoutMs({ language: "python" } as BuildArtifact))
      .toBe(PYTHON_RUNTIME_PREPARATION_TIMEOUT_MS);
    expect(runtimePreparationTimeoutMs({ language: "javascript" } as BuildArtifact))
      .toBe(DEFAULT_RUNTIME_PREPARATION_TIMEOUT_MS);
    expect(runtimePreparationTimeoutMs({ language: "custom-runtime" } as BuildArtifact))
      .toBe(DEFAULT_RUNTIME_PREPARATION_TIMEOUT_MS);
  });
});
