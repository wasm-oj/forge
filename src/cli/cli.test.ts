import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BROWSER_PROBLEM_SCHEMA, canonicalJsonBytes, derivePracticePublic } from "@wasm-oj/core";
import { PROBLEMS } from "../judge/problems";
import { MemoryConfigStore } from "./config";
import type { LocalRuntime } from "./local";
import type { RemoteClient } from "./http";
import { MemoryTokenStore } from "./keychain";
import { runWojCli, type CliIo } from "./index";
import { readWorkspace } from "./workspace";

const temporary: string[] = [];

afterEach(async () => {
  for (const directory of temporary.splice(0)) await rm(directory, { recursive: true, force: true });
});

function io() {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return { stdout, stderr, implementation: { stdout: (value: string) => stdout.push(value), stderr: (value: string) => stderr.push(value) } satisfies CliIo };
}

function local(overrides: Partial<LocalRuntime> = {}): LocalRuntime {
  const success = async () => ({ value: { ok: true }, successful: true });
  return {
    build: success, run: success, test: success, bench: success,
    inspectJudge: success, verifyJudge: success, executeJudge: success,
    toolchainList: success, toolchainInfo: success, toolchainFetch: success,
    toolchainVerify: success, toolchainPrune: success, cacheStatus: success,
    cachePrune: success, cacheClear: success, doctor: success,
    ...overrides,
  } as LocalRuntime;
}

