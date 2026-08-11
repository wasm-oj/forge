import type { RunResult } from "../core/types";
import { normalizeOutput } from "./normalization";

export function sampleOutputMatches(
  run: Pick<RunResult, "termination" | "code" | "stdout">,
  expectedOutput: string,
): boolean {
  return run.termination === "exited"
    && run.code === 0
    && normalizeOutput(run.stdout, "lines") === normalizeOutput(expectedOutput, "lines");
}
