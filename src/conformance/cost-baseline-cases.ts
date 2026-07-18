import { costProfileId } from "../core/cost-profile.ts";
import { LANGUAGES, type BuiltinLanguage, type Language, type OptimizationLevel, type TargetAbi } from "../core/types.ts";
import { TOOLCHAINS } from "../core/toolchains.ts";
import type { CompileInput } from "../sdk/project.ts";

export const COST_BASELINE_SEEDS = [0, 1, 42, 0x5eed_1234, 0xffff_ffff] as const;

export interface CostBaselineCalibrationCase {
  profile: string;
  language: Language;
  target: TargetAbi;
  optimization: OptimizationLevel;
  input: CompileInput;
}

const EMPTY_PROGRAMS: Record<BuiltinLanguage, { entry: string; source: string }> = {
  c: { entry: "src/main.c", source: "int main(void){return 0;}\n" },
  cpp: { entry: "src/main.cpp", source: "int main(){return 0;}\n" },
  rust: { entry: "src/main.rs", source: "fn main() {}\n" },
  python: { entry: "src/main.py", source: "" },
  javascript: { entry: "src/main.js", source: "" },
  typescript: { entry: "src/main.ts", source: "" },
  go: { entry: "src/main.go", source: "package main\nfunc main() {}\n" },
};

export const COST_BASELINE_CALIBRATION_CASES: readonly CostBaselineCalibrationCase[] = LANGUAGES.flatMap(
  (language) => TOOLCHAINS[language].targets.flatMap((target) => (
    (["debug", "release"] as const).map((optimization) => {
      const empty = EMPTY_PROGRAMS[language];
      return {
        profile: costProfileId(language, target, optimization),
        language,
        target,
        optimization,
        input: {
          language,
          target,
          optimization,
          entry: empty.entry,
          files: { [empty.entry]: empty.source },
          name: `empty-${language}-${target}-${optimization}`,
          projectId: `cost-baseline:${language}:${target}:${optimization}`,
        },
      };
    })
  )),
);
