import { describe, expect, it } from "vitest";
import { resolveRequestOrigin } from "./request-origin";

describe("request metadata origin", () => {
  it.each([
    ["localhost:4173", "http://localhost:4173/"],
    ["127.0.0.1:4173", "http://127.0.0.1:4173/"],
    ["127.42.0.8:4173", "http://127.42.0.8:4173/"],
    ["[::1]:4173", "http://[::1]:4173/"],
    ["wasm-oj.example", "https://wasm-oj.example/"],
  ])("uses the correct direct protocol for %s", (host, expected) => {
    expect(resolveRequestOrigin({ forwardedHost: null, forwardedProtocol: null, host }).toString()).toBe(expected);
  });

  it("honors validated proxy origin headers", () => {
    expect(resolveRequestOrigin({
      forwardedHost: "wasm-oj.example, internal.invalid",
      forwardedProtocol: "https, http",
      host: "127.0.0.1:4173",
    }).toString()).toBe("https://wasm-oj.example/");
  });

  it.each([
    { forwardedHost: null, forwardedProtocol: null, host: null },
    { forwardedHost: "wasm-oj.example/path", forwardedProtocol: "https", host: "internal" },
    { forwardedHost: "wasm-oj.example", forwardedProtocol: "ftp", host: "internal" },
  ])("rejects missing or invalid origin metadata", (headers) => {
    expect(() => resolveRequestOrigin(headers)).toThrow(/request/i);
  });
});
