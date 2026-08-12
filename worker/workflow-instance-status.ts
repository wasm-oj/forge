const INSTANCE_NOT_FOUND = /^\(instance\.not_found\) Instance not found$/;

export function workflowInstanceNotFound(error: unknown): boolean {
  return error instanceof Error && INSTANCE_NOT_FOUND.test(error.message);
}

interface WorkflowInstanceLike {
  status(): Promise<{ readonly status: string }>;
}

interface WorkflowNamespaceLike {
  get(id: string): Promise<WorkflowInstanceLike>;
}

export async function workflowStatusOrUnknown(
  namespace: WorkflowNamespaceLike,
  id: string,
): Promise<{ readonly status: string }> {
  try {
    return await (await namespace.get(id)).status();
  } catch (error) {
    if (workflowInstanceNotFound(error)) return { status: "unknown" };
    throw error;
  }
}
