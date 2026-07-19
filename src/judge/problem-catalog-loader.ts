import type { JudgeProblem } from "./problem-model";

export const BROWSER_PROBLEM_CATALOG_SCHEMA = "wasm-oj-browser-problems-v1";
export const BROWSER_PROBLEM_CATALOG_PATH = "/problems/catalog.json";
const EXPECTED_PROBLEM_COUNT = 45;

interface BrowserProblemCatalog {
  readonly schema: typeof BROWSER_PROBLEM_CATALOG_SCHEMA;
  readonly problems: readonly JudgeProblem[];
}

export function parseBrowserProblemCatalog(value: unknown): readonly JudgeProblem[] {
  if (!isRecord(value) || value.schema !== BROWSER_PROBLEM_CATALOG_SCHEMA) {
    throw new Error("The browser problem catalog has an unsupported schema.");
  }
  const problems = value.problems;
  if (!Array.isArray(problems) || problems.length !== EXPECTED_PROBLEM_COUNT) {
    throw new Error(`The browser problem catalog must contain ${EXPECTED_PROBLEM_COUNT} problems.`);
  }
  const ids = new Set<string>();
  for (let index = 0; index < problems.length; index += 1) {
    const problem = problems[index];
    if (
      !isRecord(problem)
      || problem.number !== index + 1
      || typeof problem.id !== "string"
      || !problem.id
      || ids.has(problem.id)
      || !isRecord(problem.title)
      || typeof problem.title["zh-TW"] !== "string"
      || typeof problem.title.en !== "string"
      || !Array.isArray(problem.judgeCases)
      || !isRecord(problem.scoring)
    ) {
      throw new Error(`The browser problem catalog has an invalid problem at position ${index + 1}.`);
    }
    ids.add(problem.id);
  }
  return problems as unknown as readonly JudgeProblem[];
}

export async function loadBrowserProblemCatalog(signal?: AbortSignal): Promise<readonly JudgeProblem[]> {
  const response = await fetch(BROWSER_PROBLEM_CATALOG_PATH, {
    cache: "no-cache",
    signal,
  });
  if (!response.ok) {
    throw new Error(`Unable to load the browser problem catalog (HTTP ${response.status}).`);
  }
  return parseBrowserProblemCatalog(await response.json() as unknown);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export type { BrowserProblemCatalog };
