import { base64Url, constantTimeEqual, hmacSha256Hex, sha256Hex } from "./crypto";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const ATTEMPT_TOKEN = /^[A-Za-z0-9_-]{43}$/;
const ATTEMPT_CREDENTIAL_DOMAIN = "wasm-oj-submission-attempt-v2\0";

/**
 * The only values persisted in Cloudflare Workflow parameters or a
 * start-workflow outbox. Source locations, owners, judge object identities,
 * and attempt capabilities are loaded from the authoritative databases by the
 * Workflow immediately before use.
 */
export interface SubmissionWorkflowParameters {
  readonly submissionId: string;
  readonly attempt: number;
}

export function parseSubmissionAttemptToken(value: unknown): string {
  if (typeof value !== "string" || !ATTEMPT_TOKEN.test(value)) throw new TypeError("Submission attempt token is invalid.");
  return value;
}

export function parseSubmissionWorkflowParameters(value: unknown): SubmissionWorkflowParameters {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("Submission Workflow reference is invalid.");
  const record = value as Record<string, unknown>;
  const keys = ["attempt", "submissionId"];
  if (
    Object.keys(record).sort().join("\0") !== keys.join("\0")
    || typeof record.submissionId !== "string" || !UUID.test(record.submissionId)
    || !Number.isSafeInteger(record.attempt) || (record.attempt as number) < 1
  ) throw new TypeError("Submission Workflow reference is invalid.");
  return record as unknown as SubmissionWorkflowParameters;
}

export async function deriveSubmissionAttemptToken(
  secret: string,
  submissionId: string,
  attempt: number,
): Promise<string> {
  if (secret.length < 32) throw new Error("Submission attempt HMAC secret is not configured.");
  if (!UUID.test(submissionId) || !Number.isSafeInteger(attempt) || attempt < 1) {
    throw new TypeError("Submission attempt identity is invalid.");
  }
  const message = new TextEncoder().encode(`${ATTEMPT_CREDENTIAL_DOMAIN}${submissionId}\0${attempt}`);
  const signature = await hmacSha256Hex(secret, message);
  return base64Url(Uint8Array.from(signature.match(/.{2}/g) ?? [], (byte) => Number.parseInt(byte, 16)));
}

export async function assertSubmissionAttemptTokenHash(
  secret: string,
  submissionId: string,
  attempt: number,
  expectedHash: string,
): Promise<string> {
  if (!SHA256.test(expectedHash)) throw new Error("Submission attempt token hash is invalid.");
  const token = await deriveSubmissionAttemptToken(secret, submissionId, attempt);
  if (!constantTimeEqual(await sha256Hex(token), expectedHash)) {
    throw new Error("Submission attempt credential does not match its durable fence.");
  }
  return token;
}
