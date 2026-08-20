import { createServer } from "node:http";
import {
  assertJudgeDataCostProfile,
  decodeJudgePackageForExecution,
  scoreJudgeDataResults,
  summarizeProblemPolicies,
  trustedJudgeSpec,
} from "@wasm-oj/core";
import { createServerEngine } from "@wasm-oj/server";
import { serverSource as clangToolchain } from "@wasm-oj/toolchain-clang";
import { serverSource as goToolchain } from "@wasm-oj/toolchain-go";
import { serverSource as javascriptToolchain } from "@wasm-oj/toolchain-javascript";
import { serverSource as javaToolchain } from "@wasm-oj/toolchain-java";
import { serverSource as pythonToolchain } from "@wasm-oj/toolchain-python";
import { serverSource as rustToolchain } from "@wasm-oj/toolchain-rust";
import { assertExpectedContainerIdentity, loadEmbeddedContainerIdentity } from "./identity.mjs";
import { caseProgressDecision } from "./progress.mjs";
import { formalSubmissionOutcome } from "./submission-result.mjs";

const MAX_REQUEST_BYTES = 64 * 1024;
const MAX_SOURCE_SNAPSHOT_BYTES = 2 * 1024 * 1024;
const MAX_JUDGE_PACKAGE_BYTES = 32 * 1024 * 1024;
const MAX_JUDGE_JOB_OUTPUT_BYTES = 32 * 1024 * 1024;
const encoder = new TextEncoder();
const embeddedIdentity = loadEmbeddedContainerIdentity();
function containerToolchainSource(source) {
  return Object.freeze({ ...source, directory: new URL("file:///app/public/toolchains/") });
}
const toolchains = Object.freeze([
  clangToolchain(), rustToolchain(), pythonToolchain(), javascriptToolchain(), goToolchain(), javaToolchain(),
].map(containerToolchainSource));

class ContainerProtocolError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = "ContainerProtocolError";
    this.status = status;
    this.code = code;
  }
}

