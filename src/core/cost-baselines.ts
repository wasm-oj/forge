import { costProfileId } from "./cost-profile";
import { toolchainContentIdentity } from "./toolchains";

/** Measured weighted cost of an empty Java main for the pinned TeaVM profile. */
export const JAVA_EMPTY_PROGRAM_BASELINE_COST = Object.freeze({ debug: 2907, release: 2419 });

const javaContent = toolchainContentIdentity("java");

/** Default baselines shipped with this exact compiler/runtime distribution. */
export const DEFAULT_COST_BASELINES = Object.freeze<Record<string, number>>({
  [costProfileId("java", "wasip1", "debug", javaContent)]: JAVA_EMPTY_PROGRAM_BASELINE_COST.debug,
  [costProfileId("java", "wasip1", "release", javaContent)]: JAVA_EMPTY_PROGRAM_BASELINE_COST.release,
});
