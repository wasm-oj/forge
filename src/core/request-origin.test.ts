import { describe, expect, it } from "vitest";
import { resolveRequestOrigin } from "./request-origin";

describe("request metadata origin", () => {
  it.each([
    ["localhost:4173", "http://localhost:4173/"],
    ["127.0.0.1:4173", "http://127.0.0.1:4173/"],
    ["127.42.0.8:4173", "http://127.42.0.8:4173/"],
    ["[::1]:4173", "http://[::1]:4173/"],
    ["forge.example", "https://forge.example/"],
  ])("uses the correct direct protocol for %s", (host, expected) => {
    expect(resolveRequestOrigin({ forwardedHost: null, forwardedProtocol: null, host }).toString()).toBe(expected);
  });

  it("honors validated proxy origin headers", () => {
    expect(resolveRequestOrigin({
      forwardedHost: "forge.example, internal.invalid",
      forwardedProtocol: "https, http",
      host: "127.0.0.1:4173",
    }).toString()).toBe("https://forge.example/");
  });

  it.each([
    { forwardedHost: null, forwardedProtocol: null, host: null },
    { forwardedHost: "forge.example/path", forwardedProtocol: "https", host: "internal" },
    { forwardedHost: "forge.example", forwardedProtocol: "ftp", host: "internal" },
  ])("rejects missing or invalid origin metadata", (headers) => {
    expect(() => resolveRequestOrigin(headers)).toThrow(/request/i);
  });
});
