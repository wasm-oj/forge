import { describe, expect, it, vi } from "vitest";
import { FORGE_CONTRACT_VERSION } from "../core/contract";
import { DEFAULT_DETERMINISM } from "../core/determinism";
import { sha256Hex } from "../core/hash";
import { costProfileId } from "../core/cost-profile";
import { DEFAULT_RESOURCE_POLICY, WEIGHTED_METER_MODEL } from "../core/resources";
import type { BuildArtifact, InteractiveRunResult, RunResult } from "../core/types";
import { createJudgeExecutor, JudgeEngine, type JudgeExecutor } from "./engine";
import {
  fileMatcher,
  floatMatcher,
  setMatcher,
  sha256Matcher,
  textMatcher,
  tokenMatcher,
  wasmCheckerMatcher,
  type JudgeSpec,
} from "./spec";

const artifact: BuildArtifact = {
  kind: "wasm",
  forgeContract: FORGE_CONTRACT_VERSION,
  id: "artifact",
  projectId: "project",
  cacheKey: "cache",
  name: "app.wasm",
  language: "test",
  target: "wasip1",
  optimization: "release",
  createdAt: 0,
  durationMs: 0,
  size: 8,
  toolchains: ["test-toolchain"],
  costProfile: costProfileId("test", "wasip1", "release", "test-toolchain"),
  bytes: new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]),
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
      version: FORGE_CONTRACT_VERSION,
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
      version: FORGE_CONTRACT_VERSION,
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
      version: FORGE_CONTRACT_VERSION,
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
      version: FORGE_CONTRACT_VERSION,
      cases: [
        { kind: "batch", id: "limited", input: { kind: "inline", value: "" }, matcher: textMatcher("") },
        { kind: "batch", id: "not-run", input: { kind: "inline", value: "" }, matcher: textMatcher("") },
      ],
    });
    expect(result.verdict).toBe("instruction-limit");
    expect(result.completed).toBe(1);
    expect(executor.run).toHaveBeenCalledTimes(1);
  });

  it("preserves logical-time-limit independently from the emergency wall deadline", async () => {
    const executor = judgeExecutor(
      vi.fn().mockResolvedValue(run("", { code: 137, termination: "logical-time-limit" })),
    );
    const result = await new JudgeEngine(executor).judge(artifact, {
      version: FORGE_CONTRACT_VERSION,
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
      version: FORGE_CONTRACT_VERSION,
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
      version: FORGE_CONTRACT_VERSION,
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
      version: FORGE_CONTRACT_VERSION,
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
    const checker: BuildArtifact = {
      ...artifact,
      id: "checker",
      cacheKey: "checker-cache",
      name: "checker.wasm",
      language: "checker",
      toolchains: ["checker-test"],
      costProfile: costProfileId("checker", "wasip1", "release", "checker-test"),
    };
    const runCase = vi.fn(async (selected: BuildArtifact, ...rest: unknown[]) => {
      void rest;
      return selected.id === "checker" ? run("accepted by checker\n") : run("candidate output\n");
    });
    const executor = judgeExecutor(runCase);
    const result = await new JudgeEngine(executor).judge(artifact, {
      version: FORGE_CONTRACT_VERSION,
      cases: [{
        kind: "batch",
        id: "custom-checker",
        input: { kind: "inline", value: "input\n" },
        matcher: wasmCheckerMatcher(checker, "expected\n", ["--strict"]),
      }],
    });
    expect(result.verdict).toBe("accepted");
    expect(runCase).toHaveBeenCalledTimes(2);
    expect(runCase.mock.calls[1]?.[0]).toBe(checker);
    expect(runCase.mock.calls[1]?.[2]).toMatchObject({
      files: {
        "/checker/input.txt": new TextEncoder().encode("input\n"),
        "/checker/expected.txt": new TextEncoder().encode("expected\n"),
        "/checker/actual.txt": new TextEncoder().encode("candidate output\n"),
      },
    });
  });

  it("runs an interactive case through the shared runner contract without exposing secret input to the contestant", async () => {
    const interactor: BuildArtifact = {
      ...artifact,
      id: "interactor",
      cacheKey: "interactor-cache",
      name: "interactor.wasm",
      language: "interactor",
      toolchains: ["interactor-test"],
      costProfile: costProfileId("interactor", "wasip1", "release", "interactor-test"),
    };
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
        metrics: { ...run("").metrics, costProfile: interactor.costProfile },
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
    });
    const result = await new JudgeEngine(executor, {
      inputProviders: [{ id: "fixtures", resolve: vi.fn().mockResolvedValue("secret file\n") }],
    }).judge(artifact, {
      version: FORGE_CONTRACT_VERSION,
      cases: [{
        kind: "interactive",
        id: "dialogue",
        input: { kind: "inline", value: "41\n" },
        files: { "/judge/secret.txt": { kind: "provider", provider: "fixtures", key: "secret" } },
        contestant: { args: ["--contestant"] },
        interactor: {
          artifact: interactor,
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
      interactor,
      expect.objectContaining({
        contestant: expect.not.objectContaining({ files: expect.anything() }),
        interactor: expect.objectContaining({
          args: ["/judge/input.txt"],
          files: {
            "/judge/input.txt": new TextEncoder().encode("41\n"),
            "/judge/secret.txt": new TextEncoder().encode("secret file\n"),
          },
        }),
      }),
    );
  });

  it("validates every case before running any user program", async () => {
    const executor = judgeExecutor(vi.fn().mockResolvedValue(run("ok")));
    const judge = new JudgeEngine(executor);
    const invalid: JudgeSpec = {
      version: FORGE_CONTRACT_VERSION,
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
      version: FORGE_CONTRACT_VERSION,
      cases: [{ ...baseCase, matcher: { id: "text", config: null as never } }],
    })).rejects.toThrow("matcher config");
    await expect(judge.judge(artifact, {
      version: FORGE_CONTRACT_VERSION,
      cases: [{ ...baseCase, args: [1] as never }],
    })).rejects.toThrow("array of strings");
    await expect(judge.judge(artifact, {
      version: FORGE_CONTRACT_VERSION,
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
