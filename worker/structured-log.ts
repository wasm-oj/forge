export type OperationalEvent =
  | "api.unhandled-error"
  | "submission.admission-progress"
  | "submission.admission-failed"
  | "workflow.delivery-deferred"
  | "reconciler.delivery-failed"
  | "control.formal-mutations-changed"
  | "control.emergency-cancel";

export interface OperationalLogFields {
  readonly event: OperationalEvent;
  readonly outcome: "success" | "failure" | "deferred";
  readonly code?: string;
  readonly releaseId?: string;
  readonly environment?: "development" | "staging" | "production";
  readonly aggregateType?: "submission" | "catalog" | "release";
  readonly aggregateId?: string;
  readonly count?: number;
}

const SAFE_VALUE = /^[A-Za-z0-9_.:@/-]{1,128}$/;

export function operationalLogRecord(fields: OperationalLogFields, timestamp = new Date()): Readonly<Record<string, string | number>> {
  const record: Record<string, string | number> = {
    schema: "wasm-oj-platform/operations-log/v1",
    timestamp: timestamp.toISOString(),
    event: fields.event,
    outcome: fields.outcome,
  };
  for (const key of ["code", "releaseId", "environment", "aggregateType", "aggregateId"] as const) {
    const value = fields[key];
    if (typeof value === "string" && SAFE_VALUE.test(value)) record[key] = value;
  }
  if (Number.isSafeInteger(fields.count) && (fields.count as number) >= 0) record.count = fields.count as number;
  return Object.freeze(record);
}

export function operationalLog(level: "info" | "warn" | "error", fields: OperationalLogFields): void {
  const line = JSON.stringify(operationalLogRecord(fields));
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.info(line);
}
