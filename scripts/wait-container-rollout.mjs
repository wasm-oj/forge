import { execFile } from "node:child_process";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu;
const HEALTH_KEYS = ["active", "assigned", "healthy", "stopped", "failed", "scheduling", "starting"];
const DEFAULT_TIMEOUT_MS = 15 * 60 * 1_000;
const DEFAULT_POLL_INTERVAL_MS = 5_000;
const REQUIRED_STABLE_OBSERVATIONS = 2;

function object(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object.`);
  }
  return value;
}

function positiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError(`${label} must be a positive integer.`);
  return value;
}

export function configuredContainerRolloutTarget(config) {
  const root = object(config, "Worker config");
  const containers = root.containers;
  if (!Array.isArray(containers) || containers.length !== 1) {
    throw new TypeError("Worker config must declare exactly one Container application.");
  }
  const container = object(containers[0], "Worker config Container application");
  if (typeof container.name !== "string" || container.name.length === 0) {
    throw new TypeError("Worker config Container application name is invalid.");
  }
  if (typeof container.class_name !== "string" || container.class_name.length === 0) {
    throw new TypeError("Worker config Container class name is invalid.");
  }
  if (container.image !== "./Dockerfile") {
    throw new TypeError("Worker config Container image must be built from ./Dockerfile by Wrangler.");
  }
  return Object.freeze({
    className: container.class_name,
    name: container.name,
  });
}

export async function readContainerRolloutTarget(configPath) {
  let config;
  try {
    config = JSON.parse(await readFile(configPath, "utf8"));
  } catch (error) {
    throw new TypeError(`Cannot read rendered Worker config ${configPath}.`, { cause: error });
  }
  return configuredContainerRolloutTarget(config);
}

function parseApplicationSummary(value, target) {
  if (!Array.isArray(value)) throw new TypeError("Wrangler container list output must be an array.");
  const matches = value.filter((entry) => entry?.name === target.name);
  if (matches.length !== 1) {
    throw new Error(`Expected exactly one Cloudflare Container application named ${target.name}; found ${matches.length}.`);
  }
  const summary = object(matches[0], "Cloudflare Container application summary");
  if (typeof summary.id !== "string" || !UUID.test(summary.id)) {
    throw new TypeError("Cloudflare Container application ID is invalid.");
  }
  return summary;
}

function parseInstancesPage(value) {
  const page = object(value, "Wrangler container instances output");
  if (!Array.isArray(page.instances)) throw new TypeError("Wrangler container instances output is missing instances.");
  const resultInfo = object(page.result_info, "Wrangler container instances result_info");
  const nextPageToken = resultInfo.next_page_token;
  if (nextPageToken !== null && (typeof nextPageToken !== "string" || nextPageToken.length === 0)) {
    throw new TypeError("Wrangler container instances next_page_token is invalid.");
  }
  return { instances: page.instances, nextPageToken };
}

export function assessContainerRollout(target, summaryValue, infoValue, instancesValue) {
  const summary = object(summaryValue, "Cloudflare Container application summary");
  const info = object(infoValue, "Cloudflare Container application info");
  if (!Array.isArray(instancesValue)) throw new TypeError("Cloudflare Container instances must be an array.");

  const reasons = [];
  if (summary.name !== target.name || info.name !== target.name) reasons.push("application name does not match config");
  if (summary.id !== info.id) reasons.push("application ID changed between queries");
  if (typeof summary.image !== "string" || summary.image.length === 0
    || typeof info.configuration?.image !== "string" || info.configuration.image.length === 0) {
    reasons.push("deployed application image is missing");
  }
  if (!Number.isSafeInteger(summary.version) || summary.version <= 0) reasons.push("summary version is invalid");
  if (!Number.isSafeInteger(info.version) || info.version <= 0) reasons.push("info version is invalid");
  if (summary.version !== info.version) reasons.push("application version changed between queries");
  if (summary.state !== "ready") reasons.push(`application state is ${JSON.stringify(summary.state)}, not ready`);

  const health = info.health;
  const counters = health?.instances;
  if (!Array.isArray(health?.errors) || health.errors.length !== 0) reasons.push("application health contains errors");
  if (counters === null || typeof counters !== "object" || Array.isArray(counters)) {
    reasons.push("application health counters are missing");
  } else {
    for (const key of HEALTH_KEYS) {
      if (!Number.isSafeInteger(counters[key]) || counters[key] < 0) reasons.push(`health counter ${key} is invalid`);
    }
    if (!Number.isSafeInteger(info.instances) || info.instances <= 0) {
      reasons.push("application has no configured healthy instances");
    } else if (counters.healthy !== info.instances) {
      reasons.push(`healthy instance count ${String(counters.healthy)} does not equal application count ${String(info.instances)}`);
    }
    for (const key of HEALTH_KEYS.filter((key) => key !== "healthy")) {
      if (counters[key] !== 0) reasons.push(`health counter ${key} is not terminal (${String(counters[key])})`);
    }
  }
  if (summary.instances !== info.instances) reasons.push("instance count changed between queries");

  for (const [index, instanceValue] of instancesValue.entries()) {
    const instance = object(instanceValue, `Cloudflare Container instance ${index}`);
    if (instance.state === "inactive") continue;
    if (instance.state !== "running") {
      reasons.push(`live instance ${String(instance.id)} state is ${JSON.stringify(instance.state)}, not running`);
    }
    if (instance.version !== info.version) {
      reasons.push(`live instance ${String(instance.id)} version ${String(instance.version)} is not target ${String(info.version)}`);
    }
  }

  return Object.freeze({
    applicationId: typeof info.id === "string" ? info.id : null,
    healthyInstances: Number.isSafeInteger(counters?.healthy) ? counters.healthy : null,
    image: typeof info.configuration?.image === "string" ? info.configuration.image : null,
    ready: reasons.length === 0,
    reasons: Object.freeze(reasons),
    version: Number.isSafeInteger(info.version) ? info.version : null,
  });
}

async function defaultWranglerJson(args, { configPath, timeoutMs }) {
  const { stdout } = await execFileAsync(
    "pnpm",
    ["exec", "wrangler", "containers", ...args, "--json", "--config", configPath],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      env: process.env,
      maxBuffer: 8 * 1024 * 1024,
      timeout: Math.max(1, timeoutMs),
    },
  );
  try {
    return JSON.parse(stdout);
  } catch (error) {
    throw new TypeError(`Wrangler returned invalid JSON for containers ${args[0]}.`, { cause: error });
  }
}

export async function inspectContainerRollout(
  target,
  { configPath, now = Date.now, timeoutMs, wranglerJson = defaultWranglerJson },
) {
  const deadline = now() + positiveInteger(timeoutMs, "timeoutMs");
  const queryTimeout = () => {
    const remainingMs = deadline - now();
    if (remainingMs <= 0) throw new Error("Container rollout inspection exceeded its deadline.");
    return remainingMs;
  };
  const summaries = await wranglerJson(["list", "--per-page", "100"], { configPath, timeoutMs: queryTimeout() });
  const summary = parseApplicationSummary(summaries, target);
  const info = await wranglerJson(["info", summary.id], { configPath, timeoutMs: queryTimeout() });
  const instances = [];
  let pageToken = null;
  const seenPageTokens = new Set();
  do {
    const pageArgs = ["instances", summary.id, "--per-page", "100"];
    if (pageToken !== null) pageArgs.push("--page-token", pageToken);
    const page = parseInstancesPage(await wranglerJson(pageArgs, { configPath, timeoutMs: queryTimeout() }));
    instances.push(...page.instances);
    pageToken = page.nextPageToken;
    if (pageToken !== null && seenPageTokens.has(pageToken)) {
      throw new Error("Wrangler container instances pagination repeated a page token.");
    }
    if (pageToken !== null) seenPageTokens.add(pageToken);
  } while (pageToken !== null);
  return { assessment: assessContainerRollout(target, summary, info, instances), info, instances, summary };
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

export async function waitForContainerRollout({
  configPath,
  inspect,
  now = Date.now,
  pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
  sleep = delay,
  stableObservations = REQUIRED_STABLE_OBSERVATIONS,
  target,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  writeStatus = (message) => process.stderr.write(`${message}\n`),
}) {
  positiveInteger(timeoutMs, "timeoutMs");
  positiveInteger(pollIntervalMs, "pollIntervalMs");
  positiveInteger(stableObservations, "stableObservations");
  const deadline = now() + timeoutMs;
  let attempt = 0;
  let lastFailure = "no observation completed";
  let stableCount = 0;
  let stableKey = null;

  while (true) {
    attempt += 1;
    const remainingMs = deadline - now();
    if (remainingMs <= 0) {
      throw new Error(`Container rollout did not become ready within ${String(timeoutMs)}ms: ${lastFailure}.`);
    }
    try {
      const observation = await inspect({ configPath, target, timeoutMs: remainingMs });
      const assessment = observation.assessment;
      if (assessment.ready) {
        const key = `${assessment.applicationId}:${String(assessment.version)}`;
        stableCount = key === stableKey ? stableCount + 1 : 1;
        stableKey = key;
        lastFailure = `only ${String(stableCount)} of ${String(stableObservations)} stable ready observations completed`;
        writeStatus(
          `Container rollout observation ${String(attempt)} is ready for version ${String(assessment.version)} `
          + `(${String(assessment.healthyInstances)} healthy; stable ${String(stableCount)}/${String(stableObservations)}).`,
        );
        if (stableCount >= stableObservations) return observation;
      } else {
        stableCount = 0;
        stableKey = null;
        lastFailure = assessment.reasons.join("; ");
        writeStatus(`Container rollout observation ${String(attempt)} is pending: ${lastFailure}.`);
      }
    } catch (error) {
      stableCount = 0;
      stableKey = null;
      lastFailure = errorMessage(error);
      writeStatus(`Container rollout observation ${String(attempt)} failed: ${lastFailure}.`);
    }

    const delayMs = Math.min(pollIntervalMs, deadline - now());
    if (delayMs <= 0) {
      throw new Error(`Container rollout did not become ready within ${String(timeoutMs)}ms: ${lastFailure}.`);
    }
    await sleep(delayMs);
  }
}

function receipt(target, observation, observedAt) {
  const assessment = observation.assessment;
  return {
    schema: "wasm-oj/container-rollout-gate/v1",
    observedAt,
    application: {
      id: assessment.applicationId,
      name: target.name,
      version: assessment.version,
      image: assessment.image,
      healthyInstances: assessment.healthyInstances,
    },
  };
}

async function writeReceipt(outputPath, value) {
  await mkdir(path.dirname(outputPath), { recursive: true });
  const temporaryPath = `${outputPath}.${String(process.pid)}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx" });
  await rename(temporaryPath, outputPath);
}

