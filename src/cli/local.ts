import { createHash } from "node:crypto";
import { lstat, mkdir, open, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  decodeJudgePackageForExecution,
  parseStandaloneProblemBundle,
  trustedJudgeSpec,
  validateJudgePackage,
  WASM_OJ_JUDGE_PACKAGE_MAX_BYTES,
  type Engine,
  type JudgeResult,
  type ServerToolchainSource,
  type ToolchainDescriptor,
} from "@wasm-oj/core";
import { createServerEngine } from "@wasm-oj/server";
import { defaultConfigDirectory, type WojConfig } from "./config";
import { CliError, usageError } from "./errors";
import { CLI_TOOLCHAIN_DESCRIPTORS } from "./toolchains";
import { readWorkspace, readWorkspaceFileBytes, readWorkspaceSources, type WojWorkspace } from "./workspace";
import { canonicalizeSystemTemporaryPrefix } from "../path-safety";

const DESCRIPTORS: readonly ToolchainDescriptor[] = CLI_TOOLCHAIN_DESCRIPTORS;
const CACHE_MARKER = ".woj-cache";
const CACHE_MARKER_CONTENTS = "wasm-oj-cli-cache-v1\n";

export interface LocalCommandResult {
  readonly value: unknown;
  readonly successful: boolean;
}

export interface LocalRuntime {
  build(root: string, config: WojConfig): Promise<LocalCommandResult>;
  run(root: string, config: WojConfig, options: { readonly stdin?: string; readonly args: readonly string[] }): Promise<LocalCommandResult>;
  test(root: string, config: WojConfig, options: { readonly cases: readonly string[] }): Promise<LocalCommandResult>;
  bench(root: string, config: WojConfig, options: { readonly stdin?: string; readonly iterations: number }): Promise<LocalCommandResult>;
  inspectJudge(file: string): Promise<LocalCommandResult>;
  verifyJudge(file: string, options: { readonly sha256?: string; readonly bytes?: number }): Promise<LocalCommandResult>;
  executeJudge(root: string, config: WojConfig, file: string): Promise<LocalCommandResult>;
  toolchainList(config: WojConfig): Promise<LocalCommandResult>;
  toolchainInfo(config: WojConfig, id: string): Promise<LocalCommandResult>;
  toolchainFetch(config: WojConfig, server: string, id: string, fetchImplementation?: typeof fetch): Promise<LocalCommandResult>;
  toolchainVerify(config: WojConfig, id?: string): Promise<LocalCommandResult>;
  toolchainPrune(config: WojConfig): Promise<LocalCommandResult>;
  cacheStatus(config: WojConfig): Promise<LocalCommandResult>;
  cachePrune(config: WojConfig): Promise<LocalCommandResult>;
  cacheClear(config: WojConfig): Promise<LocalCommandResult>;
  doctor(root: string, config: WojConfig): Promise<LocalCommandResult>;
}

