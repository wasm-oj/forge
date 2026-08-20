import { describe, expect, it, vi } from "vitest";
import { deviceLogin } from "./auth";
import type { RemoteClient } from "./http";
import { MemoryTokenStore } from "./keychain";

const ORIGIN = "https://judge.example";
const FLOW_ID = "11111111-1111-4111-8111-111111111111";

describe("woj browser authentication URL fence", () => {
  it.each([
    ["cross-origin URL", `https://attacker.example/auth/cli?flow=${FLOW_ID}`],
    ["mismatched flow binding", `${ORIGIN}/auth/cli?flow=22222222-2222-4222-8222-222222222222`],
  ])("rejects a %s before opening a browser or polling", async (_label, verificationUrl) => {
    const request = vi.fn(async () => ({
      flowId: FLOW_ID,
      verificationUrl,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      pollIntervalSeconds: 2,
    }));
    const client = { origin: ORIGIN, request, requestBytes: vi.fn() } satisfies RemoteClient;
    const tokens = new MemoryTokenStore();
    const open = vi.fn(async () => undefined);

    await expect(deviceLogin(client, tokens, { open }, {
      deviceName: "test",
      onVerification: vi.fn(),
      sleep: async () => undefined,
    })).rejects.toMatchObject({ exitCode: 6, code: "verification-url-invalid" });
    expect(request).toHaveBeenCalledOnce();
    expect(open).not.toHaveBeenCalled();
    expect(await tokens.get(ORIGIN)).toBeUndefined();
  });
});
