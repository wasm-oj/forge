import { createHash, randomUUID } from "node:crypto";
import { watch as watchFile, type FSWatcher } from "node:fs";
import { lstat, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { BrowserOpener } from "./auth";
import { deviceLogin, turnstileVerificationUrl } from "./auth";
import { CONFIG_KEYS, isConfigKey, validateConfigValue, type ConfigStore, type WojConfig } from "./config";
import { WOJ_CLI_VERSION, WOJ_EXIT, commandKey, type WojExitCode } from "./contracts";
import { assertSafeFileDestinations } from "./destinations";
import { atomicWriteFile, readProtectedTextFile } from "./files";
import { ApiError, type RemoteClient } from "./http";
import { isWojAccessToken, type TokenStore } from "./keychain";
import { CliError, usageError } from "./errors";
import { parsePublicProblem, type LocalCommandResult, type LocalRuntime } from "./local";
import type { ParsedCommand } from "./parser";
import {
  LANGUAGES,
  WOJ_WORKSPACE_SCHEMA,
  createWorkspace,
  readWorkspace,
  readWorkspaceSources,
  writeWorkspace,
  type WorkspaceLanguage,
} from "./workspace";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const TERMINAL_SUBMISSION_STATES = new Set(["completed", "compile-error", "judge-error", "infrastructure-error", "cancelled"]);
const TERMINAL_VALIDATION_STATES = new Set(["valid", "invalid", "infrastructure-error"]);
const TERMINAL_PUBLICATION_STATES = new Set(["published", "failed"]);
const TERMINAL_REJUDGE_STATES = new Set(["effective", "failed", "cancelled"]);

export interface CommandDependencies {
  readonly cwd: string;
  readonly configStore: ConfigStore;
  readonly tokenStore: TokenStore;
  readonly local: LocalRuntime;
  readonly collectionCli: (arguments_: readonly string[]) => Promise<void>;
  readonly remote: (origin: string) => RemoteClient;
  readonly opener: BrowserOpener;
  readonly sleep: (milliseconds: number) => Promise<void>;
  readonly onNotice: (message: string) => void;
}

export interface CommandOutcome {
  readonly value: unknown;
  readonly exitCode: WojExitCode;
}

type OptionValue = string | boolean | readonly string[];

function stringOption(command: ParsedCommand, name: string): string | undefined {
  const value = command.options[name];
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw usageError(`--${name} requires one value.`);
  return value;
}

function booleanOption(command: ParsedCommand, name: string): boolean {
  return command.options[name] === true;
}

function repeatableOption(command: ParsedCommand, name: string): readonly string[] {
  const value = command.options[name];
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw usageError(`--${name} is repeatable.`);
  return value;
}

function localeOption(command: ParsedCommand): "zh-TW" | "en" {
  const locale = stringOption(command, "locale") ?? "zh-TW";
  if (locale !== "zh-TW" && locale !== "en") throw usageError("--locale must be zh-TW or en.");
  return locale;
}

async function runInput(command: ParsedCommand, cwd: string): Promise<string | undefined> {
  const input = stringOption(command, "input");
  const text = stringOption(command, "text");
  if (input !== undefined && text !== undefined) throw usageError("Use either --input or --text, not both.");
  if (input === undefined) return text;
  const file = path.resolve(cwd, input);
  let metadata;
  try { metadata = await lstat(file); }
  catch (error) { throw new CliError("--input must name a readable UTF-8 file no larger than 8 MiB.", { exitCode: 7, code: "input-file-invalid", cause: error }); }
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > 8 * 1024 * 1024) {
    throw new CliError("--input must name a real UTF-8 file no larger than 8 MiB.", { exitCode: 7, code: "input-file-invalid" });
  }
  const bytes = new Uint8Array(await readFile(file));
  try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch (error) { throw new CliError("--input is not valid UTF-8.", { exitCode: 7, code: "input-file-invalid", cause: error }); }
}

function canonicalTimestamp(value: string | undefined, label: string): string | undefined {
  if (value === undefined) return undefined;
  if (Number.isNaN(Date.parse(value)) || new Date(value).toISOString() !== value) throw usageError(`--${label} must be a canonical ISO timestamp.`);
  return value;
}

function canonicalCursorTimestamp(value: string, label: string): string {
  if (Number.isNaN(Date.parse(value)) || new Date(value).toISOString() !== value) throw usageError(`${label} timestamp is invalid.`);
  return value;
}

function normalizedRelativePath(value: string, label: string): string {
  if (!value || value.length > 512 || value.startsWith("/") || value.includes("\\") || value.includes("\0")
    || value.split("/").some((part) => !part || part === "." || part === "..")) {
    throw usageError(`${label} must be a normalized relative POSIX path.`);
  }
  return value;
}

function exactPositionals(command: ParsedCommand, minimum: number, maximum = minimum): readonly string[] {
  if (command.positionals.length < minimum || command.positionals.length > maximum) {
    throw usageError(`Usage: woj ${command.spec.path.join(" ")}${command.spec.usage ? ` ${command.spec.usage}` : ""}`);
  }
  return command.positionals;
}

function uuid(value: string, label: string): string {
  if (!UUID.test(value)) throw usageError(`${label} must be a UUID.`);
  return value;
}

function serverUuid(record: Record<string, unknown>, name: string, label = name): string {
  const value = field(record, name, label);
  if (!UUID.test(value)) throw new CliError(`Server ${label} is not a UUID.`, { exitCode: 6, code: "server-response-invalid" });
  return value;
}

function positiveInteger(value: string | undefined, fallback: number, maximum: number, label: string): number {
  const parsed = Number(value ?? String(fallback));
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > maximum) throw usageError(`${label} must be an integer from 1 to ${maximum}.`);
  return parsed;
}

function boundedIntegerOption(command: ParsedCommand, name: string, maximum: number): string | undefined {
  const value = stringOption(command, name);
  return value === undefined ? undefined : String(positiveInteger(value, 1, maximum, `--${name}`));
}

function query(parameters: Readonly<Record<string, string | undefined>>): string {
  const search = new URLSearchParams();
  for (const [name, value] of Object.entries(parameters)) if (value !== undefined) search.set(name, value);
  const suffix = search.toString();
  return suffix ? `?${suffix}` : "";
}

