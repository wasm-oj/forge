import { WOJ_EXIT, type WojExitCode } from "./contracts";

export class CliError extends Error {
  readonly exitCode: WojExitCode;
  readonly code: string;

  constructor(message: string, options: { readonly exitCode?: WojExitCode; readonly code?: string; readonly cause?: unknown } = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "CliError";
    this.exitCode = options.exitCode ?? WOJ_EXIT.infrastructure;
    this.code = options.code ?? "cli-error";
  }
}

export function usageError(message: string): CliError {
  return new CliError(message, { exitCode: WOJ_EXIT.usage, code: "usage" });
}

export function unavailableError(message: string, cause?: unknown): CliError {
  return new CliError(message, { exitCode: WOJ_EXIT.infrastructure, code: "unavailable", cause });
}

export function asCliError(error: unknown): CliError {
  if (error instanceof CliError) return error;
  if (error instanceof Error) return new CliError(error.message, { cause: error });
  return new CliError("The CLI failed with a non-Error value.");
}
