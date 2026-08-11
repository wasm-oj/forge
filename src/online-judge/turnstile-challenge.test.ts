import { describe, expect, it } from "vitest";
import { turnstileChallengeResponse } from "../../worker/turnstile-challenge";
import type { ForgeWorkerEnv } from "../../worker/env";

const env = {
  PUBLIC_ORIGIN: "https://app-staging.example.test",
  TURNSTILE_SITE_KEY: "site-key",
} as ForgeWorkerEnv;

describe("same-origin Turnstile challenge route", () => {
  it("renders only a nonce-bound, action-bound no-store challenge", async () => {
    const response = turnstileChallengeResponse(new Request(
      "https://app-staging.example.test/turnstile/challenge?action=official-submit&nonce=01988dc1-5c00-7000-8000-000000000000",
    ), env);
    const body = await response.text();
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(response.headers.get("content-security-policy")).toContain("'strict-dynamic'");
    expect(response.headers.get("content-security-policy")).toContain("frame-ancestors 'self'");
    expect(response.headers.get("cross-origin-embedder-policy")).toBe("require-corp");
    expect(response.headers.get("cross-origin-resource-policy")).toBe("same-origin");
    expect(response.headers.has("x-frame-options")).toBe(false);
    expect(body).toContain("https://challenges.cloudflare.com/turnstile/v0/api.js");
    expect(body).toContain('data-action="official-submit"');
    expect(body).toContain("https://app-staging.example.test");
    expect(body).not.toContain("siteverify");
  });

  it("rejects unknown parameters, actions, and a different origin", () => {
    const nonce = "01988dc1-5c00-7000-8000-000000000000";
    expect(turnstileChallengeResponse(new Request(`https://app-staging.example.test/turnstile/challenge?action=unknown&nonce=${nonce}`), env).status).toBe(400);
    expect(turnstileChallengeResponse(new Request(`https://app-staging.example.test/turnstile/challenge?action=official-submit&nonce=${nonce}&next=x`), env).status).toBe(404);
    expect(turnstileChallengeResponse(new Request(`https://other.example.test/turnstile/challenge?action=official-submit&nonce=${nonce}`), env).status).toBe(500);
  });
});