function cursor(value: string | undefined, fields: readonly string[], label: string): Readonly<Record<string, string>> {
  if (value === undefined) return {};
  let parsed: unknown;
  try { parsed = JSON.parse(value) as unknown; }
  catch (error) { throw new CliError(`${label} must be the exact JSON nextCursor returned by the server.`, { exitCode: 2, code: "usage", cause: error }); }
  const record = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : undefined;
  if (!record || JSON.stringify(Object.keys(record).sort()) !== JSON.stringify([...fields].sort())
    || fields.some((fieldName) => typeof record[fieldName] !== "string" || !record[fieldName])) {
    throw usageError(`${label} must be the exact JSON nextCursor returned by the server.`);
  }
  return Object.fromEntries(fields.map((fieldName) => [fieldName, record[fieldName] as string]));
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new CliError(`${label} has an invalid shape.`, { exitCode: 6, code: "server-response-invalid" });
  return value as Record<string, unknown>;
}

function array(value: unknown, label: string): readonly unknown[] {
  if (!Array.isArray(value)) throw new CliError(`${label} has an invalid shape.`, { exitCode: 6, code: "server-response-invalid" });
  return value;
}

function localOutcome(result: LocalCommandResult): CommandOutcome {
  return { value: result.value, exitCode: result.successful ? WOJ_EXIT.success : WOJ_EXIT.unsuccessful };
}

async function configured(command: ParsedCommand, dependencies: CommandDependencies): Promise<{ config: WojConfig; origin: string; client: RemoteClient }> {
  const config = await dependencies.configStore.read();
  const origin = command.global.server ?? config.server;
  if (!origin) throw usageError("No server is configured. Pass --server or run 'woj config set server <origin>'.");
  const canonical = new URL(validateConfigValue("server", origin)).origin;
  return { config, origin: canonical, client: dependencies.remote(canonical) };
}

async function logout(origin: string, client: RemoteClient, tokenStore: TokenStore): Promise<CommandOutcome> {
  const token = await tokenStore.get(origin);
  if (token === undefined) return { value: { authenticated: false, server: origin }, exitCode: 0 };
  if (!isWojAccessToken(token)) {
    await tokenStore.delete(origin);
    return { value: { authenticated: false, server: origin }, exitCode: 0 };
  }
  let value: unknown;
  try {
    value = await client.request("/api/auth/logout", { method: "POST", body: {} });
  } catch (error) {
    if (!(error instanceof ApiError && error.status === 401 && error.code === "authentication-required")) throw error;
    await tokenStore.delete(origin);
    return { value: { authenticated: false, server: origin }, exitCode: 0 };
  }
  const response = object(value, "logout response");
  if (JSON.stringify(Object.keys(response).sort()) !== JSON.stringify(["ok"]) || response.ok !== true) {
    throw new CliError("Server logout response has an invalid shape.", { exitCode: 6, code: "server-response-invalid" });
  }
  await tokenStore.delete(origin);
  return { value: { authenticated: false, server: origin }, exitCode: 0 };
}

function field(record: Record<string, unknown>, name: string, label = name): string {
  const value = record[name];
  if (typeof value !== "string" || !value) throw new CliError(`Server ${label} is invalid.`, { exitCode: 6, code: "server-response-invalid" });
  return value;
}

function terminalSummary(value: unknown, envelope: string): Record<string, unknown> {
  const result = object(value, `${envelope} response`);
  return object(result[envelope], envelope);
}

async function watchResource(options: {
  readonly client: RemoteClient;
  readonly path: string;
  readonly envelope: string;
  readonly terminal: ReadonlySet<string>;
  readonly success: ReadonlySet<string>;
  readonly intervalMs: number;
  readonly sleep: (milliseconds: number) => Promise<void>;
}): Promise<CommandOutcome> {
  for (;;) {
    const value = await options.client.request(options.path);
    const resource = terminalSummary(value, options.envelope);
    const state = typeof resource.state === "string" ? resource.state : typeof resource.status === "string" ? resource.status : undefined;
    if (!state) throw new CliError(`${options.envelope} state is missing.`, { exitCode: 6 });
    if (options.terminal.has(state)) return { value, exitCode: options.success.has(state) ? 0 : 1 };
    await options.sleep(options.intervalMs);
  }
}

async function submissionWatch(client: RemoteClient, id: string, intervalMs: number, sleep: CommandDependencies["sleep"]): Promise<CommandOutcome> {
  let cursor = 0;
  for (;;) {
    const value = object(await client.request(`/api/submissions/${id}/events?after=${cursor}`), "submission events");
    if (Number.isSafeInteger(value.nextCursor) && (value.nextCursor as number) >= cursor) cursor = value.nextCursor as number;
    const summary = object(value.summary, "submission summary");
    const state = field(summary, "state", "submission state");
    if (TERMINAL_SUBMISSION_STATES.has(state)) {
      return { value, exitCode: state === "completed" && summary.verdict === "accepted" ? 0 : 1 };
    }
    await sleep(intervalMs);
  }
}

async function retryTurnstile<T>(action: () => Promise<T>, dependencies: CommandDependencies, origin: string): Promise<T> {
  let openedUrl: string | undefined;
  for (let attempt = 0; attempt < 150; attempt += 1) {
    try { return await action(); }
    catch (error) {
      if (!(error instanceof ApiError) || error.code !== "turnstile-required") throw error;
      const verificationUrl = turnstileVerificationUrl(origin, error.details);
      if (openedUrl !== undefined && openedUrl !== verificationUrl) {
        throw new CliError("Browser verification binding changed while retrying the same submission.", { exitCode: 6, code: "verification-url-invalid" });
      }
      if (openedUrl === undefined) {
        openedUrl = verificationUrl;
        dependencies.onNotice(`Complete the browser verification: ${verificationUrl}`);
        await dependencies.opener.open(verificationUrl);
      }
      await dependencies.sleep(2_000);
    }
  }
  throw new CliError("Browser verification did not complete before the CLI deadline.", { exitCode: 3, code: "turnstile-expired" });
}

