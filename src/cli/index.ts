import { runCollectionCli } from "@wasm-oj/organizer";
import { deviceLogin, SystemBrowserOpener, type BrowserOpener } from "./auth";
import { dispatchCommand, type CommandDependencies } from "./commands";
import { JsonConfigStore, type ConfigStore } from "./config";
import { WOJ_CLI_VERSION, WOJ_EXIT, type WojExitCode } from "./contracts";
import { asCliError, CliError, usageError } from "./errors";
import { helpText } from "./help";
import { HttpRemoteClient, type RemoteClient } from "./http";
import { OsKeychainTokenStore, type TokenStore } from "./keychain";
import { NodeLocalRuntime, type LocalRuntime } from "./local";
import { parseCli } from "./parser";

export * from "./contracts";
export * from "./config";
export * from "./errors";
export * from "./http";
export * from "./keychain";
export * from "./local";
export * from "./parser";
export * from "./toolchains";
export * from "./workspace";
export { deviceLogin };
export type { BrowserOpener, CommandDependencies };

export interface CliIo {
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
}

export interface WojCliDependencies {
  readonly cwd?: string;
  readonly configStore?: ConfigStore;
  readonly tokenStore?: TokenStore;
  readonly local?: LocalRuntime;
  readonly collectionCli?: (arguments_: readonly string[]) => Promise<void>;
  readonly remote?: (origin: string) => RemoteClient;
  readonly opener?: BrowserOpener;
  readonly sleep?: (milliseconds: number) => Promise<void>;
  readonly io?: CliIo;
}

function defaultIo(): CliIo {
  return {
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
  };
}

const TERMINAL_CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/gu;

function escapedCodePoint(value: string): string {
  return [...value].map((character) => `\\u{${character.codePointAt(0)!.toString(16).padStart(4, "0")}}`).join("");
}

function terminalText(value: string): string {
  return value.replace(TERMINAL_CONTROL, escapedCodePoint).replaceAll("\r", "\\u{000d}");
}

function terminalLine(value: string, maximumCodePoints: number): string {
  const sanitized = terminalText(value).replace(/[\n\t\u2028\u2029]+/gu, " ").trim();
  const codePoints = [...sanitized];
  return codePoints.length <= maximumCodePoints ? sanitized : `${codePoints.slice(0, maximumCodePoints).join("")}…`;
}

function terminalJson(value: unknown): string {
  const serialized = JSON.stringify(value, null, 2) ?? "null";
  return serialized.replace(/[\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/gu, (character) =>
    `\\u${character.codePointAt(0)!.toString(16).padStart(4, "0")}`);
}

function printValue(io: CliIo, value: unknown, json: boolean): void {
  if (typeof value === "string" && !json) {
    io.stdout(`${terminalText(value)}\n`);
    return;
  }
  io.stdout(`${terminalJson(value)}\n`);
}

function printError(io: CliIo, error: CliError, json: boolean): void {
  if (json) io.stderr(`${terminalJson({ error: { code: error.code, message: error.message, exitCode: error.exitCode } })}\n`);
  else io.stderr(`error[${terminalLine(error.code, 80) || "cli-error"}]: ${terminalLine(error.message, 2_000) || "The CLI failed."}\n`);
}

export async function runWojCli(arguments_: readonly string[], provided: WojCliDependencies = {}): Promise<WojExitCode> {
  const io = provided.io ?? defaultIo();
  let json = arguments_.includes("--json");
  try {
    const parsed = parseCli(arguments_);
    if (parsed.kind === "help") { io.stdout(`${helpText(parsed.prefix)}\n`); return WOJ_EXIT.success; }
    if (parsed.kind === "version") { io.stdout(`woj ${WOJ_CLI_VERSION}\n`); return WOJ_EXIT.success; }
    json = parsed.command.global.json;
    if (parsed.command.global.offline && parsed.command.spec.boundary !== "local") {
      throw usageError(`'woj ${parsed.command.spec.path.join(" ")}' can access the network and is disabled by --offline.`);
    }
    const tokenStore = provided.tokenStore ?? new OsKeychainTokenStore();
    const dependencies: CommandDependencies = {
      cwd: provided.cwd ?? process.cwd(),
      configStore: provided.configStore ?? new JsonConfigStore(),
      tokenStore,
      local: provided.local ?? new NodeLocalRuntime(),
      collectionCli: provided.collectionCli ?? runCollectionCli,
      remote: provided.remote ?? ((origin) => new HttpRemoteClient(origin, tokenStore)),
      opener: provided.opener ?? new SystemBrowserOpener(),
      sleep: provided.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))),
      onNotice: (message) => io.stderr(`${terminalLine(message, 4_000)}\n`),
    };
    const outcome = await dispatchCommand(parsed.command, dependencies);
    printValue(io, outcome.value, json);
    return outcome.exitCode;
  } catch (error) {
    const cliError = asCliError(error);
    printError(io, cliError, json);
    return cliError.exitCode;
  }
}

export async function main(arguments_: readonly string[]): Promise<number> {
  return runWojCli(arguments_);
}
