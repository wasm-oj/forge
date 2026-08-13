import { WOJ_COMMANDS, WOJ_CLI_VERSION } from "./contracts";

const ROOT_HELP = `woj ${WOJ_CLI_VERSION} — local-first WASM-OJ

Usage: woj [--offline] [--json] [--server origin] <command> [options]

Local engine:   init, build, run, test, bench, watch, judge, toolchain
Student:        auth, problem, submit, submission, contest, performance
Organizer:      organizer repo, organizer collection, organizer contest, organizer rejudge
Operations:     config, cache, doctor, completion, version

Boundaries:
  Local commands use only bytes already on this machine.
  Remote commands address immutable server resources and require authentication where noted.
  --offline rejects every command that could access the network before dispatch.

Run 'woj <command> --help' for command details.`;

export function helpText(prefix: readonly string[]): string {
  if (prefix.length === 0) return ROOT_HELP;
  const exact = WOJ_COMMANDS.find((command) => command.path.length === prefix.length
    && prefix.every((part, index) => command.path[index] === part));
  const children = WOJ_COMMANDS
    .filter((command) => command.path.length > prefix.length && prefix.every((part, index) => command.path[index] === part))
    .map((command) => ({ name: command.path[prefix.length]!, command }));
  if (exact && children.length === 0) {
    const optionLines = Object.entries(exact.options ?? {}).map(([name, kind]) => `  --${name}${kind === "boolean" ? "" : " <value>"}`);
    return [
      exact.summary,
      "",
      `Usage: woj ${exact.path.join(" ")}${exact.usage ? ` ${exact.usage}` : ""}${optionLines.length ? " [options]" : ""}`,
      `Boundary: ${exact.boundary}`,
      ...(optionLines.length ? ["", "Options:", ...optionLines] : []),
    ].join("\n");
  }
  const unique = new Map<string, string>();
  for (const child of children) {
    const direct = child.command.path.length === prefix.length + 1;
    unique.set(child.name, direct ? child.command.summary : `${child.name} commands`);
  }
  return [
    `Usage: woj ${prefix.join(" ")} <command>`,
    "",
    "Commands:",
    ...[...unique].sort(([left], [right]) => left.localeCompare(right)).map(([name, summary]) => `  ${name.padEnd(16)} ${summary}`),
  ].join("\n");
}
