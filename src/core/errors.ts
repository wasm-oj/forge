export const WASM_OJ_ERROR_CODES = Object.freeze([
  "operation-cancelled",
  "operation-conflict",
  "invalid-input",
  "unsupported",
  "integrity-failure",
  "compiler-failure",
  "runner-failure",
  "judge-failure",
  "replay-failure",
  "dependency-failure",
  "storage-failure",
  "initialization-failure",
  "disposed",
  "internal-failure",
] as const);

export type WasmOjErrorCode = (typeof WASM_OJ_ERROR_CODES)[number];

export const WASM_OJ_ERROR_STAGES = Object.freeze([
  "operation",
  "compile",
  "prepare",
  "run",
  "judge",
  "replay",
  "dependency",
  "storage",
  "initialize",
] as const);

export type WasmOjErrorStage = (typeof WASM_OJ_ERROR_STAGES)[number];

export interface WasmOjErrorOptions extends ErrorOptions {
  code: WasmOjErrorCode;
  stage: WasmOjErrorStage;
  retryable?: boolean;
  operationId?: string;
  details?: Readonly<Record<string, string | number | boolean | null>>;
}

export interface WasmOjErrorRecord {
  name: "WasmOjError";
  message: string;
  code: WasmOjErrorCode;
  stage: WasmOjErrorStage;
  retryable: boolean;
  operationId?: string;
  details?: Readonly<Record<string, string | number | boolean | null>>;
}

/** Stable infrastructure failure exposed at public asynchronous boundaries. */
export class WasmOjError extends Error {
  readonly code: WasmOjErrorCode;
  readonly stage: WasmOjErrorStage;
  readonly retryable: boolean;
  readonly operationId?: string;
  readonly details?: Readonly<Record<string, string | number | boolean | null>>;

  constructor(message: string, options: WasmOjErrorOptions) {
    super(message, options);
    if (!WASM_OJ_ERROR_CODES.includes(options.code)) throw new TypeError(`Invalid WASM-OJ error code '${String(options.code)}'.`);
    if (!WASM_OJ_ERROR_STAGES.includes(options.stage)) throw new TypeError(`Invalid WASM-OJ error stage '${String(options.stage)}'.`);
    if (options.retryable !== undefined && typeof options.retryable !== "boolean") {
      throw new TypeError("WASM-OJ error retryable must be a boolean.");
    }
    if (options.operationId !== undefined && (
      typeof options.operationId !== "string"
      || !options.operationId
      || options.operationId !== options.operationId.trim()
      || options.operationId.length > 128
    )) {
      throw new TypeError("WASM-OJ error operationId must be non-empty, trimmed, and at most 128 characters.");
    }
    this.name = "WasmOjError";
    this.code = options.code;
    this.stage = options.stage;
    this.retryable = options.retryable ?? false;
    this.operationId = options.operationId;
    this.details = validatedDetails(options.details);
  }

  toJSON(): WasmOjErrorRecord {
    return {
      name: "WasmOjError",
      message: this.message,
      code: this.code,
      stage: this.stage,
      retryable: this.retryable,
      ...(this.operationId === undefined ? {} : { operationId: this.operationId }),
      ...(this.details === undefined ? {} : { details: { ...this.details } }),
    };
  }
}

function validatedDetails(
  value: WasmOjErrorOptions["details"],
): Readonly<Record<string, string | number | boolean | null>> | undefined {
  if (value === undefined) return undefined;
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("WASM-OJ error details must be a plain object.");
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError("WASM-OJ error details must be a plain object.");
  }
  const entries = Object.entries(value);
  if (entries.length > 32) throw new RangeError("WASM-OJ error details may contain at most 32 entries.");
  const details: Record<string, string | number | boolean | null> = {};
  for (const [key, detail] of entries) {
    if (!key || key !== key.trim() || key.length > 128) {
      throw new TypeError("WASM-OJ error detail keys must be non-empty, trimmed, and at most 128 characters.");
    }
    if (typeof detail === "string" && detail.length <= 4_096) details[key] = detail;
    else if (typeof detail === "number" && Number.isFinite(detail)) details[key] = detail;
    else if (typeof detail === "boolean" || detail === null) details[key] = detail;
    else throw new TypeError(`WASM-OJ error detail '${key}' has an unsupported value.`);
  }
  return Object.freeze(details);
}

export function asWasmOjError(
  error: unknown,
  options: Omit<WasmOjErrorOptions, "cause">,
): WasmOjError {
  if (error instanceof WasmOjError) {
    if (error.operationId !== undefined || options.operationId === undefined) return error;
    return new WasmOjError(error.message, {
      code: error.code,
      stage: error.stage,
      retryable: error.retryable,
      operationId: options.operationId,
      details: error.details,
      cause: error,
    });
  }
  return new WasmOjError(error instanceof Error ? error.message : String(error), {
    ...options,
    cause: error,
  });
}
