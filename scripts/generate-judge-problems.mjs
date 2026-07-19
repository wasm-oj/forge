#!/usr/bin/env node

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import { applyLearningPath } from "./learning-path.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CATALOG_PATH = path.join(ROOT, "catalog.json");
const LEARNING_PATH_PATH = path.join(ROOT, "learning-path.json");
const OUTPUT_PATH = path.join(ROOT, "src/judge/problems.generated.ts");
const CATALOG_SCHEMA_PATH = path.join(ROOT, "schemas/problem-catalog.schema.json");
const PROBLEM_SCHEMA_PATH = path.join(ROOT, "schemas/problem.schema.json");
const LOCALES = Object.freeze(["zh-TW", "en"]);
const LANGUAGES = Object.freeze([
  "c",
  "cpp",
  "rust",
  "go",
  "python",
  "javascript",
  "typescript",
]);
const POLICY_IDS = Object.freeze(["baseline", "efficient", "optimal"]);

function fail(message) {
  throw new Error(message);
}

function parseArgs(arguments_) {
  if (arguments_.length > 1 || (arguments_.length === 1 && arguments_[0] !== "--check")) {
    console.error("usage: node scripts/generate-judge-problems.mjs [--check]");
    process.exit(2);
  }
  return { check: arguments_[0] === "--check" };
}

function assertRecord(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail(`${label} must be an object`);
  }
  return value;
}

function assertExactKeys(value, keys, label) {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    fail(`${label} has unexpected keys: ${actual.join(", ")}`);
  }
}

function assertLocalizedText(value, label) {
  const record = assertRecord(value, label);
  assertExactKeys(record, LOCALES, label);
  for (const locale of LOCALES) {
    if (typeof record[locale] !== "string" || !record[locale] || record[locale] !== record[locale].trim()) {
      fail(`${label}[${locale}] must be a non-empty trimmed string`);
    }
  }
  return record;
}

function resolveRelative(base, relative, label) {
  if (
    typeof relative !== "string"
    || !relative
    || relative.startsWith("/")
    || relative.includes("\\")
    || relative.includes("\0")
    || relative.endsWith("/")
  ) {
    fail(`${label} must be a normalized relative POSIX path`);
  }
  const segments = relative.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
    fail(`${label} must be a normalized relative POSIX path`);
  }
  return path.join(base, ...segments);
}