function cacheRoot(config: WojConfig): string {
  if (config["cache-directory"]) return config["cache-directory"];
  if (process.platform === "darwin") return path.join(os.homedir(), "Library", "Caches", "woj");
  if (process.platform === "win32") {
    const root = process.env.LOCALAPPDATA;
    if (!root) throw new CliError("LOCALAPPDATA is required to locate the woj cache on Windows.", { exitCode: 7 });
    return path.join(root, "woj");
  }
  return path.join(process.env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache"), "woj");
}

async function ownedCacheRoot(config: WojConfig, create: boolean): Promise<string | undefined> {
  const root = path.resolve(cacheRoot(config));
  const anchoredRoot = await canonicalizeSystemTemporaryPrefix(root);
  const parsed = path.parse(anchoredRoot);
  const home = path.resolve(os.homedir());
  const configDirectory = path.resolve(defaultConfigDirectory());
  if (parsed.root === root || root === home || configDirectory === root || configDirectory.startsWith(`${root}${path.sep}`)) {
    throw new CliError("The woj cache directory cannot be a filesystem, home, or CLI configuration root (or its ancestor).", { exitCode: 7, code: "cache-root-invalid" });
  }
  let existingParent = parsed.root;
  const components = path.relative(parsed.root, anchoredRoot).split(path.sep).filter(Boolean);
  for (let index = 0; index < components.length; index += 1) {
    const candidate = path.join(existingParent, components[index]!);
    try {
      const componentMetadata = await lstat(candidate);
      if (componentMetadata.isSymbolicLink() || (!componentMetadata.isDirectory() && index < components.length - 1)) {
        throw new CliError(`Cache path component '${candidate}' must be a real directory.`, { exitCode: 7, code: "cache-root-invalid" });
      }
      existingParent = candidate;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") break;
      throw error;
    }
  }
  let metadata;
  try { metadata = await lstat(root); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    if (!create) return undefined;
    await mkdir(root, { recursive: true, mode: 0o700 });
    const createdMetadata = await lstat(root);
    const entries = await readdir(root);
    if (!createdMetadata.isDirectory() || createdMetadata.isSymbolicLink() || entries.length > 0) {
      throw new CliError(`Refusing to adopt cache directory '${root}'.`, { exitCode: 7, code: "cache-root-invalid" });
    }
    await writeFile(path.join(root, CACHE_MARKER), CACHE_MARKER_CONTENTS, { encoding: "utf8", flag: "wx", mode: 0o600 });
    return root;
  }
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new CliError("The woj cache path must be a real directory.", { exitCode: 7, code: "cache-root-invalid" });
  }
  const marker = path.join(root, CACHE_MARKER);
  let markerMetadata;
  try { markerMetadata = await lstat(marker); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const entries = await readdir(root);
    if (!create || entries.length > 0) {
      throw new CliError(`Refusing to use unowned cache directory '${root}'.`, { exitCode: 7, code: "cache-marker-missing" });
    }
    await writeFile(marker, CACHE_MARKER_CONTENTS, { encoding: "utf8", flag: "wx", mode: 0o600 });
    return root;
  }
  if (!markerMetadata.isFile() || markerMetadata.isSymbolicLink()) {
    throw new CliError(`Cache marker in '${root}' failed integrity verification.`, { exitCode: 7, code: "cache-marker-invalid" });
  }
  let markerContents: string;
  try { markerContents = await readFile(marker, "utf8"); }
  catch (error) { throw new CliError(`Cache marker in '${root}' could not be read.`, { exitCode: 7, code: "cache-marker-invalid", cause: error }); }
  if (markerContents !== CACHE_MARKER_CONTENTS) {
    throw new CliError(`Cache marker in '${root}' failed integrity verification.`, { exitCode: 7, code: "cache-marker-invalid" });
  }
  return root;
}

function toolchainDirectory(config: WojConfig, descriptor: ToolchainDescriptor): string {
  return path.join(cacheRoot(config), "toolchains", descriptor.id, descriptor.version);
}

async function safeCacheDirectory(root: string, segments: readonly string[], create: boolean): Promise<string | undefined> {
  let current = root;
  for (const segment of segments) {
    current = path.join(current, segment);
    let metadata;
    try { metadata = await lstat(current); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      if (!create) return undefined;
      try { await mkdir(current, { mode: 0o700 }); }
      catch (mkdirError) {
        if ((mkdirError as NodeJS.ErrnoException).code !== "EEXIST") throw mkdirError;
      }
      metadata = await lstat(current);
    }
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw new CliError(`Cache component '${current}' must be a real directory.`, { exitCode: 7, code: "cache-path-integrity" });
    }
  }
  return current;
}

function descriptorById(id: string): ToolchainDescriptor {
  const descriptor = DESCRIPTORS.find((candidate) => candidate.id === id);
  if (!descriptor) throw usageError(`Unknown toolchain '${id}'.`);
  return descriptor;
}

function sourceFor(config: WojConfig, descriptor: ToolchainDescriptor): ServerToolchainSource {
  return { kind: "server", descriptor, directory: pathToFileURL(`${toolchainDirectory(config, descriptor)}${path.sep}`) };
}

async function sha256(file: string): Promise<string> {
  const digest = createHash("sha256");
  const handle = await open(file, "r");
  try { for await (const chunk of handle.createReadStream({ autoClose: false })) digest.update(chunk as Buffer); }
  finally { await handle.close(); }
  return digest.digest("hex");
}

