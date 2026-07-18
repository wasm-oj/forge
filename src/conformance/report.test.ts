import { describe, expect, it } from "vitest";
import type { ConformanceReport, ConformanceSample } from "./matrix";
import {
  CONFORMANCE_MATRIX_END,
  CONFORMANCE_MATRIX_START,
  CONFORMANCE_SUMMARY_END,
  CONFORMANCE_SUMMARY_START,
  renderConformanceReportEvidence,
} from "./report";

const digest = "a".repeat(64);

function sample(host: string, first: number, repeat: number, run: number): ConformanceSample {
  return {
    host,
    caseId: "c-wasip1",
    caseLabel: "C / wasip1",
    success: true,
    artifactDigest: digest,
    artifactBytes: 1_234,
    firstUncachedCompileMs: first,
    repeatUncachedCompileMs: repeat,
    runMedianMs: run,
    diagnostics: [],
    transcript: {
      code: 0,
      stdout: "42\n",
      stderr: "",
      files: {},
      termination: "exited",
      determinism: {
        randomSeed: 0,
        realtimeEpochMs: 946_684_800_000,
        clockStepNs: 1_000_000,
      },
      resources: {
        instructionBudget: 10_000,
        logicalTimeLimitMs: 1_000,
        memoryLimitBytes: 65_536,
        outputLimitBytes: 4_096,
        filesystemWriteLimitBytes: 65_536,
        filesystemEntryLimit: 16,
        wallTimeLimitMs: 1_000,
      },
      metrics: {
        cost: 7,
        rawCost: 10,
        baselineCost: 3,
        costProfile: "profile",
        costModel: "weighted",
        operations: {},
        memoryBytes: 65_536,
        logicalTimeNs: 1_000_000,
        filesystemBytes: 0,
        filesystemEntries: 0,
        stdoutBytes: 3,
        stderrBytes: 0,
      },
    },
  };
}

function report(): ConformanceReport {
  const samples = [
    sample("server-native", 100.4, 50.6, 3.2),
    sample("browser-wasmer-js", 80.2, 40.1, 2.9),
  ];
  return {
    compatible: true,
    repetitions: 3,
    samples,
    mismatches: [],
    efficiency: samples.map((item) => ({
      caseId: item.caseId,
      host: item.host,
      firstUncachedCompileMs: item.firstUncachedCompileMs,
      repeatUncachedCompileMs: item.repeatUncachedCompileMs,
      runMedianMs: item.runMedianMs,
      artifactBytes: item.artifactBytes,
      netWeightedCost: item.transcript!.metrics.cost,
      rawWeightedCost: item.transcript!.metrics.rawCost,
      baselineWeightedCost: item.transcript!.metrics.baselineCost,
    })),
  };
}

const template = [
  "# Report",
  "",
  CONFORMANCE_SUMMARY_START,
  "stale summary",
  CONFORMANCE_SUMMARY_END,
  "",
  "This prose must remain byte-identical.",
  "",
  CONFORMANCE_MATRIX_START,
  "stale matrix",
  CONFORMANCE_MATRIX_END,
  "",
  "Tail prose.",
  "",
].join("\n");

describe("conformance evidence report", () => {
  it("deterministically replaces evidence blocks and preserves prose", () => {
    const rendered = renderConformanceReportEvidence(template, report(), [
      "2026-07-17T15:59:59.000Z",
      "2026-07-17T16:00:00.000Z",
    ]);

    expect(rendered).toContain("runs on 2026-07-18\n(Asia/Taipei)");
    expect(rendered).toContain("This prose must remain byte-identical.");
    expect(rendered).toContain("Tail prose.");
    expect(rendered).toContain("| C / wasip1 | `aaaaaaaa…aaaaa` | 1,234 | 7 / 10 / 3 | 100 ms / 51 ms | 80 ms / 40 ms | 3 ms / 3 ms |");
    expect(renderConformanceReportEvidence(rendered, report(), ["2026-07-17T16:00:00.000Z"])).toBe(rendered);
  });

  it("refuses to render incompatible evidence", () => {
    const incompatible = report();
    incompatible.compatible = false;
    expect(() => renderConformanceReportEvidence(template, incompatible, ["2026-07-17T16:00:00.000Z"]))
      .toThrow("incompatible evidence");
  });

  it("fails closed when the tracked report markers are absent", () => {
    expect(() => renderConformanceReportEvidence("# Report\n", report(), ["2026-07-17T16:00:00.000Z"]))
      .toThrow("marker pair");
  });
});
