const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export interface CatalogWorkflowParameters {
  readonly kind: "validation" | "publish";
  readonly jobId: string;
}

export function parseCatalogWorkflowParameters(value: unknown): CatalogWorkflowParameters {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("Catalog Workflow reference is invalid.");
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).sort().join("\0") !== "jobId\0kind"
    || (record.kind !== "validation" && record.kind !== "publish")
    || typeof record.jobId !== "string" || !UUID.test(record.jobId)
  ) throw new TypeError("Catalog Workflow reference is invalid.");
  return { kind: record.kind, jobId: record.jobId };
}
