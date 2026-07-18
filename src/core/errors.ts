export const FORGE_ERROR_CODES = Object.freeze([
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

export type ForgeErrorCode = (typeof FORGE_ERROR_CODES)[number];

export const FORGE_ERROR_STAGES = Object.freeze([
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

export type ForgeErrorStage = (typeof FORGE_ERROR_STAGES)[number];

export interface ForgeErrorOptions extends ErrorOptions {
  code: ForgeErrorCode;
  stage: ForgeErrorStage;
  retryable?: boolean;
  operationId?: string;
  details?: Readonly<Record<string, string | number | boolean | null>>;
}

export interface ForgeErrorRecord {
  name: "ForgeError";
  message: string;
  code: ForgeErrorCode;
  stage: ForgeErrorStage;
  retryable: boolean;
  operationId?: string;
  details?: Readonly<Record<string, string | number | boolean | null>>;
}

/** Stable infrastructure failure exposed at public asynchronous boundaries. */
export class ForgeError extends Error {
  readonly code: ForgeErrorCode;
  readonly stage: ForgeErrorStage;
  readonly retryable: boolean;
  readonly operationId?: string;
  readonly details?: Readonly<Record<string, string | number | boolean | null>>;

  constructor(message: string, options: ForgeErrorOptions) {
    super(message, options);
    if (!FORGE_ERROR_CODES.includes(options.code)) throw new TypeError(`Invalid Forge error code '${String(options.code)}'.`);
    if (!FORGE_ERROR_STAGES.includes(options.stage)) throw new TypeError(`Invalid Forge error stage '${String(options.stage)}'.`);
    if (options.retryable !== undefined && typeof options.retryable !== "boolean") {
      throw new TypeError("Forge error retryable must be a boolean.");
    }
    if (options.operationId !== undefined && (
      typeof options.operationId !== "string"
      || !options.operationId
      || options.operationId !== options.operationId.trim()
      || options.operationId.length > 128
    )) {
      throw new TypeError("Forge error operationId must be non-empty, trimmed, and at most 128 characters.");
    }
    this.name = "ForgeError";
    this.code = options.code;
    this.stage = options.stage;
    this.retryable = options.retryable ?? false;
    this.operationId = options.operationId;
    this.details = validatedDetails(options.details);
  }

  toJSON(): ForgeErrorRecord {
    return {
      name: "ForgeError",
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
  value: ForgeErrorOptions["details"],
): Readonly<Record<string, string | number | boolean | null>> | undefined {
  if (value === undefined) return undefined;
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Forge error details must be a plain object.");
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError("Forge error details must be a plain object.");
  }
  const entries = Object.entries(value);
  if (entries.length > 32) throw new RangeError("Forge error details may contain at most 32 entries.");
  const details: Record<string, string | number | boolean | null> = {};
  for (const [key, detail] of entries) {
    if (!key || key !== key.trim() || key.length > 128) {
      throw new TypeError("Forge error detail keys must be non-empty, trimmed, and at most 128 characters.");
    }
    if (typeof detail === "string" && detail.length <= 4_096) details[key] = detail;
    else if (typeof detail === "number" && Number.isFinite(detail)) details[key] = detail;
    else if (typeof detail === "boolean" || detail === null) details[key] = detail;
    else throw new TypeError(`Forge error detail '${key}' has an unsupported value.`);
  }
  return Object.freeze(details);
}

export function asForgeError(
  error: unknown,
  options: Omit<ForgeErrorOptions, "cause">,
): ForgeError {
  if (error instanceof ForgeError) {
    if (error.operationId !== undefined || options.operationId === undefined) return error;
    return new ForgeError(error.message, {
      code: error.code,
      stage: error.stage,
      retryable: error.retryable,
      operationId: options.operationId,
      details: error.details,
      cause: error,
    });
  }
  return new ForgeError(error instanceof Error ? error.message : String(error), {
    ...options,
    cause: error,
  });
}
