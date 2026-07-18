import { execFileSync, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { sourceTreeProvenance } from "../src/conformance/provenance.ts";
import { FORGE_CONTRACT_VERSION, FORGE_SCHEMAS } from "../src/core/contract.ts";

const EXPERIMENT_ID = `forge-contract-${FORGE_CONTRACT_VERSION}-conformance`;
const SPEC_PATH = path.resolve(`experiments/${EXPERIMENT_ID}/SPEC.md`);
const RAW_DIRECTORY = path.resolve(`experiments/${EXPERIMENT_ID}/runs/raw/records`);
const NETWORK_POLICY = "loopback-same-origin-http";
const suite = process.env.FORGE_CONFORMANCE_SUITE === "full" ? "full" : "default";
const requestedCases = process.env.FORGE_CONFORMANCE_CASES?.split(",").filter(Boolean) ?? [];
const repetitions = Number(process.env.FORGE_CONFORMANCE_REPETITIONS ?? "3");
if (!Number.isInteger(repetitions) || repetitions < 2) {
  throw new Error("FORGE_CONFORMANCE_REPETITIONS must be an integer of at least 2.");
}
const urlArgument = process.argv[2];
if (process.argv.length > 3) throw new Error("Usage: node scripts/run-browser-conformance.mjs [base-url]");
if (urlArgument) new URL(urlArgument);

if (isEntrypoint()) await main();

async function main() {
  const spec = await readFile(SPEC_PATH);
  const runId = `${new Date().toISOString().replaceAll(":", "-")}-${randomUUID()}`;
  let server;
  let browser;
  let snapshot;
  let failure;
  const consoleErrors = [];
  const pageErrors = [];
  let browserEnvironment;
  const networkProof = {
    policy: NETWORK_POLICY,
    serviceWorkers: "blocked",
    allowedOrigin: null,
    localBaseUrl: false,
    httpRequests: [],
    violations: [],
  };

  try {
    const baseUrl = urlArgument ?? await startServer().then((value) => {
      server = value.child;
      return value.url;
    });
    const allowedOrigin = requireLocalBrowserOrigin(baseUrl);
    networkProof.allowedOrigin = allowedOrigin;
    networkProof.localBaseUrl = true;
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ serviceWorkers: "block" });
    await context.route("**/*", async (route) => {
      const request = route.request();
      const decision = classifyBrowserHttpRequest(request.url(), allowedOrigin);
      if (!decision.tracked) {
        await route.continue();
        return;
      }
      const entry = {
        url: request.url(),
        method: request.method(),
        resourceType: request.resourceType(),
        navigation: request.isNavigationRequest(),
        postDataBytes: request.postDataBuffer()?.byteLength ?? 0,
        allowed: decision.allowed,
        reason: decision.reason,
      };
      networkProof.httpRequests.push(entry);
      if (!decision.allowed) {
        networkProof.violations.push(entry);
        await route.abort("blockedbyclient");
        return;
      }
      await route.continue();
    });
    const page = await context.newPage();
    page.on("console", (message) => {
      if (message.type() === "error") consoleErrors.push(message.text());
    });
    page.on("pageerror", (error) => pageErrors.push(error.message));
    const target = new URL("/conformance", baseUrl);
    target.searchParams.set("autorun", "1");
    target.searchParams.set("repetitions", String(repetitions));
    if (suite === "full") target.searchParams.set("suite", "full");
    if (requestedCases.length > 0) target.searchParams.set("cases", requestedCases.join(","));
    await page.goto(target.toString(), { waitUntil: "domcontentloaded", timeout: 120_000 });
    await page.waitForFunction(
      () => Boolean(window.__FORGE_CONFORMANCE__) || Boolean(document.querySelector("[data-testid=conformance-error]")),
      undefined,
      { timeout: 1_800_000 },
    );
    snapshot = await page.evaluate(() => window.__FORGE_CONFORMANCE__);
    failure = await page.locator("[data-testid=conformance-error]").textContent().catch(() => undefined);
    browserEnvironment = await page.evaluate(() => ({
      userAgent: navigator.userAgent,
      hardwareConcurrency: navigator.hardwareConcurrency,
      crossOriginIsolated,
    }));
    browserEnvironment.version = browser.version();
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error);
  } finally {
    try {
      await browser?.close();
    } catch (error) {
      failure = appendFailure(failure, `Browser cleanup failed: ${errorMessage(error)}`);
    }
    try {
      await stopServer(server);
    } catch (error) {
      failure = appendFailure(failure, `Development-server cleanup failed: ${errorMessage(error)}`);
    }
  }

  if (networkProof.violations.length > 0) {
    const message = `Browser network policy blocked ${networkProof.violations.length} non-local or cross-origin HTTP(S) request(s).`;
    failure = failure ? `${failure}\n${message}` : message;
  }

  const record = {
    schema: FORGE_SCHEMAS.conformanceEvidence,
    experimentId: EXPERIMENT_ID,
    runId,
    collectedAt: new Date().toISOString(),
    forgeContract: FORGE_CONTRACT_VERSION,
    suite,
    specPath: path.relative(process.cwd(), SPEC_PATH),
    specSha256: sha256(spec),
    executionCommand: [
      suite === "full" ? "FORGE_CONFORMANCE_SUITE=full" : "",
      requestedCases.length > 0 ? `FORGE_CONFORMANCE_CASES=${requestedCases.join(",")}` : "",
      repetitions === 3 ? "" : `FORGE_CONFORMANCE_REPETITIONS=${repetitions}`,
      urlArgument ? `pnpm run conformance:browser ${urlArgument}` : "pnpm run conformance:browser",
    ].filter(Boolean).join(" "),
    gitHead: git("rev-parse", "HEAD"),
    worktreeStatus: git("status", "--short"),
    sourceTree: await sourceTreeProvenance(),
    environment: {
      platform: process.platform,
      architecture: process.arch,
      node: process.version,
      cpu: os.cpus()[0]?.model ?? "unknown",
      browser: browserEnvironment,
    },
    networkProof,
    consoleErrors,
    pageErrors,
    failure,
    snapshot,
  };
  await mkdir(RAW_DIRECTORY, { recursive: true });
  const output = path.join(RAW_DIRECTORY, `${runId}.json`);
  await writeFile(output, `${JSON.stringify(record, null, 2)}\n`, { flag: "wx" });
  process.stdout.write(`FORGE_BROWSER_CONFORMANCE_EVIDENCE=${output}\n`);

  const invalid = failure
    || !networkProof.localBaseUrl
    || networkProof.violations.length > 0
    || consoleErrors.length > 0
    || pageErrors.length > 0
    || !snapshot
    || snapshot.schema !== FORGE_SCHEMAS.conformance
    || snapshot.samples?.some((sample) => !sample.success);
  if (invalid) {
    process.stderr.write(`${failure ?? "Browser conformance failed validation."}\n`);
    process.exitCode = 1;
  }
}