async function readJson(file, label) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    fail(`${label} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function assertSchema(validate, value, label) {
  if (!validate(value)) {
    const details = validate.errors
      ?.map((error) => `${error.instancePath || "/"} ${error.message}`)
      .join("; ");
    fail(`${label} violates its JSON schema: ${details ?? "unknown validation error"}`);
  }
}

async function loadSchemaValidators() {
  const [catalogSchema, problemSchema] = await Promise.all([
    readJson(CATALOG_SCHEMA_PATH, "catalog schema"),
    readJson(PROBLEM_SCHEMA_PATH, "problem schema"),
  ]);
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  return {
    catalog: ajv.compile(catalogSchema),
    problem: ajv.compile(problemSchema),
  };
}

async function loadCatalog(validate) {
  const catalog = assertRecord(await readJson(CATALOG_PATH, "catalog.json"), "catalog.json");
  assertSchema(validate, catalog, "catalog.json");
  assertExactKeys(catalog, ["schema", "problemSchema", "localization", "problems"], "catalog.json");
  if (catalog.schema !== "wasm-oj-catalog-v2" || catalog.problemSchema !== "wasm-oj-problem-v3") {
    fail("catalog.json uses an unsupported schema");
  }
  if (JSON.stringify(catalog.localization) !== JSON.stringify({
    defaultLocale: "zh-TW",
    supportedLocales: LOCALES,
  })) {
    fail("catalog.json uses an unsupported localization contract");
  }
  if (!Array.isArray(catalog.problems) || catalog.problems.length !== 45) {
    fail("catalog.json must contain exactly 45 problems");
  }
  return catalog;
}

async function loadProblem(entry, expectedNumber, validate) {
  const catalogEntry = assertRecord(entry, `catalog problem ${expectedNumber}`);
  assertExactKeys(catalogEntry, ["id", "slug", "manifest"], `catalog problem ${expectedNumber}`);
  if (catalogEntry.id !== expectedNumber || typeof catalogEntry.slug !== "string") {
    fail(`catalog problem ${expectedNumber} has an invalid identity`);
  }
  const expectedManifest = `problems/${String(expectedNumber).padStart(3, "0")}-${catalogEntry.slug}/problem.json`;
  if (catalogEntry.manifest !== expectedManifest) {
    fail(`catalog problem ${expectedNumber} manifest must be ${expectedManifest}`);
  }
  const manifestPath = resolveRelative(ROOT, catalogEntry.manifest, `problem ${expectedNumber} manifest`);
  const problemRoot = path.dirname(manifestPath);
  const manifest = assertRecord(await readJson(manifestPath, expectedManifest), expectedManifest);
  assertSchema(validate, manifest, expectedManifest);
  if (
    manifest.schema !== "wasm-oj-problem-v3"
    || manifest.id !== expectedNumber
    || manifest.slug !== catalogEntry.slug
  ) {
    fail(`${expectedManifest} identity disagrees with catalog.json`);
  }
  const title = assertLocalizedText(manifest.title, `${expectedManifest} title`);
  const files = assertRecord(manifest.files, `${expectedManifest} files`);
  const statements = assertRecord(files.statements, `${expectedManifest} statement files`);
  const editorials = assertRecord(files.editorials, `${expectedManifest} editorial files`);
  assertExactKeys(statements, LOCALES, `${expectedManifest} statement files`);
  assertExactKeys(editorials, LOCALES, `${expectedManifest} editorial files`);
  const localizedStatement = {};
  const localizedEditorial = {};
  for (const locale of LOCALES) {
    localizedStatement[locale] = await readFile(
      resolveRelative(problemRoot, statements[locale], `${expectedManifest} statement[${locale}]`),
      "utf8",
    );
    localizedEditorial[locale] = await readFile(
      resolveRelative(problemRoot, editorials[locale], `${expectedManifest} editorial[${locale}]`),
      "utf8",
    );
    if (!localizedStatement[locale].startsWith(`# ${title[locale]}\n`)) {
      fail(`${expectedManifest} statement[${locale}] title disagrees with manifest`);
    }
  }

  const solutionPaths = assertRecord(files.solutions, `${expectedManifest} solutions`);
  assertExactKeys(solutionPaths, LANGUAGES, `${expectedManifest} solutions`);
  const declaredPrograms = [
    ["validator", files.validator],
    ["generator", files.generator],
    ["oracle", files.oracle],
    ...LANGUAGES.map((language) => [`solution[${language}]`, solutionPaths[language]]),
  ];
  await Promise.all(declaredPrograms.map(async ([label, relative]) => {
    const contents = await readFile(
      resolveRelative(problemRoot, relative, `${expectedManifest} ${label}`),
    );
    if (contents.byteLength === 0) fail(`${expectedManifest} ${label} must not be empty`);
  }));
  const tests = files.tests;
  if (!Array.isArray(tests) || tests.length < 4) fail(`${expectedManifest} must declare at least four tests`);
  const judgeCases = [];
  const testIds = new Set();
  for (const [index, test] of tests.entries()) {
    const record = assertRecord(test, `${expectedManifest} test ${index}`);
    assertExactKeys(record, ["id", "kind", "input", "output"], `${expectedManifest} test ${index}`);
    if (
      typeof record.id !== "string"
      || !["sample", "adversarial", "regression"].includes(record.kind)
    ) {
      fail(`${expectedManifest} test ${index} has invalid metadata`);
    }
    if (testIds.has(record.id)) fail(`${expectedManifest} repeats test id ${record.id}`);
    testIds.add(record.id);
    const [input, output] = await Promise.all([
      readFile(resolveRelative(problemRoot, record.input, `${expectedManifest} test input`), "utf8"),
      readFile(resolveRelative(problemRoot, record.output, `${expectedManifest} test output`), "utf8"),
    ]);
    judgeCases.push({ id: record.id, kind: record.kind, input, output });
  }
  if (judgeCases.filter((testCase) => testCase.kind === "sample").length !== 3) {
    fail(`${expectedManifest} must declare exactly three sample cases`);
  }

  const scoring = assertRecord(manifest.scoring, `${expectedManifest} scoring`);
  const calibration = assertRecord(scoring.calibration, `${expectedManifest} calibration`);
  const profiles = assertRecord(calibration.profiles, `${expectedManifest} calibration profiles`);
  assertExactKeys(profiles, LANGUAGES, `${expectedManifest} calibration profiles`);
  if (
    scoring.maximumPoints !== 100
    || calibration.status !== "measured"
    || calibration.method !== "forge-v1-compiled-average-optimal-rounded-v1"
  ) {
    fail(`${expectedManifest} has an unsupported scoring contract`);
  }
  if (!Array.isArray(scoring.policies) || scoring.policies.length !== POLICY_IDS.length) {
    fail(`${expectedManifest} must declare exactly ${POLICY_IDS.join(", ")}`);
  }
  const policies = scoring.policies.map((policy, index) => {
    const record = assertRecord(policy, `${expectedManifest} policy ${index}`);
    return {
      id: record.id,
      title: assertLocalizedText(record.title, `${expectedManifest} policy ${index} title`),
      points: record.points,
      limits: record.limits,
    };
  });
  if (policies.some((policy, index) => policy.id !== POLICY_IDS[index])) {
    fail(`${expectedManifest} scoring policies must be exactly ${POLICY_IDS.join(", ")}`);
  }
  if (policies.reduce((sum, policy) => sum + policy.points, 0) !== scoring.maximumPoints) {
    fail(`${expectedManifest} scoring policy points must sum to ${scoring.maximumPoints}`);
  }
  for (let index = 1; index < policies.length; index += 1) {
    const broader = policies[index - 1].limits;
    const stricter = policies[index].limits;
    if (
      stricter.instructionBudget > broader.instructionBudget
      || stricter.memoryLimitBytes > broader.memoryLimitBytes
      || (broader.logicalTimeLimitMs !== undefined && stricter.logicalTimeLimitMs === undefined)
      || (
        broader.logicalTimeLimitMs !== undefined
        && stricter.logicalTimeLimitMs > broader.logicalTimeLimitMs
      )
    ) {
      fail(`${expectedManifest} scoring policies must be ordered from broadest to strictest`);
    }
  }
  const complexities = manifest.complexities;
  if (!Array.isArray(complexities) || complexities.length < 2) {
    fail(`${expectedManifest} must declare at least two complexity paths`);
  }
  if (!complexities.some((complexity) => complexity.accepted)) {
    fail(`${expectedManifest} must declare an accepted complexity path`);
  }

  return {
    id: catalogEntry.slug,
    number: expectedNumber,
    title,
    difficulty: manifest.difficulty,
    tags: manifest.tags,
    statement: localizedStatement,
    editorial: localizedEditorial,
    judgeCases,
    scoring: {
      maximumPoints: 100,
      calibration: { method: calibration.method, profiles },
      policies,
      safetyLimits: scoring.safetyLimits,
    },
    complexities: complexities.map((complexity, index) => {
      const record = assertRecord(complexity, `${expectedManifest} complexity ${index}`);
      return {
        name: assertLocalizedText(record.name, `${expectedManifest} complexity ${index} name`),
        time: record.time,
        space: record.space,
        accepted: record.accepted,
      };
    }),
  };
}

