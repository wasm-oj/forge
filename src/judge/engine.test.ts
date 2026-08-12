import { describe, expect, it, vi } from "vitest";
import { WASM_OJ_CONTRACT_VERSION } from "../core/contract";
import { DEFAULT_DETERMINISM } from "../core/determinism";
import { sha256Hex } from "../core/hash";
import { costProfileId } from "../core/cost-profile";
import { DEFAULT_RESOURCE_POLICY, WEIGHTED_METER_MODEL } from "../core/resources";
import type { BuildArtifact, InteractiveRunResult, RunResult } from "../core/types";
import type { TrustedJudgeProgram } from "../online-judge/trusted-judge-wasm";
import { createJudgeExecutor, JudgeEngine, type JudgeExecutor, type JudgeResolvedInput } from "./engine";
import {
  fileMatcher,
  floatMatcher,
  setMatcher,
  sha256Matcher,
  textMatcher,
  tokenMatcher,
  wasmCheckerMatcher,
  type BatchJudgeCaseSpec,
  type JudgeSpec,
} from "./spec";

const trustedWasm = Uint8Array.from([
  0, 97, 115, 109, 1, 0, 0, 0,
  1, 4, 1, 96, 0, 0,
  3, 2, 1, 0,
  5, 3, 1, 0, 1,
  7, 19, 2, 6, 109, 101, 109, 111, 114, 121, 2, 0, 6, 95, 115, 116, 97, 114, 116, 0, 0,
  10, 4, 1, 2, 0, 11,
]);
const trustedProgram: TrustedJudgeProgram = { runtimeProfile: "c-wasip1-release", wasm: trustedWasm };

const artifact: BuildArtifact = {
  kind: "wasm",
  wasmOjContract: WASM_OJ_CONTRACT_VERSION,
  id: "artifact",
  projectId: "project",
  cacheKey: "cache",
  name: "app.wasm",
  language: "test",
  target: "wasip1",
  optimization: "release",
  createdAt: 0,
  durationMs: 0,
  size: trustedWasm.byteLength,
  toolchains: ["test-toolchain"],
  costProfile: costProfileId("test", "wasip1", "release", "test-toolchain"),
  bytes: trustedWasm,
};

function run(stdout: string, overrides: Partial<RunResult> = {}): RunResult {
  return {
    code: 0,
    stdout,
    stderr: "",
    files: {},
    durationMs: 1,
    determinism: { ...DEFAULT_DETERMINISM },
    resources: { ...DEFAULT_RESOURCE_POLICY },
    termination: "exited",
    metrics: {
      cost: 10,
      rawCost: 13,
      baselineCost: 3,
      costProfile: artifact.costProfile,
      costModel: WEIGHTED_METER_MODEL,
      operations: { I32Const: 1 },
      memoryBytes: 65_536,
      logicalTimeNs: 1_000_000,
      filesystemBytes: 0,
      filesystemEntries: 0,
      stdoutBytes: stdout.length,
      stderrBytes: 0,
    },
    ...overrides,
  };
}

function judgeExecutor(runCase: JudgeExecutor["run"]): JudgeExecutor {
  return {
    run: runCase,
    runTrusted: vi.fn(async () => {
      throw new Error("Trusted judge execution was not expected by this test.");
    }),
    interact: vi.fn(async () => {
      throw new Error("Interactive execution was not expected by this test.");
    }),
  };
}

