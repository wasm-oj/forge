import { createHash, timingSafeEqual } from "node:crypto";

export const RESET_MIGRATION = "0017_architecture_reset.sql";
export const RESET_TOKEN_MINIMUM_BYTES = 32;

export function sha256Hex(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

export function assertArchitectureResetToken(provided, expected) {
  if (typeof expected !== "string" || Buffer.byteLength(expected) < RESET_TOKEN_MINIMUM_BYTES) {
    throw new Error(
      `WASM_OJ_ARCHITECTURE_RESET_TOKEN must be a secret of at least ${RESET_TOKEN_MINIMUM_BYTES} bytes.`,
    );
  }
  if (typeof provided !== "string") {
    throw new Error("WASM_OJ_ARCHITECTURE_RESET_TOKEN_PROVIDED is required.");
  }
  const providedBytes = Buffer.from(provided);
  const expectedBytes = Buffer.from(expected);
  if (providedBytes.length !== expectedBytes.length || !timingSafeEqual(providedBytes, expectedBytes)) {
    throw new Error("Architecture reset token does not match the protected production secret.");
  }
}

export function rowsFromWranglerJson(stdout, label) {
  let batches;
  try {
    batches = JSON.parse(stdout);
  } catch (error) {
    throw new TypeError(`${label} did not return JSON.`, { cause: error });
  }
  if (!Array.isArray(batches)) throw new TypeError(`${label} returned an invalid result envelope.`);
  return batches.flatMap((batch) => Array.isArray(batch?.results) ? batch.results : []);
}
