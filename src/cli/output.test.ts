import { describe, expect, it, vi } from "vitest";
import { MemoryConfigStore } from "./config";
import { HttpRemoteClient } from "./http";
import type { CliIo } from "./index";
import { runWojCli } from "./index";
import { MemoryTokenStore, type TokenStore } from "./keychain";
import type { LocalRuntime } from "./local";

function output() {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    io: {
      stdout: (value: string) => stdout.push(value),
      stderr: (value: string) => stderr.push(value),
    } satisfies CliIo,
  };
}

function runtime(run: LocalRuntime["run"]): LocalRuntime {
  return { run } as LocalRuntime;
}

describe("woj terminal output boundary", () => {
  it("escapes terminal controls in successful human output", async () => {
    const captured = output();
    const dangerous = "visible\u001b]52;c;Y2xpcGJvYXJk\u0007\u009b31m";
    expect(await runWojCli(["run"], {
      io: captured.io,
      local: runtime(async () => ({ value: dangerous, successful: true })),
    })).toBe(0);
    const text = captured.stdout.join("");
    expect(text).not.toContain("\u001b");
    expect(text).not.toContain("\u0007");
    expect(text).not.toContain("\u009b");
    expect(text).toContain("\\u{001b}]52;c;Y2xpcGJvYXJk\\u{0007}\\u{009b}31m");
  });

  it("forces errors onto one bounded, control-free human line", async () => {
    const captured = output();
    const message = `first\nsecond\u001b]52;c;YQ==\u0007\u009b${"x".repeat(2_100)}`;
    expect(await runWojCli(["run"], {
      io: captured.io,
      local: runtime(async () => { throw new Error(message); }),
    })).toBe(6);
    const text = captured.stderr.join("");
    expect(text.match(/\n/gu)).toHaveLength(1);
    expect(text).not.toMatch(/[\u001b\u0007\u009b]/u);
    expect(text).toContain("first second\\u{001b}]52;c;YQ==\\u{0007}\\u{009b}");
    expect([...text].length).toBeLessThan(2_100);
  });

  it("sanitizes a server-controlled API error at the terminal boundary", async () => {
    const captured = output();
    const remote = () => new HttpRemoteClient("https://judge.example", new MemoryTokenStore(), async () =>
      new Response(JSON.stringify({ error: {
        code: "bad\u001b]52;c;YQ==\u0007\u009b",
        message: "remote\nmessage\u001b]52;c;Yg==\u0007\u009b",
      } }), { status: 400, headers: { "content-type": "application/json" } }));
    expect(await runWojCli(["problem", "list"], {
      io: captured.io,
      configStore: new MemoryConfigStore({ server: "https://judge.example" }),
      tokenStore: new MemoryTokenStore(),
      remote,
    })).toBe(4);
    const text = captured.stderr.join("");
    expect(text.match(/\n/gu)).toHaveLength(1);
    expect(text).not.toMatch(/[\u001b\u0007\u009b]/u);
    expect(text).toContain("\\u{001b}");
  });

  it("sanitizes a workspace path embedded in a local error", async () => {
    const captured = output();
    expect(await runWojCli(["build"], {
      cwd: process.cwd(),
      io: captured.io,
      local: { build: async () => { throw new Error("Workspace source 'linked/secret\u001b]52;c;Yw==\u0007\u009b' is invalid."); } } as unknown as LocalRuntime,
    })).toBe(6);
    const text = captured.stderr.join("");
    expect(text.match(/\n/gu)).toHaveLength(1);
    expect(text).not.toMatch(/[\u001b\u0007\u009b]/u);
    expect(text).toContain("\\u{001b}");
  });

  it("escapes C1 and bidi controls in JSON bytes without changing decoded data", async () => {
    const captured = output();
    const dangerous = "left\u009bright\u202e";
    expect(await runWojCli(["--json", "run"], {
      io: captured.io,
      local: runtime(async () => ({ value: dangerous, successful: true })),
    })).toBe(0);
    const text = captured.stdout.join("");
    expect(text).not.toContain("\u009b");
    expect(text).not.toContain("\u202e");
    expect(JSON.parse(text)).toBe(dangerous);
  });

  it("rejects a malformed stored token without echoing it or reaching fetch", async () => {
    const captured = output();
    const malformed = "credential-secret-that-must-never-appear";
    const tokenStore: TokenStore = {
      get: async () => malformed,
      set: async () => undefined,
      delete: async () => undefined,
    };
    const fetchImplementation = vi.fn(async () => new Response("{}"));
    const remote = () => new HttpRemoteClient("https://judge.example", tokenStore, fetchImplementation);
    expect(await runWojCli(["submission", "list"], {
      io: captured.io,
      configStore: new MemoryConfigStore({ server: "https://judge.example" }),
      tokenStore,
      remote,
    })).toBe(7);
    expect(fetchImplementation).not.toHaveBeenCalled();
    expect(captured.stderr.join("")).not.toContain(malformed);
  });
});