async function exactPublicProblem(client: RemoteClient, problemVersionId: string, contestId?: string): Promise<{
  readonly metadata: Record<string, unknown>;
  readonly content: Record<string, unknown>;
  readonly bytes: Uint8Array;
  readonly problem: ReturnType<typeof parsePublicProblem>;
}> {
  const metadataPath = `/api/problems/${problemVersionId}${query({ contestId })}`;
  const metadata = object(await client.request(metadataPath, { authenticated: contestId ? true : "optional" }), "problem metadata");
  if (metadata.problemVersionId !== problemVersionId || metadata.schema !== "wasm-oj-platform/problem-content-pointer/v2") throw new CliError("Problem metadata identity is invalid.", { exitCode: 4 });
  const content = object(metadata.content, "problem content pointer");
  const contentUrl = field(content, "url", "problem content URL");
  const contentSha256 = field(content, "sha256", "problem content digest");
  if (!/^[0-9a-f]{64}$/.test(contentSha256) || !Number.isSafeInteger(content.bytes) || (content.bytes as number) < 1) throw new CliError("Problem content pointer is invalid.", { exitCode: 4 });
  const bytes = await client.requestBytes(contentUrl, { authenticated: contestId ? true : "optional" });
  if (bytes.byteLength !== content.bytes || createHash("sha256").update(bytes).digest("hex") !== contentSha256) throw new CliError("Downloaded problem bytes disagree with their immutable pointer.", { exitCode: 4, code: "problem-content-integrity" });
  return { metadata, content, bytes, problem: parsePublicProblem(bytes) };
}

function localizedList(value: unknown, locale: "zh-TW" | "en"): unknown {
  const response = object(value, "problem list");
  const collections = array(response.collections, "problem collections").map((collectionValue) => {
    const collection = object(collectionValue, "problem collection");
    const problems = array(collection.problems, "collection problems").map((problemValue) => {
      const problem = object(problemValue, "problem summary");
      const title = object(problem.title, "problem title")[locale];
      const track = problem.track === null ? null : object(problem.track, "problem track")[locale];
      if (typeof title !== "string" || (track !== null && typeof track !== "string")) throw new CliError("Problem localization is invalid.", { exitCode: 6 });
      return { ...problem, title, track };
    });
    return { ...collection, problems };
  });
  return { ...response, locale, collections };
}

async function problemPull(command: ParsedCommand, dependencies: CommandDependencies, client: RemoteClient): Promise<CommandOutcome> {
  const [problemVersionId, directory = "."] = exactPositionals(command, 1, 2);
  uuid(problemVersionId!, "problem-version-id");
  const contestId = stringOption(command, "contest");
  if (contestId) uuid(contestId, "contest");
  const locale = localeOption(command);
  const language = stringOption(command, "language");
  if (!language || !LANGUAGES.includes(language as WorkspaceLanguage)) throw usageError("problem pull requires a supported --language.");
  const downloaded = await exactPublicProblem(client, problemVersionId!, contestId);
  const { metadata, content, bytes, problem } = downloaded;
  const catalogPublicationId = serverUuid(metadata, "catalogPublicationId", "catalogPublicationId");
  const contentUrl = field(content, "url", "problem content URL");
  const contentSha256 = field(content, "sha256", "problem content digest");
  const allowedProfiles = object(metadata.allowedProfiles, "allowedProfiles");
  const profile = object(allowedProfiles[language], `allowedProfiles.${language}`);
  if ((profile.target !== "wasip1" && profile.target !== "wasix") || (profile.optimization !== "debug" && profile.optimization !== "release")) {
    throw usageError(`Language '${language}' is not available for this problem version.`);
  }
  const template = problem.starterTemplates[language as WorkspaceLanguage];
  if (!template) throw usageError(`Problem has no starter template for '${language}'.`);
  const root = path.resolve(dependencies.cwd, directory!);
  const destinations = ["woj.json", "problem.json", ...Object.keys(template.files)];
  await assertSafeFileDestinations(root, destinations, booleanOption(command, "force"));
  await mkdir(root, { recursive: true });
  for (const [relative, source] of Object.entries(template.files)) {
    const file = path.join(root, ...relative.split("/"));
    await mkdir(path.dirname(file), { recursive: true });
    await atomicWriteFile(file, source);
  }
  await atomicWriteFile(path.join(root, "problem.json"), bytes);
  await writeWorkspace(root, {
    schema: WOJ_WORKSPACE_SCHEMA,
    name: problem.id,
    language: language as WorkspaceLanguage,
    target: profile.target,
    optimization: profile.optimization,
    entry: template.entry,
    sources: Object.keys(template.files).sort(),
    problem: {
      problemVersionId: problemVersionId!, catalogPublicationId, serverOrigin: client.origin,
      contentUrl, contentSha256, contentFile: "problem.json", locale,
      ...(contestId ? { contestId } : {}),
    },
  });
  return { value: { directory: root, problemVersionId, catalogPublicationId, contentSha256, language, target: profile.target, optimization: profile.optimization }, exitCode: 0 };
}

async function submit(command: ParsedCommand, dependencies: CommandDependencies, client: RemoteClient): Promise<CommandOutcome> {
  exactPositionals(command, 0);
  const workspace = await readWorkspace(dependencies.cwd);
  if (!workspace.problem) throw usageError("Official Submit requires a workspace created by 'woj problem pull'.");
  if (workspace.problem.serverOrigin !== client.origin) throw new CliError(`Pinned problem belongs to ${workspace.problem.serverOrigin}; refusing to submit it to ${client.origin}.`, { exitCode: 5, code: "server-origin-mismatch" });
  const language = stringOption(command, "language") ?? workspace.language;
  const target = stringOption(command, "target") ?? workspace.target;
  const optimization = stringOption(command, "optimization") ?? workspace.optimization;
  const entry = stringOption(command, "entry") ?? workspace.entry;
  if (!LANGUAGES.includes(language as WorkspaceLanguage)) throw usageError("--language must name a supported language.");
  if (target !== "wasip1" && target !== "wasix") throw usageError("--target must be wasip1 or wasix.");
  if (optimization !== "debug" && optimization !== "release") throw usageError("--optimization must be debug or release.");
  normalizedRelativePath(entry, "--entry");
  if (!workspace.sources.includes(entry)) throw usageError("--entry must identify a source pinned in woj.json.");
  if (language !== workspace.language || target !== workspace.target || optimization !== workspace.optimization) throw new CliError("Official Submit must use the exact compile profile pinned by problem pull.", { exitCode: 5, code: "profile-pin-mismatch" });
  const contestId = stringOption(command, "contest") ?? workspace.problem.contestId;
  if (contestId !== undefined) uuid(contestId, "contest");
  if (contestId !== workspace.problem.contestId) throw new CliError("Official Submit contest context must match the pinned workspace.", { exitCode: 5 });
  const sources = await readWorkspaceSources(dependencies.cwd, workspace);
  const body = {
    problemVersionId: workspace.problem.problemVersionId,
    ...(contestId ? { contestId } : {}),
    language, target, optimization, entry,
    sourceFiles: Object.entries(sources).sort(([left], [right]) => left.localeCompare(right)).map(([filePath, content]) => ({ path: filePath, encoding: "utf8", content })),
    idempotencyKey: `woj-submit-${randomUUID()}`,
  };
  const created = await retryTurnstile(() => client.request("/api/submissions", { method: "POST", body }), dependencies, client.origin);
  if (!booleanOption(command, "wait")) return { value: created, exitCode: 0 };
  const id = serverUuid(object(created, "submission creation"), "submissionId");
  return submissionWatch(client, id, 2_000, dependencies.sleep);
}

