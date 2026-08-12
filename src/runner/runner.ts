import type {
  BuildArtifact,
  InteractiveRunConfig,
  InteractiveRunResult,
  RunConfig,
  RunResult,
  WorkerProgress,
} from "../core/types";
import type { TrustedJudgeProgram } from "../online-judge/trusted-judge-wasm";

/** Environment-neutral runner contract implemented by browser and native hosts. */
export interface Runner {
  ready(): Promise<void>;
  run(artifact: BuildArtifact, config: RunConfig): Promise<RunResult>;
  interact(
    contestant: BuildArtifact,
    interactor: BuildArtifact,
    config: InteractiveRunConfig,
  ): Promise<InteractiveRunResult>;
  /** Server-side immutable judge command path; browser hosts intentionally omit it. */
  runTrusted?(program: TrustedJudgeProgram, config: RunConfig): Promise<RunResult>;
  interactTrusted?(
    contestant: BuildArtifact,
    interactor: TrustedJudgeProgram,
    config: InteractiveRunConfig,
  ): Promise<InteractiveRunResult>;
  onProgress(listener: (progress: WorkerProgress) => void): () => void;
  onStream(listener: (stream: "stdout" | "stderr", chunk: string) => void): () => void;
  clearRuntimeCache(): Promise<void>;
  cancel(): void;
  /** Cancel accepted execution work and wait until it can no longer mutate caches. */
  cancelAndWait(): Promise<void>;
  restart(): void;
  dispose(): void;
}
