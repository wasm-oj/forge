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

export type WorkflowInstanceLookup =
  | { readonly found: true; readonly status: string }
  | { readonly found: false };

/** Distinguishes an exact instance.not_found response from every transport/status failure. */
export async function lookupWorkflowInstance(
  namespace: WorkflowNamespaceLike,
  id: string,
): Promise<WorkflowInstanceLookup> {
  try {
    const result = await (await namespace.get(id)).status();
    return { found: true, status: result.status };
  } catch (error) {
    if (workflowInstanceNotFound(error)) return { found: false };
    throw error;
  }
}

export async function workflowStatusOrUnknown(
  namespace: WorkflowNamespaceLike,
  id: string,
): Promise<{ readonly status: string }> {
  const lookup = await lookupWorkflowInstance(namespace, id);
  return lookup.found ? { status: lookup.status } : { status: "unknown" };
}
