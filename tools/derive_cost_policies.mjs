#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const LANGUAGES = Object.freeze([
  "c",
  "cpp",
  "rust",
  "go",
  "python",
  "javascript",
  "typescript",
]);
const COMPILED_LANGUAGES = Object.freeze(["c", "cpp", "rust", "go"]);
const POLICY_IDS = Object.freeze(["baseline", "efficient", "optimal"]);
const EVIDENCE_PATH = path.join(
  ROOT,
  "calibration/forge-v1/reference-costs.json",
);
const DERIVATION_PATH = path.join(
  ROOT,
  "calibration/forge-v1/derived-policies.json",
);
const METHOD = "forge-v1-compiled-average-optimal-rounded-v1";
const HEADROOM_NUMERATOR = 105;
const HEADROOM_DENOMINATOR = 100;
const ROUNDING_QUANTUM_COEFFICIENT = 5;
const POLICY_BASIS = Object.freeze({
  baseline: Object.freeze({
    aggregation: "maximum",
    languages: LANGUAGES,
  }),
  efficient: Object.freeze({
    aggregation: "maximum",
    languages: COMPILED_LANGUAGES,
  }),
  optimal: Object.freeze({
    aggregation: "arithmetic-mean",
    languages: COMPILED_LANGUAGES,
  }),
});

function fail(message) {
  throw new Error(message);
}

function parseArgs(arguments_) {
  if (arguments_.length > 1 || (arguments_.length === 1 && arguments_[0] !== "--write")) {
    console.error("usage: node tools/derive_cost_policies.mjs [--write]");
    process.exit(2);
  }
  return { write: arguments_[0] === "--write" };
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function ceilDivideBigInt(numerator, denominator) {
  return (numerator + denominator - 1n) / denominator;
}

function safeNumber(value, label) {
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    fail(`${label} exceeds the safe integer range`);
  }
  return Number(value);
}

function nonnegativeBigInt(value, label) {
  if (typeof value === "bigint") {
    if (value < 0n) fail(`${label} must be non-negative`);
    return value;
  }
  if (!Number.isSafeInteger(value) || value < 0) {
    fail(`${label} must be a non-negative safe integer or bigint`);
  }
  return BigInt(value);
}

function applyHeadroom(numerator, denominator = 1) {
  const exactNumerator = nonnegativeBigInt(numerator, "measured cost numerator");
  const exactDenominator = nonnegativeBigInt(denominator, "measured cost denominator");
  if (exactDenominator === 0n) fail("measured cost denominator must be positive");
  return safeNumber(
    ceilDivideBigInt(
      exactNumerator * BigInt(HEADROOM_NUMERATOR),
      exactDenominator * BigInt(HEADROOM_DENOMINATOR),
    ),
    "unrounded instruction budget",
  );
}

function decimalRoundingQuantum(value) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    fail("instruction budget lower bound must be a positive safe integer");
  }
  const decimalDigits = String(value).length;
  return decimalDigits <= 2
    ? 1
    : ROUNDING_QUANTUM_COEFFICIENT * 10 ** (decimalDigits - 2);
}

function roundInstructionBudget(value) {
  const quantum = decimalRoundingQuantum(value);
  const rounded = safeNumber(
    ceilDivideBigInt(BigInt(value), BigInt(quantum)) * BigInt(quantum),
    "rounded instruction budget",
  );
  return { rounded, quantum };
}

function candidateMap(candidates) {
  const byLanguage = new Map();
  for (const candidate of candidates) {
    if (
      !LANGUAGES.includes(candidate.language)
      || !Number.isSafeInteger(candidate.maximumCost)
      || candidate.maximumCost < 0
      || !Array.isArray(candidate.maximumCaseIds)
      || byLanguage.has(candidate.language)
    ) {
      fail("policy derivation received malformed or duplicate language costs");
    }
    byLanguage.set(candidate.language, candidate);
  }
  for (const language of LANGUAGES) {
    if (!byLanguage.has(language)) fail(`policy derivation is missing ${language}`);
  }
  return byLanguage;
}

