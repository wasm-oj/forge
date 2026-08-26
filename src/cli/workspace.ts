import { lstat, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { assertSafeFileDestinations } from "./destinations";
import { PROJECT_SOURCE_LIMITS } from "@wasm-oj/core";
import { CliError, usageError } from "./errors";
import { canonicalizeSystemTemporaryPrefix } from "../path-safety";
import { atomicWriteFile } from "./files";

export const WOJ_WORKSPACE_SCHEMA = "wasm-oj-cli-workspace-v2";
export const WORKSPACE_FILE = "woj.json";
export const LANGUAGES = ["c", "cpp", "rust", "go", "python", "javascript", "typescript"] as const;
export type WorkspaceLanguage = typeof LANGUAGES[number];

export interface PinnedProblem {
  readonly problemId: string;
  readonly catalogCommit: string;
  readonly serverOrigin: string;
  readonly contentUrl: string;
  readonly contentSha256: string;
  readonly contentFile: "problem.json";
  readonly locale: "zh-TW" | "en";
  readonly contestId?: string;
}

export interface WojWorkspace {
  readonly schema: typeof WOJ_WORKSPACE_SCHEMA;
  readonly name: string;
  readonly language: WorkspaceLanguage;
  readonly target: "wasip1" | "wasix";
  readonly optimization: "debug" | "release";
  readonly entry: string;
  readonly sources: readonly string[];
  readonly problem?: PinnedProblem;
}

const SOURCE_BY_LANGUAGE: Readonly<Record<WorkspaceLanguage, { entry: string; source: string }>> = {
  c: { entry: "main.c", source: "#include <stdio.h>\nint main(void) { return 0; }\n" },
  cpp: { entry: "main.cpp", source: "#include <iostream>\nint main() { return 0; }\n" },
  rust: { entry: "main.rs", source: "fn main() {}\n" },
  go: { entry: "main.go", source: "package main\nfunc main() {}\n" },
  python: { entry: "main.py", source: "def main():\n    pass\n\nif __name__ == \"__main__\":\n    main()\n" },
  javascript: { entry: "main.js", source: "function main() {}\nmain();\n" },
  typescript: { entry: "main.ts", source: "function main(): void {}\nmain();\n" },
};

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new CliError(`${label} must be an object.`);
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new CliError(`${label} has an invalid shape.`);
}

function relativeFile(value: unknown, label: string): string {
  if (typeof value !== "string" || !value || value.startsWith("/") || value.includes("\\") || value.includes("\0")
    || value.split("/").some((part) => !part || part === "." || part === "..")) throw new CliError(`${label} must be a normalized relative POSIX file path.`);
  return value;
}

