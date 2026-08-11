export class OutputBudgetExceededError extends Error {}

export class OutputBudget {
  constructor(limit: number);
  readonly used: number;
  readonly remaining: number;
  consume(bytes: number): void;
}
