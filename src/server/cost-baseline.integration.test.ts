import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  COST_BASELINE_CALIBRATION_CASES,
  COST_BASELINE_SEEDS,
} from "../conformance/cost-baseline-cases";
import { artifactDigest } from "../conformance/matrix";
import { sourceTreeProvenance } from "../conformance/provenance";
import { FORGE_CONTRACT_VERSION, FORGE_SCHEMAS } from "../core/contract";
import { DEFAULT_DETERMINISM } from "../core/determinism";
import { DEFAULT_RESOURCE_POLICY, WEIGHTED_METER_MODEL } from "../core/resources";
import { CostBaselineRegistry } from "../core/cost";
import { createDefaultRuntimeDrivers } from "../runner/artifact";
import { createForgeEngine } from "../sdk/engine";
import { ServerForgeCompiler } from "./server-compiler";
import { ServerForgeRunner } from "./server-runner";

const enabled = process.env.FORGE_RUN_COST_BASELINE === "1";
const EXPERIMENT_ID = `forge-contract-${FORGE_CONTRACT_VERSION}-cost-baseline`;
const SPEC_PATH = path.resolve(`experiments/${EXPERIMENT_ID}/SPEC.md`);
const RAW_DIRECTORY = path.resolve(`experiments/${EXPERIMENT_ID}/runs/raw/records`);

describe.skipIf(!enabled)("empty-program raw cost calibration", () => {
  it("records every profile and determinism seed as append-only evidence", { timeout: 1_800_000 }, async () => {
    execFileSync("cargo", [
      "build", "--locked", "--manifest-path", "crates/runtime-core/Cargo.toml", "--release",
      "--bin", "forge-runner", "--bin", "forge-compiler",
    ], { stdio: "pipe" });
    const panel = process.env.FORGE_COST_BASELINE_PANEL === "smoke" ? "smoke" : "primary";
    const cases = panel === "smoke"
      ? COST_BASELINE_CALIBRATION_CASES.filter((item) => item.optimization === "release")
      : COST_BASELINE_CALIBRATION_CASES;
    const seeds = panel === "smoke" ? [DEFAULT_DETERMINISM.randomSeed] : [...COST_BASELINE_SEEDS];
    const calibrationBaselines = panel === "primary"
      ? new CostBaselineRegistry(Object.fromEntries(cases.map((item) => [item.profile, 0])))
      : undefined;
    const runId = `${new Date().toISOString().replaceAll(":", "-")}-${randomUUID()}`;
    const cacheDirectory = await mkdtemp(path.join(os.tmpdir(), "forge-cost-baseline-"));
    const engine = await createForgeEngine({
      compiler: new ServerForgeCompiler({
        compilerExecutable: path.resolve("crates/runtime-core/target/release/forge-compiler"),
        toolchainDirectory: path.resolve("public/toolchains"),
      }),
      runner: new ServerForgeRunner({
        runtimeExecutable: path.resolve("crates/runtime-core/target/release/forge-runner"),
        toolchainDirectory: path.resolve("public/toolchains"),
        cacheDirectory,
        ...(calibrationBaselines
          ? { runtimeDrivers: createDefaultRuntimeDrivers(calibrationBaselines) }
          : {}),
      }),
    });
    const profiles: unknown[] = [];
    try {
      for (const [index, item] of cases.entries()) {
        process.stderr.write(`[${index + 1}/${cases.length}] ${item.profile}\n`);
        let compiled;
        try {
          compiled = await engine.compile(item.input, { cache: false });
        } catch (error) {
          profiles.push({
            ...profileIdentity(item),
            status: "build-threw",
            error: error instanceof Error ? error.message : String(error),
          });
          continue;
        }
        if (!compiled.success || !compiled.artifact) {
          profiles.push({
            ...profileIdentity(item),
            status: "build-failed",
            diagnostics: compiled.diagnostics,
            stdout: compiled.stdout,
            stderr: compiled.stderr,
          });
          continue;
        }
        const observations: unknown[] = [];
        for (const seed of seeds) {
          try {
            const run = await engine.run(compiled.artifact, {
              determinism: { ...DEFAULT_DETERMINISM, randomSeed: seed },
              resources: { ...DEFAULT_RESOURCE_POLICY, instructionBudget: 50_000_000_000 },
            });
            observations.push({
              seed,
              status: run.code === 0
                && run.termination === "exited"
                && !run.stdout
                && !run.stderr
                && (panel === "primary"
                  ? run.metrics.cost === run.metrics.rawCost && run.metrics.baselineCost === 0
                  : run.metrics.cost === 0 && run.metrics.rawCost === run.metrics.baselineCost)
                ? "ok"
                : "unexpected-result",
              netCostPoints: run.metrics.cost,
              rawCostPoints: run.metrics.rawCost,
              appliedBaselineCostPoints: run.metrics.baselineCost,
              costProfile: run.metrics.costProfile,
              costModel: run.metrics.costModel,
              operations: run.metrics.operations,
              code: run.code,
              termination: run.termination,
              stdout: run.stdout,
              stderr: run.stderr,
              determinism: run.determinism,
              resources: run.resources,
            });
          } catch (error) {
            observations.push({
              seed,
              status: "run-failed",
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }
        profiles.push({
          ...profileIdentity(item),
          status: "built",
          artifactDigest: await artifactDigest(compiled.artifact),
          artifactBytes: compiled.artifact.size,
          toolchains: compiled.artifact.toolchains,
          artifactCostProfile: compiled.artifact.costProfile,
          observations,
        });
      }
    } finally {
      engine.dispose();
      await rm(cacheDirectory, { recursive: true, force: true });
    }

    const spec = await readFile(SPEC_PATH);
    const record = {
      schema: FORGE_SCHEMAS.costBaselineRaw,
      experimentId: EXPERIMENT_ID,
      runId,
      panel,
      collectedAt: new Date().toISOString(),
      specPath: path.relative(process.cwd(), SPEC_PATH),
      specSha256: sha256(spec),
      executionCommand: panel === "smoke"
        ? "FORGE_COST_BASELINE_PANEL=smoke pnpm run cost-baseline:calibrate"
        : "pnpm run cost-baseline:calibrate",
      gitHead: git("rev-parse", "HEAD"),
      worktreeStatus: git("status", "--short"),
      sourceTree: await sourceTreeProvenance(),
      environment: {
        platform: process.platform,
        architecture: process.arch,
        node: process.version,
        cpu: os.cpus()[0]?.model ?? "unknown",
      },
      contracts: {
        forge: FORGE_CONTRACT_VERSION,
        meter: WEIGHTED_METER_MODEL,
      },
      seeds,
      profiles,
    };
    await mkdir(RAW_DIRECTORY, { recursive: true });
    const output = path.join(RAW_DIRECTORY, `${runId}.json`);
    await writeFile(output, `${JSON.stringify(record, null, 2)}\n`, { flag: "wx" });
    process.stdout.write(`FORGE_COST_BASELINE_RAW=${output}\n`);

    const failed = profiles.filter((value) => {
      const profile = value as { status: string; observations?: Array<{ status: string }> };
      return profile.status !== "built" || profile.observations?.some((item) => item.status !== "ok");
    });
    expect(failed).toEqual([]);
  });
});

function profileIdentity(item: (typeof COST_BASELINE_CALIBRATION_CASES)[number]) {
  return {
    profile: item.profile,
    language: item.language,
    target: item.target,
    optimization: item.optimization,
  };
}

function sha256(value: Uint8Array | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function git(...args: string[]): string {
  try {
    return execFileSync("git", args, { encoding: "utf8" }).trim();
  } catch {
    return "unavailable";
  }
}