function parseWorkspaceInternal(value: unknown): WojWorkspace {
  const workspace = record(value, "woj workspace");
  const keys = ["schema", "name", "language", "target", "optimization", "entry", "sources", ...(workspace.problem === undefined ? [] : ["problem"])];
  exactKeys(workspace, keys, "woj workspace");
  if (workspace.schema !== WOJ_WORKSPACE_SCHEMA) throw new CliError(`Unsupported workspace schema '${String(workspace.schema)}'.`);
  if (typeof workspace.name !== "string" || !workspace.name.trim() || workspace.name.length > 128) throw new CliError("Workspace name is invalid.");
  if (!LANGUAGES.includes(workspace.language as WorkspaceLanguage)) throw new CliError("Workspace language is unsupported.");
  if (workspace.target !== "wasip1" && workspace.target !== "wasix") throw new CliError("Workspace target must be 'wasip1' or 'wasix'.");
  if (workspace.optimization !== "debug" && workspace.optimization !== "release") throw new CliError("Workspace optimization is invalid.");
  const entry = relativeFile(workspace.entry, "Workspace entry");
  if (!Array.isArray(workspace.sources) || workspace.sources.length < 1 || workspace.sources.length > 256) throw new CliError("Workspace sources are invalid.");
  const sources = workspace.sources.map((source) => relativeFile(source, "Workspace source"));
  if (new Set(sources).size !== sources.length || !sources.includes(entry)) throw new CliError("Workspace sources must be unique and include the entry.");
  let problem: PinnedProblem | undefined;
  if (workspace.problem !== undefined) {
    const pinned = record(workspace.problem, "Pinned problem");
    exactKeys(pinned, ["problemId", "catalogCommit", "serverOrigin", "contentUrl", "contentSha256", "contentFile", "locale", ...(pinned.contestId === undefined ? [] : ["contestId"])], "Pinned problem");
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
    if (typeof pinned.problemId !== "string" || !uuid.test(pinned.problemId)) throw new CliError("Pinned problem ID is invalid.");
    if (typeof pinned.catalogCommit !== "string" || !/^[0-9a-f]{40}$/.test(pinned.catalogCommit)) throw new CliError("Pinned catalog commit is invalid.");
    let serverOrigin: string;
    try { serverOrigin = new URL(String(pinned.serverOrigin)).origin; } catch { throw new CliError("Pinned server origin is invalid."); }
    if (serverOrigin !== pinned.serverOrigin) throw new CliError("Pinned server origin must be canonical.");
    if (typeof pinned.contentUrl !== "string" || !pinned.contentUrl.startsWith("/api/problems/")) throw new CliError("Pinned content URL is invalid.");
    if (typeof pinned.contentSha256 !== "string" || !/^[0-9a-f]{64}$/.test(pinned.contentSha256)) throw new CliError("Pinned problem digest is invalid.");
    if (pinned.contentFile !== "problem.json") throw new CliError("Pinned problem content file is invalid.");
    if (pinned.locale !== "zh-TW" && pinned.locale !== "en") throw new CliError("Pinned problem locale is invalid.");
    if (pinned.contestId !== undefined && (typeof pinned.contestId !== "string" || !uuid.test(pinned.contestId))) throw new CliError("Pinned contest ID is invalid.");
    problem = {
      problemId: pinned.problemId,
      catalogCommit: pinned.catalogCommit,
      serverOrigin,
      contentUrl: pinned.contentUrl,
      contentSha256: pinned.contentSha256,
      contentFile: "problem.json",
      locale: pinned.locale,
      ...(pinned.contestId ? { contestId: pinned.contestId } : {}),
    };
  }
  return {
    schema: WOJ_WORKSPACE_SCHEMA,
    name: workspace.name.trim(),
    language: workspace.language as WorkspaceLanguage,
    target: workspace.target,
    optimization: workspace.optimization,
    entry,
    sources,
    ...(problem ? { problem } : {}),
  };
}

export function parseWorkspace(value: unknown): WojWorkspace {
  try { return parseWorkspaceInternal(value); }
  catch (error) {
    if (error instanceof CliError) throw new CliError(error.message, { exitCode: 4, code: "workspace-invalid", cause: error });
    throw error;
  }
}

async function safeWorkspaceFile(root: string, relative: string, maximumBytes: number): Promise<string> {
  const anchoredRoot = await canonicalizeSystemTemporaryPrefix(path.resolve(root));
  const filesystemRoot = path.parse(anchoredRoot).root;
  let current = filesystemRoot;
  for (const segment of path.relative(filesystemRoot, anchoredRoot).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    const metadata = await lstat(current);
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
      throw new CliError(`Workspace component '${current}' must be a real directory.`, { exitCode: 7, code: "workspace-source-integrity" });
    }
  }
  const segments = relative.split("/");
  for (let index = 0; index < segments.length; index += 1) {
    current = path.join(current, segments[index]!);
    const metadata = await lstat(current);
    const final = index === segments.length - 1;
    if (metadata.isSymbolicLink() || (final ? !metadata.isFile() : !metadata.isDirectory())) {
      throw new CliError(`Workspace path '${relative}' has a symlink or invalid ancestor.`, { exitCode: 7, code: "workspace-source-integrity" });
    }
    if (final && metadata.size > maximumBytes) {
      throw new CliError(`Workspace file '${relative}' exceeds its byte limit.`, { exitCode: 7, code: "workspace-source-integrity" });
    }
  }
  return current;
}

