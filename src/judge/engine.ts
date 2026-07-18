import { resolveDeterminism } from "../core/determinism";
import { sha256Hex } from "../core/hash";
import { resolveResourcePolicy } from "../core/resources";
import { assertValidBuildArtifact } from "../core/artifact-validation";
import type {
  BuildArtifact,
  DeterminismConfig,
  InteractiveProgramConfig,
  InteractiveRunResult,
  RunResult,
} from "../core/types";
import { normalizeOutput, type OutputNormalization } from "./normalization";
import {
  validateJudgeSpec,
  type BatchJudgeCaseSpec,
  type InteractiveJudgeCaseSpec,
  type JudgeCaseSpec,
  type JudgeInputSpec,
  type JudgeMatcherSpec,
  type JudgeProgramSpec,
  type JudgeSpec,
} from "./spec";

export type JudgeCaseVerdict =
  | "accepted"
  | "wrong-answer"
  | "runtime-error"
  | "instruction-limit"
  | "memory-limit"
  | "output-limit"
  | "filesystem-limit"
  | "logical-time-limit"
  | "wall-time-limit"
  | "judge-error";

export interface JudgeMatchResult {
  accepted: boolean;
  message?: string;
}

export interface JudgeMatcherContext {
  case: BatchJudgeCaseSpec;
  artifact: BuildArtifact;
  stdin: string;
  run: RunResult;
  stdout: string;
  stderr: string;
  files: Readonly<Record<string, Uint8Array>>;
}

export interface JudgeMatcher {
  readonly id: string;
  match(spec: JudgeMatcherSpec, context: JudgeMatcherContext): Promise<JudgeMatchResult>;
}

export interface JudgeInputProvider {
  readonly id: string;
  resolve(input: Extract<JudgeInputSpec, { kind: "provider" }>, caseSpec: JudgeCaseSpec): Promise<string>;
}

export interface JudgeCaseResult {
  id: string;
  verdict: JudgeCaseVerdict;
  message?: string;
  run?: RunResult;
  interaction?: InteractiveRunResult;
}

export interface JudgeResult {
  verdict: JudgeCaseVerdict | "accepted";
  completed: number;
  total: number;
  cases: JudgeCaseResult[];
  metrics: {
    cost: number | null;
    rawCost: number | null;
    baselineCost: number;
    logicalTimeNs: number | null;
    maxMemoryBytes: number | null;
    maxFilesystemBytes: number | null;
    maxFilesystemEntries: number | null;
    stdoutBytes: number | null;
    stderrBytes: number | null;
  };
}

export interface JudgeExecutor {
  run(artifact: BuildArtifact, caseSpec: BatchJudgeCaseSpec, input: JudgeResolvedInput): Promise<RunResult>;
  interact(
    contestant: BuildArtifact,
    caseSpec: InteractiveJudgeCaseSpec,
    input: JudgeResolvedInput,
  ): Promise<InteractiveRunResult>;
}

export interface JudgeResolvedInput {
  stdin: string;
  files: Readonly<Record<string, Uint8Array>>;
}

export interface JudgeEngineOptions {
  inputProviders?: readonly JudgeInputProvider[];
  matchers?: readonly JudgeMatcher[];
}

export interface JudgeRunOptions {
  onCase?(result: JudgeCaseResult, completed: number, total: number): void | Promise<void>;
}

export class JudgeEngine {
  private readonly executor: JudgeExecutor;
  private readonly inputs = new Map<string, JudgeInputProvider>();
  private readonly matchers = new Map<string, JudgeMatcher>();

  constructor(executor: JudgeExecutor, options: JudgeEngineOptions = {}) {
    this.executor = executor;
    this.registerMatcher(textOutputMatcher);
    this.registerMatcher(sha256OutputMatcher);
    this.registerMatcher(fileOutputMatcher);
    this.registerMatcher(tokenOutputMatcher);
    this.registerMatcher(floatOutputMatcher);
    this.registerMatcher(setOutputMatcher);
    this.registerMatcher(wasmCheckerOutputMatcher(this.executor));
    for (const provider of options.inputProviders ?? []) this.registerInputProvider(provider);
    for (const matcher of options.matchers ?? []) this.registerMatcher(matcher);
  }

