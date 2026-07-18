import type { ConformanceReport, ConformanceSample } from "./matrix.ts";
import { FORGE_CONTRACT_ID } from "../core/contract.ts";

export const CONFORMANCE_SUMMARY_START = "<!-- forge-conformance-summary:start -->";
export const CONFORMANCE_SUMMARY_END = "<!-- forge-conformance-summary:end -->";
export const CONFORMANCE_MATRIX_START = "<!-- forge-conformance-matrix:start -->";
export const CONFORMANCE_MATRIX_END = "<!-- forge-conformance-matrix:end -->";

const SERVER_HOST = "server-native";
const BROWSER_HOST = "browser-wasmer-js";
const REPORT_TIME_ZONE = "Asia/Taipei";

/** Replace only the evidence-derived blocks, leaving explanatory prose intact. */
export function renderConformanceReportEvidence(
  markdown: string,
  report: ConformanceReport,
  collectedAt: readonly string[],
): string {
  assertPublishable(report);
  const date = latestEvidenceDate(collectedAt);
  const summary = [
    `This report records real local server and browser runs on ${date}`,
    `(${REPORT_TIME_ZONE}). The canonical matrix is generated from independent append-only`,
    `evidence records under \`${FORGE_CONTRACT_ID}\`; it is not a synthetic estimate.`,
  ].join("\n");
  return replaceMarkedBlock(
    replaceMarkedBlock(
      markdown,
      CONFORMANCE_SUMMARY_START,
      CONFORMANCE_SUMMARY_END,
      summary,
    ),
    CONFORMANCE_MATRIX_START,
    CONFORMANCE_MATRIX_END,
    renderMatrix(report),
  );
}

function renderMatrix(report: ConformanceReport): string {
  const serverSamples = samplesForHost(report, SERVER_HOST);
  const browserSamples = samplesForHost(report, BROWSER_HOST);
  const browserByCase = new Map(browserSamples.map((sample) => [sample.caseId, sample]));
  if (browserByCase.size !== browserSamples.length) throw new Error(`Duplicate ${BROWSER_HOST} case in conformance report.`);
  if (serverSamples.length !== browserSamples.length) throw new Error("Conformance hosts reported different case counts.");

  const rows = serverSamples.map((server) => {
    const browser = browserByCase.get(server.caseId);
    if (!browser) throw new Error(`Missing ${BROWSER_HOST} sample for '${server.caseId}'.`);
    if (server.caseLabel !== browser.caseLabel) throw new Error(`Cross-host case label mismatch for '${server.caseId}'.`);
    if (server.artifactDigest !== browser.artifactDigest || server.artifactBytes !== browser.artifactBytes) {
      throw new Error(`Cross-host artifact mismatch for '${server.caseId}'.`);
    }
    const metrics = requiredTranscript(server).metrics;
    return [
      requiredString(server.caseLabel, "case label"),
      `\`${abbreviateDigest(requiredString(server.artifactDigest, "artifact digest"))}\``,
      formatInteger(requiredNumber(server.artifactBytes, "artifact bytes")),
      [
        formatInteger(requiredNumber(metrics.cost, "net cost")),
        formatInteger(requiredNumber(metrics.rawCost, "raw cost")),
        formatInteger(metrics.baselineCost),
      ].join(" / "),
      formatTimingPair(server),
      formatTimingPair(browser),
      `${formatMilliseconds(server.runMedianMs)} / ${formatMilliseconds(browser.runMedianMs)}`,
    ];
  });
  if (browserByCase.size !== rows.length) throw new Error(`Unexpected ${BROWSER_HOST} case in conformance report.`);

  return [
    `All ${formatCount(rows.length)} declared language/target cases passed independently in`,
    `\`${SERVER_HOST}\` and \`${BROWSER_HOST}\`. The canonical comparison contains zero`,
    "mismatches: every artifact digest and every deterministic transcript field is",
    "identical across hosts. Timing remains observational and is excluded from",
    "compatibility.",
    "",
    "| Case | Artifact | Bytes | Net / raw / baseline | Server compile 1 / 2 | Browser compile 1 / 2 | Median run server / browser |",
    "| --- | --- | ---: | ---: | ---: | ---: | ---: |",
    ...rows.map((row) => `| ${row.join(" | ")} |`),
  ].join("\n");
}

