import { describe, expect, it } from "vitest";
import { COMMAND_BY_KEY, WOJ_COMMANDS, WOJ_EXIT } from "./contracts";

describe("woj CLI public contract", () => {
  it("keeps stable, distinct exit codes 0 through 7", () => {
    expect(WOJ_EXIT).toEqual({
      success: 0,
      unsuccessful: 1,
      usage: 2,
      authentication: 3,
      integrity: 4,
      conflict: 5,
      infrastructure: 6,
      localIntegrity: 7,
    });
    expect(new Set(Object.values(WOJ_EXIT)).size).toBe(8);
  });

  it("exposes every Issue #42 command family through one tree", () => {
    const required = [
      "auth login", "init", "build", "run", "test", "bench", "watch",
      "problem pull", "submit", "submission watch", "contest standings",
      "performance frontier", "judge execute", "toolchain fetch",
      "organizer repo list", "organizer collection activate",
      "organizer contest participants", "organizer rejudge cancel",
      "config set", "cache clear", "doctor", "completion", "version",
    ];
    for (const key of required) expect(COMMAND_BY_KEY.has(key), key).toBe(true);
    expect(new Set(WOJ_COMMANDS.map((command) => command.path.join(" "))).size).toBe(WOJ_COMMANDS.length);
  });

  it("labels every command that can cross the network boundary", () => {
    expect(COMMAND_BY_KEY.get("problem list")?.boundary).toBe("remote");
    expect(COMMAND_BY_KEY.get("toolchain fetch")?.boundary).toBe("network");
    expect(COMMAND_BY_KEY.get("build")?.boundary).toBe("local");
    expect(COMMAND_BY_KEY.get("organizer collection verify")?.boundary).toBe("local");
  });
});