export function requireLocalBrowserOrigin(baseUrl) {
  const parsed = new URL(baseUrl);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`Browser conformance requires an HTTP(S) base URL, received '${parsed.protocol}'.`);
  }
  if (parsed.username || parsed.password) {
    throw new Error("Browser conformance does not accept credentials in its base URL.");
  }
  if (!isLoopbackHostname(parsed.hostname)) {
    throw new Error(`Browser conformance requires a loopback base URL, received '${parsed.hostname}'.`);
  }
  return parsed.origin;
}

export function classifyBrowserHttpRequest(requestUrl, allowedOrigin) {
  let parsed;
  try {
    parsed = new URL(requestUrl);
  } catch {
    return { tracked: true, allowed: false, reason: "invalid-url" };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { tracked: false, allowed: true, reason: "non-http" };
  }
  if (!isLoopbackHostname(parsed.hostname)) {
    return { tracked: true, allowed: false, reason: "non-loopback-host" };
  }
  if (parsed.origin !== allowedOrigin) {
    return { tracked: true, allowed: false, reason: "cross-origin" };
  }
  return { tracked: true, allowed: true, reason: "same-origin-loopback" };
}

function isLoopbackHostname(hostname) {
  const normalized = hostname.toLowerCase();
  if (normalized === "localhost" || normalized === "[::1]" || normalized === "::1") return true;
  const octets = normalized.split(".");
  return octets.length === 4
    && octets[0] === "127"
    && octets.every((octet) => /^\d{1,3}$/.test(octet) && Number(octet) <= 255);
}