describe("JudgeEngine", () => {
  it("runs serializable text and WARK-compatible hash matchers", async () => {
    const digest = await sha256Hex("42");
    const executor = judgeExecutor(vi.fn().mockResolvedValue(run("42  \r\n")));
    const judge = new JudgeEngine(executor);
    const spec: JudgeSpec = {
      version: WASM_OJ_CONTRACT_VERSION,
      failFast: false,
      cases: [
        { kind: "batch", id: "text", input: { kind: "inline", value: "" }, matcher: textMatcher("42\n") },
        { kind: "batch", id: "hash", input: { kind: "inline", value: "" }, matcher: sha256Matcher(digest) },
      ],
    };
    const result = await judge.judge(artifact, spec);
    expect(result.verdict).toBe("accepted");
    expect(result.completed).toBe(2);
    expect(result.metrics.cost).toBe(20);
    expect(result.metrics.rawCost).toBe(26);
    expect(result.metrics.baselineCost).toBe(6);
    expect(result.metrics.logicalTimeNs).toBe(2_000_000);
  });

  it("resolves and verifies provider inputs without embedding network access", async () => {
    const input = "private fixture\n";
    const executor = judgeExecutor(vi.fn().mockResolvedValue(run("ok\n")));
    const judge = new JudgeEngine(executor, {
      inputProviders: [{ id: "fixtures", resolve: vi.fn().mockResolvedValue(input) }],
    });
    const result = await judge.judge(artifact, {
      version: WASM_OJ_CONTRACT_VERSION,
      cases: [{
        kind: "batch",
        id: "provider",
        input: { kind: "provider", provider: "fixtures", key: "case-1", sha256: await sha256Hex(input) },
        matcher: textMatcher("ok"),
      }],
    });
    expect(result.verdict).toBe("accepted");
    expect(executor.run).toHaveBeenCalledWith(
      artifact,
      expect.objectContaining({ id: "provider" }),
      { stdin: input, files: {} },
    );
  });

  it("mounts provider-backed input files and matches the exact output file set", async () => {
    const executor = judgeExecutor(vi.fn().mockResolvedValue(run("", {
      files: { "/output/answer.txt": new TextEncoder().encode("42\n") },
    })));
    const judge = new JudgeEngine(executor, {
      inputProviders: [{ id: "fixtures", resolve: vi.fn().mockResolvedValue("40 2\n") }],
    });
    const result = await judge.judge(artifact, {
      version: WASM_OJ_CONTRACT_VERSION,
      cases: [{
        kind: "batch",
        id: "file-io",
        input: { kind: "inline", value: "" },
        files: { "/input/problem.txt": { kind: "provider", provider: "fixtures", key: "input" } },
        outputPaths: ["/output/answer.txt"],
        matcher: fileMatcher({ "/output/answer.txt": "42\n" }),
      }],
    });
    expect(result.verdict).toBe("accepted");
    expect(executor.run).toHaveBeenCalledWith(
      artifact,
      expect.objectContaining({ outputPaths: ["/output/answer.txt"] }),
      { stdin: "", files: { "/input/problem.txt": new TextEncoder().encode("40 2\n") } },
    );
  });

  it("preserves resource termination reasons and stops on failure by default", async () => {
    const executor = judgeExecutor(
      vi.fn().mockResolvedValue(run("", { code: 137, termination: "instruction-limit" })),
    );
    const judge = new JudgeEngine(executor);
    const result = await judge.judge(artifact, {
      version: WASM_OJ_CONTRACT_VERSION,
      cases: [
        { kind: "batch", id: "limited", input: { kind: "inline", value: "" }, matcher: textMatcher("") },
        { kind: "batch", id: "not-run", input: { kind: "inline", value: "" }, matcher: textMatcher("") },
      ],
    });
    expect(result.verdict).toBe("instruction-limit");
    expect(result.completed).toBe(1);
    expect(executor.run).toHaveBeenCalledTimes(1);
  });

  it("bounds aggregate formal-job output and does not retain case I/O", async () => {
    const onOutputBytes = vi.fn();
    const executor = judgeExecutor(vi.fn()
      .mockResolvedValueOnce(run("1234", { stderr: "56" }))
      .mockResolvedValueOnce(run("7890")));
    const result = await new JudgeEngine(executor).judge(artifact, {
      version: WASM_OJ_CONTRACT_VERSION,
      failFast: false,
      cases: [
        { kind: "batch", id: "first", input: { kind: "inline", value: "" }, matcher: textMatcher("1234") },
        { kind: "batch", id: "limited", input: { kind: "inline", value: "" }, matcher: textMatcher("7890") },
        { kind: "batch", id: "not-run", input: { kind: "inline", value: "" }, matcher: textMatcher("") },
      ],
    }, { retention: "metrics-only", aggregateOutputLimitBytes: 8, onOutputBytes });

    expect(executor.run).toHaveBeenCalledTimes(2);
    expect(result.verdict).toBe("output-limit");
    expect(result.cases.map(({ id, verdict }) => ({ id, verdict }))).toEqual([
      { id: "first", verdict: "accepted" },
      { id: "limited", verdict: "output-limit" },
      { id: "not-run", verdict: "output-limit" },
    ]);
    expect(result.cases[0]?.run).toMatchObject({ stdout: "", stderr: "", files: {} });
    expect(result.cases[1]?.run).toMatchObject({ stdout: "", stderr: "", files: {} });
    expect(JSON.stringify(result.cases)).not.toContain("1234");
    expect(JSON.stringify(result.cases)).not.toContain("7890");
    expect(onOutputBytes.mock.calls).toEqual([[6, 6], [4, 10]]);
  });

  it("validates aggregate judge options before executing", async () => {
    const executor = judgeExecutor(vi.fn());
    const spec: JudgeSpec = {
      version: WASM_OJ_CONTRACT_VERSION,
      cases: [{ kind: "batch", id: "case", input: { kind: "inline", value: "" }, matcher: textMatcher("") }],
    };
    await expect(new JudgeEngine(executor).judge(artifact, spec, { aggregateOutputLimitBytes: 0 })).rejects.toThrow("positive safe integer");
    await expect(new JudgeEngine(executor).judge(artifact, spec, { retention: "invalid" as "full" })).rejects.toThrow("retention");
    expect(executor.run).not.toHaveBeenCalled();
  });

  it("counts UTF-8, output files, and trusted matcher subprocess output at the exact boundary", async () => {
    const executor = judgeExecutor(vi.fn().mockResolvedValue(run("界", {
      files: { "/answer.bin": new Uint8Array([1, 2]) },
    })));
    const judge = new JudgeEngine(executor, {
      matchers: [{
        id: "bounded-checker",
        async match() { return { accepted: true, auxiliaryOutputBytes: 3 }; },
      }],
    });
    const spec: JudgeSpec = {
      version: WASM_OJ_CONTRACT_VERSION,
      cases: [{
        kind: "batch",
        id: "bounded",
        input: { kind: "inline", value: "" },
        outputPaths: ["/answer.bin"],
        matcher: { id: "bounded-checker", config: {} },
      }],
    };
    await expect(judge.judge(artifact, spec, { aggregateOutputLimitBytes: 8 })).resolves.toMatchObject({ verdict: "accepted" });
    await expect(judge.judge(artifact, spec, { aggregateOutputLimitBytes: 7 })).resolves.toMatchObject({ verdict: "output-limit" });
  });

  it("keeps judge-error authoritative, stops immediately, and strips trap diagnostics before callbacks", async () => {
    const callback = vi.fn();
    const executor = judgeExecutor(vi.fn()
      .mockResolvedValueOnce(run("large", { trapMessage: "SECRET_TRAP" }))
      .mockRejectedValueOnce(new Error("SECRET_JUDGE_FAILURE")));
    const result = await new JudgeEngine(executor).judge(artifact, {
      version: WASM_OJ_CONTRACT_VERSION,
      failFast: false,
      cases: [
        { kind: "batch", id: "first", input: { kind: "inline", value: "" }, matcher: textMatcher("large") },
        { kind: "batch", id: "judge", input: { kind: "inline", value: "" }, matcher: textMatcher("") },
        { kind: "batch", id: "not-run", input: { kind: "inline", value: "" }, matcher: textMatcher("") },
      ],
    }, { retention: "metrics-only", aggregateOutputLimitBytes: 100, onCase: callback });

    expect(result.verdict).toBe("judge-error");
    expect(result.completed).toBe(2);
    expect(executor.run).toHaveBeenCalledTimes(2);
    expect(callback).toHaveBeenCalledTimes(2);
    const encoded = JSON.stringify(callback.mock.calls);
    expect(encoded).not.toContain("SECRET_TRAP");
    expect(encoded).not.toContain("SECRET_JUDGE_FAILURE");
  });

  it("preserves logical-time-limit independently from the emergency wall deadline", async () => {
    const executor = judgeExecutor(
      vi.fn().mockResolvedValue(run("", { code: 137, termination: "logical-time-limit" })),
    );
    const result = await new JudgeEngine(executor).judge(artifact, {
      version: WASM_OJ_CONTRACT_VERSION,
      cases: [
        { kind: "batch", id: "logical-time", input: { kind: "inline", value: "" }, matcher: textMatcher("") },
      ],
    });

    expect(result.verdict).toBe("logical-time-limit");
    expect(result.completed).toBe(1);
  });

  it("surfaces filesystem-limit and aggregates peak VFS occupancy", async () => {
    const executor = judgeExecutor(vi.fn().mockResolvedValue(run("", {
      code: 137,
      termination: "filesystem-limit",
      metrics: {
        ...run("").metrics,
        filesystemBytes: 4,
        filesystemEntries: 1,
      },
    })));
    const result = await new JudgeEngine(executor).judge(artifact, {
      version: WASM_OJ_CONTRACT_VERSION,
      cases: [{
        kind: "batch",
        id: "filesystem-limited",
        input: { kind: "inline", value: "" },
        matcher: textMatcher(""),
      }],
    });

    expect(result.verdict).toBe("filesystem-limit");
    expect(result.metrics.maxFilesystemBytes).toBe(4);
    expect(result.metrics.maxFilesystemEntries).toBe(1);
  });

  it("supports downstream custom matchers", async () => {
    const judge = new JudgeEngine(judgeExecutor(vi.fn().mockResolvedValue(run("value=42\n"))), {
      matchers: [{
        id: "contains",
        async match(spec, context) {
          return { accepted: context.stdout.includes(String(spec.config.needle)) };
        },
      }],
    });
    const result = await judge.judge(artifact, {
      version: WASM_OJ_CONTRACT_VERSION,
      cases: [{
        kind: "batch",
        id: "custom",
        input: { kind: "inline", value: "" },
        matcher: { id: "contains", config: { needle: "42" } },
      }],
    });
    expect(result.verdict).toBe("accepted");
  });

  it("supports token, floating-point, set, and multiset policies", async () => {
    const executor = judgeExecutor(vi.fn()
      .mockResolvedValueOnce(run("42   answer\n"))
      .mockResolvedValueOnce(run("3.1415927 stable\n"))
      .mockResolvedValueOnce(run("blue red blue\n"))
      .mockResolvedValueOnce(run("blue red blue\n")));
    const result = await new JudgeEngine(executor).judge(artifact, {
      version: WASM_OJ_CONTRACT_VERSION,
      failFast: false,
      cases: [
        { kind: "batch", id: "tokens", input: { kind: "inline", value: "" }, matcher: tokenMatcher("42 answer") },
        { kind: "batch", id: "float", input: { kind: "inline", value: "" }, matcher: floatMatcher("3.1415926 stable", 1e-6, 0) },
        { kind: "batch", id: "set", input: { kind: "inline", value: "" }, matcher: setMatcher("red blue") },
        { kind: "batch", id: "multiset", input: { kind: "inline", value: "" }, matcher: setMatcher("blue blue red", true) },
      ],
    });
    expect(result.verdict).toBe("accepted");
  });

  it("executes a Wasm checker through the same sandbox executor", async () => {
    const runCase = vi.fn(async () => run("candidate output\n"));
    const runTrusted = vi.fn(async (
      program: TrustedJudgeProgram,
      caseSpec: BatchJudgeCaseSpec,
      input: JudgeResolvedInput,
    ) => {
      void program;
      void caseSpec;
      void input;
      return run("accepted by checker\n");
    });
    const executor: JudgeExecutor = {
      run: runCase,
      runTrusted,
      interact: vi.fn(async () => { throw new Error("Interactive execution was not expected."); }),
    };
    const result = await new JudgeEngine(executor).judge(artifact, {
      version: WASM_OJ_CONTRACT_VERSION,
      cases: [{
        kind: "batch",
        id: "custom-checker",
        input: { kind: "inline", value: "input\n" },
        matcher: wasmCheckerMatcher(trustedProgram, "expected\n", ["--strict"], {
          "/checker/assets/policy.bin": new Uint8Array([0, 255, 1]),
        }),
      }],
    });
    expect(result.verdict).toBe("accepted");
    expect(runCase).toHaveBeenCalledTimes(1);
    expect(runTrusted).toHaveBeenCalledTimes(1);
    expect(runTrusted.mock.calls[0]?.[0]).toEqual(trustedProgram);
    expect(runTrusted.mock.calls[0]?.[2]).toMatchObject({
      files: {
        "/checker/input.txt": new TextEncoder().encode("input\n"),
        "/checker/expected.txt": new TextEncoder().encode("expected\n"),
        "/checker/actual.txt": new TextEncoder().encode("candidate output\n"),
        "/checker/assets/policy.bin": new Uint8Array([0, 255, 1]),
      },
    });
  });

  it("runs an interactive case through the shared runner contract without exposing secret input to the contestant", async () => {
    const interaction: InteractiveRunResult = {
      contestant: {
        code: 0,
        stderr: "",
        termination: "exited",
        metrics: run("").metrics,
      },
      interactor: {
        code: 0,
        stderr: "",
        termination: "exited",
        metrics: run("").metrics,
      },
      contestantToInteractor: "42\n",
      interactorToContestant: "41\n",
      durationMs: 2,
      determinism: DEFAULT_DETERMINISM,
    };
    const interact = vi.fn().mockResolvedValue(interaction);
    const executor = createJudgeExecutor({
      run: vi.fn(async () => run("")),
      interact,
      runTrusted: vi.fn(async () => run("")),
      interactTrusted: interact,
    });
    const result = await new JudgeEngine(executor, {
      inputProviders: [{ id: "fixtures", resolve: vi.fn().mockResolvedValue("secret file\n") }],
    }).judge(artifact, {
      version: WASM_OJ_CONTRACT_VERSION,
      cases: [{
        kind: "interactive",
        id: "dialogue",
        input: { kind: "inline", value: "41\n" },
        files: {
          "/judge/secret.txt": { kind: "provider", provider: "fixtures", key: "secret" },
          "/judge/binary.dat": { kind: "inline-bytes", value: new Uint8Array([0, 255, 1]) },
        },
        contestant: { args: ["--contestant"] },
        interactor: {
          program: trustedProgram,
          inputPath: "/judge/input.txt",
          args: ["/judge/input.txt"],
        },
      }],
    });

    expect(result.verdict).toBe("accepted");
    expect(result.cases[0]?.interaction).toBe(interaction);
    expect(result.metrics.cost).toBe(interaction.contestant.metrics.cost);
    expect(interact).toHaveBeenCalledWith(
      artifact,
      trustedProgram,
      expect.objectContaining({
        contestant: expect.not.objectContaining({ files: expect.anything() }),
        interactor: expect.objectContaining({
          args: ["/judge/input.txt"],
          files: {
            "/judge/input.txt": new TextEncoder().encode("41\n"),
            "/judge/secret.txt": new TextEncoder().encode("secret file\n"),
            "/judge/binary.dat": new Uint8Array([0, 255, 1]),
          },
        }),
      }),
    );
  });

  it("counts and redacts both interactive protocol directions and process diagnostics", async () => {
    const metrics = run("").metrics;
    const interaction: InteractiveRunResult = {
      contestant: { code: 0, stderr: "é", termination: "exited", metrics },
      interactor: { code: 0, stderr: "i", termination: "exited", metrics },
      contestantToInteractor: "ab",
      interactorToContestant: "cd",
      durationMs: 1,
      determinism: DEFAULT_DETERMINISM,
    };
    const executor: JudgeExecutor = {
      run: vi.fn(),
      runTrusted: vi.fn(),
      interact: vi.fn().mockResolvedValue(interaction),
    };
    const spec: JudgeSpec = {
      version: WASM_OJ_CONTRACT_VERSION,
      cases: [{
        kind: "interactive",
        id: "interactive-output",
        input: { kind: "inline", value: "" },
        interactor: { program: trustedProgram, inputPath: "/judge/input.txt" },
      }],
    };
    const accepted = await new JudgeEngine(executor).judge(artifact, spec, {
      retention: "metrics-only",
      aggregateOutputLimitBytes: 7,
    });
    expect(accepted.verdict).toBe("accepted");
    expect(accepted.cases[0]?.interaction).toMatchObject({
      contestant: { stderr: "" },
      interactor: { stderr: "" },
      contestantToInteractor: "",
      interactorToContestant: "",
    });
    await expect(new JudgeEngine(executor).judge(artifact, spec, {
      retention: "metrics-only",
      aggregateOutputLimitBytes: 6,
    })).resolves.toMatchObject({ verdict: "output-limit" });
  });

  it("validates every case before running any user program", async () => {
    const executor = judgeExecutor(vi.fn().mockResolvedValue(run("ok")));
    const judge = new JudgeEngine(executor);
    const invalid: JudgeSpec = {
      version: WASM_OJ_CONTRACT_VERSION,
      cases: [
        { kind: "batch", id: "valid", input: { kind: "inline", value: "" }, matcher: textMatcher("ok") },
        { kind: "batch", id: " padded", input: { kind: "inline", value: "" }, matcher: textMatcher("ok") },
      ],
    };

    await expect(judge.judge(artifact, invalid)).rejects.toThrow("trimmed");
    expect(executor.run).not.toHaveBeenCalled();
  });

  it("rejects malformed serializable judge fields", async () => {
    const judge = new JudgeEngine(judgeExecutor(vi.fn().mockResolvedValue(run(""))));
    const baseCase = { kind: "batch" as const, id: "case", input: { kind: "inline" as const, value: "" }, matcher: textMatcher("") };

    await expect(judge.judge(artifact, {
      version: WASM_OJ_CONTRACT_VERSION,
      cases: [{ ...baseCase, matcher: { id: "text", config: null as never } }],
    })).rejects.toThrow("matcher config");
    await expect(judge.judge(artifact, {
      version: WASM_OJ_CONTRACT_VERSION,
      cases: [{ ...baseCase, args: [1] as never }],
    })).rejects.toThrow("array of strings");
    await expect(judge.judge(artifact, {
      version: WASM_OJ_CONTRACT_VERSION,
      cases: [{ ...baseCase, env: { KEY: "bad\0value" } }],
    })).rejects.toThrow("NUL-free");
  });

  it("requires canonical registry identifiers", () => {
    const judge = new JudgeEngine(judgeExecutor(vi.fn().mockResolvedValue(run(""))));
    expect(() => judge.registerMatcher({ id: " padded", match: vi.fn() })).toThrow("trimmed");
    expect(() => judge.registerInputProvider({ id: "", resolve: vi.fn() })).toThrow("non-empty");
    expect(() => judge.registerMatcher({ id: "broken" } as never)).toThrow("implementing match()");
    expect(() => judge.registerInputProvider({ id: "broken" } as never)).toThrow("implementing resolve()");
  });
});