function maximumDerivation(kind, languages, byLanguage) {
  const contributors = languages.map((language) => byLanguage.get(language));
  const measuredWorstCaseCost = Math.max(
    ...contributors.map((candidate) => candidate.maximumCost),
  );
  const witnesses = contributors
    .filter((candidate) => candidate.maximumCost === measuredWorstCaseCost)
    .map((candidate) => ({
      language: candidate.language,
      measuredWorstCaseCost: candidate.maximumCost,
      measuredWorstCaseIds: candidate.maximumCaseIds,
    }));
  const unroundedInstructionBudget = applyHeadroom(measuredWorstCaseCost);
  const { rounded: instructionBudget, quantum: roundingQuantum } =
    roundInstructionBudget(unroundedInstructionBudget);
  return {
    kind,
    languages,
    witnesses,
    measuredWorstCaseCost,
    unroundedInstructionBudget,
    roundingQuantum,
    instructionBudget,
  };
}

function averageDerivation(kind, languages, byLanguage) {
  const contributors = languages.map((language) => {
    const candidate = byLanguage.get(language);
    return {
      language,
      measuredWorstCaseCost: candidate.maximumCost,
      measuredWorstCaseIds: candidate.maximumCaseIds,
    };
  });
  const measuredWorstCaseCostNumerator = contributors.reduce(
    (total, contributor) => total + BigInt(contributor.measuredWorstCaseCost),
    0n,
  );
  const measuredWorstCaseCostDenominator = contributors.length;
  const unroundedInstructionBudget = applyHeadroom(
    measuredWorstCaseCostNumerator,
    measuredWorstCaseCostDenominator,
  );
  const { rounded: instructionBudget, quantum: roundingQuantum } =
    roundInstructionBudget(unroundedInstructionBudget);
  return {
    kind,
    languages,
    contributors,
    measuredWorstCaseCostNumerator: measuredWorstCaseCostNumerator.toString(),
    measuredWorstCaseCostDenominator,
    unroundedInstructionBudget,
    roundingQuantum,
    instructionBudget,
  };
}

function derivePolicyInstructionBudgets(candidates) {
  const byLanguage = candidateMap(candidates);
  const policyDerivations = {
    baseline: maximumDerivation(
      "all-language-maximum",
      POLICY_BASIS.baseline.languages,
      byLanguage,
    ),
    efficient: maximumDerivation(
      "compiled-language-maximum",
      POLICY_BASIS.efficient.languages,
      byLanguage,
    ),
    optimal: averageDerivation(
      "compiled-language-average",
      POLICY_BASIS.optimal.languages,
      byLanguage,
    ),
  };
  const instructionBudgets = Object.fromEntries(
    Object.entries(policyDerivations).map(([policy, derivation]) => [
      policy,
      derivation.instructionBudget,
    ]),
  );
  if (
    instructionBudgets.baseline < instructionBudgets.efficient
    || instructionBudgets.efficient < instructionBudgets.optimal
  ) {
    fail("derived instruction policies are not relaxed-to-strict");
  }
  return { policyDerivations, instructionBudgets };
}

async function readJson(file) {
  return JSON.parse(await readFile(file, "utf8"));
}

async function atomicWriteJson(file, value) {
  const temporary = `${file}.tmp-${process.pid}`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o644,
  });
  await rename(temporary, file);
}

function assertMeasuredCase(testCase, key, costProfile) {
  if (
    typeof testCase.id !== "string" ||
    typeof testCase.inputSha256 !== "string" ||
    typeof testCase.outputSha256 !== "string" ||
    !Number.isSafeInteger(testCase.cost) ||
    testCase.cost < 0 ||
    !Number.isSafeInteger(testCase.rawCost) ||
    testCase.rawCost < 0 ||
    !Number.isSafeInteger(testCase.baselineCost) ||
    testCase.baselineCost < 0 ||
    testCase.cost !== Math.max(0, testCase.rawCost - testCase.baselineCost) ||
    testCase.costModel !== "weighted" ||
    testCase.costProfile !== costProfile
  ) {
    fail(`invalid measured case in ${key}`);
  }
}