function json(value, status = 200) {
  return new Response(`${JSON.stringify(value)}\n`, {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

async function sha256Hex(bytes) {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function boundedRequestBody(request) {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (!Number.isSafeInteger(declared) || declared < 0 || declared > MAX_REQUEST_BYTES) {
    throw new ContainerProtocolError(400, "job-size-invalid", "Container job exceeds its size limit.");
  }
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.byteLength > MAX_REQUEST_BYTES) throw new ContainerProtocolError(400, "job-size-invalid", "Container job exceeds its size limit.");
  return bytes;
}

async function boundedResponseBody(response, maximum, label) {
  const declaredHeader = response.headers.get("content-length");
  if (declaredHeader !== null) {
    const declared = Number(declaredHeader);
    if (!Number.isSafeInteger(declared) || declared < 1 || declared > maximum) {
      throw new ContainerProtocolError(500, "authorized-object-size", `${label} exceeds its authorized size limit.`);
    }
  }
  if (!response.body) throw new ContainerProtocolError(500, "authorized-object-empty", `${label} has no response body.`);
  const chunks = [];
  let received = 0;
  const reader = response.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > maximum) {
        await reader.cancel("authorized object exceeds limit");
        throw new ContainerProtocolError(500, "authorized-object-size", `${label} exceeds its authorized size limit.`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

async function verifiedResponseBody(response, expectedSha256, maximum, label) {
  if (!/^[0-9a-f]{64}$/.test(expectedSha256)) {
    throw new ContainerProtocolError(400, "job-object-digest-invalid", `${label} has no valid expected digest.`);
  }
  if (response.headers.get("x-wasm-oj-sha256") !== expectedSha256) {
    throw new ContainerProtocolError(500, "authorized-object-integrity", `${label} metadata disagrees with the job.`);
  }
  const bytes = await boundedResponseBody(response, maximum, label);
  if (await sha256Hex(bytes) !== expectedSha256) {
    bytes.fill(0);
    throw new ContainerProtocolError(500, "authorized-object-integrity", `${label} bytes do not match the expected digest.`);
  }
  return bytes;
}

function parseJson(bytes, label) {
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new ContainerProtocolError(400, "job-object-json-invalid", `${label} is not valid UTF-8 JSON.`);
  }
}

async function callback(job, pathname, method = "GET", body) {
  return fetch(`http://wasm-oj-job.internal${pathname}`, {
    method,
    headers: {
      "x-wasm-oj-attempt-token": job.attemptToken,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function emit(job, event) {
  const response = await callback(job, "/events", "POST", event);
  if (!response.ok) throw new Error(`event callback failed with HTTP ${response.status}`);
  await response.body?.cancel();
}

function sourceFiles(request) {
  if (!request || typeof request !== "object" || !Array.isArray(request.sourceFiles)) {
    throw new ContainerProtocolError(400, "source-contract-invalid", "Submission source request is invalid.");
  }
  return Object.fromEntries(request.sourceFiles.map((file) => [
    file.path,
    file.encoding === "utf8" ? file.content : new Uint8Array(Buffer.from(file.content, "base64")),
  ]));
}

function compilerDiagnosticBytes(build) {
  const fields = [build.stdout, build.stderr];
  for (const diagnostic of build.diagnostics ?? []) {
    fields.push(diagnostic.message, diagnostic.file, diagnostic.source, diagnostic.code ?? "");
  }
  return fields.reduce((total, value) => total + encoder.encode(String(value ?? "")).byteLength, 0);
}

async function executeSubmission(job, identity) {
  const [sourceResponse, judgeResponse] = await Promise.all([
    callback(job, "/r2/source"),
    callback(job, "/r2/judge"),
  ]);
  if (!sourceResponse.ok || !judgeResponse.ok) {
    throw new Error(`authorized R2 read failed (${sourceResponse.status}/${judgeResponse.status})`);
  }
  const [sourceBytes, judgeBytes] = await Promise.all([
    verifiedResponseBody(sourceResponse, job.sourceSha256, MAX_SOURCE_SNAPSHOT_BYTES, "source snapshot"),
    verifiedResponseBody(judgeResponse, job.executionSemanticSha256, MAX_JUDGE_PACKAGE_BYTES, "judge package"),
  ]);
  const source = parseJson(sourceBytes, "source snapshot");
  if (source?.schema !== "wasm-oj-platform/official-source/v1" || !source.request) {
    throw new ContainerProtocolError(400, "source-contract-invalid", "Submission source uses an unsupported schema.");
  }
  const judgePackage = await decodeJudgePackageForExecution(judgeBytes);
  if (judgePackage.executionSemanticSha256 !== job.executionSemanticSha256) {
    throw new ContainerProtocolError(409, "judge-package-identity", "Judge package identity does not match admission.");
  }
  const compileRequest = source.request;
  const allowedProfile = judgePackage.allowedProfiles[compileRequest.language];
  if (!allowedProfile || allowedProfile.target !== compileRequest.target || allowedProfile.optimization !== compileRequest.optimization) {
    throw new ContainerProtocolError(409, "compile-profile-not-allowed", "Submission compile profile is not allowed by the judge package.");
  }
  await emit(job, { kind: "state", state: "preparing" });
  const engine = await createServerEngine({
    runtimeDirectory: "/app/runtime",
    toolchains,
    cacheDirectory: `/tmp/wasm-oj-${job.jobId}-${job.attempt}`,
    artifactCache: false,
    verifiedDistribution: identity.verifiedDistribution,
  });
  try {
    await emit(job, { kind: "state", state: "compiling" });
    const spec = trustedJudgeSpec(judgePackage.judgeData, judgePackage.judge);
    await emit(job, { kind: "compile-progress", phase: "compile" });
    const build = await engine.compile({
      language: compileRequest.language,
      target: compileRequest.target,
      optimization: compileRequest.optimization,
      entry: compileRequest.entry,
      files: sourceFiles(compileRequest),
      name: `submission-${job.submissionId}`,
      projectId: job.submissionId,
    }, { cache: false });
    const compileOutputBytes = compilerDiagnosticBytes(build);
    if (!build.success || !build.artifact || compileOutputBytes >= MAX_JUDGE_JOB_OUTPUT_BYTES) {
      await emit(job, { kind: "verdict", verdict: "compile-error", score: 0, fullyPassedCases: 0 });
      return { state: "compile-error", score: 0, fullyPassedCases: 0 };
    }
    try {
      assertJudgeDataCostProfile(judgePackage.judgeData, compileRequest.language, build.artifact.costProfile);
    } catch {
      throw new ContainerProtocolError(409, "cost-profile-identity", "Compiled artifact does not match judge calibration identity.");
    }
    await emit(job, { kind: "state", state: "running" });
    let lastProgressBucket = -1;
    const judged = await engine.judging.judge(build.artifact, spec, {
      retention: "metrics-only",
      aggregateOutputLimitBytes: MAX_JUDGE_JOB_OUTPUT_BYTES - compileOutputBytes,
      onCase: async (_result, completed, total) => {
        const progress = caseProgressDecision(completed, total, lastProgressBucket);
        if (progress.emit) {
          lastProgressBucket = progress.bucket;
          await emit(job, { kind: "case-progress", completedCases: completed, totalCases: total });
        }
      },
    });
    const scoring = judged.verdict === "judge-error"
      ? { points: 0, cases: [] }
      : scoreJudgeDataResults(judgePackage.judgeData, compileRequest.language, judged.cases);
    const outcome = formalSubmissionOutcome(judged.verdict, scoring);
    const deterministicCost = judged.metrics.cost ?? Number.MAX_SAFE_INTEGER;
    const peakMemoryBytes = judged.metrics.maxMemoryBytes ?? Number.MAX_SAFE_INTEGER;
    const verdict = judged.verdict === "accepted" ? "accepted" : judged.verdict;
    await emit(job, { kind: "verdict", verdict, score: outcome.score, fullyPassedCases: outcome.fullyPassedCases });
    await emit(job, { kind: "resource-summary", deterministicCost, peakMemoryBytes });
    await emit(job, { kind: "state", state: "finalizing" });
    return {
      state: outcome.state,
      verdict,
      score: outcome.score,
      fullyPassedCases: outcome.fullyPassedCases,
      deterministicCost,
      peakMemoryBytes,
      ...(outcome.state === "completed"
        ? { policySummary: summarizeProblemPolicies(scoring) }
        : {}),
    };
  } finally {
    engine.dispose();
    sourceBytes.fill(0);
    judgeBytes.fill(0);
  }
}

async function execute(request) {
  const job = parseJson(await boundedRequestBody(request), "container job");
  const identity = await embeddedIdentity;
  assertExpectedContainerIdentity(job, identity);
  if (job.kind !== "submission") return json({ error: { code: "unsupported-job-kind" } }, 400);
  return json(await executeSubmission(job, identity));
}

function safeContainerFailure(error) {
  if (error instanceof ContainerProtocolError) {
    return { status: error.status, body: { error: { code: error.code } } };
  }
  return { status: 500, body: { error: { code: "container-infrastructure-error" } } };
}

const server = createServer(async (incoming, outgoing) => {
  try {
    const url = new URL(incoming.url ?? "/", "http://container");
    if (incoming.method === "GET" && url.pathname === "/health") {
      outgoing.writeHead(200, { "content-type": "text/plain" });
      outgoing.end("ok\n");
      return;
    }
    if (incoming.method === "GET" && url.pathname === "/identity") {
      const identity = await embeddedIdentity;
      outgoing.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      outgoing.end(`${JSON.stringify(identity)}\n`);
      return;
    }
    const request = new Request(`http://container${url.pathname}`, {
      method: incoming.method,
      headers: incoming.headers,
      ...(incoming.method === "GET" || incoming.method === "HEAD" ? {} : { body: incoming, duplex: "half" }),
    });
    const response = incoming.method === "POST" && url.pathname === "/execute"
      ? await execute(request)
      : json({ error: { code: "not-found" } }, 404);
    outgoing.writeHead(response.status, Object.fromEntries(response.headers));
    outgoing.end(Buffer.from(await response.arrayBuffer()));
  } catch (error) {
    const failure = safeContainerFailure(error);
    outgoing.writeHead(failure.status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
    outgoing.end(`${JSON.stringify(failure.body)}\n`);
  }
});

server.listen(8080, "0.0.0.0");
