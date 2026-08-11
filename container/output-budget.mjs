export class OutputBudgetExceededError extends Error {
  constructor() {
    super("The aggregate job output budget was exceeded.");
    this.name = "OutputBudgetExceededError";
  }
}

export class OutputBudget {
  #limit;
  #used = 0;

  constructor(limit) {
    if (!Number.isSafeInteger(limit) || limit < 1) throw new TypeError("Output budget limit must be a positive safe integer.");
    this.#limit = limit;
  }

  get used() {
    return this.#used;
  }

  get remaining() {
    return this.#limit - this.#used;
  }

  consume(bytes) {
    if (!Number.isSafeInteger(bytes) || bytes < 0) throw new TypeError("Output budget consumption must be a non-negative safe integer.");
    if (bytes > this.remaining) throw new OutputBudgetExceededError();
    this.#used += bytes;
  }
}