function assertManifestPolicies(manifest, problemId) {
  const policies = manifest.scoring?.policies;
  if (
    !Array.isArray(policies)
    || policies.length !== POLICY_IDS.length
    || policies.some((policy, index) => policy?.id !== POLICY_IDS[index])
  ) {
    fail(`${problemId}: scoring policies must be exactly ${POLICY_IDS.join(", ")}`);
  }
  return policies;
}

function normalizedRecords(evidence) {
  if (
    evidence.schema !== "wasm-oj-cost-calibration-v1" ||
    evidence.forge?.contract !== "wasm-oj-forge-v1" ||
    evidence.configuration?.target !== "wasip1" ||
    evidence.configuration?.optimization !== "release" ||
    evidence.configuration?.caseSet !== "all-manifest-tests" ||
    !Array.isArray(evidence.records)
  ) {
    fail("calibration evidence does not satisfy the derivation contract");
  }
  const records = new Map();
  for (const record of evidence.records) {
    const key = `${record.problemId}:${record.language}`;
    if (
      !Number.isInteger(record.problemId) ||
      record.problemId < 1 ||
      record.problemId > 40 ||
      !LANGUAGES.includes(record.language) ||
      typeof record.slug !== "string" ||
      typeof record.sourcePath !== "string" ||
      typeof record.sourceSha256 !== "string" ||
      typeof record.artifactCostProfile !== "string" ||
      !record.artifactCostProfile ||
      !Array.isArray(record.cases) ||
      record.cases.length < 4 ||
      records.has(key)
    ) {
      fail(`malformed or duplicate calibration record: ${key}`);
    }
    for (const testCase of record.cases) {
      assertMeasuredCase(testCase, key, record.artifactCostProfile);
    }
    records.set(key, record);
  }
  if (records.size !== 40 * LANGUAGES.length) {
    fail(`expected 280 calibration records, found ${records.size}`);
  }
  return records;
}

async function derive(evidenceBytes, evidence) {
  const records = normalizedRecords(evidence);
  const catalogBytes = await readFile(path.join(ROOT, "catalog.json"));
  if (sha256(catalogBytes) !== evidence.repositoryCatalogSha256) {
    fail("catalog.json changed after measurement");
  }
  const catalog = JSON.parse(catalogBytes.toString("utf8"));
  if (!Array.isArray(catalog.problems) || catalog.problems.length !== 40) {
    fail("catalog.json must contain exactly 40 problems");
  }
  const problems = [];
  for (const entry of catalog.problems) {
    const manifestPath = path.join(ROOT, ...entry.manifest.split("/"));
    const manifest = await readJson(manifestPath);
    const candidates = [];
    const costProfiles = {};
    for (const language of LANGUAGES) {
      const record = records.get(`${entry.id}:${language}`);
      if (!record || record.slug !== entry.slug) fail(`missing identity for ${entry.id}:${language}`);
      if (manifest.files?.solutions?.[language] !== record.sourcePath) {
        fail(`${entry.id}:${language} source path changed after measurement`);
      }
      const sourceBytes = await readFile(path.join(path.dirname(manifestPath), record.sourcePath));
      if (sha256(sourceBytes) !== record.sourceSha256) {
        fail(`${entry.id}:${language} source changed after measurement`);
      }
      const declaredCases = manifest.files?.tests;
      if (!Array.isArray(declaredCases) || declaredCases.length !== record.cases.length) {
        fail(`${entry.id}:${language} test inventory changed after measurement`);
      }
      for (let index = 0; index < declaredCases.length; index += 1) {
        const declared = declaredCases[index];
        const measured = record.cases[index];
        if (declared.id !== measured.id) fail(`${entry.id}:${language} test order changed`);
        const [inputBytes, outputBytes] = await Promise.all([
          readFile(path.join(path.dirname(manifestPath), declared.input)),
          readFile(path.join(path.dirname(manifestPath), declared.output)),
        ]);
        if (
          sha256(inputBytes) !== measured.inputSha256 ||
          sha256(outputBytes) !== measured.outputSha256
        ) {
          fail(`${entry.id}:${language}/${declared.id} case bytes changed after measurement`);
        }
      }
      candidates.push({
        language,
        maximumCost: Math.max(...record.cases.map((testCase) => testCase.cost)),
        maximumCaseIds: record.cases
          .filter(
            (testCase) =>
              testCase.cost === Math.max(...record.cases.map((item) => item.cost)),
          )
          .map((testCase) => testCase.id),
      });
      costProfiles[language] = record.artifactCostProfile;
    }
    candidates.sort(
      (left, right) =>
        left.maximumCost - right.maximumCost ||
        LANGUAGES.indexOf(left.language) - LANGUAGES.indexOf(right.language),
    );
    const { policyDerivations, instructionBudgets } =
      derivePolicyInstructionBudgets(candidates);
    problems.push({
      id: entry.id,
      slug: entry.slug,
      policyDerivations,
      instructionBudgets,
      languageMaximumCosts: candidates,
      costProfiles,
    });
  }
  return {
    schema: "wasm-oj-derived-cost-policies-v2",
    method: METHOD,
    sourceEvidence: "calibration/forge-v1/reference-costs.json",
    sourceEvidenceSha256: sha256(evidenceBytes),
    basis: "compiled-language-average-optimal-with-compiled-and-all-language-maximum-tiers",
    headroom: {
      numerator: HEADROOM_NUMERATOR,
      denominator: HEADROOM_DENOMINATOR,
    },
    rounding: {
      mode: "ceiling",
      quantumFormula: "5 * 10^(decimalDigits(unroundedInstructionBudget) - 2)",
      appliesFromDecimalDigits: 3,
    },
    policyBasis: POLICY_BASIS,
    problems,
  };
}

