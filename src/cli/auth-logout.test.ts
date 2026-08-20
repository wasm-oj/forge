import { describe, expect, it, vi } from "vitest";
import { MemoryConfigStore } from "./config";
import { CliError, unavailableError } from "./errors";
import { ApiError, type RemoteClient } from "./http";
import { runWojCli, type CliIo } from "./index";
import type { TokenStore } from "./keychain";

const ORIGIN = "https://judge.example";
const TOKEN = "t".repeat(43);

class StateTokenStore implements TokenStore {
  token: string | undefined;
  failDelete = false;
  readonly delete = vi.fn(async () => {
    if (this.failDelete) throw new CliError("keychain delete failed", { exitCode: 7, code: "keychain-delete-failed" });
    this.token = undefined;
  });

  constructor(token?: string) { this.token = token; }
  get(): Promise<string | undefined> { return Promise.resolve(this.token); }
  set(_origin: string, token: string): Promise<void> { this.token = token; return Promise.resolve(); }
}

function capturedIo(): { readonly io: CliIo; readonly stderr: string[] } {
  const stderr: string[] = [];
  return { io: { stdout: () => undefined, stderr: (value) => stderr.push(value) }, stderr };
}

function dependencies(tokenStore: TokenStore, request: RemoteClient["request"], io: CliIo) {
  return {
    configStore: new MemoryConfigStore({ server: ORIGIN }),
    tokenStore,
    remote: () => ({ origin: ORIGIN, request, requestBytes: vi.fn() }) satisfies RemoteClient,
    io,
  };
}

describe("woj auth logout credential lifecycle", () => {
  it("succeeds without constructing a request when no local credential exists", async () => {
    const store = new StateTokenStore();
    const request = vi.fn(async () => ({ ok: true }));
    expect(await runWojCli(["auth", "logout"], dependencies(store, request, capturedIo().io))).toBe(0);
    expect(request).not.toHaveBeenCalled();
    expect(store.delete).not.toHaveBeenCalled();
  });

  it("deletes the local credential only after an exact successful response", async () => {
    const store = new StateTokenStore(TOKEN);
    const request = vi.fn(async () => ({ ok: true }));
    expect(await runWojCli(["auth", "logout"], dependencies(store, request, capturedIo().io))).toBe(0);
    expect(store.token).toBeUndefined();
    expect(store.delete).toHaveBeenCalledOnce();
  });

  it("treats the canonical invalid-or-expired bearer response as successful local cleanup", async () => {
    const store = new StateTokenStore(TOKEN);
    const request = vi.fn(async () => { throw new ApiError(401, "authentication-required", "expired"); });
    expect(await runWojCli(["auth", "logout"], dependencies(store, request, capturedIo().io))).toBe(0);
    expect(store.token).toBeUndefined();
  });

  it.each([
    ["network failure", async () => { throw unavailableError("network failed"); }],
    ["malformed success", async () => ({ okay: true })],
    ["server failure", async () => { throw new ApiError(503, "unavailable", "server failed"); }],
    ["other rejection", async () => { throw new ApiError(409, "logout-conflict", "conflict"); }],
  ])("retains the local credential after %s", async (_label, implementation) => {
    const store = new StateTokenStore(TOKEN);
    const request = vi.fn(implementation);
    expect(await runWojCli(["auth", "logout"], dependencies(store, request, capturedIo().io))).not.toBe(0);
    expect(store.token).toBe(TOKEN);
    expect(store.delete).not.toHaveBeenCalled();
  });

  it("surfaces keychain deletion failure and completes cleanup on a retry that receives 401", async () => {
    const store = new StateTokenStore(TOKEN);
    store.failDelete = true;
    const request = vi.fn<RemoteClient["request"]>()
      .mockResolvedValueOnce({ ok: true })
      .mockRejectedValueOnce(new ApiError(401, "authentication-required", "already revoked"));
    expect(await runWojCli(["auth", "logout"], dependencies(store, request, capturedIo().io))).toBe(7);
    expect(store.token).toBe(TOKEN);
    store.failDelete = false;
    expect(await runWojCli(["auth", "logout"], dependencies(store, request, capturedIo().io))).toBe(0);
    expect(store.token).toBeUndefined();
    expect(request).toHaveBeenCalledTimes(2);
  });
});
