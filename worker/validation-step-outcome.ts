import { readBoundedResponseJson } from "./http";

const MAX_ERROR_BODY_BYTES = 4 * 1024;
const SAFE_ERROR_MESSAGE = /^[^\u0000-\u001f\u007f]{1,300}$/;

const REJECTION_MESSAGES = {
  "container-identity-mismatch": "The validation container did not accept this immutable release.",
  "container-one-shot": "The validation container did not accept this collection attempt.",
  "container-pool-mismatch": "The validation container did not accept this collection job.",
  "validation-input-rejected": "The collection format or judge packaging is invalid.",
} as const;

export type ValidationRejectionCode = keyof typeof REJECTION_MESSAGES;

export interface ValidationStepRejection {
  readonly kind: "rejected";
  readonly status: 409 | 422;
  readonly code: ValidationRejectionCode | "validation-failed";
  readonly message: string;
}

export type ValidationStepOutcome<T> =
  | { readonly kind: "accepted"; readonly result: T }
  | ValidationStepRejection;

function safeRejection(value: unknown, status: 409 | 422): ValidationStepRejection {
  const fallback = {
    kind: "rejected",
    status,
    code: "validation-failed",
    message: "Managed collection validation rejected the canonical source.",
  } as const;
  if (!value || typeof value !== "object" || Array.isArray(value)) return fallback;
  const error = (value as Record<string, unknown>).error;
  if (!error || typeof error !== "object" || Array.isArray(error)) return fallback;
  const record = error as Record<string, unknown>;
  if (typeof record.code !== "string" || !Object.hasOwn(REJECTION_MESSAGES, record.code)) return fallback;
  const code = record.code as ValidationRejectionCode;
  return {
    kind: "rejected",
    status,
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
  if (response.status === 409 || response.status === 422) {
    let body: unknown;
    try {
      body = await readBoundedResponseJson(response, MAX_ERROR_BODY_BYTES);
    } catch {
      body = undefined;
    }
    return safeRejection(body, response.status);
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error(`Validation container infrastructure failed with HTTP ${response.status}.`);
  }
  return { kind: "accepted", result: await readAccepted(response) };
}
