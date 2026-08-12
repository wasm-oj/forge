import { describe, expect, it } from "vitest";
import { parseTurnstileMessage } from "./client";

describe("Turnstile client boundary", () => {
  it("binds a token to its action and nonce", () => {
    const nonce = "01988dc1-5c00-7000-8000-000000000000";
    expect(parseTurnstileMessage({
      type: "wasm-oj-platform/turnstile/v1",
      action: "official-submit",
      nonce,
      token: "verified-token",
    }, "official-submit", nonce)).toMatchObject({ token: "verified-token" });
    expect(parseTurnstileMessage({
      type: "wasm-oj-platform/turnstile/v1",
      action: "organizer-application",
      nonce,
      token: "verified-token",
    }, "official-submit", nonce)).toBeUndefined();
    expect(parseTurnstileMessage({
      type: "wasm-oj-platform/turnstile/v1",
      action: "official-submit",
      nonce: "01988dc1-5c00-7000-8000-000000000001",
      token: "verified-token",
    }, "official-submit", nonce)).toBeUndefined();
  });

  it("rejects malformed tokens and accepts only stable failure codes", () => {
    const nonce = "01988dc1-5c00-7000-8000-000000000000";
    expect(parseTurnstileMessage({ type: "wasm-oj-platform/turnstile/v1", action: "official-submit", nonce, token: "bad token" }, "official-submit", nonce)).toBeUndefined();
    expect(parseTurnstileMessage({ type: "wasm-oj-platform/turnstile-error/v1", action: "official-submit", nonce, code: "internal-details" }, "official-submit", nonce)).toBeUndefined();
    expect(parseTurnstileMessage({ type: "wasm-oj-platform/turnstile-error/v1", action: "official-submit", nonce, code: "turnstile-expired" }, "official-submit", nonce)).toMatchObject({ code: "turnstile-expired" });
  });
});