function startServer() {
  return new Promise((resolve, reject) => {
    const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
    const child = spawn(pnpm, ["run", "dev"], {
      cwd: process.cwd(),
      env: { ...process.env, NO_COLOR: "1" },
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
    let settled = false;
    let output = "";
    const timer = setTimeout(() => finish(new Error(`Development server did not become ready.\n${output}`)), 120_000);
    const finish = (error, url) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) {
        void stopServer(child).then(() => reject(error), reject);
      } else {
        resolve({ child, url });
      }
    };
    const inspect = (chunk) => {
      const decoded = stripAnsi(chunk.toString("utf8"));
      output += decoded;
      const matched = decoded.match(/Local:\s+(https?:\/\/[^\s]+)/) ?? output.match(/Local:\s+(https?:\/\/[^\s]+)/);
      if (matched?.[1]) finish(undefined, matched[1]);
    };
    child.stdout.on("data", inspect);
    child.stderr.on("data", inspect);
    child.on("error", finish);
    child.on("close", (code) => {
      if (!settled) finish(new Error(`Development server exited with code ${code}.\n${output}`));
    });
  });
}

export async function stopServer(child) {
  if (!child?.pid) return;
  if (process.platform === "win32") {
    const code = await new Promise((resolve) => {
      const killer = spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
      });
      killer.once("error", () => resolve(-1));
      killer.once("close", (status) => resolve(status ?? -1));
    });
    await waitForChildExit(child, 5_000);
    if (code !== 0 && child.exitCode === null && child.signalCode === null) {
      throw new Error(`taskkill could not terminate development-server process tree ${child.pid}.`);
    }
    return;
  }

  signalProcessGroup(child.pid, "SIGTERM");
  await Promise.all([
    waitForChildExit(child, 5_000),
    waitForProcessGroupExit(child.pid, 5_000),
  ]);
  if (processGroupExists(child.pid)) {
    signalProcessGroup(child.pid, "SIGKILL");
    await waitForProcessGroupExit(child.pid, 5_000);
    if (processGroupExists(child.pid)) {
      throw new Error(`Development-server process group ${child.pid} survived SIGKILL.`);
    }
  }
}

function signalProcessGroup(pid, signal) {
  try {
    process.kill(-pid, signal);
  } catch (error) {
    if (error?.code !== "ESRCH") throw error;
  }
}

function processGroupExists(pid) {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    // A just-orphaned process group can transiently report EPERM while its
    // final member is being reaped. It still exists, so keep waiting.
    if (error?.code === "EPERM") return true;
    throw error;
  }
}

async function waitForChildExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise((resolve) => {
    const timer = setTimeout(done, timeoutMs);
    child.once("close", done);
    function done() {
      clearTimeout(timer);
      child.off("close", done);
      resolve();
    }
  });
}

async function waitForProcessGroupExit(pid, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (processGroupExists(pid) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

function stripAnsi(value) {
  return value.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "");
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function git(...args) {
  try {
    return execFileSync("git", args, { encoding: "utf8" }).trim();
  } catch {
    return "unavailable";
  }
}

function appendFailure(current, next) {
  return current ? `${current}\n${next}` : next;
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function isEntrypoint() {
  return process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
}
