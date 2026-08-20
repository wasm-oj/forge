import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DEFAULT_CONFORMANCE_CASES, FULL_CONFORMANCE_CASES } from "../conformance/cases";
import { runConformanceHost, type ConformanceSnapshot } from "../conformance/matrix";
import { sourceTreeProvenance } from "../conformance/provenance";
import { WASM_OJ_CONTRACT_VERSION, WASM_OJ_SCHEMAS } from "../core/contract";
import { JAVA_EMPTY_PROGRAM_BASELINE_COST } from "../core/cost-baselines";
import { createEngine, type Engine } from "../sdk/engine";
import { ServerCompiler } from "./server-compiler";
import { ServerRunner } from "./server-runner";
import { testToolchains } from "./test-toolchains.test-helper";

const enabled = process.env.WASM_OJ_RUN_CONFORMANCE === "1";
const EXPERIMENT_ID = `wasm-oj-contract-${WASM_OJ_CONTRACT_VERSION}-conformance`;
const SPEC_PATH = path.resolve(`experiments/${EXPERIMENT_ID}/SPEC.md`);
const RAW_DIRECTORY = path.resolve(`experiments/${EXPERIMENT_ID}/runs/raw/records`);

describe.skipIf(!enabled)("real server conformance snapshot", () => {
  let engine: Engine;
  let cacheDirectory: string;
  let removeProgress: (() => void) | undefined;

  beforeAll(async () => {
    execFileSync("cargo", [
      "build", "--locked", "--manifest-path", "crates/runtime-core/Cargo.toml", "--release",
      "--bin", "wasm-oj-runner", "--bin", "wasm-oj-compiler",
    ], { stdio: "pipe" });
    cacheDirectory = await mkdtemp(path.join(os.tmpdir(), "wasm-oj-conformance-"));
    engine = await createEngine({
      compiler: new ServerCompiler({
        compilerExecutable: path.resolve("crates/runtime-core/target/release/wasm-oj-compiler"),
        toolchains: testToolchains(),
      }),
      runner: new ServerRunner({
        runtimeExecutable: path.resolve("crates/runtime-core/target/release/wasm-oj-runner"),
        toolchains: testToolchains(),
        cacheDirectory,
      }),
    });
    removeProgress = engine.onProgress((progress) => {
      process.stderr.write(`[${progress.phase}] ${progress.label}\n`);
    });
  }, 300_000);

  afterAll(async () => {
    removeProgress?.();
    engine?.dispose();
    if (cacheDirectory) await rm(cacheDirectory, { recursive: true, force: true });
  });

  it("compiles and replays every declared language/target case", { timeout: 1_800_000 }, async () => {
    const repetitions = Number(process.env.WASM_OJ_CONFORMANCE_REPETITIONS ?? "3");
    const requestedCases = process.env.WASM_OJ_CONFORMANCE_CASES?.split(",").filter(Boolean);
    const suite = process.env.WASM_OJ_CONFORMANCE_SUITE === "full"
      ? FULL_CONFORMANCE_CASES
      : DEFAULT_CONFORMANCE_CASES;
    const cases = requestedCases?.length
      ? FULL_CONFORMANCE_CASES.filter((item) => requestedCases.includes(item.id))
      : suite;
    if (cases.length === 0) throw new Error("WASM_OJ_CONFORMANCE_CASES did not match a declared case.");
    const snapshot: ConformanceSnapshot = await runConformanceHost({
      id: "server-native",
      compile: (input, options) => engine.compile(input, options),
      run: (artifact, options) => engine.run(artifact, options),
    }, cases, {
      repetitions,
      repeatCompile: true,
      onSample(sample, completed, total) {
        process.stderr.write(`[${completed}/${total}] ${sample.caseId}: ${sample.success ? "pass" : `fail: ${sample.error}`}\n`);
      },
    });
    const spec = await readFile(SPEC_PATH);
    const runId = `${new Date().toISOString().replaceAll(":", "-")}-${randomUUID()}`;
    const record = {
      schema: WASM_OJ_SCHEMAS.conformanceEvidence,
      experimentId: EXPERIMENT_ID,
      runId,
      collectedAt: new Date().toISOString(),
      wasmOjContract: WASM_OJ_CONTRACT_VERSION,
      suite: process.env.WASM_OJ_CONFORMANCE_SUITE === "full" ? "full" : "default",
      specPath: path.relative(process.cwd(), SPEC_PATH),
      specSha256: createHash("sha256").update(spec).digest("hex"),
      executionCommand: "pnpm run conformance:server",
      gitHead: git("rev-parse", "HEAD"),
      worktreeStatus: git("status", "--short"),
      sourceTree: await sourceTreeProvenance(),
      environment: {
        platform: process.platform,
        architecture: process.arch,
        node: process.version,
        cpu: os.cpus()[0]?.model ?? "unknown",
      },
      snapshot,
    };
    await mkdir(RAW_DIRECTORY, { recursive: true });
    const output = path.join(RAW_DIRECTORY, `${runId}.json`);
    await writeFile(output, `${JSON.stringify(record, null, 2)}\n`, { flag: "wx" });
    process.stdout.write(`WASM_OJ_CONFORMANCE_EVIDENCE=${output}\n`);
    expect(snapshot.samples.filter((sample) => !sample.success)).toEqual([]);
    for (const sample of snapshot.samples.filter((item) => item.caseId.startsWith("java-"))) {
      const metrics = sample.transcript?.metrics;
      expect(metrics).toMatchObject({ baselineCost: JAVA_EMPTY_PROGRAM_BASELINE_COST });
      expect(metrics?.rawCost).toBe((metrics?.cost ?? 0) + (metrics?.baselineCost ?? 0));
    }
  });
});

function git(...args: string[]): string {
  try {
    return execFileSync("git", args, { encoding: "utf8" }).trim();
  } catch {
    return "unavailable";
  }
}