describe("woj CLI dispatch", () => {
  it("rejects every remote and acquisition command before constructing a client in offline mode", async () => {
    const output = io();
    const remote = vi.fn<(_: string) => RemoteClient>();
    expect(await runWojCli(["--offline", "problem", "list"], { io: output.implementation, remote })).toBe(2);
    expect(await runWojCli(["--offline", "toolchain", "fetch", "rust"], { io: output.implementation, remote })).toBe(2);
    expect(remote).not.toHaveBeenCalled();
  });

  it("keeps local build network-free and returns exit 1 for an unsuccessful workload", async () => {
    const output = io();
    const remote = vi.fn<(_: string) => RemoteClient>();
    const build = vi.fn(async () => ({ value: { success: false }, successful: false }));
    expect(await runWojCli(["build"], { io: output.implementation, remote, local: local({ build }) })).toBe(1);
    expect(build).toHaveBeenCalledOnce();
    expect(remote).not.toHaveBeenCalled();
  });

  it("maps read-only submission show to GET and exit 0 regardless of verdict", async () => {
    const output = io();
    const request = vi.fn(async () => ({ submission: { state: "completed", verdict: "wrong-answer" } }));
    const remote = () => ({ origin: "https://judge.example", request, requestBytes: vi.fn() }) satisfies RemoteClient;
    const id = "11111111-1111-4111-8111-111111111111";
    expect(await runWojCli(["submission", "show", id], {
      io: output.implementation,
      configStore: new MemoryConfigStore({ server: "https://judge.example" }),
      tokenStore: new MemoryTokenStore(), remote,
    })).toBe(0);
    expect(request).toHaveBeenCalledWith(`/api/submissions/${id}`);
  });

  it("does not silently accept unimplemented commands", async () => {
    const output = io();
    expect(await runWojCli(["unknown"], { io: output.implementation })).toBe(2);
    expect(output.stderr.join("")).toContain("Unknown command");
  });

  it("pulls exact bytes, selects the server profile, and pins origin plus publication", async () => {
    const output = io();
    const root = await mkdtemp(path.join(os.tmpdir(), "woj-pull-"));
    temporary.push(root);
    const problem = derivePracticePublic(PROBLEMS[0]!);
    const bytes = canonicalJsonBytes({ schema: BROWSER_PROBLEM_SCHEMA, problem });
    const digest = createHash("sha256").update(bytes).digest("hex");
    const version = "11111111-1111-4111-8111-111111111111";
    const publication = "22222222-2222-4222-8222-222222222222";
    const contentUrl = `/api/problems/${version}/content?role=practice`;
    const request = vi.fn(async () => ({
      schema: "wasm-oj-platform/problem-content-pointer/v2",
      problemVersionId: version,
      catalogPublicationId: publication,
      allowedProfiles: { cpp: { target: "wasix", optimization: "release" } },
      content: { url: contentUrl, bytes: bytes.byteLength, sha256: digest },
    }));
    const requestBytes = vi.fn(async () => bytes);
    const remote = () => ({ origin: "https://judge.example", request, requestBytes }) satisfies RemoteClient;
    expect(await runWojCli(["problem", "pull", version, root, "--language", "cpp", "--locale", "en"], {
      io: output.implementation,
      configStore: new MemoryConfigStore({ server: "https://judge.example" }),
      tokenStore: new MemoryTokenStore(), remote,
    })).toBe(0);
    const workspace = await readWorkspace(root);
    expect(workspace).toMatchObject({
      language: "cpp", target: "wasix", optimization: "release",
      problem: { problemVersionId: version, catalogPublicationId: publication, serverOrigin: "https://judge.example", contentSha256: digest, locale: "en" },
    });
    expect(new Uint8Array(await readFile(path.join(root, "problem.json")))).toEqual(bytes);
    expect(requestBytes).toHaveBeenCalledWith(contentUrl, { authenticated: "optional" });
  });

  it("uses atomic Organizer contest problem endpoints instead of a read-modify-write race", async () => {
    const output = io();
    const request = vi.fn(async () => ({ changed: true }));
    const remote = () => ({ origin: "https://judge.example", request, requestBytes: vi.fn() }) satisfies RemoteClient;
    const contest = "11111111-1111-4111-8111-111111111111";
    const problem = "22222222-2222-4222-8222-222222222222";
    const dependencies = {
      io: output.implementation,
      configStore: new MemoryConfigStore({ server: "https://judge.example" }),
      tokenStore: new MemoryTokenStore(), remote,
    };
    expect(await runWojCli(["organizer", "contest", "add-problem", contest, problem], dependencies)).toBe(0);
    expect(request).toHaveBeenLastCalledWith(`/api/organizer/contests/${contest}/problems/${problem}`, { method: "POST", body: {} });
    expect(await runWojCli(["organizer", "contest", "remove-problem", contest, problem], dependencies)).toBe(0);
    expect(request).toHaveBeenLastCalledWith(`/api/organizer/contests/${contest}/problems/${problem}`, { method: "DELETE", body: {} });
  });

  it("projects contest problems from the top-level API envelope", async () => {
    const output = io();
    const request = vi.fn(async () => ({ contest: { id: "contest" }, problems: [{ problemVersionId: "problem" }] }));
    const contest = "11111111-1111-4111-8111-111111111111";
    expect(await runWojCli(["contest", "problems", contest], {
      io: output.implementation,
      configStore: new MemoryConfigStore({ server: "https://judge.example" }),
      tokenStore: new MemoryTokenStore(),
      remote: () => ({ origin: "https://judge.example", request, requestBytes: vi.fn() }),
    })).toBe(0);
    expect(JSON.parse(output.stdout.at(-1)!) as unknown).toEqual({ problems: [{ problemVersionId: "problem" }] });
  });

  it("settles validation watch on infrastructure-error with exit 1", async () => {
    const output = io();
    const request = vi.fn(async () => ({ validation: { id: "validation", state: "infrastructure-error" } }));
    const validation = "11111111-1111-4111-8111-111111111111";
    expect(await runWojCli(["organizer", "collection", "validation", validation, "--watch"], {
      io: output.implementation,
      configStore: new MemoryConfigStore({ server: "https://judge.example" }),
      tokenStore: new MemoryTokenStore(),
      remote: () => ({ origin: "https://judge.example", request, requestBytes: vi.fn() }),
      sleep: async () => { throw new Error("terminal state should not sleep"); },
    })).toBe(1);
    expect(request).toHaveBeenCalledOnce();
  });
});