async function verifyDescriptor(config: WojConfig, descriptor: ToolchainDescriptor): Promise<{ readonly descriptor: ToolchainDescriptor; readonly directory: string }> {
  const owned = await ownedCacheRoot(config, false);
  if (!owned) throw new CliError(`Toolchain '${descriptor.id}' is not fetched. Run 'woj toolchain fetch ${descriptor.id}'.`, { exitCode: 7, code: "toolchain-missing" });
  const directory = await safeCacheDirectory(owned, ["toolchains", descriptor.id, descriptor.version], false);
  if (!directory) throw new CliError(`Toolchain '${descriptor.id}' is not fetched. Run 'woj toolchain fetch ${descriptor.id}'.`, { exitCode: 7, code: "toolchain-missing" });
  for (const asset of descriptor.assets) {
    const file = path.join(directory, path.basename(asset.path));
    let metadata;
    try { metadata = await lstat(file); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new CliError(`Toolchain '${descriptor.id}' is not fetched. Run 'woj toolchain fetch ${descriptor.id}'.`, { exitCode: 7, code: "toolchain-missing" });
      throw error;
    }
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size !== asset.bytes || await sha256(file) !== asset.sha256) {
      throw new CliError(`Toolchain asset '${asset.path}' failed size or digest verification.`, { exitCode: 7, code: "toolchain-integrity" });
    }
  }
  return { descriptor, directory };
}

function descriptorForLanguage(language: string): ToolchainDescriptor {
  const matches = DESCRIPTORS.filter((descriptor) => descriptor.languages.includes(language));
  if (matches.length !== 1) throw new CliError(`No unique toolchain provides language '${language}'.`, { exitCode: 7, code: "toolchain-unavailable" });
  return matches[0]!;
}

async function engineFor(root: string, config: WojConfig, workspace: WojWorkspace): Promise<Engine> {
  if (!config["runtime-directory"]) throw new CliError("runtime-directory is not configured. Run 'woj config set runtime-directory <path>'.", { exitCode: 7, code: "runtime-missing" });
  const descriptor = descriptorForLanguage(workspace.language);
  await verifyDescriptor(config, descriptor);
  const owned = await ownedCacheRoot(config, true);
  if (!owned) throw new CliError("The woj cache directory could not be created.", { exitCode: 7, code: "cache-root-invalid" });
  const engineCache = await safeCacheDirectory(owned, ["engine"], true);
  if (!engineCache) throw new CliError("The engine cache directory could not be created.", { exitCode: 7, code: "cache-path-integrity" });
  for (const component of ["runtime", "artifacts", "dependencies"] as const) {
    if (!await safeCacheDirectory(engineCache, [component], true)) {
      throw new CliError(`The engine ${component} cache directory could not be created.`, { exitCode: 7, code: "cache-path-integrity" });
    }
  }
  try {
    return await createServerEngine({
      runtimeDirectory: config["runtime-directory"],
      cacheDirectory: engineCache,
      toolchains: [sourceFor(config, descriptor)],
    });
  } catch (error) {
    throw new CliError("The configured local runtime distribution failed verification.", { exitCode: 7, code: "runtime-integrity", cause: error });
  }
}

async function project(root: string): Promise<{ readonly workspace: WojWorkspace; readonly input: {
  readonly language: string; readonly entry: string; readonly files: Readonly<Record<string, string>>;
  readonly target: "wasip1" | "wasix"; readonly optimization: "debug" | "release"; readonly name: string;
} }> {
  const workspace = await readWorkspace(root);
  return {
    workspace,
    input: {
      language: workspace.language,
      entry: workspace.entry,
      files: await readWorkspaceSources(root, workspace),
      target: workspace.target,
      optimization: workspace.optimization,
      name: workspace.name,
    },
  };
}

async function withEngine<T>(root: string, config: WojConfig, workspace: WojWorkspace, action: (engine: Engine) => Promise<T>): Promise<T> {
  const engine = await engineFor(root, config, workspace);
  try { return await action(engine); }
  finally { engine.dispose(); }
}