function render(problems) {
  return [
    "// Generated by scripts/generate-judge-problems.mjs. Do not edit by hand.",
    'import type { JudgeProblem } from "./problem-model";',
    "",
    `export const GENERATED_PROBLEMS = ${JSON.stringify(problems, null, 2)} as const satisfies readonly JudgeProblem[];`,
    "",
  ].join("\n");
}

async function atomicWrite(file, output) {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp-${process.pid}`;
  await writeFile(temporary, output, { encoding: "utf8", flag: "wx", mode: 0o644 });
  await rename(temporary, file);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const validators = await loadSchemaValidators();
  const catalog = await loadCatalog(validators.catalog);
  const canonicalProblems = await Promise.all(
    catalog.problems.map((entry, index) => loadProblem(entry, index + 1, validators.problem)),
  );
  const learningPath = await readJson(LEARNING_PATH_PATH, "learning-path.json");
  const problems = applyLearningPath(learningPath, canonicalProblems);
  const output = render(problems);
  if (options.check) {
    let current;
    try {
      current = await readFile(OUTPUT_PATH, "utf8");
    } catch {
      fail("generated TypeScript problem fixture is missing; run pnpm problems:generate");
    }
    if (current !== output) {
      fail("generated TypeScript problem fixture is stale; run pnpm problems:generate");
    }
    console.log("verified generated Forge problem fixture for 45 localized problems");
    return;
  }
  await atomicWrite(OUTPUT_PATH, output);
  console.log("generated Forge problem fixture for 45 localized problems");
}

await main();
