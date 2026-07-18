import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { publishEvidenceFiles } from "./evidence-publication.mjs";
import { sourceTreeProvenance } from "../src/conformance/provenance.ts";
import { FORGE_CONTRACT_VERSION, FORGE_SCHEMAS } from "../src/core/contract.ts";
import { WEIGHTED_METER_MODEL } from "../src/core/resources.ts";
import {
  COST_BASELINE_CALIBRATION_CASES,
  COST_BASELINE_SEEDS,
} from "../src/conformance/cost-baseline-cases.ts";

const EXPERIMENT_ID = `forge-contract-${FORGE_CONTRACT_VERSION}-cost-baseline`;
const FORGE_CONTRACT = FORGE_CONTRACT_VERSION;
const RAW_SCHEMA = FORGE_SCHEMAS.costBaselineRaw;
const TABLE_SCHEMA = FORGE_SCHEMAS.costBaselineTable;
const MANIFEST_SCHEMA = FORGE_SCHEMAS.costBaselineManifest;
const COST_MODEL = WEIGHTED_METER_MODEL;
const SEEDS = [...COST_BASELINE_SEEDS];

if (isEntrypoint()) await main();

async function main() {
  const inputArgument = process.argv[2];
  if (!inputArgument || process.argv.length !== 3) {
    throw new Error("Usage: node scripts/transform-cost-baselines.mjs <primary-raw-record.json>");
  }

  const root = process.cwd();
  const rawPath = path.resolve(inputArgument);
  const specPath = path.resolve(`experiments/${EXPERIMENT_ID}/SPEC.md`);
  const tableDirectory = path.resolve(`experiments/${EXPERIMENT_ID}/runs/tables`);
  const tablePath = path.join(tableDirectory, "cost-baselines.json");
  const manifestPath = path.join(tableDirectory, "MANIFEST.json");
  const generatedPath = path.resolve("src/core/generated/cost-baselines.ts");
  const [rawBytes, specBytes, currentSourceTree] = await Promise.all([
    readFile(rawPath),
    readFile(specPath),
    sourceTreeProvenance(root),
  ]);
  const raw = JSON.parse(rawBytes.toString("utf8"));

  required(raw.schema === RAW_SCHEMA, `Expected raw schema '${RAW_SCHEMA}'.`);
  required(raw.experimentId === EXPERIMENT_ID, `Expected experiment '${EXPERIMENT_ID}'.`);
  required(raw.panel === "primary", "Only a primary-panel record can publish baselines.");
  required(raw.specSha256 === sha256(specBytes), "Raw record spec hash does not match the current frozen spec.");
  required(raw.sourceTree?.algorithm === "forge-source-tree-sha256", "Raw record is missing source-tree provenance.");
  required(typeof raw.sourceTree.sha256 === "string" && /^[0-9a-f]{64}$/.test(raw.sourceTree.sha256), "Raw record has an invalid source-tree digest.");
  required(Number.isSafeInteger(raw.sourceTree.files) && raw.sourceTree.files > 0, "Raw record has an invalid source-tree file count.");
  required(
    raw.sourceTree.sha256 === currentSourceTree.sha256 && raw.sourceTree.files === currentSourceTree.files,
    "Raw record source-tree provenance does not match the current source tree.",
  );
  required(raw.contracts?.forge === FORGE_CONTRACT, "Forge contract mismatch.");
  required(raw.contracts?.meter === COST_MODEL, "Meter contract mismatch.");
  required(equalArray(raw.seeds, SEEDS), "Raw record seed panel is incomplete or reordered.");

  const expected = expectedProfiles();
  const profiles = new Map();
  for (const profile of requiredArray(raw.profiles, "profiles")) {
    required(typeof profile.profile === "string", "Raw profile is missing its ID.");
    required(!profiles.has(profile.profile), `Duplicate raw profile '${profile.profile}'.`);
    profiles.set(profile.profile, profile);
  }
  required(profiles.size === expected.length, `Expected ${expected.length} profiles, received ${profiles.size}.`);

  const rows = expected.map((identity) => {
    const profile = profiles.get(identity.profile);
    required(profile, `Missing profile '${identity.profile}'.`);
    required(profile.status === "built", `Profile '${identity.profile}' did not build successfully.`);
    required(profile.language === identity.language, `Language mismatch for '${identity.profile}'.`);
    required(profile.target === identity.target, `Target mismatch for '${identity.profile}'.`);
    required(profile.optimization === identity.optimization, `Optimization mismatch for '${identity.profile}'.`);
    required(profile.artifactCostProfile === identity.profile, `Artifact profile mismatch for '${identity.profile}'.`);
    required(typeof profile.artifactDigest === "string" && /^[0-9a-f]{64}$/.test(profile.artifactDigest), `Invalid artifact digest for '${identity.profile}'.`);
    required(Number.isSafeInteger(profile.artifactBytes) && profile.artifactBytes > 0, `Invalid artifact size for '${identity.profile}'.`);
    const observations = requiredArray(profile.observations, `${identity.profile}.observations`);
    required(observations.length === SEEDS.length, `Incomplete observations for '${identity.profile}'.`);
    const bySeed = new Map(observations.map((observation) => [observation.seed, observation]));
    required(bySeed.size === SEEDS.length, `Duplicate seed observation for '${identity.profile}'.`);
    const costs = SEEDS.map((seed) => {
      const observation = bySeed.get(seed);
      required(observation, `Missing seed ${seed} for '${identity.profile}'.`);
      required(observation.status === "ok", `Seed ${seed} failed for '${identity.profile}'.`);
      required(observation.costModel === COST_MODEL, `Cost model mismatch for '${identity.profile}'.`);
      required(observation.code === 0 && observation.termination === "exited", `Unexpected result for '${identity.profile}' seed ${seed}.`);
      required(observation.stdout === "" && observation.stderr === "", `Empty program emitted output for '${identity.profile}' seed ${seed}.`);
      required(Number.isSafeInteger(observation.rawCostPoints) && observation.rawCostPoints > 0, `Invalid raw cost for '${identity.profile}' seed ${seed}.`);
      return observation.rawCostPoints;
    });
    required(new Set(costs).size === 1, `Seed-dependent baseline for '${identity.profile}': ${costs.join(", ")}.`);
    return {
      ...identity,
      baselineCostPoints: costs[0],
      artifactDigest: profile.artifactDigest,
      artifactBytes: profile.artifactBytes,
      toolchains: profile.toolchains,
      validatedSeeds: [...SEEDS],
    };
  });

  const rawRelative = path.relative(root, rawPath);
  const table = {
    schema: TABLE_SCHEMA,
    experimentId: EXPERIMENT_ID,
    sourceRunId: raw.runId,
    sourceRawRecord: rawRelative,
    sourceRawSha256: sha256(rawBytes),
    specSha256: raw.specSha256,
    sourceTree: raw.sourceTree,
    costModel: COST_MODEL,
    forgeContract: FORGE_CONTRACT,
    rowGrain: "one row per language-target-optimization cost profile",
    rows,
  };
  const tableBytes = encodeJson(table);
  const generated = generatedModule(table);
  const generatedBytes = Buffer.from(generated);
  const manifest = {
    schema: MANIFEST_SCHEMA,
    experimentId: EXPERIMENT_ID,
    transformScript: "scripts/transform-cost-baselines.mjs",
    transformCommand: `npm run cost-baseline:transform -- ${rawRelative}`,
    sourceRawRecord: rawRelative,
    sourceRawSha256: sha256(rawBytes),
    specPath: path.relative(root, specPath),
    specSha256: sha256(specBytes),
    outputs: [
      { path: path.relative(root, tablePath), sha256: sha256(tableBytes), rows: rows.length },
      { path: path.relative(root, generatedPath), sha256: sha256(generatedBytes), rows: rows.length },
    ],
  };

  await publishEvidenceFiles([
    { path: tablePath, bytes: tableBytes },
    { path: generatedPath, bytes: generatedBytes },
    { path: manifestPath, bytes: encodeJson(manifest) },
  ]);
  process.stdout.write(`${JSON.stringify({ table: tablePath, generated: generatedPath, profiles: rows.length })}\n`);
}

