import type {
  ContestClock,
  ContestOfficialTrack,
  ContestProblemAvailability,
  ContestRulePhase,
} from "../../../online-judge/contest-rules";
import type { ContestRuntimeState } from "../../contests/model/contest-projection";

export interface ContestWorkspaceRuntime {
  readonly contestId: string;
  readonly problemId: string;
  readonly timelineGeneration: number;
  readonly rulesEpoch: number;
  readonly problemEpoch: number;
  readonly officialTrack: ContestOfficialTrack;
  readonly promptCompilerAvailable: boolean;
  readonly aiAssistAvailable: boolean;
  readonly promptContextSha256: string | null;
  readonly availability: ContestProblemAvailability;
  readonly attemptsRemaining: number;
  readonly paused: boolean;
  readonly phase: ContestRulePhase;
  readonly runtimeState: ContestRuntimeState;
  readonly clock: ContestClock;
  readonly scheduleShiftSeconds: number;
  readonly logicalTimeSeconds: number | null;
  readonly nextBoundarySeconds: number | null;
  readonly fetchedAtMs: number;
  readonly judgeProvisional: boolean;
  readonly entrantState: "joined" | "active" | "eliminated" | "completed" | null;
  readonly publicRepositoryWarning: string | null;
}

export function promptProgramBlockedReason(runtime: ContestWorkspaceRuntime): string | null {
  if (runtime.officialTrack.kind !== "prompt-program") return "This contest uses official code submissions.";
  if (!runtime.promptCompilerAvailable) return "The pinned Prompt Compiler is unavailable.";
  if (runtime.promptContextSha256 === null) return "The exact public prompt context is unavailable.";
  if (runtime.paused) return "The contest is paused.";
  if (runtime.entrantState === "eliminated") return "This entrant has been eliminated.";
  if (runtime.availability === "locked") return "This problem has not been released.";
  if (runtime.availability === "closed") return "Official attempts for this problem are closed.";
  if (runtime.attemptsRemaining < 1) return "No official Prompt Program attempts remain.";
  return null;
}
