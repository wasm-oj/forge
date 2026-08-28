export interface PromptAttemptWorkflowParameters {
  readonly attemptId: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function parsePromptAttemptWorkflowParameters(value: unknown): PromptAttemptWorkflowParameters {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Prompt attempt workflow parameters must be an object.");
  }
  const input = value as Record<string, unknown>;
  const keys = Object.keys(input).sort();
  const expected = ["attemptId"];
  if (JSON.stringify(keys) !== JSON.stringify(expected)) {
    throw new TypeError("Prompt attempt workflow parameters have an invalid shape.");
  }
  if (typeof input.attemptId !== "string" || !UUID.test(input.attemptId)) throw new TypeError("Prompt attempt workflow attemptId is invalid.");
  return { attemptId: input.attemptId };
}