export async function readWorkspaceFileBytes(root: string, relative: string, maximumBytes: number): Promise<Uint8Array> {
  return new Uint8Array(await readFile(await safeWorkspaceFile(root, relative, maximumBytes)));
}

export async function readWorkspace(root = process.cwd()): Promise<WojWorkspace> {
  let source: string;
  try {
    const bytes = await readWorkspaceFileBytes(root, WORKSPACE_FILE, 1024 * 1024);
    source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw usageError(`No ${WORKSPACE_FILE} exists in '${root}'. Run 'woj init'.`);
    if (error instanceof TypeError) throw new CliError(`${WORKSPACE_FILE} is not valid UTF-8.`, { exitCode: 4, code: "workspace-invalid", cause: error });
    throw error;
  }
  try { return parseWorkspace(JSON.parse(source) as unknown); }
  catch (error) {
    if (error instanceof SyntaxError) throw new CliError(`${WORKSPACE_FILE} is not valid JSON.`, { exitCode: 4, code: "workspace-invalid", cause: error });
    throw error;
  }
}

export async function writeWorkspace(root: string, workspace: WojWorkspace): Promise<void> {
  const validated = parseWorkspace(workspace);
  await mkdir(root, { recursive: true });
  const file = path.join(root, WORKSPACE_FILE);
  const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(validated, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  await rename(temporary, file);
}

export async function createWorkspace(root: string, options: {
  readonly name?: string;
  readonly language?: string;
  readonly target?: string;
  readonly optimization?: string;
  readonly entry?: string;
  readonly force?: boolean;
}): Promise<WojWorkspace> {
  const language = options.language ?? "cpp";
  if (!LANGUAGES.includes(language as WorkspaceLanguage)) throw usageError(`Unsupported language '${language}'.`);
  if (options.target !== undefined && options.target !== "wasip1" && options.target !== "wasix") throw usageError("--target must be 'wasip1' or 'wasix'.");
  if (options.optimization !== undefined && options.optimization !== "debug" && options.optimization !== "release") throw usageError("--optimization must be debug or release.");
  const starter = SOURCE_BY_LANGUAGE[language as WorkspaceLanguage];
  const entry = options.entry ?? starter.entry;
  const workspace = parseWorkspace({
    schema: WOJ_WORKSPACE_SCHEMA,
    name: options.name ?? path.basename(path.resolve(root)),
    language,
    target: options.target ?? "wasip1",
    optimization: options.optimization ?? "debug",
    entry,
    sources: [entry],
  });
  await assertSafeFileDestinations(root, [WORKSPACE_FILE, entry], Boolean(options.force));
  await mkdir(root, { recursive: true });
  await mkdir(path.dirname(path.join(root, ...entry.split("/"))), { recursive: true });
  await writeWorkspace(root, workspace);
  await atomicWriteFile(path.join(root, entry), starter.source);
  return workspace;
}

export async function readWorkspaceSources(root: string, workspace: WojWorkspace): Promise<Readonly<Record<string, string>>> {
  let totalBytes = 0;
  const verified: Array<readonly [string, string]> = [];
  for (const relative of workspace.sources) {
    const file = await safeWorkspaceFile(root, relative, PROJECT_SOURCE_LIMITS.bytesPerFile);
    const metadata = await lstat(file);
    totalBytes += metadata.size;
    if (totalBytes > PROJECT_SOURCE_LIMITS.totalBytes) throw new CliError("Workspace sources exceed the aggregate limit.", { exitCode: 7, code: "workspace-source-integrity" });
    verified.push([relative, file]);
  }
  const entries: Array<readonly [string, string]> = [];
  for (const [relative, file] of verified) {
    const bytes = new Uint8Array(await readFile(file));
    let source: string;
    try { source = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
    catch (error) { throw new CliError(`Workspace source '${relative}' is not valid UTF-8.`, { exitCode: 7, code: "workspace-source-integrity", cause: error }); }
    entries.push([relative, source]);
  }
  return Object.fromEntries(entries);
}
