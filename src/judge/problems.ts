import { GENERATED_PROBLEMS } from "./problems.generated";
import type { JudgeProblem } from "./problem-model";

export * from "./problem-model";

export const PROBLEMS: readonly JudgeProblem[] = GENERATED_PROBLEMS;

export function problemById(id: string): JudgeProblem | undefined {
  return PROBLEMS.find((problem) => problem.id === id);
}
