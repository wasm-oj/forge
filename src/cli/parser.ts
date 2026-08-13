import { COMMAND_BY_KEY, WOJ_COMMANDS, type CommandSpec } from "./contracts";
import { usageError } from "./errors";

export interface ParsedCommand {
  readonly spec: CommandSpec;
  readonly positionals: readonly string[];
  readonly options: Readonly<Record<string, string | boolean | readonly string[]>>;
  readonly global: {
    readonly offline: boolean;
    readonly json: boolean;
    readonly server?: string;
  };
}
export type ParseResult =
  | { readonly kind: "command"; readonly command: ParsedCommand }
  | { readonly kind: "help"; readonly prefix: readonly string[] }
  | { readonly kind: "version" };

const GLOBAL_OPTIONS = new Set(["offline", "json", "server"]);

function takeGlobal(arguments_: readonly string[]): {
  readonly rest: string[];
  readonly offline: boolean;
  readonly json: boolean;
  readonly server?: string;
  readonly help: boolean;
  readonly version: boolean;
} {
  const rest: string[] = [];
  let offline = false;
  let json = false;
  let server: string | undefined;
  let help = false;
  let version = false;
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index]!;
    if (argument === "--") {
      rest.push(...arguments_.slice(index + 1));
      break;
    }
    if (argument === "--offline") offline = true;
    else if (argument === "--json") json = true;
    else if (argument === "--help" || argument === "-h") help = true;
    else if (argument === "--version" || argument === "-V") version = true;
    else if (argument === "--server") {
      const value = arguments_[index + 1];
      if (!value || value.startsWith("-")) throw usageError("--server requires an origin.");
      server = value;
      index += 1;
    } else rest.push(argument);
  }
  return { rest, offline, json, ...(server ? { server } : {}), help, version };
}

function matchingCommand(words: readonly string[]): { readonly spec: CommandSpec; readonly consumed: number } | undefined {
  let match: { spec: CommandSpec; consumed: number } | undefined;
  for (let count = 1; count <= words.length; count += 1) {
    const spec = COMMAND_BY_KEY.get(words.slice(0, count).join(" "));
    if (spec) match = { spec, consumed: count };
  }
  return match;
}

function knownPrefix(words: readonly string[]): boolean {
  return WOJ_COMMANDS.some((command) => words.length <= command.path.length && words.every((word, index) => command.path[index] === word));
}

function parseLeafArguments(spec: CommandSpec, arguments_: readonly string[]): Pick<ParsedCommand, "positionals" | "options"> {
  const positionals: string[] = [];
  const options: Record<string, string | boolean | string[]> = {};
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index]!;
    if (argument === "--") {
      positionals.push(...arguments_.slice(index + 1));
      break;
    }
    if (!argument.startsWith("--")) {
      if (argument.startsWith("-") && argument !== "-") throw usageError(`Unknown option '${argument}'.`);
      positionals.push(argument);
      continue;
    }
    const equals = argument.indexOf("=");
    const name = argument.slice(2, equals < 0 ? undefined : equals);
    if (!name || GLOBAL_OPTIONS.has(name)) throw usageError(`Global option '--${name}' must appear before the command.`);
    const kind = spec.options?.[name];
    if (!kind) throw usageError(`Unknown option '--${name}' for '${spec.path.join(" ")}'.`);
    if (kind === "boolean") {
      if (equals >= 0) throw usageError(`--${name} does not accept a value.`);
      options[name] = true;
      continue;
    }
    const value = equals >= 0 ? argument.slice(equals + 1) : arguments_[index + 1];
    if (!value || (equals < 0 && value.startsWith("--"))) throw usageError(`--${name} requires a value.`);
    if (equals < 0) index += 1;
    if (kind === "repeatable") {
      const current = options[name];
      options[name] = [...(Array.isArray(current) ? current : []), value];
    } else {
      if (name in options) throw usageError(`--${name} may be provided only once.`);
      options[name] = value;
    }
  }
  return { positionals, options };
}

export function parseCli(arguments_: readonly string[]): ParseResult {
  const global = takeGlobal(arguments_);
  if (global.version) return { kind: "version" };
  if (global.rest.length === 0) return { kind: "help", prefix: [] };
  const match = matchingCommand(global.rest);
  if (global.help) {
    const prefix = match?.spec.path ?? global.rest.filter((part) => !part.startsWith("-"));
    if (!knownPrefix(prefix)) throw usageError(`Unknown command '${prefix.join(" ")}'.`);
    return { kind: "help", prefix };
  }
  if (!match) {
    const prefix = global.rest.filter((part) => !part.startsWith("-"));
    if (knownPrefix(prefix)) return { kind: "help", prefix };
    throw usageError(`Unknown command '${prefix.join(" ")}'. Run 'woj --help'.`);
  }
  const leaf = parseLeafArguments(match.spec, global.rest.slice(match.consumed));
  return {
    kind: "command",
    command: {
      spec: match.spec,
      ...leaf,
      global: {
        offline: global.offline,
        json: global.json,
        ...(global.server ? { server: global.server } : {}),
      },
    },
  };
}
