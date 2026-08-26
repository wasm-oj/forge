const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export interface CatalogWorkflowParameters {
  readonly syncJobId: string;
}

export function parseCatalogWorkflowParameters(value: unknown): CatalogWorkflowParameters {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("Catalog Workflow reference is invalid.");
  const record = value as Record<string, unknown>;
  if (Object.keys(record).length !== 1 || typeof record.syncJobId !== "string" || !UUID.test(record.syncJobId)) {
    throw new TypeError("Catalog Workflow reference is invalid.");
  }
  return { syncJobId: record.syncJobId };
}