async function updateManifests(derivation) {
  const catalog = await readJson(path.join(ROOT, "catalog.json"));
  for (const entry of catalog.problems) {
    const manifestPath = path.join(ROOT, ...entry.manifest.split("/"));
    const manifest = await readJson(manifestPath);
    const derived = derivation.problems.find((problem) => problem.id === entry.id);
    manifest.scoring.calibration = {
      status: "measured",
      method: METHOD,
      profiles: derived.costProfiles,
    };
    for (const policy of assertManifestPolicies(manifest, entry.id)) {
      const budget = derived.instructionBudgets[policy.id];
      if (!Number.isSafeInteger(budget)) fail(`${entry.id}: unknown policy ${policy.id}`);
      policy.limits.instructionBudget = budget;
    }
    await atomicWriteJson(manifestPath, manifest);
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const evidenceBytes = await readFile(EVIDENCE_PATH);
  const evidence = JSON.parse(evidenceBytes.toString("utf8"));
  const derivation = await derive(evidenceBytes, evidence);
  if (options.write) {
    await atomicWriteJson(DERIVATION_PATH, derivation);
    await updateManifests(derivation);
    console.log("wrote measured policy derivation and 40 manifests");
    return;
  }
  const recorded = await readJson(DERIVATION_PATH);
  if (JSON.stringify(recorded) !== JSON.stringify(derivation)) {
    fail("derived-policies.json is stale; run with --write after reviewing evidence");
  }
  const catalog = await readJson(path.join(ROOT, "catalog.json"));
  for (const entry of catalog.problems) {
    const manifest = await readJson(path.join(ROOT, ...entry.manifest.split("/")));
    const derived = derivation.problems.find((problem) => problem.id === entry.id);
    if (
      manifest.scoring?.calibration?.status !== "measured" ||
      manifest.scoring?.calibration?.method !== METHOD ||
      JSON.stringify(manifest.scoring?.calibration?.profiles) !==
        JSON.stringify(derived.costProfiles)
    ) {
      fail(`${entry.id}: manifest calibration identity is stale`);
    }
    for (const policy of assertManifestPolicies(manifest, entry.id)) {
      if (policy.limits.instructionBudget !== derived.instructionBudgets[policy.id]) {
        fail(`${entry.id}: ${policy.id} instruction budget is stale`);
      }
    }
  }
  console.log("cost policy derivation and all 40 manifests are current");
}

const isMain = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) await main();

export {
  COMPILED_LANGUAGES,
  METHOD,
  POLICY_BASIS,
  POLICY_IDS,
  assertManifestPolicies,
  assertMeasuredCase,
  derivePolicyInstructionBudgets,
};
