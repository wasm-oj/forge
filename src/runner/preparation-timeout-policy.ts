import type { BuildArtifact } from "../core/types";

export const DEFAULT_RUNTIME_PREPARATION_TIMEOUT_MS = 120_000;
export const PYTHON_RUNTIME_PREPARATION_TIMEOUT_MS = 300_000;

/** Shared hard boundary for browser Worker and server-child runtime preparation. */
export function runtimePreparationTimeoutMs(artifact: BuildArtifact): number {
  return artifact.language === "python"
    ? PYTHON_RUNTIME_PREPARATION_TIMEOUT_MS
    : DEFAULT_RUNTIME_PREPARATION_TIMEOUT_MS;
}
