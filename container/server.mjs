import { createServer } from "node:http";
import { gunzipSync } from "node:zlib";
import {
  assertProblemCostProfile,
  BROWSER_PROBLEM_SCHEMA,
  createManagedJudgeRuntimeProjection,
  createForgeValidationSource,
  forgeValidationSourceBytes,
  isCostProfileFor,
  managedJudgeSpec,
  parseStandaloneProblemBundle,
  redactJudgeCasesForAudit,
  scoreProblemResults,
  verifyForgeValidationSourceBytes,
  verifyForgeValidationSourceObjects,
} from "@wasm-oj/forge";
import { createServerForge } from "@wasm-oj/forge/server";
import { assertExpectedContainerIdentity, loadEmbeddedContainerIdentity } from "./identity.mjs";
import { OutputBudget, OutputBudgetExceededError } from "./output-budget.mjs";
import { formalSubmissionOutcome } from "./submission-result.mjs";

const MAX_REQUEST_BYTES = 64 * 1024;
const MAX_SOURCE_SNAPSHOT_BYTES = 2 * 1024 * 1024;
const MAX_JUDGE_PROJECTION_BYTES = 32 * 1024 * 1024;
const MAX_CANONICAL_OBJECT_BYTES = 32 * 1024 * 1024;
const MAX_ARCHIVE_BYTES = 128 * 1024 * 1024;
const MAX_EXPANDED_BYTES = 256 * 1024 * 1024;
const MAX_ARCHIVE_ENTRIES = 10_000;
const MAX_ARCHIVE_FILE_BYTES = 32 * 1024 * 1024;
const MAX_JUDGE_JOB_OUTPUT_BYTES = 32 * 1024 * 1024;
const MAX_VALIDATION_JOB_OUTPUT_BYTES = 64 * 1024 * 1024;
const MAX_MANAGED_PROBLEMS = 64;
const encoder = new TextEncoder();
const embeddedIdentity = loadEmbeddedContainerIdentity();

class ContainerProtocolError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = "ContainerProtocolError";
    this.status = status;
    this.code = code;
  }
}

class ValidationRejectedError extends ContainerProtocolError {
  constructor(message = "The repository does not satisfy the managed collection contract.") {
    super(422, "validation-input-rejected", message);
    this.name = "ValidationRejectedError";
  }
}

function json(value, status = 200) {
  return new Response(`${JSON.stringify(value)}\n`, {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalValue(value[key])]));
}

function canonicalBytes(value) {
  return encoder.encode(`${JSON.stringify(canonicalValue(value))}\n`);
}

async function sha256Hex(bytes) {
  const digest = await crypto.subtle.digest("SHA-256", bytes.slice().buffer);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function boundedRequestBody(request, maximum = MAX_REQUEST_BYTES) {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (declared > maximum) throw new Error("request body exceeds its limit");
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.byteLength > maximum) throw new Error("request body exceeds its limit");
  return bytes;
}

