import type { BuildResult, Project } from "../core/types";
import { isToolchainLibcxxPchHeader } from "./libcxx-pch";

/**
 * Keeps Clang 22 output-ready processes below the observed SDK executor limit.
 *
 * A Worker failed after 11 completed stages. Eight is the conservative verified
 * operating boundary used until the SDK can reclaim abandoned process state.
 */
export const MAX_OUTPUT_READY_CLANG_STAGES_PER_WORKER = 8;

export function usesOutputReadyClang(project: Project): boolean {
  return (project.config.target === "wasip1" || project.config.target === "wasix")
    && (project.config.language === "c" || project.config.language === "cpp");
}

/** Upper bound before cache lookup: optional PCH, project units, deterministic runtime shim, and linker. */
export function maximumOutputReadyClangStages(project: Project): number {
  if (!usesOutputReadyClang(project)) return 0;
  const sourcePattern = project.config.language === "cpp" ? /\.(?:cc|cpp|cxx)$/ : /\.c$/;
  const sources = new Set(project.files.filter((file) => sourcePattern.test(file.path)).map((file) => file.path));
  sources.add(project.config.entry);
  const pchFile = project.config.language === "cpp"
    ? project.files.find((file) => file.path.split("/").at(-1) === "forge.pch.hpp")
    : undefined;
  const pch = pchFile && !isToolchainLibcxxPchHeader(pchFile.content) ? 1 : 0;
  return sources.size + pch + 2;
}

export function assertOutputReadyClangStageBudget(project: Project): number {
  const maximum = maximumOutputReadyClangStages(project);
  if (maximum > MAX_OUTPUT_READY_CLANG_STAGES_PER_WORKER) {
    throw new Error(
      `The browser Clang project requires ${maximum} compiler stages; `
      + `the verified per-Worker limit is ${MAX_OUTPUT_READY_CLANG_STAGES_PER_WORKER}.`,
    );
  }
  return maximum;
}

/** Successful builds launch one process per graph miss; failures reserve their upper bound. */
export function observedOutputReadyClangStages(result: BuildResult, maximum: number): number {
  if (!result.success || !result.artifact || !result.buildGraph) return maximum;
  return (result.buildGraph.misses.pch ?? 0)
    + (result.buildGraph.misses.object ?? 0)
    + (result.buildGraph.misses["link-result"] ?? 0);
}
