const INSTANCE_NOT_FOUND = /^\(instance\.not_found\) Instance not found$/;

export function workflowInstanceNotFound(error: unknown): boolean {
  return error instanceof Error && INSTANCE_NOT_FOUND.test(error.message);
}