function assertPublishable(report: ConformanceReport): void {
  if (!report.compatible || report.mismatches.length > 0 || report.samples.some((sample) => !sample.success)) {
    throw new Error("Cannot render a conformance report from incompatible evidence.");
  }
}

function samplesForHost(report: ConformanceReport, host: string): ConformanceSample[] {
  const samples = report.samples.filter((sample) => sample.host === host);
  if (samples.length === 0) throw new Error(`Conformance report is missing host '${host}'.`);
  if (new Set(samples.map((sample) => sample.caseId)).size !== samples.length) {
    throw new Error(`Duplicate ${host} case in conformance report.`);
  }
  return samples;
}

function latestEvidenceDate(values: readonly string[]): string {
  if (values.length === 0) throw new Error("Conformance evidence has no collection timestamps.");
  const instants = values.map((value) => {
    const instant = new Date(value);
    if (!value || Number.isNaN(instant.valueOf())) throw new Error(`Invalid evidence timestamp '${value}'.`);
    return instant;
  });
  const latest = new Date(Math.max(...instants.map((instant) => instant.valueOf())));
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: REPORT_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(latest);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((item) => item.type === type)?.value;
  const year = part("year");
  const month = part("month");
  const day = part("day");
  if (!year || !month || !day) throw new Error("Could not format the conformance evidence date.");
  return `${year}-${month}-${day}`;
}

function replaceMarkedBlock(markdown: string, start: string, end: string, contents: string): string {
  const startIndex = markdown.indexOf(start);
  const endIndex = markdown.indexOf(end);
  if (startIndex < 0 || endIndex < 0 || endIndex <= startIndex) {
    throw new Error(`Conformance report is missing the '${start}'/'${end}' marker pair.`);
  }
  if (markdown.indexOf(start, startIndex + start.length) >= 0 || markdown.indexOf(end, endIndex + end.length) >= 0) {
    throw new Error(`Conformance report contains a duplicate '${start}'/'${end}' marker.`);
  }
  const before = markdown.slice(0, startIndex + start.length);
  const after = markdown.slice(endIndex);
  return `${before}\n${contents.trim()}\n${after}`;
}

function requiredTranscript(sample: ConformanceSample): NonNullable<ConformanceSample["transcript"]> {
  if (!sample.transcript) throw new Error(`Conformance sample '${sample.caseId}' has no transcript.`);
  return sample.transcript;
}

function requiredString(value: string | undefined, label: string): string {
  if (!value) throw new Error(`Conformance sample is missing ${label}.`);
  return value;
}

function requiredNumber(value: number | null | undefined, label = "numeric evidence"): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`Conformance sample has invalid ${label}.`);
  return value;
}

function formatTimingPair(sample: ConformanceSample): string {
  return `${formatMilliseconds(sample.firstUncachedCompileMs)} / ${formatMilliseconds(sample.repeatUncachedCompileMs)}`;
}

function formatMilliseconds(value: number | undefined): string {
  return `${formatInteger(requiredNumber(value, "timing"))} ms`;
}

function formatInteger(value: number): string {
  return Math.round(value).toLocaleString("en-US");
}

function abbreviateDigest(value: string): string {
  if (!/^[0-9a-f]{64}$/.test(value)) throw new Error(`Invalid artifact digest '${value}'.`);
  return `${value.slice(0, 8)}…${value.slice(-5)}`;
}

function formatCount(value: number): string {
  const names = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"];
  return names[value] ?? String(value);
}
