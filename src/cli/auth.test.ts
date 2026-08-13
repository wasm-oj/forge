import { describe, expect, it, vi } from "vitest";
import { deviceLogin } from "./auth";
import { ApiError, type RemoteClient } from "./http";
import { MemoryTokenStore } from "./keychain";

describe("woj browser device login", () => {
  it("uses the exact PKCE request shape and stores only the exchanged bearer in keychain", async () => {
    const expiresAt = new Date(Date.now() + 60_000).toISOString();
    const accessToken = "s".repeat(43);
    const requests: Array<{ path: string; body: unknown }> = [];
    let polls = 0;
    const client: RemoteClient = {
      origin: "https://judge.example",
      requestBytes: vi.fn(),
      async request(path, options) {
        requests.push({ path, body: options?.body });
        if (path.endsWith("/start")) return { flowId: "11111111-1111-4111-8111-111111111111", verificationUrl: "https://judge.example/auth/cli?flow=11111111-1111-4111-8111-111111111111", expiresAt, pollIntervalSeconds: 2 };
        polls += 1;
        if (polls === 1) throw new ApiError(428, "cli-login-pending", "pending", { retryAfterSeconds: 2 });
        return { accessToken, tokenType: "Bearer", expiresAt };
      },
    };
    const tokens = new MemoryTokenStore();
    const open = vi.fn(async () => undefined);
    const result = await deviceLogin(client, tokens, { open }, { deviceName: "test", onVerification: vi.fn(), sleep: async () => undefined });
    expect(requests[0]?.path).toBe("/api/auth/cli/start");
    expect(requests[0]?.body).toEqual({ codeChallenge: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/), deviceName: "test" });
    const exchange = requests[1]?.body as Record<string, unknown>;
    expect(exchange).toEqual({ flowId: "11111111-1111-4111-8111-111111111111", codeVerifier: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/) });
    expect(await tokens.get(client.origin)).toBe(accessToken);
    expect(result).toEqual({ authenticated: true, server: client.origin, expiresAt });
    expect(JSON.stringify(result)).not.toContain(accessToken);
    expect(open).toHaveBeenCalledWith("https://judge.example/auth/cli?flow=11111111-1111-4111-8111-111111111111");
  });

  it("rejects a malformed server token before storing it", async () => {
    const expiresAt = new Date(Date.now() + 60_000).toISOString();
    const client: RemoteClient = {
      origin: "https://judge.example",
      requestBytes: vi.fn(),
      request: vi.fn(async (path) => path.endsWith("/start")
        ? { flowId: "11111111-1111-4111-8111-111111111111", verificationUrl: "https://judge.example/auth/cli?flow=11111111-1111-4111-8111-111111111111", expiresAt, pollIntervalSeconds: 2 }
        : { accessToken: "malformed-secret", tokenType: "Bearer", expiresAt }),
    };
    const tokens = new MemoryTokenStore();
    await expect(deviceLogin(client, tokens, { open: async () => undefined }, {
      deviceName: "test",
      onVerification: vi.fn(),
      sleep: async () => undefined,
    })).rejects.toMatchObject({ exitCode: 6, code: "server-response-invalid" });
    expect(await tokens.get(client.origin)).toBeUndefined();
  });
});