function expectedProfiles() {
  return COST_BASELINE_CALIBRATION_CASES.map(({ profile, language, target, optimization }) => ({
    profile,
    language,
    target,
    optimization,
  }));
}

export function generatedModule(table) {
  const baselines = Object.fromEntries(table.rows.map((row) => [row.profile, row.baselineCostPoints]));
  const evidence = {
    experimentId: table.experimentId,
    specSha256: table.specSha256,
    costModel: table.costModel,
    forgeContract: table.forgeContract,
    profileCount: table.rows.length,
  };
  return [
    "// Generated by scripts/transform-cost-baselines.mjs. Do not edit by hand.",
    `export const GENERATED_COST_BASELINES: Readonly<Record<string, number>> = Object.freeze(${JSON.stringify(baselines, null, 2)});`,
    "/** Stable contract/spec identity. Per-run provenance lives in the canonical table manifest. */",
    `export const COST_BASELINE_EVIDENCE = Object.freeze(${JSON.stringify(evidence, null, 2)});`,
    "",
  ].join("\n");
}

function required(condition, message) {
  if (!condition) throw new Error(message);
}

function requiredArray(value, name) {
  required(Array.isArray(value), `'${name}' must be an array.`);
  return value;
}

function equalArray(left, right) {
  return Array.isArray(left) && left.length === right.length && left.every((value, index) => value === right[index]);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function encodeJson(value) {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
}

function isEntrypoint() {
  return process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
}
