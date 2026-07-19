import type { Project } from "../core/types";

/** rustc and wasm-ld each leave one output-ready process in the SDK executor. */
export const OUTPUT_READY_RUST_STAGES_PER_BUILD = 2;

/**
 * The pinned Wasmer SDK failed while starting the sixth accumulated Rust
 * process on a clean Linux runner. Four preserves one warm repeat build and
 * recycles before the observed unsafe third build.
 */
export const MAX_OUTPUT_READY_RUST_STAGES_PER_WORKER = 4;

export function usesOutputReadyRust(project: Project): boolean {
  return project.config.language === "rust";
}

export function maximumOutputReadyRustStages(project: Project): number {
  return usesOutputReadyRust(project) ? OUTPUT_READY_RUST_STAGES_PER_BUILD : 0;
}
