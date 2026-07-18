import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sourceTreeProvenance } from "../src/conformance/provenance.ts";
import { FORGE_CONTRACT_VERSION, FORGE_SCHEMAS } from "../src/core/contract.ts";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const experiment = `forge-contract-${FORGE_CONTRACT_VERSION}-conformance`;
const matrixPath = path.join(root, "experiments", experiment, "runs/tables/conformance-matrix.json");
const specPath = path.join(root, "experiments", experiment, "SPEC.md");
const [matrixBytes, specBytes, sourceTree] = await Promise.all([
  readFile(matrixPath),
  readFile(specPath),
  sourceTreeProvenance(root),
]);
const matrix = JSON.parse(matrixBytes.toString("utf8"));

if (matrix.schema !== FORGE_SCHEMAS.conformanceMatrix) throw new Error("Canonical conformance matrix has the wrong schema.");
if (matrix.experimentId !== experiment || matrix.forgeContract !== FORGE_CONTRACT_VERSION) {
  throw new Error("Canonical conformance matrix is bound to another Forge contract.");
}
if (matrix.specSha256 !== sha256(specBytes)) throw new Error("Canonical conformance matrix does not bind the current specification.");
if (matrix.sourceTree?.algorithm !== sourceTree.algorithm
  || matrix.sourceTree.sha256 !== sourceTree.sha256
  || matrix.sourceTree.files !== sourceTree.files) {
  throw new Error("Canonical conformance matrix does not bind the current source tree.");
}
if (matrix.report?.compatible !== true || !Array.isArray(matrix.report.mismatches) || matrix.report.mismatches.length !== 0) {
  throw new Error("Canonical conformance matrix contains a cross-host mismatch.");
}
if (!Array.isArray(matrix.sourceRecords) || matrix.sourceRecords.length !== 2) {
  throw new Error("Canonical conformance matrix must bind exactly one server and one browser evidence record.");
}
for (const record of matrix.sourceRecords) {
  if (typeof record?.path !== "string" || !record.path.startsWith(`experiments/${experiment}/runs/raw/records/`)) {
    throw new Error("Canonical conformance matrix refers to an invalid evidence path.");
  }
  const bytes = await readFile(path.join(root, record.path));
  if (record.sha256 !== sha256(bytes)) throw new Error(`Conformance evidence '${record.path}' failed its SHA-256 binding.`);
}
const samples = matrix.report.samples;
if (!Array.isArray(samples) || samples.length !== 42 || samples.some((sample) => sample.success !== true)) {
  throw new Error("Canonical conformance matrix must contain 42 successful host samples.");
}
const hosts = new Map();
for (const sample of samples) hosts.set(sample.host, (hosts.get(sample.host) ?? 0) + 1);
if (hosts.size !== 2 || hosts.get("server-native") !== 21 || hosts.get("browser-wasmer-js") !== 21) {
  throw new Error("Canonical conformance matrix must contain 21 server and 21 browser samples.");
}

process.stdout.write(`Verified zero-mismatch cross-host evidence for source tree ${sourceTree.sha256}.\n`);

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}
