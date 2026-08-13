import { createHash } from "node:crypto";
import { link, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { BROWSER_PROBLEM_SCHEMA, canonicalJsonBytes, derivePracticePublic } from "@wasm-oj/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PROBLEMS } from "../judge/problems";
import { MemoryConfigStore } from "./config";
import type { RemoteClient } from "./http";
import { runWojCli, type CliIo } from "./index";
import { MemoryTokenStore } from "./keychain";
import { NodeLocalRuntime, type LocalRuntime } from "./local";
import { WOJ_WORKSPACE_SCHEMA, writeWorkspace } from "./workspace";

const SERVER = "https://judge.example";
const PROBLEM_VERSION_ID = "11111111-1111-4111-8111-111111111111";
const PUBLICATION_ID = "22222222-2222-4222-8222-222222222222";
const OTHER_ID = "33333333-3333-4333-8333-333333333333";
const temporary: string[] = [];

afterEach(async () => {
  for (const directory of temporary.splice(0)) await rm(directory, { recursive: true, force: true });
});

function io() {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    implementation: {
      stdout: (value: string) => stdout.push(value),
      stderr: (value: string) => stderr.push(value),
    } satisfies CliIo,
  };
}

function local(overrides: Partial<LocalRuntime> = {}): LocalRuntime {
  const success = async () => ({ value: { ok: true }, successful: true });
  return {
    build: success,
    run: success,
    test: success,
    bench: success,
    inspectJudge: success,
    verifyJudge: success,
    executeJudge: success,
    toolchainList: success,
    toolchainInfo: success,
    toolchainFetch: success,
    toolchainVerify: success,
    toolchainPrune: success,
    cacheStatus: success,
    cachePrune: success,
    cacheClear: success,
    doctor: success,
    ...overrides,
  } as LocalRuntime;
}

function configuredRemote(request: RemoteClient["request"], requestBytes = vi.fn<RemoteClient["requestBytes"]>()) {
  return {
    configStore: new MemoryConfigStore({ server: SERVER }),
    tokenStore: new MemoryTokenStore(),
    remote: () => ({ origin: SERVER, request, requestBytes }) satisfies RemoteClient,
  };
}

async function exists(file: string): Promise<boolean> {
  try {
    await lstat(file);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), prefix));
  temporary.push(directory);
  return directory;
}

function publicProblemRemote() {
  const problem = derivePracticePublic(PROBLEMS[0]!);
  const bytes = canonicalJsonBytes({ schema: BROWSER_PROBLEM_SCHEMA, problem });
  const digest = createHash("sha256").update(bytes).digest("hex");
  const contentUrl = `/api/problems/${PROBLEM_VERSION_ID}/content?role=practice`;
  const request = vi.fn(async () => ({
    schema: "wasm-oj-platform/problem-content-pointer/v2",
    problemVersionId: PROBLEM_VERSION_ID,
    catalogPublicationId: PUBLICATION_ID,
    allowedProfiles: { cpp: { target: "wasix", optimization: "release" } },
    content: { url: contentUrl, bytes: bytes.byteLength, sha256: digest },
  }));
  const requestBytes = vi.fn(async () => bytes);
  return { problem, request, requestBytes };
}