function buildProjection(build: Awaited<ReturnType<Engine["compile"]>>) {
  return {
    success: build.success,
    diagnostics: build.diagnostics,
    stdout: build.stdout,
    stderr: build.stderr,
    cacheHit: build.cacheHit,
    artifact: build.artifact ? { kind: build.artifact.kind, size: build.artifact.size, metadata: {
      id: build.artifact.id, language: build.artifact.language, target: build.artifact.target,
      optimization: build.artifact.optimization, durationMs: build.artifact.durationMs,
    } } : null,
  };
}

export function parsePublicProblem(bytes: Uint8Array): ReturnType<typeof parseStandaloneProblemBundle> {
  let value: unknown;
  try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown; }
  catch (error) { throw new CliError("Pinned problem content is invalid UTF-8 JSON.", { exitCode: 4, code: "problem-content-invalid", cause: error }); }
  const record = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
  try {
    if (record?.schema === "wasm-oj-platform/practice-problem-projection/v1") {
      return parseStandaloneProblemBundle({ schema: "wasm-oj-browser-problem-v1", problem: record.problem });
    }
    if (record?.schema === "wasm-oj-platform/contest-public-problem-projection/v1") {
      const problem = record.problem as Record<string, unknown>;
      return { ...parseStandaloneProblemBundle({ schema: "wasm-oj-browser-problem-v1", problem: { ...problem, editorial: { "zh-TW": "redacted", en: "redacted" } } }), editorial: { "zh-TW": "", en: "" } };
    }
    return parseStandaloneProblemBundle(value);
  } catch (error) {
    throw new CliError(error instanceof Error ? error.message : "Pinned problem content has an invalid schema.", { exitCode: 4, code: "problem-content-invalid", cause: error });
  }
}

async function pinnedProblem(root: string, workspace: WojWorkspace) {
  if (!workspace.problem) throw usageError("This workspace has no pinned problem. Run 'woj problem pull'.");
  let bytes: Uint8Array;
  try { bytes = await readWorkspaceFileBytes(root, workspace.problem.contentFile, 8 * 1024 * 1024); }
  catch (error) { throw new CliError("Pinned problem content is missing or unsafe.", { exitCode: 4, code: "problem-content-integrity", cause: error }); }
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (digest !== workspace.problem.contentSha256) throw new CliError("Pinned problem bytes no longer match woj.json.", { exitCode: 4, code: "problem-content-integrity" });
  return parsePublicProblem(bytes);
}

async function directoryBytes(root: string): Promise<number> {
  let total = 0;
  const walk = async (directory: string): Promise<void> => {
    let entries;
    try { entries = await readdir(directory, { withFileTypes: true }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
    for (const entry of entries) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) await walk(file);
      else if (entry.isFile()) total += (await stat(file)).size;
    }
  };
  await walk(root);
  return total;
}

async function exactResponseBytes(response: Response, expected: number, label: string): Promise<Uint8Array> {
  const declared = response.headers.get("content-length");
  if (declared !== null && (!/^(?:0|[1-9][0-9]*)$/.test(declared) || Number(declared) !== expected)) {
    throw new CliError(`Fetched toolchain asset '${label}' has the wrong Content-Length.`, { exitCode: 7, code: "toolchain-integrity" });
  }
  if (!response.body) throw new CliError(`Fetched toolchain asset '${label}' has no body.`, { exitCode: 6 });
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > expected) {
        await reader.cancel("toolchain asset exceeds its pinned size");
        throw new CliError(`Fetched toolchain asset '${label}' exceeds its pinned size.`, { exitCode: 7, code: "toolchain-integrity" });
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  if (total !== expected) throw new CliError(`Fetched toolchain asset '${label}' has the wrong size.`, { exitCode: 7, code: "toolchain-integrity" });
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { output.set(chunk, offset); offset += chunk.byteLength; }
  return output;
}

export class NodeLocalRuntime implements LocalRuntime {
  async build(root: string, config: WojConfig): Promise<LocalCommandResult> {
    const { workspace, input } = await project(root);
    const build = await withEngine(root, config, workspace, (engine) => engine.compile(input));
    return { value: buildProjection(build), successful: build.success };
  }