async function boundedResponseBody(response, maximum, label) {
  const declaredHeader = response.headers.get("content-length");
  if (declaredHeader !== null) {
    const declared = Number(declaredHeader);
    if (!Number.isSafeInteger(declared) || declared < 0 || declared > maximum) {
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
      if (received > maximum) throw new ContainerProtocolError(500, "authorized-object-size", `${label} exceeds its authorized size limit.`);
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
  const declaredDigest = response.headers.get("x-forge-sha256");
  if (declaredDigest !== null && declaredDigest !== expectedSha256) {
    throw new ContainerProtocolError(500, "authorized-object-integrity", `${label} response metadata disagrees with the job.`);
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
  } catch (error) {
    throw new Error(`${label} is not valid UTF-8 JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function callback(job, pathname, method = "GET", body) {
  return fetch(`http://forge-job.internal${pathname}`, {
    method,
    headers: {
      "x-forge-attempt-token": job.attemptToken,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function emit(job, event) {
  const response = await callback(job, "/events", "POST", event);
  if (!response.ok) throw new Error(`event callback failed with HTTP ${response.status}`);
}

function sourceFiles(request) {
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

function consumeValidationOutput(budget, bytes) {
  try {
    budget.consume(bytes);
  } catch (error) {
    if (error instanceof OutputBudgetExceededError) {
      throw new ValidationRejectedError("The managed collection exceeds the validation job output budget.");
    }
    throw error;
  }
}

async function executeSubmission(job, identity) {
  const [sourceResponse, judgeResponse] = await Promise.all([
    callback(job, "/r2/source"),
    callback(job, "/r2/judge"),
  ]);
  if (!sourceResponse.ok || !judgeResponse.ok) throw new Error(`authorized R2 read failed (${sourceResponse.status}/${judgeResponse.status})`);
  const [sourceBytes, judgeBytes] = await Promise.all([
    verifiedResponseBody(sourceResponse, job.sourceSha256, MAX_SOURCE_SNAPSHOT_BYTES, "source snapshot"),
    verifiedResponseBody(judgeResponse, job.judgeSha256, MAX_JUDGE_PROJECTION_BYTES, "judge projection"),
  ]);
  // Verify authorized bytes before JSON parsing. R2 keys and metadata are never
  // treated as substitutes for the content digest carried by the immutable job.
  const source = parseJson(sourceBytes, "source snapshot");
  const projection = parseJson(judgeBytes, "judge projection");
  if (source?.schema !== "forge-official-source-v1" || projection?.schema !== "forge-server-judge-projection-v1") {
    throw new Error("job objects use unsupported schemas");
  }
  if (
    projection.forgeReleaseId !== job.expectedReleaseId
    || !/^[0-9a-f]{64}$/.test(job.expectedProblemBundleDigest ?? "")
    || projection.digest !== job.expectedProblemBundleDigest
  ) {
    throw new ContainerProtocolError(409, "judge-projection-identity", "Judge projection identity does not match the immutable admission.");
  }
  const problem = parseStandaloneProblemBundle({ schema: BROWSER_PROBLEM_SCHEMA, problem: projection.problem });
  const request = source.request;
  const allowedProfile = projection.allowedProfiles?.[request.language];
  if (!allowedProfile || allowedProfile.target !== request.target || allowedProfile.optimization !== request.optimization) {
    throw new Error("submission compile profile is not allowed by the managed snapshot");
  }
  await emit(job, { kind: "state", state: "preparing" });
  const engine = await createServerForge({
    runtimeDirectory: "/app/runtime",
    toolchainDirectory: "/app/public/toolchains",
    cacheDirectory: `/tmp/forge-${job.jobId}-${job.attempt}`,
    artifactCache: false,
  });
  try {
    await emit(job, { kind: "state", state: "compiling" });
    const spec = await managedJudgeSpec(problem, projection.judge);
    await emit(job, { kind: "compile-progress", phase: "compile" });
    const build = await engine.compile({
      language: request.language,
      target: request.target,
      optimization: request.optimization,
      entry: request.entry,
      files: sourceFiles(request),
      name: `submission-${job.submissionId}`,
      projectId: job.submissionId,
    }, { cache: false });
    const compileOutputBytes = compilerDiagnosticBytes(build);
    if (compileOutputBytes >= MAX_JUDGE_JOB_OUTPUT_BYTES) {
      await emit(job, { kind: "verdict", verdict: "compile-error", score: 0, fullyPassedCases: 0 });
      return { state: "compile-error", score: 0, fullyPassedCases: 0 };
    }
    if (!build.success || !build.artifact) {
      await emit(job, { kind: "verdict", verdict: "compile-error", score: 0, fullyPassedCases: 0 });
      return { state: "compile-error", score: 0, fullyPassedCases: 0 };
    }
    try {
      assertProblemCostProfile(problem, request.language, build.artifact.costProfile);
    } catch {
      throw new ContainerProtocolError(409, "cost-profile-identity", "Compiled artifact does not match the managed snapshot calibration identity.");
    }
    await emit(job, { kind: "state", state: "running" });
    const judge = await engine.judge(build.artifact, spec, {
      retention: "metrics-only",
      aggregateOutputLimitBytes: MAX_JUDGE_JOB_OUTPUT_BYTES - compileOutputBytes,
      onCase: async (_result, completed, total) => {
        await emit(job, { kind: "case-progress", completedCases: completed, totalCases: total });
      },
    });
    const scoring = judge.verdict === "judge-error"
      ? { points: 0, cases: [] }
      : scoreProblemResults(problem, request.language, judge.cases);
    const outcome = formalSubmissionOutcome(judge.verdict, scoring);
    const deterministicCost = judge.metrics.cost ?? Number.MAX_SAFE_INTEGER;
    const peakMemoryBytes = judge.metrics.maxMemoryBytes ?? Number.MAX_SAFE_INTEGER;
    const verdict = judge.verdict === "accepted" ? "accepted" : judge.verdict;
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
      audit: {
        schema: "forge-submission-audit-v1",
        submissionId: job.submissionId,
        attempt: job.attempt,
        sourceDigest: source.sourceDigest,
        forgeReleaseId: projection.forgeReleaseId,
        expectedManifestSha256: job.expectedManifestSha256,
        expectedContainerIdentitySha256: job.expectedContainerIdentitySha256,
        actualContainerIdentitySha256: identity.identitySha256,
        judgeProjectionSha256: job.judgeSha256,
        problemBundleDigest: projection.digest,
        cases: redactJudgeCasesForAudit(judge.cases),
      },
    };
  } finally {
    engine.dispose();
  }
}

function tarString(bytes) {
  const zero = bytes.indexOf(0);
  return Buffer.from(zero >= 0 ? bytes.subarray(0, zero) : bytes).toString("utf8").trim();
}

function tarOctal(bytes, label) {
  const value = tarString(bytes).replace(/^0+/, "") || "0";
  if (!/^[0-7]+$/.test(value)) throw new Error(`${label} has invalid tar octal metadata`);
  const parsed = Number.parseInt(value, 8);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`${label} has unsafe tar metadata`);
  return parsed;
}

function normalizedArchivePath(value) {
  if (!value || value.startsWith("/") || value.includes("\\") || value.includes("\0")) throw new Error(`archive path '${value}' is unsafe`);
  const parts = value.replace(/\/$/, "").split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) throw new Error(`archive path '${value}' is unsafe`);
  return parts;
}

function parseGitHubTarGz(archive) {
  if (archive.byteLength > MAX_ARCHIVE_BYTES) throw new Error("repository archive exceeds 128 MiB");
  const tar = new Uint8Array(gunzipSync(archive, { maxOutputLength: MAX_EXPANDED_BYTES }));
  const files = new Map();
  let offset = 0;
  let entries = 0;
  let root;
  while (offset + 512 <= tar.byteLength) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    entries += 1;
    if (entries > MAX_ARCHIVE_ENTRIES) throw new Error("repository archive has too many entries");
    const storedChecksum = tarOctal(header.subarray(148, 156), "tar header");
    let checksum = 0;
    for (let index = 0; index < header.length; index += 1) checksum += index >= 148 && index < 156 ? 32 : header[index];
    if (storedChecksum !== checksum) throw new Error("repository archive tar checksum is invalid");
    const name = tarString(header.subarray(0, 100));
    const prefix = tarString(header.subarray(345, 500));
    const parts = normalizedArchivePath(prefix ? `${prefix}/${name}` : name);
    root ??= parts[0];
    if (parts[0] !== root) throw new Error("repository archive contains multiple roots");
    const relative = parts.slice(1).join("/");
    const size = tarOctal(header.subarray(124, 136), relative || "archive root");
    if (size > MAX_ARCHIVE_FILE_BYTES) throw new Error(`archive file '${relative}' exceeds 32 MiB`);
    const type = String.fromCharCode(header[156] || 48);
    if (type === "1" || type === "2") throw new Error(`archive link '${relative}' is forbidden`);
    if (type !== "0" && type !== "5") throw new Error(`archive entry '${relative}' has unsupported tar type '${type}'`);
    const dataStart = offset + 512;
    const dataEnd = dataStart + size;
    if (dataEnd > tar.byteLength) throw new Error(`archive entry '${relative}' is truncated`);
    if (type === "0" && relative) {
      if (files.has(relative)) throw new Error(`archive repeats '${relative}'`);
      const contents = tar.slice(dataStart, dataEnd);
      const prefixText = Buffer.from(contents.subarray(0, 200)).toString("utf8");
      if (prefixText.startsWith("version https://git-lfs.github.com/spec/v1")) throw new Error(`Git LFS pointer '${relative}' is forbidden`);
      if (relative === ".gitmodules") throw new Error("Git submodules are forbidden");
      files.set(relative, contents);
    }
    offset = dataStart + Math.ceil(size / 512) * 512;
  }
  return files;
}

async function uploadProjection(job, value) {
  const bytes = canonicalBytes(value);
  if (bytes.byteLength > MAX_JUDGE_PROJECTION_BYTES) {
    throw new ValidationRejectedError("A generated managed projection exceeds 32 MiB.");
  }
  return uploadObject(job, bytes, "application/json");
}

async function uploadObject(job, bytes, contentType = "application/octet-stream") {
  const digest = await sha256Hex(bytes);
  const response = await fetch(`http://forge-job.internal/r2/output/${digest}`, {
    method: "PUT",
    headers: { "content-type": contentType, "x-forge-attempt-token": job.attemptToken },
    body: bytes,
  });
  if (!response.ok) throw new Error(`projection upload failed with HTTP ${response.status}`);
  return response.json();
}

async function reloadUploadedObject(job, reference, maximum = MAX_CANONICAL_OBJECT_BYTES) {
  if (!reference || typeof reference.digest !== "string" || !/^[0-9a-f]{64}$/.test(reference.digest) || !Number.isSafeInteger(reference.bytes)) {
    throw new ContainerProtocolError(500, "canonical-object-reference", "Canonical object upload returned an invalid reference.");
  }
  const response = await callback(job, `/r2/output/${reference.digest}`);
  if (!response.ok) throw new ContainerProtocolError(500, "canonical-object-read", "Canonical object read-back failed.");
  const bytes = await verifiedResponseBody(response, reference.digest, maximum, "canonical source object");
  if (bytes.byteLength !== reference.bytes) {
    bytes.fill(0);
    throw new ContainerProtocolError(500, "canonical-object-integrity", "Canonical object read-back has an unexpected length.");
  }
  return bytes;
}

async function managedProgramInput(program, repositoryFiles, label) {
  const result = {};
  for (const file of program.files) {
    const bytes = repositoryFiles.get(file.repositoryPath);
    if (!bytes || bytes.byteLength !== file.bytes || await sha256Hex(bytes) !== file.sha256) throw new Error(`${label} source '${file.path}' failed integrity verification`);
    try {
      result[file.path] = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      throw new Error(`${label} source '${file.path}' is not UTF-8 text`);
    }
  }
  return {
    language: program.language,
    target: program.target,
    optimization: program.optimization,
    entry: program.entry,
    files: result,
    name: label,
    projectId: label,
  };
}

async function compileManagedJudge(engine, problem, managed, repositoryFiles, outputBudget) {
  if (managed.judge.kind === "text") {
    return createManagedJudgeRuntimeProjection(managed.judge, undefined, repositoryFiles);
  }
  if (!engine) throw new Error("Trusted judge compilation engine is unavailable.");
  const label = `${managed.judge.kind}-${problem.id}`;
  const build = await engine.compile(await managedProgramInput(managed.judge.program, repositoryFiles, label), { cache: false });
  consumeValidationOutput(outputBudget, compilerDiagnosticBytes(build));
  if (!build.success || !build.artifact) throw new ValidationRejectedError(`The declared ${managed.judge.kind} program does not compile.`);
  if (build.artifact.kind !== "wasm" || !isCostProfileFor(
    build.artifact.costProfile,
    managed.judge.program.language,
    managed.judge.program.target,
    managed.judge.program.optimization,
  )) {
    throw new ValidationRejectedError(`The declared ${managed.judge.kind} program did not produce an allowed standalone Wasm artifact.`);
  }
  try {
    return await createManagedJudgeRuntimeProjection(managed.judge, build.artifact, repositoryFiles);
  } catch {
    throw new ValidationRejectedError(`The declared ${managed.judge.kind} artifact or assets violate the managed projection contract.`);
  }
}

function declaredProfiles(managed) {
  return Object.fromEntries(managed.references.map((reference) => [
    reference.language,
    { target: reference.target, optimization: reference.optimization },
  ]));
}

async function canonicalArchiveInput(job) {
  const response = await callback(job, "/r2/archive");
  if (!response.ok) throw new Error(`archive read failed with HTTP ${response.status}`);
  let archive;
  try {
    archive = await boundedResponseBody(response, MAX_ARCHIVE_BYTES, "repository archive");
  } catch (error) {
    if (error instanceof ContainerProtocolError && error.code === "authorized-object-size") throw new ValidationRejectedError("Repository archive exceeds 128 MiB.");
    throw error;
  }
  const archiveSha256 = await sha256Hex(archive);
  let files;
  let created;
  try {
    files = parseGitHubTarGz(archive);
    created = await createForgeValidationSource({
      githubRepositoryId: job.githubRepositoryId,
      commitSha: job.commitSha,
      indexPath: job.indexPath,
      archiveSha256,
    }, files);
  } catch (error) {
    throw new ValidationRejectedError(error instanceof Error ? error.message : undefined);
  }
  files.clear();
  archive.fill(0);
  const canonicalObjects = [];
  for (const reference of created.source.objects) {
    const bytes = created.objects.get(reference.sha256);
    if (!bytes) throw new Error("canonical source object is missing");
    canonicalObjects.push(await uploadObject(job, bytes));
  }
  const canonicalSourceBytes = forgeValidationSourceBytes(created.source);
  const canonicalSource = await uploadObject(job, canonicalSourceBytes, "application/json");
  created.objects.clear();

  // Persistence barrier: semantic validation consumes objects read back from
  // the authoritative bucket and verified by digest, never archive-backed bytes.
  const persistedSourceBytes = await reloadUploadedObject(job, canonicalSource);
  const persistedSource = await verifyForgeValidationSourceBytes(persistedSourceBytes, canonicalSource.digest);
  const persistedObjects = new Map();
  for (const reference of persistedSource.objects) {
    persistedObjects.set(reference.sha256, await reloadUploadedObject(job, {
      key: `snapshots/objects/${reference.sha256}`,
      digest: reference.sha256,
      bytes: reference.bytes,
    }));
  }
  return { sourceKind: "github-archive", canonicalSource, canonicalObjects, persistedSource, persistedObjects };
}

async function validateCollection(job) {
  const canonical = await canonicalArchiveInput(job);
  const { sourceKind, canonicalSource, canonicalObjects, persistedSource, persistedObjects } = canonical;
  const verifiedSource = await verifyForgeValidationSourceObjects(persistedSource, persistedObjects);
  persistedObjects.clear();
  const index = verifiedSource.index;
  if (index.problems.length > MAX_MANAGED_PROBLEMS) throw new ValidationRejectedError("A managed collection may contain at most 64 problems.");
  const managedCollection = verifiedSource.managed;
  const repositoryFiles = verifiedSource.repositoryFiles;
  const needsTrustedJudgeCompilation = managedCollection.problems.some((problem) => problem.judge.kind !== "text");
  const engine = needsTrustedJudgeCompilation ? await createServerForge({
    runtimeDirectory: "/app/runtime",
    toolchainDirectory: "/app/public/toolchains",
    cacheDirectory: `/tmp/forge-validation-${job.jobId}`,
    artifactCache: false,
  }) : undefined;
  const outputs = [];
  const outputBudget = new OutputBudget(MAX_VALIDATION_JOB_OUTPUT_BYTES);
  try {
    for (const [problemIndex, entry] of index.problems.entries()) {
      const problem = verifiedSource.problems[problemIndex]?.problem;
      if (!problem) throw new Error(`canonical source does not contain problem '${entry.id}'`);
      const managed = managedCollection.problems[problemIndex];
      if (!managed || managed.id !== problem.id) throw new Error(`managed contract is missing problem '${problem.id}'`);
      const judgeRuntime = await compileManagedJudge(engine, problem, managed, repositoryFiles, outputBudget);
      const allowedProfiles = declaredProfiles(managed);
      const practice = await uploadProjection(job, {
        schema: "forge-practice-problem-projection-v1",
        problem,
        digest: entry.bundle.sha256,
      });
      const contestPublic = await uploadProjection(job, {
        schema: "forge-contest-public-problem-projection-v1",
        problem: {
          ...problem,
          editorial: { "zh-TW": "", en: "" },
          judgeCases: problem.judgeCases.filter((item) => item.kind === "sample"),
        },
        digest: entry.bundle.sha256,
      });
      const judge = await uploadProjection(job, {
        schema: "forge-server-judge-projection-v1",
        forgeReleaseId: job.forgeReleaseId,
        allowedProfiles,
        problem,
        judge: judgeRuntime,
        digest: entry.bundle.sha256,
      });
      outputs.push({
        id: entry.id,
        number: entry.number,
        title: entry.title,
        difficulty: problem.difficulty,
        tags: problem.tags,
        trackId: problem.trackId,
        track: problem.track,
        bundleDigest: entry.bundle.sha256,
        allowedProfiles,
        practice,
        contestPublic,
        judge,
      });
    }
  } finally {
    engine?.dispose();
  }
  const projections = {
    practice: await uploadProjection(job, {
      schema: "forge-practice-collection-projection-v1",
      collectionRevision: index.revision,
      problems: outputs.map((output) => ({ id: output.id, projection: output.practice })),
    }),
    contestPublic: await uploadProjection(job, {
      schema: "forge-contest-public-collection-projection-v1",
      collectionRevision: index.revision,
      problems: outputs.map((output) => ({ id: output.id, projection: output.contestPublic })),
    }),
    judge: await uploadProjection(job, {
      schema: "forge-server-judge-collection-projection-v1",
      collectionRevision: index.revision,
      forgeReleaseId: job.forgeReleaseId,
      problems: outputs.map((output) => ({ id: output.id, projection: output.judge })),
    }),
  };
  const reportValue = {
    schema: "forge-collection-validation-report-v1",
    importId: job.jobId,
    sourceKind,
    forgeReleaseId: job.forgeReleaseId,
    collectionRevision: index.revision,
    problemCount: outputs.length,
    checks: [
      "archive-structure", "no-links", "no-lfs", "canonical-source-extraction",
      "canonical-source-integrity", "collection-schema", "bundle-integrity", "reference-declarations",
      ...(needsTrustedJudgeCompilation ? ["trusted-judge-source-compile"] : []),
      "public-hidden-projection",
    ],
    canonicalSource: { manifest: canonicalSource, objects: canonicalObjects },
    projections,
    outputs,
  };
  const report = await uploadProjection(job, reportValue);
  return {
    schema: "forge-validation-workflow-result-v1",
    importId: job.jobId,
    sourceKind,
    forgeReleaseId: job.forgeReleaseId,
    collectionRevision: index.revision,
    canonicalSource: { manifest: canonicalSource, objects: canonicalObjects },
    projections,
    outputs,
    report,
  };
}

async function execute(request) {
  const job = parseJson(await boundedRequestBody(request), "container job");
  const identity = await embeddedIdentity;
  assertExpectedContainerIdentity(job, identity);
  if (job.kind === "submission") return json(await executeSubmission(job, identity));
  if (job.kind === "validation") return json(await validateCollection(job));
  return json({ error: "unsupported job kind" }, 400);
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
      : json({ error: "not found" }, 404);
    outgoing.writeHead(response.status, Object.fromEntries(response.headers));
    outgoing.end(Buffer.from(await response.arrayBuffer()));
  } catch (error) {
    const failure = safeContainerFailure(error);
    outgoing.writeHead(failure.status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
    outgoing.end(`${JSON.stringify(failure.body)}\n`);
  }
});

server.listen(8080, "0.0.0.0");
