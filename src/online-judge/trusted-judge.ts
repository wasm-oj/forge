import { WASM_OJ_CONTRACT_VERSION } from "../core/contract";
import type { JudgeSpec } from "../judge/spec";
import { textMatcher, wasmCheckerMatcher } from "../judge/spec";
import type { JudgeData, JudgePolicy } from "./judge-data";
import type { TrustedJudgeExecutable } from "./judge-package";
import type { TrustedJudgeProgram } from "./trusted-judge-wasm";

function resources(data: JudgeData, policy: JudgePolicy) {
  return {
    instructionBudget: policy.limits.instructionBudget,
    memoryLimitBytes: policy.limits.memoryLimitBytes,
    wallTimeLimitMs: data.scoring.safetyLimits.wallTimeLimitMs,
    ...(policy.limits.logicalTimeLimitMs === undefined ? {} : {
      logicalTimeLimitMs: policy.limits.logicalTimeLimitMs,
    }),
  };
}

function program(executable: Exclude<TrustedJudgeExecutable, { readonly kind: "text" }>): TrustedJudgeProgram {
  return { runtimeProfile: executable.runtimeProfile, wasm: executable.artifact.slice() };
}

function assets(executable: Exclude<TrustedJudgeExecutable, { readonly kind: "text" }>): Record<string, Uint8Array> {
  return Object.fromEntries(executable.assets.map((asset) => [asset.guestPath, asset.bytes.slice()]));
}

/** Build the runtime judge spec directly from verified WOJJDG02 execution data. */
export function trustedJudgeSpec(data: JudgeData, executable: TrustedJudgeExecutable): JudgeSpec {
  const broadest = data.scoring.policies[0];
  if (!broadest) throw new TypeError("Judge package has no resource policy.");
  const executionResources = resources(data, broadest);
  if (executable.kind === "text") {
    return {
      version: WASM_OJ_CONTRACT_VERSION,
      failFast: false,
      cases: data.cases.map((testCase) => ({
        kind: "batch",
        id: testCase.id,
        input: { kind: "inline", value: testCase.input },
        matcher: textMatcher(testCase.output, "lines"),
        args: [],
        env: {},
        resources: executionResources,
      })),
    };
  }
  const trustedProgram = program(executable);
  const trustedAssets = assets(executable);
  if (executable.kind === "checker") {
    return {
      version: WASM_OJ_CONTRACT_VERSION,
      failFast: false,
      cases: data.cases.map((testCase) => ({
        kind: "batch",
        id: testCase.id,
        input: { kind: "inline", value: testCase.input },
        matcher: wasmCheckerMatcher(trustedProgram, testCase.output, executable.args, trustedAssets),
        args: [],
        env: {},
        resources: executionResources,
      })),
    };
  }
  const files = Object.fromEntries(Object.entries(trustedAssets).map(([path, bytes]) => [
    path,
    { kind: "inline-bytes" as const, value: bytes },
  ]));
  return {
    version: WASM_OJ_CONTRACT_VERSION,
    failFast: false,
    cases: data.cases.map((testCase) => ({
      kind: "interactive",
      id: testCase.id,
      input: { kind: "inline", value: testCase.input },
      files,
      contestant: { args: [], env: {}, resources: executionResources },
      interactor: {
        program: trustedProgram,
        args: [...executable.args],
        env: {},
        resources: executionResources,
        inputPath: executable.inputPath,
      },
    })),
  };
}