  async run(root: string, config: WojConfig, options: { readonly stdin?: string; readonly args: readonly string[] }): Promise<LocalCommandResult> {
    const { workspace, input } = await project(root);
    const result = await withEngine(root, config, workspace, (engine) => engine.execute(input, { stdin: options.stdin ?? "", args: options.args }));
    return { value: { build: buildProjection(result.build), run: result.run ?? null }, successful: Boolean(result.build.success && result.run?.termination === "exited" && result.run.code === 0) };
  }

  async test(root: string, config: WojConfig, options: { readonly cases: readonly string[] }): Promise<LocalCommandResult> {
    const { workspace, input } = await project(root);
    const problem = await pinnedProblem(root, workspace);
    const publicSamples = problem.judgeCases.filter((testCase) => testCase.kind === "sample");
    if (new Set(options.cases).size !== options.cases.length) throw usageError("--case values must be unique.");
    const samples = options.cases.length === 0
      ? publicSamples
      : options.cases.map((id) => {
        const sample = publicSamples.find((candidate) => candidate.id === id);
        if (!sample) throw usageError(`Public sample case '${id}' does not exist in the pinned problem.`);
        return sample;
      });
    const results: unknown[] = [];
    let successful = true;
    await withEngine(root, config, workspace, async (engine) => {
      const build = await engine.compile(input);
      if (!build.success || !build.artifact) { results.push({ build: buildProjection(build) }); successful = false; return; }
      for (const sample of samples) {
        const run = await engine.run(build.artifact, { stdin: sample.input });
        const accepted = run.termination === "exited" && run.code === 0 && run.stdout.replace(/[ \t]+$/gm, "").trimEnd() === sample.output.replace(/[ \t]+$/gm, "").trimEnd();
        results.push({ id: sample.id, accepted, run });
        if (!accepted) successful = false;
      }
    });
    return { value: { samples: results, passed: successful }, successful };
  }

  async bench(root: string, config: WojConfig, options: { readonly stdin?: string; readonly iterations: number }): Promise<LocalCommandResult> {
    const { workspace, input } = await project(root);
    const durations: number[] = [];
    let buildValue: unknown;
    let successful = true;
    await withEngine(root, config, workspace, async (engine) => {
      const build = await engine.compile(input);
      buildValue = buildProjection(build);
      if (!build.success || !build.artifact) { successful = false; return; }
      for (let index = 0; index < options.iterations; index += 1) {
        const run = await engine.run(build.artifact, { stdin: options.stdin ?? "" });
        durations.push(run.durationMs);
        if (run.termination !== "exited" || run.code !== 0) successful = false;
      }
    });
    const sorted = [...durations].sort((left, right) => left - right);
    return { value: { build: buildValue, iterations: durations.length, durationsMs: durations, medianMs: sorted[Math.floor(sorted.length / 2)] ?? null }, successful };
  }