async function currentContestDraft(client: RemoteClient, id: string): Promise<{ readonly body: Record<string, unknown>; readonly current: Record<string, unknown> }> {
  const value = object(await client.request(`/api/organizer/contests/${id}`), "Organizer contest");
  const contest = object(value.contest, "contest");
  const problems = array(value.problems, "contest problems");
  const freezeAt = contest.freezeAt;
  if (freezeAt !== null && freezeAt !== undefined && typeof freezeAt !== "string") {
    throw new CliError("Organizer contest freezeAt has an invalid shape.", { exitCode: 6, code: "server-response-invalid" });
  }
  return {
    current: value,
    body: {
      title: contest.title,
      description: contest.description,
      accessMode: contest.accessMode,
      startsAt: contest.startsAt,
      endsAt: contest.endsAt,
      ...(typeof freezeAt === "string" ? { freezeAt } : {}),
      problemVersionIds: problems.map((problem) => field(object(problem, "contest problem"), "problemVersionId")),
    },
  };
}

async function contestBody(command: ParsedCommand, cwd: string, base: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const body: Record<string, unknown> = { ...base };
  const mapping = { title: "title", description: "description", access: "accessMode", starts: "startsAt", ends: "endsAt", freeze: "freezeAt" } as const;
  for (const [option, key] of Object.entries(mapping)) {
    const value = stringOption(command, option);
    if (value !== undefined) body[key] = value;
  }
  const inviteCode = await readProtectedTextFile(cwd, stringOption(command, "invite-code-file"), "--invite-code-file");
  if (inviteCode !== undefined) body.inviteCode = inviteCode;
  const problems = repeatableOption(command, "problem");
  if (problems.length) body.problemVersionIds = problems.map((id) => uuid(id, "problem"));
  if (typeof body.title === "string" && (!body.title.trim() || body.title.length > 120)) throw usageError("--title must contain 1–120 characters.");
  if (typeof body.description === "string" && body.description.length > 10_000) throw usageError("--description must contain at most 10,000 characters.");
  if (Array.isArray(body.problemVersionIds) && (body.problemVersionIds.length < 1 || body.problemVersionIds.length > 100 || new Set(body.problemVersionIds).size !== body.problemVersionIds.length)) {
    throw usageError("Contest problem IDs must be unique and contain 1–100 values.");
  }
  if (body.accessMode !== "public" && body.accessMode !== "invite") throw usageError("--access must be public or invite.");
  const invite = body.inviteCode;
  if (invite !== undefined && (typeof invite !== "string" || invite.length < 16 || invite.length > 128)) throw usageError("--invite-code-file must contain 16–128 characters.");
  if (body.accessMode === "public" && invite !== undefined) throw usageError("--invite-code-file cannot be used with --access public.");
  const startsAt = canonicalTimestamp(typeof body.startsAt === "string" ? body.startsAt : undefined, "starts");
  const endsAt = canonicalTimestamp(typeof body.endsAt === "string" ? body.endsAt : undefined, "ends");
  const freezeAt = canonicalTimestamp(typeof body.freezeAt === "string" ? body.freezeAt : undefined, "freeze");
  if (startsAt !== undefined && endsAt !== undefined && (endsAt <= startsAt || (freezeAt !== undefined && (freezeAt <= startsAt || freezeAt >= endsAt)))) {
    throw usageError("Contest timestamps must satisfy starts < freeze < ends (freeze is optional).");
  }
  return body;
}

async function createCollectionSkeleton(root: string, force: boolean): Promise<CommandOutcome> {
  const file = path.join(root, "collection", "source.json");
  await assertSafeFileDestinations(root, ["collection/source.json"], force);
  await mkdir(path.dirname(file), { recursive: true });
  await atomicWriteFile(file, `${JSON.stringify({
    schema: "wasm-oj-browser-collection-source-v1",
    localization: { defaultLocale: "zh-TW", supportedLocales: ["zh-TW", "en"] },
    problems: [],
  }, null, 2)}\n`);
  return { value: { directory: root, source: file }, exitCode: 0 };
}