  registerInputProvider(provider: JudgeInputProvider): void {
    if (!provider || typeof provider !== "object" || typeof provider.resolve !== "function") {
      throw new TypeError("Judge input providers must be objects implementing resolve().");
    }
    registerUnique(this.inputs, provider.id, provider, "input provider");
  }

  registerMatcher(matcher: JudgeMatcher): void {
    if (!matcher || typeof matcher !== "object" || typeof matcher.match !== "function") {
      throw new TypeError("Judge matchers must be objects implementing match().");
    }
    registerUnique(this.matchers, matcher.id, matcher, "matcher");
  }

  async judge(artifact: BuildArtifact, spec: JudgeSpec, options: JudgeRunOptions = {}): Promise<JudgeResult> {
    assertValidBuildArtifact(artifact);
    validateJudgeSpec(spec);
    const cases: JudgeCaseResult[] = [];
    for (const caseSpec of spec.cases) {
      const result = await this.runCase(artifact, caseSpec);
      cases.push(result);
      await options.onCase?.(result, cases.length, spec.cases.length);
      if ((spec.failFast ?? true) && result.verdict !== "accepted") break;
    }
    return summarize(cases, spec.cases.length);
  }

  private async runCase(artifact: BuildArtifact, caseSpec: JudgeCaseSpec): Promise<JudgeCaseResult> {
    try {
      const input = await this.resolveInput(caseSpec);
      if (caseSpec.kind === "interactive") {
        const interaction = await this.executor.interact(artifact, caseSpec, input);
        const verdict = interactiveVerdict(interaction);
        return {
          id: caseSpec.id,
          verdict,
          ...(verdict === "wrong-answer" ? { message: interaction.interactor.stderr.trim() || "Interactor rejected the protocol." } : {}),
          interaction,
        };
      }
      const run = await this.executor.run(artifact, caseSpec, input);
      const termination = terminationVerdict(run);
      if (termination) return { id: caseSpec.id, verdict: termination, run };
      const matcher = this.matchers.get(caseSpec.matcher.id);
      if (!matcher) throw new Error(`No judge matcher is registered for '${caseSpec.matcher.id}'.`);
      const matched = await matcher.match(caseSpec.matcher, {
        case: caseSpec,
        artifact,
        stdin: input.stdin,
        run,
        stdout: run.stdout,
        stderr: run.stderr,
        files: run.files,
      });
      return {
        id: caseSpec.id,
        verdict: matched.accepted ? "accepted" : "wrong-answer",
        message: matched.message,
        run,
      };
    } catch (error) {
      return {
        id: caseSpec.id,
        verdict: "judge-error",
        message: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private async resolveInput(caseSpec: JudgeCaseSpec): Promise<JudgeResolvedInput> {
    const stdin = await this.resolveInputSpec(caseSpec.input, caseSpec);
    const files: Record<string, Uint8Array> = {};
    for (const [path, input] of Object.entries(caseSpec.files ?? {}).sort(([left], [right]) => left.localeCompare(right))) {
      files[path] = new TextEncoder().encode(await this.resolveInputSpec(input, caseSpec));
    }
    return { stdin, files };
  }

  private async resolveInputSpec(input: JudgeInputSpec, caseSpec: JudgeCaseSpec): Promise<string> {
    if (input.kind === "inline") return input.value;
    const provider = this.inputs.get(input.provider);
    if (!provider) throw new Error(`No judge input provider is registered for '${input.provider}'.`);
    const value = await provider.resolve(input, caseSpec);
    if (input.sha256 && await sha256Hex(value) !== input.sha256.toLowerCase()) {
      throw new Error(`Input provider '${provider.id}' returned data with the wrong SHA-256 digest.`);
    }
    return value;
  }
}

export interface JudgeExecutionAdapter {
  run(artifact: BuildArtifact, options: {
    args: readonly string[];
    stdin: string;
    env: Readonly<Record<string, string>>;
    files: Record<string, Uint8Array>;
    outputPaths: string[];
    cwd?: string;
    determinism: ReturnType<typeof resolveDeterminism>;
    resources: ReturnType<typeof resolveResourcePolicy>;
  }): Promise<RunResult>;
  interact(
    contestant: BuildArtifact,
    interactor: BuildArtifact,
    options: {
      contestant: InteractiveProgramConfig;
      interactor: InteractiveProgramConfig;
      determinism: DeterminismConfig;
    },
  ): Promise<InteractiveRunResult>;
}

export function createJudgeExecutor(adapter: JudgeExecutionAdapter): JudgeExecutor {
  return {
    run: (artifact, caseSpec, input) => adapter.run(artifact, {
      args: caseSpec.args ?? [],
      stdin: input.stdin,
      env: caseSpec.env ?? {},
      files: cloneFiles(input.files),
      outputPaths: [...(caseSpec.outputPaths ?? [])],
      ...(caseSpec.cwd === undefined ? {} : { cwd: caseSpec.cwd }),
      determinism: resolveDeterminism(caseSpec.determinism),
      resources: resolveResourcePolicy(caseSpec.resources),
    }),
    interact: (contestant, caseSpec, input) => {
      const interactorFiles: Record<string, Uint8Array> = {
        ...cloneFiles(input.files),
        [caseSpec.interactor.inputPath]: new TextEncoder().encode(input.stdin),
      };
      return adapter.interact(contestant, caseSpec.interactor.artifact, {
        contestant: judgeProgramConfig(caseSpec.contestant),
        interactor: {
          ...judgeProgramConfig(caseSpec.interactor),
          files: interactorFiles,
        },
        determinism: resolveDeterminism(caseSpec.determinism),
      });
    },
  };
}

function judgeProgramConfig(spec: JudgeProgramSpec = {}): InteractiveProgramConfig {
  return {
    args: [...(spec.args ?? [])],
    env: { ...(spec.env ?? {}) },
    ...(spec.cwd === undefined ? {} : { cwd: spec.cwd }),
    resources: resolveResourcePolicy(spec.resources),
  };
}

function cloneFiles(files: Readonly<Record<string, Uint8Array>>): Record<string, Uint8Array> {
  return Object.fromEntries(Object.entries(files).map(([path, contents]) => [path, contents.slice()]));
}

const textOutputMatcher: JudgeMatcher = {
  id: "text",
  async match(spec, context) {
    const expected = requiredString(spec, "expected");
    const normalization = normalizationFrom(spec);
    const actual = normalizeOutput(context.stdout, normalization);
    const normalizedExpected = normalizeOutput(expected, normalization);
    return actual === normalizedExpected
      ? { accepted: true }
      : { accepted: false, message: `Output mismatch: expected ${JSON.stringify(normalizedExpected)}, received ${JSON.stringify(actual)}.` };
  },
};

const sha256OutputMatcher: JudgeMatcher = {
  id: "sha256",
  async match(spec, context) {
    const digest = requiredString(spec, "digest").toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(digest)) throw new Error("sha256 matcher requires a 64-character hexadecimal digest.");
    const actual = await sha256Hex(normalizeOutput(context.stdout, normalizationFrom(spec)));
    return actual === digest
      ? { accepted: true }
      : { accepted: false, message: `Output SHA-256 mismatch: expected ${digest}, received ${actual}.` };
  },
};

const fileOutputMatcher: JudgeMatcher = {
  id: "files",
  async match(spec, context) {
    const expected = spec.config.expected;
    if (!expected || typeof expected !== "object" || Array.isArray(expected)) {
      throw new Error("files matcher requires record config 'expected'.");
    }
    const normalization = normalizationFrom(spec);
    const expectedRecord = expected as Record<string, unknown>;
    const expectedPaths = Object.keys(expectedRecord).sort();
    const actualPaths = Object.keys(context.files).sort();
    if (JSON.stringify(actualPaths) !== JSON.stringify(expectedPaths)) {
      return { accepted: false, message: `Output file set mismatch: expected ${expectedPaths.join(", ")}, received ${actualPaths.join(", ")}.` };
    }
    const decoder = new TextDecoder("utf-8", { fatal: true });
    for (const path of expectedPaths) {
      const expectedContents = expectedRecord[path];
      if (typeof expectedContents !== "string") throw new Error(`Expected contents for '${path}' must be a string.`);
      const actual = normalizeOutput(decoder.decode(context.files[path]), normalization);
      const wanted = normalizeOutput(expectedContents, normalization);
      if (actual !== wanted) return { accepted: false, message: `Output file '${path}' mismatch.` };
    }
    return { accepted: true };
  },
};

const tokenOutputMatcher: JudgeMatcher = {
  id: "tokens",
  async match(spec, context) {
    const expected = tokens(requiredString(spec, "expected"));
    const actual = tokens(context.stdout);
    return arraysEqual(actual, expected)
      ? { accepted: true }
      : { accepted: false, message: `Token mismatch: expected ${expected.length} tokens, received ${actual.length}.` };
  },
};

const floatOutputMatcher: JudgeMatcher = {
  id: "float",
  async match(spec, context) {
    const expected = tokens(requiredString(spec, "expected"));
    const actual = tokens(context.stdout);
    const absoluteTolerance = requiredTolerance(spec, "absoluteTolerance");
    const relativeTolerance = requiredTolerance(spec, "relativeTolerance");
    if (actual.length !== expected.length) {
      return { accepted: false, message: `Float token count mismatch: expected ${expected.length}, received ${actual.length}.` };
    }
    for (let index = 0; index < expected.length; index += 1) {
      const wanted = parseFiniteNumber(expected[index]!);
      const received = parseFiniteNumber(actual[index]!);
      if (wanted === undefined || received === undefined) {
        if (actual[index] !== expected[index]) return { accepted: false, message: `Token ${index + 1} is not equal.` };
        continue;
      }
      const difference = Math.abs(received - wanted);
      const tolerance = Math.max(absoluteTolerance, relativeTolerance * Math.abs(wanted));
      if (difference > tolerance) {
        return { accepted: false, message: `Float token ${index + 1} differs by ${difference}, exceeding ${tolerance}.` };
      }
    }
    return { accepted: true };
  },
};

const setOutputMatcher: JudgeMatcher = {
  id: "set",
  async match(spec, context) {
    const multiplicity = spec.config.multiplicity;
    if (typeof multiplicity !== "boolean") throw new Error("set matcher requires boolean config 'multiplicity'.");
    const normalize = (value: string): string[] => {
      const values = tokens(value).sort();
      return multiplicity ? values : [...new Set(values)];
    };
    const expected = normalize(requiredString(spec, "expected"));
    const actual = normalize(context.stdout);
    return arraysEqual(actual, expected)
      ? { accepted: true }
      : { accepted: false, message: `${multiplicity ? "Multiset" : "Set"} output mismatch.` };
  },
};

function wasmCheckerOutputMatcher(executor: JudgeExecutor): JudgeMatcher {
  return {
    id: "wasm-checker",
    async match(spec, context) {
      const checker = spec.config.checker;
      assertValidBuildArtifact(checker);
      if (checker.kind !== "wasm") throw new Error("Custom checker artifact must be a standalone Wasm module.");
      const expected = requiredString(spec, "expected");
      const configuredArgs = spec.config.args;
      if (!Array.isArray(configuredArgs) || configuredArgs.some((value) => typeof value !== "string")) {
        throw new Error("wasm-checker matcher requires string array config 'args'.");
      }
      const files: Record<string, Uint8Array> = {
        "/checker/input.txt": new TextEncoder().encode(context.stdin),
        "/checker/expected.txt": new TextEncoder().encode(expected),
        "/checker/actual.txt": new TextEncoder().encode(context.stdout),
        "/checker/stderr.txt": new TextEncoder().encode(context.stderr),
      };
      for (const [path, contents] of Object.entries(context.files)) files[`/checker/files${path}`] = contents.slice();
      const checkerCase: BatchJudgeCaseSpec = {
        kind: "batch",
        id: `${context.case.id}:checker`,
        input: { kind: "inline", value: "" },
        matcher: { id: "text", config: { expected: "" } },
        args: [
          "/checker/input.txt",
          "/checker/expected.txt",
          "/checker/actual.txt",
          "/checker/stderr.txt",
          ...configuredArgs,
        ],
        env: {},
        determinism: context.case.determinism,
        resources: context.case.resources,
      };
      const result = await executor.run(checker, checkerCase, { stdin: "", files });
      if (result.termination !== "exited" || (result.code !== 0 && result.code !== 1)) {
        throw new Error(`Custom checker failed with ${result.termination} and exit code ${result.code}: ${result.stderr.trim()}`);
      }
      return result.code === 0
        ? { accepted: true, ...(result.stdout.trim() ? { message: result.stdout.trim() } : {}) }
        : { accepted: false, message: result.stdout.trim() || result.stderr.trim() || "Custom checker rejected the output." };
    },
  };
}

function tokens(value: string): string[] {
  const trimmed = value.trim();
  return trimmed ? trimmed.split(/\s+/u) : [];
}

function arraysEqual(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function requiredTolerance(spec: JudgeMatcherSpec, key: string): number {
  const value = spec.config[key];
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(`float matcher requires finite non-negative config '${key}'.`);
  }
  return value;
}

function parseFiniteNumber(value: string): number | undefined {
  if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function requiredString(spec: JudgeMatcherSpec, key: string): string {
  const value = spec.config[key];
  if (typeof value !== "string") throw new Error(`${spec.id} matcher requires string config '${key}'.`);
  return value;
}

function normalizationFrom(spec: JudgeMatcherSpec): OutputNormalization {
  const value = spec.config.normalization ?? (spec.id === "sha256" ? "trimmed-lines" : "lines");
  if (value !== "exact" && value !== "lines" && value !== "trimmed-lines") {
    throw new Error(`Unsupported output normalization '${String(value)}'.`);
  }
  return value;
}

function terminationVerdict(run: RunResult): JudgeCaseVerdict | undefined {
  if (run.termination === "exited" && run.code === 0) return undefined;
  if (run.termination === "exited" || run.termination === "trap") return "runtime-error";
  return run.termination;
}

function interactiveVerdict(result: InteractiveRunResult): JudgeCaseVerdict {
  const contestantTermination = interactiveContestantTerminationVerdict(result);
  if (contestantTermination && contestantTermination !== "runtime-error") return contestantTermination;
  if (result.interactor.termination !== "exited") return "judge-error";
  if (result.interactor.code === 1) return "wrong-answer";
  if (result.interactor.code !== 0) return "judge-error";
  return contestantTermination ?? "accepted";
}

function interactiveContestantTerminationVerdict(
  result: InteractiveRunResult,
): Exclude<JudgeCaseVerdict, "accepted" | "wrong-answer" | "judge-error"> | undefined {
  const { contestant } = result;
  if (contestant.termination === "exited" && contestant.code === 0) return undefined;
  if (contestant.termination === "exited" || contestant.termination === "trap") return "runtime-error";
  return contestant.termination;
}

function registerUnique<T>(registry: Map<string, T>, id: string, value: T, label: string): void {
  if (typeof id !== "string" || !id || id !== id.trim() || id.length > 128) {
    throw new Error(`Judge ${label} IDs must be non-empty, trimmed strings of at most 128 characters.`);
  }
  if (registry.has(id)) throw new Error(`Judge ${label} '${id}' is already registered.`);
  registry.set(id, value);
}

function summarize(cases: JudgeCaseResult[], total: number): JudgeResult {
  const metrics = cases.flatMap((item) => item.run
    ? [item.run.metrics]
    : item.interaction
      ? [item.interaction.contestant.metrics]
      : []);
  const sum = (values: Array<number | null>) => values.some((value) => value === null)
    ? null
    : values.reduce<number>((totalValue, value) => totalValue + (value ?? 0), 0);
  const maximum = (values: Array<number | null>) => values.some((value) => value === null)
    ? null
    : Math.max(0, ...values.map((value) => value ?? 0));
  return {
    verdict: cases.find((item) => item.verdict !== "accepted")?.verdict ?? "accepted",
    completed: cases.length,
    total,
    cases,
    metrics: {
      cost: sum(metrics.map((value) => value.cost)),
      rawCost: sum(metrics.map((value) => value.rawCost)),
      baselineCost: metrics.reduce((totalValue, value) => totalValue + value.baselineCost, 0),
      logicalTimeNs: sum(metrics.map((value) => value.logicalTimeNs)),
      maxMemoryBytes: maximum(metrics.map((value) => value.memoryBytes)),
      maxFilesystemBytes: maximum(metrics.map((value) => value.filesystemBytes)),
      maxFilesystemEntries: maximum(metrics.map((value) => value.filesystemEntries)),
      stdoutBytes: sum(metrics.map((value) => value.stdoutBytes)),
      stderrBytes: sum(metrics.map((value) => value.stderrBytes)),
    },
  };
}
