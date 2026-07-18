import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { publishEvidenceFiles } from "./evidence-publication.mjs";
import { compareConformanceSnapshots, type ConformanceSnapshot } from "../src/conformance/matrix.ts";
import { sourceTreeProvenance } from "../src/conformance/provenance.ts";
import { renderConformanceReportEvidence } from "../src/conformance/report.ts";
import { FORGE_CONTRACT_VERSION, FORGE_SCHEMAS } from "../src/core/contract.ts";

const inputs = process.argv.slice(2);
const EXPERIMENT_ID = `forge-contract-${FORGE_CONTRACT_VERSION}-conformance`;
const SPEC_PATH = path.resolve(`experiments/${EXPERIMENT_ID}/SPEC.md`);
if (inputs.length !== 2) {
  throw new Error("Usage: node --experimental-strip-types scripts/compare-conformance.ts <server-record.json> <browser-record.json>");
}

const records = await Promise.all(inputs.map(async (input) => {
  const file = path.resolve(input);
  const bytes = await readFile(file);
  const value = JSON.parse(bytes.toString("utf8")) as {
    schema: string;
    experimentId: string;
    forgeContract: number;
    specSha256: string;
    collectedAt: string;
    sourceTree: { algorithm: string; sha256: string; files: number };
    failure?: unknown;
    consoleErrors?: unknown;
    pageErrors?: unknown;
    environment?: { browser?: unknown };
    networkProof?: {
      policy?: unknown;
      serviceWorkers?: unknown;
      allowedOrigin?: unknown;
      localBaseUrl?: unknown;
      httpRequests?: unknown;
      violations?: unknown;
    };
    snapshot: ConformanceSnapshot;
  };
  if (value.schema !== FORGE_SCHEMAS.conformanceEvidence) throw new Error(`Invalid evidence schema in '${input}'.`);
  if (value.experimentId !== EXPERIMENT_ID) throw new Error(`Invalid experiment ID in '${input}'.`);
  if (value.forgeContract !== FORGE_CONTRACT_VERSION) throw new Error(`Forge contract mismatch in '${input}'.`);
  if (value.snapshot?.schema !== FORGE_SCHEMAS.conformance) throw new Error(`Invalid snapshot schema in '${input}'.`);
  if (value.failure !== undefined && value.failure !== null && value.failure !== "") {
    throw new Error(`Evidence '${input}' contains an infrastructure failure: ${String(value.failure)}`);
  }
  for (const [field, errors] of [["consoleErrors", value.consoleErrors], ["pageErrors", value.pageErrors]] as const) {
    if (errors !== undefined && (!Array.isArray(errors) || errors.length > 0)) {
      throw new Error(`Evidence '${input}' contains ${field}.`);
    }
  }
  if (
    value.environment?.browser !== undefined
    || value.snapshot.samples.some((sample) => sample.host === "browser-wasmer-js")
  ) {
    validateBrowserNetworkProof(value.networkProof, input);
  }
  if (
    value.sourceTree?.algorithm !== "forge-source-tree-sha256"
    || !/^[0-9a-f]{64}$/.test(value.sourceTree.sha256)
    || !Number.isSafeInteger(value.sourceTree.files)
    || value.sourceTree.files < 1
  ) {
    throw new Error(`Invalid source-tree provenance in '${input}'.`);
  }
  return { file, bytes, value };
}));
const [specBytes, currentSourceTree] = await Promise.all([
  readFile(SPEC_PATH),
  sourceTreeProvenance(),
]);
const currentSpecSha256 = createHash("sha256").update(specBytes).digest("hex");
for (const record of records) {
  if (record.value.specSha256 !== currentSpecSha256) {
    throw new Error(`Conformance evidence '${record.file}' does not bind the current specification.`);
  }
  if (
    record.value.sourceTree.sha256 !== currentSourceTree.sha256
    || record.value.sourceTree.files !== currentSourceTree.files
  ) {
    throw new Error(`Conformance evidence '${record.file}' does not bind the current source tree.`);
  }
}
if (records[0]!.value.specSha256 !== records[1]!.value.specSha256) {
  throw new Error("Conformance evidence records bind different specifications.");
}
if (records[0]!.value.sourceTree.sha256 !== records[1]!.value.sourceTree.sha256) {
  throw new Error("Conformance evidence records were produced from different source trees.");
}

