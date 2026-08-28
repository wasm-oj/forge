import { readFile } from "node:fs/promises";

const capacity = JSON.parse(await readFile(new URL("../config/capacity.json", import.meta.url), "utf8"));

function assertPositiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${label} must be a positive integer.`);
}

for (const [scope, values] of Object.entries(capacity)) {
  for (const [name, value] of Object.entries(values)) assertPositiveInteger(value, `${scope}.${name}`);
}
if (capacity.submission.rejudgeActive > capacity.submission.globalActive) {
  throw new Error("submission.rejudgeActive cannot exceed submission.globalActive.");
}
if (capacity.submission.perUserActive > capacity.submission.globalActive) {
  throw new Error("submission.perUserActive cannot exceed submission.globalActive.");
}
if (capacity.catalog.perOrganizerActive > capacity.catalog.globalActive) {
  throw new Error("catalog.perOrganizerActive cannot exceed catalog.globalActive.");
}

function stripJsonComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

for (const filename of ["wrangler.jsonc", "wrangler.quick-production.jsonc"]) {
  const config = JSON.parse(stripJsonComments(await readFile(new URL(`../${filename}`, import.meta.url), "utf8")));
  const submission = config.containers?.find((entry) => entry.class_name === "SubmissionJudgeContainer");
  if (!submission) throw new Error(`${filename} is missing SubmissionJudgeContainer.`);
  if (submission.max_instances !== capacity.submission.globalActive) {
    throw new Error(`${filename} SubmissionJudgeContainer max_instances must equal submission.globalActive.`);
  }
  const validation = config.containers?.find((entry) => entry.class_name === "ValidationJudgeContainer");
  if (validation) throw new Error(`${filename} must not declare ValidationJudgeContainer.`);
  if (config.containers.length !== 1) throw new Error(`${filename} must declare only the SubmissionJudgeContainer.`);

  const catalogWorkflow = config.workflows?.find((entry) => entry.binding === "CATALOG_WORKFLOW");
  if (!catalogWorkflow || catalogWorkflow.class_name !== "CatalogWorkflow") {
    throw new Error(`${filename} must bind CATALOG_WORKFLOW to CatalogWorkflow.`);
  }
  if (config.workflows?.some((entry) => entry.binding === "VALIDATION_WORKFLOW")) {
    throw new Error(`${filename} must not bind the legacy VALIDATION_WORKFLOW.`);
  }
  if (config.durable_objects?.bindings?.some((entry) => entry.name === "VALIDATION_CONTAINER")) {
    throw new Error(`${filename} must not bind the legacy VALIDATION_CONTAINER.`);
  }
  const durableBindings = config.durable_objects?.bindings?.map((entry) => [entry.name, entry.class_name]);
  if (JSON.stringify(durableBindings) !== JSON.stringify([["SUBMISSION_CONTAINER", "SubmissionJudgeContainer"]])) {
    throw new Error(`${filename} must bind only SUBMISSION_CONTAINER.`);
  }
  const workflows = config.workflows?.map((entry) => [entry.binding, entry.class_name]);
  if (JSON.stringify(workflows) !== JSON.stringify([
    ["SUBMISSION_WORKFLOW", "SubmissionWorkflow"],
    ["CATALOG_WORKFLOW", "CatalogWorkflow"],
    ["PROMPT_ATTEMPT_WORKFLOW", "PromptAttemptWorkflow"],
  ])) {
    throw new Error(`${filename} must bind the submission, catalog, and Prompt Program Workflows.`);
  }
}

console.log("verified shared catalog and submission capacity configuration");
