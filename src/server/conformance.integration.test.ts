import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DEFAULT_CONFORMANCE_CASES, FULL_CONFORMANCE_CASES } from "../conformance/cases";
import { runConformanceHost, type ConformanceSnapshot } from "../conformance/matrix";
import { sourceTreeProvenance } from "../conformance/provenance";
import { FORGE_CONTRACT_VERSION, FORGE_SCHEMAS } from "../core/contract";
import { createForgeEngine, type ForgeEngine } from "../sdk/engine";
import { ServerForgeCompiler } from "./server-compiler";
import { ServerForgeRunner } from "./server-runner";

const enabled = process.env.FORGE_RUN_CONFORMANCE === "1";
const EXPERIMENT_ID = `forge-contract-${FORGE_CONTRACT_VERSION}-conformance`;
const SPEC_PATH = path.resolve(`experiments/${EXPERIMENT_ID}/SPEC.md`);
const RAW_DIRECTORY = path.resolve(`experiments/${EXPERIMENT_ID}/runs/raw/records`);

describe.skipIf(!enabled)("real server conformance snapshot", () => {
  let engine: ForgeEngine;
  let cacheDirectory: string;
  let removeProgress: (() => void) | undefined;

  beforeAll(async () => {
    execFileSync("cargo", [
      "build", "--locked", "--manifest-path", "crates/runtime-core/Cargo.toml", "--release",
      "--bin", "forge-runner", "--bin", "forge-compiler",
    ], { stdio: "pipe" });
    cacheDirectory = await mkdtemp(path.join(os.tmpdir(), "forge-conformance-"));
    engine = await createForgeEngine({
      compiler: new ServerForgeCompiler({
        compilerExecutable: path.resolve("crates/runtime-core/target/release/forge-compiler"),
        toolchainDirectory: path.resolve("public/toolchains"),
      }),
      runner: new ServerForgeRunner({
        runtimeExecutable: path.resolve("crates/runtime-core/target/release/forge-runner"),
        toolchainDirectory: path.resolve("public/toolchains"),
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
    const repetitions = Number(process.env.FORGE_CONFORMANCE_REPETITIONS ?? "3");
    const requestedCases = process.env.FORGE_CONFORMANCE_CASES?.split(",").filter(Boolean);
    const suite = process.env.FORGE_CONFORMANCE_SUITE === "full"
      ? FULL_CONFORMANCE_CASES
      : DEFAULT_CONFORMANCE_CASES;
    const cases = requestedCases?.length
      ? FULL_CONFORMANCE_CASES.filter((item) => requestedCases.includes(item.id))
      : suite;
    if (cases.length === 0) throw new Error("FORGE_CONFORMANCE_CASES did not match a declared case.");
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
      schema: FORGE_SCHEMAS.conformanceEvidence,
      experimentId: EXPERIMENT_ID,
      runId,
      collectedAt: new Date().toISOString(),
      forgeContract: FORGE_CONTRACT_VERSION,
      suite: process.env.FORGE_CONFORMANCE_SUITE === "full" ? "full" : "default",
      specPath: path.relative(process.cwd(), SPEC_PATH),
      specSha256: createHash("sha256").update(spec).digest("hex"),
      executionCommand: "npm run conformance:server",
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
    process.stdout.write(`FORGE_CONFORMANCE_EVIDENCE=${output}\n`);
    expect(snapshot.samples.filter((sample) => !sample.success)).toEqual([]);
  });
});

function git(...args: string[]): string {
  try {
    return execFileSync("git", args, { encoding: "utf8" }).trim();
  } catch {
    return "unavailable";
  }
}