  async inspectJudge(file: string): Promise<LocalCommandResult> {
    let validated;
    try {
      const target = path.resolve(file);
      const metadata = await lstat(target);
      if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > WASM_OJ_JUDGE_PACKAGE_MAX_BYTES) throw new Error("Judge package must be a bounded regular file.");
      validated = await validateJudgePackage(new Uint8Array(await readFile(target)));
    }
    catch (error) { throw new CliError(error instanceof Error ? error.message : "Judge package is invalid.", { exitCode: 4, code: "judge-package-invalid", cause: error }); }
    return { value: validated, successful: true };
  }

  async verifyJudge(file: string, options: { readonly sha256?: string; readonly bytes?: number }): Promise<LocalCommandResult> {
    let validated;
    try {
      const target = path.resolve(file);
      const metadata = await lstat(target);
      if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > WASM_OJ_JUDGE_PACKAGE_MAX_BYTES) throw new Error("Judge package must be a bounded regular file.");
      validated = await validateJudgePackage(new Uint8Array(await readFile(target)), { expectedBytes: options.bytes, expectedSha256: options.sha256 });
    }
    catch (error) { throw new CliError(error instanceof Error ? error.message : "Judge package is invalid.", { exitCode: 4, code: "judge-package-invalid", cause: error }); }
    return { value: validated, successful: true };
  }

  async executeJudge(root: string, config: WojConfig, file: string): Promise<LocalCommandResult> {
    const { workspace, input } = await project(root);
    let package_;
    try {
      const target = path.resolve(file);
      const metadata = await lstat(target);
      if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > WASM_OJ_JUDGE_PACKAGE_MAX_BYTES) throw new Error("Judge package must be a bounded regular file.");
      package_ = await decodeJudgePackageForExecution(new Uint8Array(await readFile(target)));
    }
    catch (error) { throw new CliError(error instanceof Error ? error.message : "Judge package is invalid.", { exitCode: 4, code: "judge-package-invalid", cause: error }); }
    const allowed = package_.allowedProfiles[workspace.language];
    if (!allowed || allowed.target !== workspace.target || allowed.optimization !== workspace.optimization) {
      throw new CliError("Workspace compile profile is not allowed by this judge package.", { exitCode: 4, code: "judge-profile-mismatch" });
    }
    const result = await withEngine(root, config, workspace, (engine) => engine.judgeProject(input, trustedJudgeSpec(package_.judgeData, package_.judge)));
    const accepted = Boolean(result.build.success && result.judge?.verdict === "accepted");
    return { value: { build: buildProjection(result.build), judge: result.judge ?? null }, successful: accepted };
  }

  async toolchainList(config: WojConfig): Promise<LocalCommandResult> {
    const values = await Promise.all(DESCRIPTORS.map(async (descriptor) => {
      try { await verifyDescriptor(config, descriptor); return { ...descriptor, fetched: true }; }
      catch (error) { if (error instanceof CliError && error.code === "toolchain-missing") return { ...descriptor, fetched: false }; throw error; }
    }));
    return { value: { toolchains: values }, successful: true };
  }

  async toolchainInfo(config: WojConfig, id: string): Promise<LocalCommandResult> {
    const descriptor = descriptorById(id);
    let fetched = false;
    try { await verifyDescriptor(config, descriptor); fetched = true; }
    catch (error) { if (!(error instanceof CliError) || error.code !== "toolchain-missing") throw error; }
    return { value: { ...descriptor, fetched, directory: toolchainDirectory(config, descriptor) }, successful: true };
  }

  async toolchainFetch(config: WojConfig, server: string, id: string, fetchImplementation: typeof fetch = globalThis.fetch): Promise<LocalCommandResult> {
    const descriptor = descriptorById(id);
    const owned = await ownedCacheRoot(config, true);
    if (!owned) throw new CliError("The woj cache directory could not be created.", { exitCode: 7, code: "cache-root-invalid" });
    const directory = await safeCacheDirectory(owned, ["toolchains", descriptor.id, descriptor.version], true);
    if (!directory) throw new CliError("The toolchain cache directory could not be created.", { exitCode: 7, code: "cache-path-integrity" });
    for (const asset of descriptor.assets) {
      let response: Response;
      try { response = await fetchImplementation(new URL(asset.path, server), { redirect: "error" }); }
      catch (error) { throw new CliError(`Could not fetch '${asset.path}'.`, { exitCode: 6, cause: error }); }
      if (!response.ok) throw new CliError(`Could not fetch '${asset.path}' (HTTP ${response.status}).`, { exitCode: 6 });
      const bytes = await exactResponseBytes(response, asset.bytes, asset.path);
      if (bytes.byteLength !== asset.bytes || createHash("sha256").update(bytes).digest("hex") !== asset.sha256) {
        throw new CliError(`Fetched toolchain asset '${asset.path}' failed size or digest verification.`, { exitCode: 7, code: "toolchain-integrity" });
      }
      const output = path.join(directory, path.basename(asset.path));
      const temporary = `${output}.${process.pid}.${crypto.randomUUID()}.tmp`;
      await writeFile(temporary, bytes, { flag: "wx", mode: 0o600 });
      await rename(temporary, output);
    }
    await verifyDescriptor(config, descriptor);
    return { value: { id: descriptor.id, version: descriptor.version, directory }, successful: true };
  }

  async toolchainVerify(config: WojConfig, id?: string): Promise<LocalCommandResult> {
    const descriptors = id ? [descriptorById(id)] : DESCRIPTORS;
    const verified = [];
    for (const descriptor of descriptors) { await verifyDescriptor(config, descriptor); verified.push({ id: descriptor.id, version: descriptor.version }); }
    return { value: { verified }, successful: true };
  }

  async toolchainPrune(config: WojConfig): Promise<LocalCommandResult> {
    const owned = await ownedCacheRoot(config, true);
    if (!owned) throw new CliError("The woj cache directory could not be created.", { exitCode: 7, code: "cache-root-invalid" });
    const root = await safeCacheDirectory(owned, ["toolchains"], true);
    if (!root) throw new CliError("The toolchain cache directory could not be created.", { exitCode: 7, code: "cache-path-integrity" });
    const keep = new Set(DESCRIPTORS.map((descriptor) => path.resolve(toolchainDirectory(config, descriptor))));
    const removed: string[] = [];
    let ids;
    try { ids = await readdir(root, { withFileTypes: true }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return { value: { removed }, successful: true }; throw error; }
    for (const id of ids) {
      if (id.isSymbolicLink() || !id.isDirectory()) throw new CliError(`Cache component '${path.join(root, id.name)}' must be a real directory.`, { exitCode: 7, code: "cache-path-integrity" });
      const idRoot = await safeCacheDirectory(root, [id.name], false);
      if (!idRoot) continue;
      const versions = await readdir(idRoot, { withFileTypes: true });
      for (const version of versions) {
        const candidate = path.resolve(idRoot, version.name);
        if (version.isSymbolicLink() || !version.isDirectory()) throw new CliError(`Cache component '${candidate}' must be a real directory.`, { exitCode: 7, code: "cache-path-integrity" });
        const verified = await safeCacheDirectory(idRoot, [version.name], false);
        if (verified && !keep.has(candidate)) { await rm(candidate, { recursive: true, force: false }); removed.push(candidate); }
      }
    }
    return { value: { removed }, successful: true };
  }

  async cacheStatus(config: WojConfig): Promise<LocalCommandResult> {
    const root = await ownedCacheRoot(config, false);
    return { value: { directory: cacheRoot(config), bytes: root ? await directoryBytes(root) : 0 }, successful: true };
  }

  async cachePrune(config: WojConfig): Promise<LocalCommandResult> {
    const root = await ownedCacheRoot(config, true);
    if (!root) throw new CliError("The woj cache directory could not be created.", { exitCode: 7, code: "cache-root-invalid" });
    const engine = await safeCacheDirectory(root, ["engine"], false);
    if (!engine) return { value: { removed: [] }, successful: true };
    await rm(engine, { recursive: true, force: false });
    return { value: { removed: engine }, successful: true };
  }

  async cacheClear(config: WojConfig): Promise<LocalCommandResult> {
    const root = await ownedCacheRoot(config, true);
    if (!root) throw new CliError("The woj cache directory could not be created.", { exitCode: 7, code: "cache-root-invalid" });
    await rm(root, { recursive: true, force: true });
    return { value: { removed: root }, successful: true };
  }

  async doctor(root: string, config: WojConfig): Promise<LocalCommandResult> {
    const checks: Array<{ name: string; ok: boolean; detail: string }> = [];
    checks.push({ name: "server", ok: Boolean(config.server), detail: config.server ?? "not configured" });
    checks.push({ name: "runtime", ok: Boolean(config["runtime-directory"]), detail: config["runtime-directory"] ?? "not configured" });
    try { const workspace = await readWorkspace(root); checks.push({ name: "workspace", ok: true, detail: `${workspace.language}/${workspace.target}/${workspace.optimization}` }); }
    catch (error) { checks.push({ name: "workspace", ok: false, detail: error instanceof Error ? error.message : "invalid" }); }
    for (const descriptor of DESCRIPTORS) {
      try { await verifyDescriptor(config, descriptor); checks.push({ name: `toolchain:${descriptor.id}`, ok: true, detail: descriptor.version }); }
      catch (error) { checks.push({ name: `toolchain:${descriptor.id}`, ok: false, detail: error instanceof Error ? error.message : "invalid" }); }
    }
    return { value: { checks }, successful: checks.every((check) => check.ok) };
  }
}

export function judgeSucceeded(result: JudgeResult | undefined): boolean { return result?.verdict === "accepted"; }
