import type { Project } from "../core/types";

/** rustc and wasm-ld each leave one output-ready process in the SDK executor. */
export const OUTPUT_READY_RUST_STAGES_PER_BUILD = 2;

/**
 * The pinned Wasmer SDK failed while starting the twelfth accumulated Rust
 * process. Eight is the verified conservative boundary shared with Clang.
 */
export const MAX_OUTPUT_READY_RUST_STAGES_PER_WORKER = 8;

export function usesOutputReadyRust(project: Project): boolean {
  return project.config.language === "rust";
}

export function maximumOutputReadyRustStages(project: Project): number {
  return usesOutputReadyRust(project) ? OUTPUT_READY_RUST_STAGES_PER_BUILD : 0;
}
