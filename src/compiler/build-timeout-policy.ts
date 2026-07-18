import type { Language } from "../core/types.ts";
import { isBuiltinLanguage } from "../core/types.ts";
import { GO_COMPILE_TIMEOUT_MS } from "./go-toolchain.ts";
import { RUST_COMPILE_TIMEOUT_MS } from "./rust-toolchain.ts";

export const CLANG_BUILD_CONTROL_TIMEOUT_MS = 60_000;
export const DEFAULT_BUILD_CONTROL_TIMEOUT_MS = 120_000;
export const GO_BUILD_CONTROL_TIMEOUT_MS = GO_COMPILE_TIMEOUT_MS + 10_000;
export const RUST_BUILD_CONTROL_TIMEOUT_MS = RUST_COMPILE_TIMEOUT_MS + 10_000;

/**
 * Hard host deadline for one complete compiler request. The server child and
 * browser Worker must use the same policy because an SDK call can block the
 * JavaScript event loop and therefore cannot enforce its own timer.
 */
export function buildControlTimeoutMs(language: Language): number {
  if (!isBuiltinLanguage(language)) {
    throw new Error(`The built-in Forge compiler does not support language '${language}'.`);
  }
  if (language === "c" || language === "cpp") return CLANG_BUILD_CONTROL_TIMEOUT_MS;
  if (language === "rust") return RUST_BUILD_CONTROL_TIMEOUT_MS;
  if (language === "go") return GO_BUILD_CONTROL_TIMEOUT_MS;
  return DEFAULT_BUILD_CONTROL_TIMEOUT_MS;
}