describe("woj exact Issue #42 command interfaces", () => {
  it("maps --input and --text exactly and rejects the obsolete --stdin spelling", async () => {
    const root = await temporaryDirectory("woj-run-options-");
    await writeFile(path.join(root, "input.txt"), "from file\n", "utf8");
    const run = vi.fn(async () => ({ value: { ok: true }, successful: true }));
    const runtime = local({ run });

    expect(await runWojCli(["run", "--input", "input.txt", "--arg", "one"], { cwd: root, io: io().implementation, local: runtime })).toBe(0);
    expect(run).toHaveBeenLastCalledWith(root, {}, { stdin: "from file\n", args: ["one"] });

    expect(await runWojCli(["run", "--text", "inline", "--arg", "two"], { cwd: root, io: io().implementation, local: runtime })).toBe(0);
    expect(run).toHaveBeenLastCalledWith(root, {}, { stdin: "inline", args: ["two"] });

    expect(await runWojCli(["run", "--stdin", "legacy"], { cwd: root, io: io().implementation, local: runtime })).toBe(2);
    expect(await runWojCli(["run", "--input", "input.txt", "--text", "ambiguous"], { cwd: root, io: io().implementation, local: runtime })).toBe(2);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("returns local integrity for a missing --input file", async () => {
    const root = await temporaryDirectory("woj-run-missing-input-");
    const run = vi.fn(async () => ({ value: { ok: true }, successful: true }));
    expect(await runWojCli(["run", "--input", "missing.txt"], { cwd: root, io: io().implementation, local: local({ run }) })).toBe(7);
    expect(run).not.toHaveBeenCalled();
  });

  it("passes only explicitly selected public cases to test", async () => {
    const root = await temporaryDirectory("woj-test-case-");
    const test = vi.fn(async () => ({ value: { passed: true }, successful: true }));
    expect(await runWojCli(["test", "--case", "sample-2", "--case", "sample-1"], {
      cwd: root,
      io: io().implementation,
      local: local({ test }),
    })).toBe(0);
    expect(test).toHaveBeenCalledWith(root, {}, { cases: ["sample-2", "sample-1"] });
  });

  it("requires judge execute --source and --all before dispatch", async () => {
    const root = await temporaryDirectory("woj-judge-execute-");
    const executeJudge = vi.fn(async () => ({ value: { verdict: "accepted" }, successful: true }));
    const runtime = local({ executeJudge });

    expect(await runWojCli(["judge", "execute", "problem.judge", "--source", "solution"], { cwd: root, io: io().implementation, local: runtime })).toBe(2);
    expect(await runWojCli(["judge", "execute", "problem.judge", "--all"], { cwd: root, io: io().implementation, local: runtime })).toBe(2);
    expect(executeJudge).not.toHaveBeenCalled();

    expect(await runWojCli(["judge", "execute", "problem.judge", "--source", "solution", "--all"], { cwd: root, io: io().implementation, local: runtime })).toBe(0);
    expect(executeJudge).toHaveBeenCalledWith(path.join(root, "solution"), {}, path.join(root, "problem.judge"));
  });

  it("uses collection create --repo and rejects --repository", async () => {
    const request = vi.fn(async () => ({ collection: { id: OTHER_ID } }));
    const dependencies = configuredRemote(request);

    expect(await runWojCli(["organizer", "collection", "create", "--repo", "1234", "--index", "catalog/index.json"], {
      ...dependencies,
      io: io().implementation,
    })).toBe(0);
    expect(request).toHaveBeenLastCalledWith("/api/organizer/collections", {
      method: "POST",
      body: { githubRepositoryId: 1234, indexPath: "catalog/index.json" },
    });

    request.mockClear();
    expect(await runWojCli(["organizer", "collection", "create", "--repository", "1234"], {
      ...dependencies,
      io: io().implementation,
    })).toBe(2);
    expect(request).not.toHaveBeenCalled();
  });

  it("accepts the rejudge source problem version only as a positional", async () => {
    const request = vi.fn(async () => ({ source: {}, targets: [] }));
    const dependencies = configuredRemote(request);

    expect(await runWojCli(["organizer", "rejudge", "options", PROBLEM_VERSION_ID], { ...dependencies, io: io().implementation })).toBe(0);
    expect(request).toHaveBeenLastCalledWith(`/api/organizer/rejudges/options?source=${PROBLEM_VERSION_ID}`);

    request.mockClear();
    expect(await runWojCli(["organizer", "rejudge", "options", "--source", PROBLEM_VERSION_ID], { ...dependencies, io: io().implementation })).toBe(2);
    expect(request).not.toHaveBeenCalled();
  });

  it("reads invite secrets only from protected files and rejects secret-valued argv options", async () => {
    const root = await temporaryDirectory("woj-invite-file-");
    const secret = "sixteen-char-code";
    await writeFile(path.join(root, "invite.txt"), `${secret}\n`, { mode: 0o600 });
    const output = io();
    const request = vi.fn(async () => ({ joined: true }));
    const dependencies = configuredRemote(request);
    expect(await runWojCli(["contest", "join", PROBLEM_VERSION_ID, "--code-file", "invite.txt"], {
      cwd: root,
      ...dependencies,
      io: output.implementation,
    })).toBe(0);
    expect(request).toHaveBeenCalledWith(`/api/contests/${PROBLEM_VERSION_ID}/join`, { method: "POST", body: { inviteCode: secret } });
    expect(output.stdout.join("")).not.toContain(secret);

    request.mockClear();
    expect(await runWojCli([
      "organizer", "contest", "create",
      "--title", "Private round", "--starts", "2026-09-01T00:00:00.000Z", "--ends", "2026-09-02T00:00:00.000Z",
      "--access", "invite", "--invite-code-file", "invite.txt", "--problem", OTHER_ID,
    ], { cwd: root, ...dependencies, io: output.implementation })).toBe(0);
    expect(request).toHaveBeenCalledWith("/api/contests", { method: "POST", body: expect.objectContaining({ inviteCode: secret }) });
    expect(output.stdout.join("")).not.toContain(secret);

    request.mockClear();
    expect(await runWojCli(["contest", "join", PROBLEM_VERSION_ID, "--code", secret], {
      cwd: root,
      ...dependencies,
      io: io().implementation,
    })).toBe(2);
    expect(request).not.toHaveBeenCalled();
    expect(await runWojCli(["organizer", "contest", "create", "--invite-code", secret], {
      cwd: root,
      ...dependencies,
      io: io().implementation,
    })).toBe(2);
    expect(request).not.toHaveBeenCalled();
  });
});

describe("woj write destination fences", () => {
  it("refuses an existing problem starter before writing any pulled output", async () => {
    const root = await temporaryDirectory("woj-pull-existing-");
    const { problem, request, requestBytes } = publicProblemRemote();
    const entry = problem.starterTemplates.cpp.entry;
    await mkdir(path.dirname(path.join(root, ...entry.split("/"))), { recursive: true });
    await writeFile(path.join(root, ...entry.split("/")), "keep me\n", "utf8");

    expect(await runWojCli(["problem", "pull", PROBLEM_VERSION_ID, root, "--language", "cpp"], {
      ...configuredRemote(request, requestBytes),
      io: io().implementation,
    })).toBe(5);
    expect(requestBytes).toHaveBeenCalledOnce();
    expect(await readFile(path.join(root, ...entry.split("/")), "utf8")).toBe("keep me\n");
    expect(await exists(path.join(root, "woj.json"))).toBe(false);
    expect(await exists(path.join(root, "problem.json"))).toBe(false);
  });

  it("never follows a problem starter symlink, including with --force", async () => {
    const base = await temporaryDirectory("woj-pull-symlink-");
    const root = path.join(base, "workspace");
    const sentinel = path.join(base, "sentinel.cpp");
    const { problem, request, requestBytes } = publicProblemRemote();
    const entry = problem.starterTemplates.cpp.entry;
    await mkdir(path.dirname(path.join(root, ...entry.split("/"))), { recursive: true });
    await writeFile(sentinel, "outside\n", "utf8");
    await symlink(sentinel, path.join(root, ...entry.split("/")));

    expect(await runWojCli(["problem", "pull", PROBLEM_VERSION_ID, root, "--language", "cpp", "--force"], {
      ...configuredRemote(request, requestBytes),
      io: io().implementation,
    })).toBe(5);
    expect(await readFile(sentinel, "utf8")).toBe("outside\n");
    expect(await exists(path.join(root, "woj.json"))).toBe(false);
    expect(await exists(path.join(root, "problem.json"))).toBe(false);
  });

  it("rejects an init starter symlink even with --force", async () => {
    const base = await temporaryDirectory("woj-init-symlink-");
    const root = path.join(base, "workspace");
    const sentinel = path.join(base, "sentinel.cpp");
    await mkdir(root, { recursive: true });
    await writeFile(sentinel, "outside\n", "utf8");
    await symlink(sentinel, path.join(root, "main.cpp"));

    expect(await runWojCli(["init", root, "--force"], { io: io().implementation })).toBe(5);
    expect(await readFile(sentinel, "utf8")).toBe("outside\n");
    expect(await exists(path.join(root, "woj.json"))).toBe(false);
  });

  it("atomically replaces hardlinked init and pull targets without truncating their peers", async () => {
    const base = await temporaryDirectory("woj-hardlink-destinations-");
    const initRoot = path.join(base, "init");
    const initSentinel = path.join(base, "init-sentinel.cpp");
    await mkdir(initRoot);
    await writeFile(initSentinel, "init sentinel\n");
    await link(initSentinel, path.join(initRoot, "main.cpp"));
    expect(await runWojCli(["init", initRoot, "--force"], { io: io().implementation })).toBe(0);
    expect(await readFile(initSentinel, "utf8")).toBe("init sentinel\n");

    const pullRoot = path.join(base, "pull");
    const pullSentinel = path.join(base, "pull-sentinel.cpp");
    const { problem, request, requestBytes } = publicProblemRemote();
    const entry = problem.starterTemplates.cpp.entry;
    await mkdir(path.dirname(path.join(pullRoot, ...entry.split("/"))), { recursive: true });
    await writeFile(pullSentinel, "pull sentinel\n");
    await link(pullSentinel, path.join(pullRoot, ...entry.split("/")));
    expect(await runWojCli(["problem", "pull", PROBLEM_VERSION_ID, pullRoot, "--language", "cpp", "--force"], {
      ...configuredRemote(request, requestBytes),
      io: io().implementation,
    })).toBe(0);
    expect(await readFile(pullSentinel, "utf8")).toBe("pull sentinel\n");
  });

  it("rejects a collection source symlink even with --force", async () => {
    const base = await temporaryDirectory("woj-collection-symlink-");
    const root = path.join(base, "collection-workspace");
    const sentinel = path.join(base, "sentinel.json");
    await mkdir(path.join(root, "collection"), { recursive: true });
    await writeFile(sentinel, "outside\n", "utf8");
    await symlink(sentinel, path.join(root, "collection", "source.json"));

    expect(await runWojCli(["organizer", "collection", "init", root, "--force"], { io: io().implementation })).toBe(5);
    expect(await readFile(sentinel, "utf8")).toBe("outside\n");
  });

  it("rejects collection build repository symlinks before reading or writing", async () => {
    const base = await temporaryDirectory("woj-collection-build-symlink-");
    const root = path.join(base, "collection-workspace");
    const outside = path.join(base, "outside.json");
    await mkdir(path.join(root, "collection"), { recursive: true });
    await writeFile(outside, "outside\n", "utf8");
    await symlink(outside, path.join(root, "collection", "source.json"));
    expect(await runWojCli(["organizer", "collection", "build", root], { io: io().implementation })).toBe(4);
    expect(await readFile(outside, "utf8")).toBe("outside\n");
    expect(await exists(path.join(root, "collection", "index.json"))).toBe(false);
  });

  it("rejects a workspace beneath a symlinked parent before any init write", async () => {
    const base = await temporaryDirectory("woj-init-parent-symlink-");
    const victim = path.join(base, "victim");
    await mkdir(victim);
    await symlink(victim, path.join(base, "parent-link"));
    expect(await runWojCli(["init", path.join(base, "parent-link", "workspace")], { io: io().implementation })).toBe(5);
    expect(await exists(path.join(victim, "workspace", "woj.json"))).toBe(false);
  });

  it("never uploads a source through a symlinked workspace ancestor", async () => {
    const base = await temporaryDirectory("woj-submit-source-symlink-");
    const root = path.join(base, "workspace");
    const outside = path.join(base, "outside");
    await mkdir(root);
    await mkdir(outside);
    await writeFile(path.join(outside, "secret.cpp"), "SECRET\n", "utf8");
    await symlink(outside, path.join(root, "linked"));
    await writeFile(path.join(root, "problem.json"), "{}", "utf8");
    const digest = createHash("sha256").update("{}").digest("hex");
    await writeWorkspace(root, {
      schema: WOJ_WORKSPACE_SCHEMA,
      name: "safe",
      language: "cpp",
      target: "wasip1",
      optimization: "release",
      entry: "linked/secret.cpp",
      sources: ["linked/secret.cpp"],
      problem: {
        problemVersionId: PROBLEM_VERSION_ID,
        catalogPublicationId: PUBLICATION_ID,
        serverOrigin: SERVER,
        contentUrl: `/api/problems/${PROBLEM_VERSION_ID}/content`,
        contentSha256: digest,
        contentFile: "problem.json",
        locale: "en",
      },
    });
    const request = vi.fn(async () => ({ submissionId: OTHER_ID }));
    expect(await runWojCli(["submit"], { cwd: root, ...configuredRemote(request), io: io().implementation })).toBe(7);
    expect(request).not.toHaveBeenCalled();
  });
});

describe("woj remote response and request contracts", () => {
  it("never prints the bearer returned by auth login, including JSON output", async () => {
    const output = io();
    const expiresAt = new Date(Date.now() + 60_000).toISOString();
    const accessToken = "s".repeat(43);
    const tokenStore = new MemoryTokenStore();
    const request = vi.fn<RemoteClient["request"]>(async (requestPath) => requestPath.endsWith("/start")
      ? { flowId: PROBLEM_VERSION_ID, verificationUrl: `${SERVER}/auth/cli?flow=${PROBLEM_VERSION_ID}`, expiresAt, pollIntervalSeconds: 2 }
      : { accessToken, tokenType: "Bearer", expiresAt });
    expect(await runWojCli(["--json", "auth", "login"], {
      ...configuredRemote(request),
      tokenStore,
      io: output.implementation,
      opener: { open: async () => undefined },
      sleep: async () => undefined,
    })).toBe(0);
    expect(output.stdout.join("")).not.toContain(accessToken);
    expect(JSON.parse(output.stdout.at(-1)!)).toEqual({ authenticated: true, server: SERVER, expiresAt });
    expect(await tokenStore.get(SERVER)).toBe(accessToken);
  });

  it("wraps an anonymous auth status with its configured server", async () => {
    const output = io();
    const request = vi.fn(async () => ({ authenticated: false }));
    expect(await runWojCli(["auth", "status"], { ...configuredRemote(request), io: output.implementation })).toBe(0);
    expect(request).toHaveBeenCalledWith("/api/auth/session", { authenticated: "optional" });
    expect(JSON.parse(output.stdout.at(-1)!)).toEqual({ server: SERVER, session: { authenticated: false } });
  });

  it("omits a null freezeAt when updating an Organizer contest", async () => {
    const contestId = PROBLEM_VERSION_ID;
    const request = vi.fn<RemoteClient["request"]>(async (requestPath) => requestPath.endsWith(contestId)
      ? {
        contest: {
          title: "Before",
          description: "Description",
          accessMode: "public",
          startsAt: "2026-01-01T00:00:00.000Z",
          endsAt: "2026-01-02T00:00:00.000Z",
          freezeAt: null,
        },
        problems: [{ problemVersionId: OTHER_ID }],
      }
      : { contest: { id: contestId } });

    expect(await runWojCli(["organizer", "contest", "update", contestId, "--title", "After"], {
      ...configuredRemote(request),
      io: io().implementation,
    })).toBe(0);
    expect(request).toHaveBeenCalledTimes(2);
    const update = request.mock.calls[1];
    expect(update?.[0]).toBe(`/api/organizer/contests/${contestId}`);
    expect(update?.[1]).toMatchObject({ method: "PUT" });
    expect((update?.[1] as { body: Record<string, unknown> }).body).toEqual({
      title: "After",
      description: "Description",
      accessMode: "public",
      startsAt: "2026-01-01T00:00:00.000Z",
      endsAt: "2026-01-02T00:00:00.000Z",
      problemVersionIds: [OTHER_ID],
    });
  });

  it("requests personal performance evolution with mandatory authentication", async () => {
    const request = vi.fn(async () => ({ context: {}, myEvolution: [] }));
    expect(await runWojCli(["performance", "evolution", PROBLEM_VERSION_ID, "--language", "rust"], {
      ...configuredRemote(request),
      io: io().implementation,
    })).toBe(0);
    expect(request).toHaveBeenCalledWith(`/api/problems/${PROBLEM_VERSION_ID}/performance?language=rust`, { authenticated: true });
  });

  it.each([
    ["submission limit below range", ["submission", "list", "--limit", "0"]],
    ["submission limit above range", ["submission", "list", "--limit", "101"]],
    ["non-integral standings limit", ["contest", "standings", PROBLEM_VERSION_ID, "--limit", "1.5"]],
    ["invalid contest UUID", ["contest", "standings", "not-a-uuid"]],
    ["invalid participant UUID", ["organizer", "contest", "participants", "not-a-uuid"]],
    ["participant limit above range", ["organizer", "contest", "participants", PROBLEM_VERSION_ID, "--limit", "101"]],
    ["Organizer standings limit below range", ["organizer", "contest", "standings", PROBLEM_VERSION_ID, "--limit", "0"]],
    ["rejudge list limit above range", ["organizer", "rejudge", "list", "--limit", "101"]],
  ])("returns usage without a request for %s", async (_label, arguments_) => {
    const request = vi.fn(async () => ({ unexpected: true }));
    expect(await runWojCli(arguments_, { ...configuredRemote(request), io: io().implementation })).toBe(2);
    expect(request).not.toHaveBeenCalled();
  });

  it("does not GET an already-valid validation after creation with --wait", async () => {
    const collectionId = PROBLEM_VERSION_ID;
    const validationId = OTHER_ID;
    const request = vi.fn(async () => ({ validation: { id: validationId, state: "valid" } }));
    expect(await runWojCli(["organizer", "collection", "validate", collectionId, "--ref", "main", "--wait"], {
      ...configuredRemote(request),
      io: io().implementation,
      sleep: async () => { throw new Error("an already-terminal validation must not sleep"); },
    })).toBe(0);
    expect(request).toHaveBeenCalledOnce();
    expect(request).toHaveBeenCalledWith(`/api/organizer/collections/${collectionId}/validations`, {
      method: "POST",
      body: { ref: "main" },
    });
  });
});

describe("woj cache ownership", () => {
  it("refuses to clear an unowned non-empty directory and preserves its sentinel", async () => {
    const cache = await temporaryDirectory("woj-cache-unowned-");
    const sentinel = path.join(cache, "sentinel.txt");
    await writeFile(sentinel, "keep\n", "utf8");
    expect(await runWojCli(["cache", "clear", "--yes"], {
      configStore: new MemoryConfigStore({ "cache-directory": cache }),
      io: io().implementation,
      local: new NodeLocalRuntime(),
    })).toBe(7);
    expect(await readFile(sentinel, "utf8")).toBe("keep\n");
  });

  it("clears a directory carrying the exact woj ownership marker", async () => {
    const cache = await temporaryDirectory("woj-cache-owned-");
    await writeFile(path.join(cache, ".woj-cache"), "wasm-oj-cli-cache-v1\n", "utf8");
    await writeFile(path.join(cache, "cached.bin"), "cached\n", "utf8");
    expect(await runWojCli(["cache", "clear", "--yes"], {
      configStore: new MemoryConfigStore({ "cache-directory": cache }),
      io: io().implementation,
      local: new NodeLocalRuntime(),
    })).toBe(0);
    expect(await exists(cache)).toBe(false);
  });

  it("rejects a symlinked toolchains subtree and preserves its external victim", async () => {
    const base = await temporaryDirectory("woj-cache-toolchains-symlink-");
    const cache = path.join(base, "cache");
    const victim = path.join(base, "victim");
    const sentinel = path.join(victim, "sentinel.txt");
    await mkdir(cache);
    await mkdir(victim);
    await writeFile(path.join(cache, ".woj-cache"), "wasm-oj-cli-cache-v1\n", "utf8");
    await writeFile(sentinel, "keep\n", "utf8");
    await symlink(victim, path.join(cache, "toolchains"));
    expect(await runWojCli(["toolchain", "prune", "--yes"], {
      configStore: new MemoryConfigStore({ "cache-directory": cache }),
      io: io().implementation,
      local: new NodeLocalRuntime(),
    })).toBe(7);
    expect(await readFile(sentinel, "utf8")).toBe("keep\n");
  });

  it("rejects a marked cache beneath a symlinked parent and preserves it", async () => {
    const base = await temporaryDirectory("woj-cache-parent-symlink-");
    const victim = path.join(base, "victim");
    const cache = path.join(victim, "cache");
    const sentinel = path.join(cache, "sentinel.txt");
    await mkdir(cache, { recursive: true });
    await writeFile(path.join(cache, ".woj-cache"), "wasm-oj-cli-cache-v1\n", "utf8");
    await writeFile(sentinel, "keep\n", "utf8");
    await symlink(victim, path.join(base, "parent-link"));
    expect(await runWojCli(["cache", "clear", "--yes"], {
      configStore: new MemoryConfigStore({ "cache-directory": path.join(base, "parent-link", "cache") }),
      io: io().implementation,
      local: new NodeLocalRuntime(),
    })).toBe(7);
    expect(await readFile(sentinel, "utf8")).toBe("keep\n");
  });
});