function usage() {
  return `Usage: node scripts/wait-container-rollout.mjs \\
  --config <rendered-worker-config> [--timeout-seconds 900] [--poll-interval-seconds 5] \\
  [--output <receipt.json>]`;
}

async function main() {
  const { values } = parseArgs({
    allowPositionals: false,
    options: {
      config: { type: "string", default: "wrangler.quick-production.jsonc" },
      help: { type: "boolean", short: "h", default: false },
      output: { type: "string" },
      "poll-interval-seconds": { type: "string", default: "5" },
      "timeout-seconds": { type: "string", default: "900" },
    },
    strict: true,
  });
  if (values.help) {
    console.log(usage());
    return;
  }
  if (!/^[1-9][0-9]*$/u.test(values["timeout-seconds"]) || !/^[1-9][0-9]*$/u.test(values["poll-interval-seconds"])) {
    throw new TypeError("timeout-seconds and poll-interval-seconds must be positive integers.");
  }
  const timeoutSeconds = Number(values["timeout-seconds"]);
  const pollIntervalSeconds = Number(values["poll-interval-seconds"]);
  if (!Number.isSafeInteger(timeoutSeconds) || timeoutSeconds > 3_600) {
    throw new TypeError("timeout-seconds must be at most 3600.");
  }
  if (!Number.isSafeInteger(pollIntervalSeconds) || pollIntervalSeconds > 60) {
    throw new TypeError("poll-interval-seconds must be at most 60.");
  }

  const configPath = path.resolve(values.config);
  const target = await readContainerRolloutTarget(configPath);
  const observation = await waitForContainerRollout({
    configPath,
    inspect: ({ timeoutMs }) => inspectContainerRollout(target, { configPath, timeoutMs }),
    pollIntervalMs: pollIntervalSeconds * 1_000,
    target,
    timeoutMs: timeoutSeconds * 1_000,
  });
  const value = receipt(target, observation, new Date().toISOString());
  if (values.output !== undefined) await writeReceipt(path.resolve(values.output), value);
  console.log(JSON.stringify(value));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(errorMessage(error));
    process.exitCode = 1;
  });
}
