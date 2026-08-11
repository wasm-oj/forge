import { readBoundedResponseJson } from "./http";

const MAX_ERROR_BODY_BYTES = 4 * 1024;
const SAFE_ERROR_MESSAGE = /^[^\u0000-\u001f\u007f]{1,300}$/;

const REJECTION_MESSAGES = {
  "validation-input-rejected": "The collection format or judge packaging is invalid.",
} as const;

const INFRASTRUCTURE_CONFLICT_CODES = new Set([
  "container-identity-mismatch",
  "container-one-shot",
  "container-pool-mismatch",
]);

export type ValidationRejectionCode = keyof typeof REJECTION_MESSAGES;

export interface ValidationStepRejection {
  readonly kind: "rejected";
  readonly status: 422;
  readonly code: ValidationRejectionCode | "validation-failed";
  readonly message: string;
}

export type ValidationStepOutcome<T> =
  | { readonly kind: "accepted"; readonly result: T }
  | ValidationStepRejection;

function errorRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const error = (value as Record<string, unknown>).error;
  return error && typeof error === "object" && !Array.isArray(error)
    ? error as Record<string, unknown>
    : undefined;
}

function safeRejection(value: unknown): ValidationStepRejection {
  const fallback = {
    kind: "rejected",
    status: 422,
    code: "validation-failed",
    message: "Managed collection validation rejected the canonical source.",
  } as const;
  const record = errorRecord(value);
  if (!record) return fallback;
  if (typeof record.code !== "string" || !Object.hasOwn(REJECTION_MESSAGES, record.code)) return fallback;
  const code = record.code as ValidationRejectionCode;
  return {
    kind: "rejected",
    status: 422,
    code,
    message: typeof record.message === "string" && SAFE_ERROR_MESSAGE.test(record.message)
      ? record.message
      : REJECTION_MESSAGES[code],
  };
}

/**
 * Turn expected Container rejections into plain data before the Workflow step
 * boundary. Cloudflare may serialize thrown errors from step callbacks without
 * preserving their class/name, but it preserves this exact discriminated
 * outcome.
 */
export async function validationStepOutcome<T>(
  response: Response,
  readAccepted: (response: Response) => Promise<T>,
): Promise<ValidationStepOutcome<T>> {
  if (response.status === 422) {
    let body: unknown;
    try {
      body = await readBoundedResponseJson(response, MAX_ERROR_BODY_BYTES);
    } catch {
      body = undefined;
    }
    return safeRejection(body);
  }
  if (response.status === 409) {
    let body: unknown;
    try {
      body = await readBoundedResponseJson(response, MAX_ERROR_BODY_BYTES);
    } catch {
      body = undefined;
    }
    const code = errorRecord(body)?.code;
    const suffix = typeof code === "string" && INFRASTRUCTURE_CONFLICT_CODES.has(code) ? ` (${code})` : "";
    throw new Error(`Validation container infrastructure failed with HTTP 409${suffix}.`);
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error(`Validation container infrastructure failed with HTTP ${response.status}.`);
  }
  return { kind: "accepted", result: await readAccepted(response) };
}