async function watchLocalWorkspace(
  root: string,
  execute: () => Promise<LocalCommandResult>,
  onNotice: (message: string) => void,
): Promise<LocalCommandResult> {
  const workspace = await readWorkspace(root);
  const watched = ["woj.json", ...workspace.sources].map((relative) => path.join(root, ...relative.split("/")));
  let latest = await execute();
  onNotice(JSON.stringify(latest.value));
  let running = false;
  let queued = false;
  const rerun = async () => {
    if (running) { queued = true; return; }
    running = true;
    try {
      do {
        queued = false;
        try { latest = await execute(); onNotice(JSON.stringify(latest.value)); }
        catch (error) { onNotice(`watch error: ${error instanceof Error ? error.message : String(error)}`); }
      } while (queued);
    } finally { running = false; }
  };
  const watchers: FSWatcher[] = watched.map((file) => watchFile(file, { persistent: true }, () => { void rerun(); }));
  await new Promise<void>((resolve) => {
    const stop = () => {
      for (const watcher of watchers) watcher.close();
      process.off("SIGINT", stop);
      process.off("SIGTERM", stop);
      resolve();
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
  return latest;
}

function completion(shell: string): string {
  const commands = ["auth", "init", "build", "run", "test", "bench", "watch", "problem", "submit", "submission", "contest", "performance", "judge", "toolchain", "organizer", "config", "cache", "doctor", "completion", "version"].join(" ");
  if (shell === "bash") return `complete -W '${commands}' woj`;
  if (shell === "zsh") return `#compdef woj\n_arguments '1:command:(${commands})'`;
  if (shell === "fish") return commands.split(" ").map((command) => `complete -c woj -n '__fish_use_subcommand' -a ${command}`).join("\n");
  throw usageError("completion shell must be bash, zsh, or fish.");
}

export async function dispatchCommand(command: ParsedCommand, dependencies: CommandDependencies): Promise<CommandOutcome> {
  const key = commandKey(command.spec.path);
  const config = await dependencies.configStore.read();

  if (key === "version") { exactPositionals(command, 0); return { value: { version: WOJ_CLI_VERSION }, exitCode: 0 }; }
  if (key === "config list") { exactPositionals(command, 0); return { value: config, exitCode: 0 }; }
  if (key === "config get") {
    const [name] = exactPositionals(command, 1);
    if (!isConfigKey(name!)) throw usageError(`Unknown config key '${name}'. Valid keys: ${CONFIG_KEYS.join(", ")}.`);
    return { value: { key: name, value: config[name!] ?? null }, exitCode: 0 };
  }
  if (key === "config set") {
    const [name, value] = exactPositionals(command, 2);
    if (!isConfigKey(name!)) throw usageError(`Unknown config key '${name}'. Valid keys: ${CONFIG_KEYS.join(", ")}.`);
    const next = { ...config, [name!]: validateConfigValue(name!, value!) };
    await dependencies.configStore.write(next);
    return { value: { key: name, value: next[name!] }, exitCode: 0 };
  }
  if (key === "config unset") {
    const [name] = exactPositionals(command, 1);
    if (!isConfigKey(name!)) throw usageError(`Unknown config key '${name}'. Valid keys: ${CONFIG_KEYS.join(", ")}.`);
    const next = { ...config }; delete next[name!]; await dependencies.configStore.write(next);
    return { value: { key: name, removed: true }, exitCode: 0 };
  }

  if (key === "init") {
    const [directory = "."] = exactPositionals(command, 0, 1);
    return { value: await createWorkspace(path.resolve(dependencies.cwd, directory!), {
      name: stringOption(command, "name"), language: stringOption(command, "language"), target: stringOption(command, "target"),
      optimization: stringOption(command, "optimization"), entry: stringOption(command, "entry"), force: booleanOption(command, "force"),
    }), exitCode: 0 };
  }
  if (key === "build") { exactPositionals(command, 0); return localOutcome(await dependencies.local.build(dependencies.cwd, config)); }
  if (key === "run") { exactPositionals(command, 0); return localOutcome(await dependencies.local.run(dependencies.cwd, config, { stdin: await runInput(command, dependencies.cwd), args: repeatableOption(command, "arg") })); }
  if (key === "test") { exactPositionals(command, 0); return localOutcome(await dependencies.local.test(dependencies.cwd, config, { cases: repeatableOption(command, "case") })); }
  if (key === "bench") { exactPositionals(command, 0); return localOutcome(await dependencies.local.bench(dependencies.cwd, config, { stdin: stringOption(command, "stdin"), iterations: positiveInteger(stringOption(command, "iterations"), 10, 10_000, "iterations") })); }
  if (key === "watch") {
    exactPositionals(command, 0);
    const action = stringOption(command, "command") ?? "test";
    if (!new Set(["build", "run", "test"]).has(action)) throw usageError("--command must be build, run, or test.");
    const execute = action === "build" ? () => dependencies.local.build(dependencies.cwd, config)
      : action === "run" ? () => dependencies.local.run(dependencies.cwd, config, { args: [] })
      : () => dependencies.local.test(dependencies.cwd, config, { cases: [] });
    return localOutcome(await watchLocalWorkspace(dependencies.cwd, execute, dependencies.onNotice));
  }
  if (key === "judge inspect") { const [file] = exactPositionals(command, 1); return localOutcome(await dependencies.local.inspectJudge(path.resolve(dependencies.cwd, file!))); }
  if (key === "judge verify") { const [file] = exactPositionals(command, 1); return localOutcome(await dependencies.local.verifyJudge(path.resolve(dependencies.cwd, file!), { sha256: stringOption(command, "sha256"), bytes: stringOption(command, "bytes") === undefined ? undefined : positiveInteger(stringOption(command, "bytes"), 1, 32 * 1024 * 1024, "bytes") })); }
  if (key === "judge execute") {
    const [file] = exactPositionals(command, 1); const source = stringOption(command, "source");
    if (!source) throw usageError("judge execute requires --source <woj-workspace-directory>.");
    if (!booleanOption(command, "all")) throw usageError("judge execute requires --all to acknowledge that every packaged case may be exposed.");
    return localOutcome(await dependencies.local.executeJudge(path.resolve(dependencies.cwd, source), config, path.resolve(dependencies.cwd, file!)));
  }
  if (key === "toolchain list") { exactPositionals(command, 0); return localOutcome(await dependencies.local.toolchainList(config)); }
  if (key === "toolchain info") { const [id] = exactPositionals(command, 1); return localOutcome(await dependencies.local.toolchainInfo(config, id!)); }
  if (key === "toolchain verify") { const [id] = exactPositionals(command, 0, 1); return localOutcome(await dependencies.local.toolchainVerify(config, id)); }
  if (key === "toolchain prune") { exactPositionals(command, 0); if (!booleanOption(command, "yes")) throw usageError("toolchain prune requires --yes."); return localOutcome(await dependencies.local.toolchainPrune(config)); }
  if (key === "cache status") { exactPositionals(command, 0); return localOutcome(await dependencies.local.cacheStatus(config)); }
  if (key === "cache prune") { exactPositionals(command, 0); if (!booleanOption(command, "yes")) throw usageError("cache prune requires --yes."); return localOutcome(await dependencies.local.cachePrune(config)); }
  if (key === "cache clear") { exactPositionals(command, 0); if (!booleanOption(command, "yes")) throw usageError("cache clear requires --yes."); return localOutcome(await dependencies.local.cacheClear(config)); }
  if (key === "doctor") { exactPositionals(command, 0); const result = await dependencies.local.doctor(dependencies.cwd, config); return { value: result.value, exitCode: result.successful ? 0 : 7 }; }
  if (key === "completion") { const [shell] = exactPositionals(command, 1); return { value: completion(shell!), exitCode: 0 }; }
  if (key === "organizer collection init") { const [directory = "."] = exactPositionals(command, 0, 1); return createCollectionSkeleton(path.resolve(dependencies.cwd, directory!), booleanOption(command, "force")); }
  if (key === "organizer collection build" || key === "organizer collection verify") {
    const [directory = "."] = exactPositionals(command, 0, 1);
    const arguments_: string[] = [key.endsWith("build") ? "build" : "verify", path.resolve(dependencies.cwd, directory!)];
    for (const name of ["index", "source", "managed", "managed-source"] as const) { const value = stringOption(command, name); if (value !== undefined) arguments_.push(`--${name}`, normalizedRelativePath(value, `--${name}`)); }
    if (key.endsWith("build") && stringOption(command, "managed") !== undefined && stringOption(command, "managed-source") === undefined) throw usageError("--managed requires --managed-source when building.");
    try { await dependencies.collectionCli(arguments_); }
    catch (error) { throw new CliError(error instanceof Error ? error.message : "Collection operation failed.", { exitCode: 4, code: "collection-invalid", cause: error }); }
    return { value: { command: arguments_[0], directory: arguments_[1] }, exitCode: 0 };
  }

  const { origin, client } = await configured(command, dependencies);
  if (key === "toolchain fetch") { const [id] = exactPositionals(command, 1); return localOutcome(await dependencies.local.toolchainFetch(config, origin, id!)); }
  if (key === "auth login") {
    exactPositionals(command, 0);
    const deviceName = stringOption(command, "device-name") ?? `${process.platform} woj`;
    if (!deviceName || deviceName !== deviceName.normalize("NFC") || deviceName !== deviceName.trim() || new TextEncoder().encode(deviceName).byteLength > 80 || /[\p{Cc}\p{Cf}\p{Cs}]/u.test(deviceName)) {
      throw usageError("--device-name must be trimmed NFC text containing 1–80 visible UTF-8 bytes.");
    }
    const result = await deviceLogin(client, dependencies.tokenStore, dependencies.opener, {
      deviceName,
      onVerification: dependencies.onNotice,
      sleep: dependencies.sleep,
    });
    return { value: result, exitCode: 0 };
  }
  if (key === "auth logout") { exactPositionals(command, 0); return logout(origin, client, dependencies.tokenStore); }
  if (key === "auth status") {
    exactPositionals(command, 0);
    return { value: { server: origin, session: await client.request("/api/auth/session", { authenticated: "optional" }) }, exitCode: 0 };
  }
  if (key === "problem list") { exactPositionals(command, 0); const locale = localeOption(command); return { value: localizedList(await client.request("/api/problems", { authenticated: "optional" }), locale), exitCode: 0 }; }
  if (key === "problem show") {
    const [id] = exactPositionals(command, 1); uuid(id!, "problem-version-id"); const contestId = stringOption(command, "contest"); if (contestId) uuid(contestId, "contest");
    const locale = localeOption(command); const downloaded = await exactPublicProblem(client, id!, contestId); const problem = downloaded.problem;
    return { value: {
      problemVersionId: id, catalogPublicationId: downloaded.metadata.catalogPublicationId, content: downloaded.metadata.content,
      locale, title: problem.title[locale], track: problem.track[locale], difficulty: problem.difficulty, tags: problem.tags,
      statement: problem.statement[locale], editorial: problem.editorial[locale],
      samples: problem.judgeCases.filter((testCase) => testCase.kind === "sample"),
      availableLanguages: Object.keys(problem.starterTemplates).sort(),
    }, exitCode: 0 };
  }
  if (key === "problem pull") return problemPull(command, dependencies, client);
  if (key === "submit") return submit(command, dependencies, client);
  if (key === "submission list") { exactPositionals(command, 0); const next = cursor(stringOption(command, "cursor"), ["before", "beforeId"], "submission cursor"); if (next.before) { canonicalCursorTimestamp(next.before, "submission cursor"); uuid(next.beforeId!, "submission cursor beforeId"); } return { value: await client.request(`/api/submissions${query({ limit: boundedIntegerOption(command, "limit", 100), before: next.before, beforeId: next.beforeId })}`), exitCode: 0 }; }
  if (key === "submission show") { const [id] = exactPositionals(command, 1); uuid(id!, "submission-id"); return { value: await client.request(`/api/submissions/${id}`), exitCode: 0 }; }
  if (key === "submission watch") { const [id] = exactPositionals(command, 1); uuid(id!, "submission-id"); return submissionWatch(client, id!, positiveInteger(stringOption(command, "interval"), 2, 30, "interval") * 1_000, dependencies.sleep); }
  if (key === "submission cancel") { const [id] = exactPositionals(command, 1); uuid(id!, "submission-id"); return { value: await client.request(`/api/submissions/${id}/cancel`, { method: "POST", body: {} }), exitCode: 0 }; }
  if (key === "submission source") { const [id] = exactPositionals(command, 1); uuid(id!, "submission-id"); return { value: await client.request(`/api/submissions/${id}/source`), exitCode: 0 }; }
  if (key === "submission policy") { const [id] = exactPositionals(command, 1); uuid(id!, "submission-id"); return { value: await client.request(`/api/submissions/${id}/policy-summary`), exitCode: 0 }; }
  if (key === "contest list") { exactPositionals(command, 0); return { value: await client.request("/api/contests", { authenticated: "optional" }), exitCode: 0 }; }
  if (key === "contest show" || key === "contest problems") { const [id] = exactPositionals(command, 1); uuid(id!, "contest-id"); const value = object(await client.request(`/api/contests/${id}`, { authenticated: "optional" }), "contest"); return { value: key.endsWith("problems") ? { problems: array(value.problems, "contest problems") } : value, exitCode: 0 }; }
  if (key === "contest join") { const [id] = exactPositionals(command, 1); uuid(id!, "contest-id"); const code = await readProtectedTextFile(dependencies.cwd, stringOption(command, "code-file"), "--code-file"); if (code !== undefined && (code.length < 16 || code.length > 128)) throw usageError("--code-file must contain 16–128 characters."); return { value: await client.request(`/api/contests/${id}/join`, { method: "POST", body: { ...(code ? { inviteCode: code } : {}) } }), exitCode: 0 }; }
  if (key === "contest standings") { const [id] = exactPositionals(command, 1); uuid(id!, "contest-id"); return { value: await client.request(`/api/contests/${id}/leaderboard${query({ limit: boundedIntegerOption(command, "limit", 100) })}`, { authenticated: "optional" }), exitCode: 0 }; }
  if (key === "performance frontier" || key === "performance evolution") {
    const [id] = exactPositionals(command, 1); uuid(id!, "problem-version-id");
    const language = stringOption(command, "language");
    if (language !== undefined && !LANGUAGES.includes(language as WorkspaceLanguage)) throw usageError("--language must name a supported language.");
    const contestId = stringOption(command, "contest");
    if (contestId !== undefined) uuid(contestId, "contest");
    const value = object(await client.request(`/api/problems/${id}/performance${query({ language, contestId })}`, {
      authenticated: key.endsWith("frontier") ? "optional" : true,
    }), "performance");
    return { value: key.endsWith("frontier") ? { context: value.context, frontier: value.frontier } : { context: value.context, myEvolution: value.myEvolution }, exitCode: 0 };
  }
  if (key === "organizer repo list" || key === "organizer repo show") {
    if (key.endsWith("list")) exactPositionals(command, 0);
    const id = key.endsWith("show") ? exactPositionals(command, 1)[0]! : undefined;
    if (id !== undefined) positiveInteger(id, 1, Number.MAX_SAFE_INTEGER, "repository-id");
    const values = object(await client.request("/api/organizer/repositories"), "repositories");
    if (key.endsWith("list")) return { value: values, exitCode: 0 };
    const repositories = array(values.repositories, "repositories");
    const repository = repositories.find((item) => String(object(item, "repository").id ?? object(item, "repository").github_repository_id) === id);
    if (!repository) throw new CliError(`Repository '${id}' is not in your Organizer scope.`, { exitCode: 5 });
    return { value: { repository }, exitCode: 0 };
  }
  if (key === "organizer collection list") { exactPositionals(command, 0); return { value: await client.request("/api/organizer/collections"), exitCode: 0 }; }
  if (key === "organizer collection show") { const [id] = exactPositionals(command, 1); uuid(id!, "collection-id"); return { value: await client.request(`/api/organizer/collections/${id}`), exitCode: 0 }; }
  if (key === "organizer collection create") {
    exactPositionals(command, 0); const repository = stringOption(command, "repo"); const index = stringOption(command, "index") ?? "collection/index.json";
    if (!repository) throw usageError("--repo must be a GitHub numeric repository ID.");
    const repositoryId = positiveInteger(repository, 1, Number.MAX_SAFE_INTEGER, "--repo");
    return { value: await client.request("/api/organizer/collections", { method: "POST", body: { githubRepositoryId: repositoryId, indexPath: normalizedRelativePath(index, "--index") } }), exitCode: 0 };
  }
  if (key === "organizer collection validate") {
    const [id] = exactPositionals(command, 1); uuid(id!, "collection-id"); const ref = stringOption(command, "ref");
    if (!ref || ref.length > 256 || /[\u0000-\u001f\u007f]/u.test(ref)) throw usageError("--ref must be a 1–256 character printable Git ref.");
    const created = await client.request(`/api/organizer/collections/${id}/validations`, { method: "POST", body: { ref } });
    if (!booleanOption(command, "wait")) return { value: created, exitCode: 0 };
    const validation = object(object(created, "validation creation").validation, "validation");
    const initialState = field(validation, "state", "validation state");
    if (TERMINAL_VALIDATION_STATES.has(initialState)) return { value: created, exitCode: initialState === "valid" ? 0 : 1 };
    return watchResource({ client, path: `/api/organizer/validations/${serverUuid(validation, "id", "validation ID")}`, envelope: "validation", terminal: TERMINAL_VALIDATION_STATES, success: new Set(["valid"]), intervalMs: 2_000, sleep: dependencies.sleep });
  }
  if (key === "organizer collection validation") { const [id] = exactPositionals(command, 1); uuid(id!, "validation-id"); if (!booleanOption(command, "watch")) return { value: await client.request(`/api/organizer/validations/${id}`), exitCode: 0 }; return watchResource({ client, path: `/api/organizer/validations/${id}`, envelope: "validation", terminal: TERMINAL_VALIDATION_STATES, success: new Set(["valid"]), intervalMs: positiveInteger(stringOption(command, "interval"), 2, 30, "interval") * 1_000, sleep: dependencies.sleep }); }
  if (key === "organizer collection publish") {
    const [id] = exactPositionals(command, 1); uuid(id!, "revision-id"); const mode = stringOption(command, "mode") ?? "official-practice"; if (mode !== "official-practice" && mode !== "contest") throw usageError("--mode must be official-practice or contest.");
    const created = await client.request(`/api/organizer/revisions/${id}/publications`, { method: "POST", body: { mode, idempotencyKey: `woj-publish-${randomUUID()}` } });
    if (!booleanOption(command, "wait")) return { value: created, exitCode: 0 }; const job = object(object(created, "publication creation").publicationJob, "publication job");
    return watchResource({ client, path: `/api/organizer/publications/${serverUuid(job, "id", "publication job ID")}`, envelope: "publication", terminal: TERMINAL_PUBLICATION_STATES, success: new Set(["published"]), intervalMs: 2_000, sleep: dependencies.sleep });
  }
  if (key === "organizer collection publication") { const [id] = exactPositionals(command, 1); uuid(id!, "publication-job-id"); if (!booleanOption(command, "watch")) return { value: await client.request(`/api/organizer/publications/${id}`), exitCode: 0 }; return watchResource({ client, path: `/api/organizer/publications/${id}`, envelope: "publication", terminal: TERMINAL_PUBLICATION_STATES, success: new Set(["published"]), intervalMs: positiveInteger(stringOption(command, "interval"), 2, 30, "interval") * 1_000, sleep: dependencies.sleep }); }
  if (key === "organizer collection activate") { const [id] = exactPositionals(command, 1); uuid(id!, "publication-id"); return { value: await client.request(`/api/organizer/publications/${id}/activate`, { method: "POST", body: {} }), exitCode: 0 }; }
  if (key === "organizer contest list") { exactPositionals(command, 0); return { value: await client.request("/api/organizer/contests"), exitCode: 0 }; }
  if (key === "organizer contest show") { const [id] = exactPositionals(command, 1); uuid(id!, "contest-id"); return { value: await client.request(`/api/organizer/contests/${id}`), exitCode: 0 }; }
  if (key === "organizer contest create") {
    exactPositionals(command, 0); const body = await contestBody(command, dependencies.cwd); for (const name of ["title", "startsAt", "endsAt", "accessMode", "problemVersionIds"]) if (body[name] === undefined) throw usageError(`contest create requires ${name}.`); if (body.description === undefined) body.description = "";
    if (body.accessMode === "invite" && body.inviteCode === undefined) throw usageError("Invite contests require --invite-code-file.");
    const value = await client.request("/api/contests", { method: "POST", body }); return { value, exitCode: 0 };
  }
  if (key === "organizer contest update") {
    const [contestId] = exactPositionals(command, 1); const id = uuid(contestId!, "contest-id"); const draft = await currentContestDraft(client, id);
    return { value: await client.request(`/api/organizer/contests/${id}`, { method: "PUT", body: await contestBody(command, dependencies.cwd, draft.body) }), exitCode: 0 };
  }
  if (key === "organizer contest add-problem" || key === "organizer contest remove-problem") {
    const [contestId, problemVersionId] = exactPositionals(command, 2); const id = uuid(contestId!, "contest-id"); const problem = uuid(problemVersionId!, "problem-version-id");
    return { value: await client.request(`/api/organizer/contests/${id}/problems/${problem}`, { method: key.endsWith("add-problem") ? "POST" : "DELETE", body: {} }), exitCode: 0 };
  }
  if (key === "organizer contest publish") { const [id] = exactPositionals(command, 1); uuid(id!, "contest-id"); return { value: await client.request(`/api/contests/${id}/publish`, { method: "POST", body: {} }), exitCode: 0 }; }
  if (key === "organizer contest archive") { const [id] = exactPositionals(command, 1); uuid(id!, "contest-id"); return { value: await client.request(`/api/organizer/contests/${id}/archive`, { method: "POST", body: {} }), exitCode: 0 }; }
  if (key === "organizer contest participants") { const [id] = exactPositionals(command, 1); uuid(id!, "contest-id"); const next = cursor(stringOption(command, "cursor"), ["afterJoinedAt", "afterUserId"], "participant cursor"); if (next.afterJoinedAt) { canonicalCursorTimestamp(next.afterJoinedAt, "participant cursor"); uuid(next.afterUserId!, "participant cursor afterUserId"); } return { value: await client.request(`/api/organizer/contests/${id}/participants${query({ limit: boundedIntegerOption(command, "limit", 100), afterJoinedAt: next.afterJoinedAt, afterUserId: next.afterUserId })}`), exitCode: 0 }; }
  if (key === "organizer contest standings") { const [id] = exactPositionals(command, 1); uuid(id!, "contest-id"); return { value: await client.request(`/api/contests/${id}/leaderboard${query({ limit: boundedIntegerOption(command, "limit", 100) })}`), exitCode: 0 }; }
  if (key === "organizer rejudge options") { const [source] = exactPositionals(command, 1); uuid(source!, "problem-version-id"); return { value: await client.request(`/api/organizer/rejudges/options${query({ source })}`), exitCode: 0 }; }
  if (key === "organizer rejudge start") {
    exactPositionals(command, 0); const from = stringOption(command, "from"); const to = stringOption(command, "to"); if (!from || !to) throw usageError("rejudge start requires --from and --to."); uuid(from, "from"); uuid(to, "to");
    const created = await client.request("/api/organizer/rejudges", { method: "POST", body: { oldProblemVersionId: from, newProblemVersionId: to, idempotencyKey: `woj-rejudge-${randomUUID()}` } });
    if (!booleanOption(command, "wait")) return { value: created, exitCode: 0 }; const id = serverUuid(object(created, "rejudge creation"), "rejudgeBatchId"); return watchResource({ client, path: `/api/organizer/rejudges/${id}`, envelope: "rejudgeBatch", terminal: TERMINAL_REJUDGE_STATES, success: new Set(["effective"]), intervalMs: 2_000, sleep: dependencies.sleep });
  }
  if (key === "organizer rejudge list") { exactPositionals(command, 0); return { value: await client.request(`/api/organizer/rejudges${query({ limit: boundedIntegerOption(command, "limit", 100) })}`), exitCode: 0 }; }
  if (key === "organizer rejudge show") { const [id] = exactPositionals(command, 1); uuid(id!, "batch-id"); return { value: await client.request(`/api/organizer/rejudges/${id}`), exitCode: 0 }; }
  if (key === "organizer rejudge watch") { const [id] = exactPositionals(command, 1); uuid(id!, "batch-id"); return watchResource({ client, path: `/api/organizer/rejudges/${id}`, envelope: "rejudgeBatch", terminal: TERMINAL_REJUDGE_STATES, success: new Set(["effective"]), intervalMs: positiveInteger(stringOption(command, "interval"), 2, 30, "interval") * 1_000, sleep: dependencies.sleep }); }
  if (key === "organizer rejudge cancel") { const [id] = exactPositionals(command, 1); uuid(id!, "batch-id"); return { value: await client.request(`/api/organizer/rejudges/${id}/cancel`, { method: "POST", body: {} }), exitCode: 0 }; }

  throw new CliError(`Command '${key}' has no handler.`, { exitCode: 6, code: "handler-missing" });
}

export function optionRecord(command: ParsedCommand): Readonly<Record<string, OptionValue>> { return command.options; }