const report = compareConformanceSnapshots(records.map((record) => record.value.snapshot));
const table = {
  schema: FORGE_SCHEMAS.conformanceMatrix,
  experimentId: EXPERIMENT_ID,
  forgeContract: FORGE_CONTRACT_VERSION,
  specSha256: records[0]!.value.specSha256,
  sourceTree: records[0]!.value.sourceTree,
  sourceRecords: records.map((record) => ({
    path: path.relative(process.cwd(), record.file),
    sha256: createHash("sha256").update(record.bytes).digest("hex"),
  })),
  report,
};
if (!report.compatible) throw new Error(`Cross-host conformance failed with ${report.mismatches.length} mismatch(es).`);

const output = path.resolve(`experiments/${EXPERIMENT_ID}/runs/tables/conformance-matrix.json`);
const reportPath = path.resolve("docs/conformance-report.md");
const reportMarkdown = renderConformanceReportEvidence(
  await readFile(reportPath, "utf8"),
  report,
  records.map((record) => record.value.collectedAt),
);
await publishEvidenceFiles([
  { path: output, bytes: `${JSON.stringify(table, null, 2)}\n` },
  { path: reportPath, bytes: reportMarkdown },
]);
process.stdout.write(`FORGE_CONFORMANCE_MATRIX=${output}\n`);
process.stdout.write(`FORGE_CONFORMANCE_REPORT=${reportPath}\n`);

function validateBrowserNetworkProof(
  proof: {
    policy?: unknown;
    serviceWorkers?: unknown;
    allowedOrigin?: unknown;
    localBaseUrl?: unknown;
    httpRequests?: unknown;
    violations?: unknown;
  } | undefined,
  input: string,
): void {
  if (
    proof?.policy !== "loopback-same-origin-http"
    || proof.serviceWorkers !== "blocked"
    || proof.localBaseUrl !== true
    || typeof proof.allowedOrigin !== "string"
  ) {
    throw new Error(`Browser evidence '${input}' is missing the required local network proof.`);
  }
  const allowedOrigin = new URL(proof.allowedOrigin);
  if (!isHttp(allowedOrigin) || !isLoopback(allowedOrigin.hostname) || allowedOrigin.origin !== proof.allowedOrigin) {
    throw new Error(`Browser evidence '${input}' has an invalid allowed origin.`);
  }
  if (!Array.isArray(proof.violations) || proof.violations.length > 0) {
    throw new Error(`Browser evidence '${input}' contains a network-policy violation.`);
  }
  if (!Array.isArray(proof.httpRequests) || proof.httpRequests.length === 0) {
    throw new Error(`Browser evidence '${input}' contains no intercepted HTTP(S) requests.`);
  }
  for (const request of proof.httpRequests) {
    if (
      typeof request !== "object"
      || request === null
      || !("url" in request)
      || typeof request.url !== "string"
      || !("method" in request)
      || typeof request.method !== "string"
      || request.method.length === 0
      || !("resourceType" in request)
      || typeof request.resourceType !== "string"
      || request.resourceType.length === 0
      || !("navigation" in request)
      || typeof request.navigation !== "boolean"
      || !("allowed" in request)
      || request.allowed !== true
      || !("reason" in request)
      || request.reason !== "same-origin-loopback"
      || !("postDataBytes" in request)
      || !Number.isSafeInteger(request.postDataBytes)
      || request.postDataBytes < 0
    ) {
      throw new Error(`Browser evidence '${input}' contains an invalid network request record.`);
    }
    const url = new URL(request.url);
    if (!isHttp(url) || !isLoopback(url.hostname) || url.origin !== allowedOrigin.origin) {
      throw new Error(`Browser evidence '${input}' contains a request outside its allowed origin.`);
    }
  }
}

function isHttp(url: URL): boolean {
  return url.protocol === "http:" || url.protocol === "https:";
}

function isLoopback(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  if (normalized === "localhost" || normalized === "[::1]" || normalized === "::1") return true;
  const octets = normalized.split(".");
  return octets.length === 4
    && octets[0] === "127"
    && octets.every((octet) => /^\d{1,3}$/.test(octet) && Number(octet) <= 255);
}
