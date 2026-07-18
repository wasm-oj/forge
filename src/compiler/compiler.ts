import type { BuildResult, Project, WorkerProgress } from "../core/types";

/** Environment-neutral compiler contract implemented by browser and server hosts. */
export interface ForgeCompiler {
  /**
   * Stable, content-addressed identity for the compiler inputs used by this
   * project. Forge incorporates it into artifact cache keys before building.
   */
  cacheIdentity(project: Project): string;
  ready(): Promise<void>;
  build(project: Project, cacheKey: string): Promise<BuildResult>;
  onProgress(listener: (progress: WorkerProgress) => void): () => void;
  clearToolchainCache(): Promise<void>;
  cancel(): void;
  restart(): void;
  dispose(): void;
}
