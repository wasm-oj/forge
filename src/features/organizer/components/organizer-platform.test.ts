import { describe, expect, it } from "vitest";
import {
  CATALOG_POLL_DELAYS_MS,
  catalogIssueMessage,
  catalogPollDelay,
  generateContestInviteCode,
  isTerminalCatalogSync,
} from "./organizer-platform";

describe("Organizer repository sync polling", () => {
  it("backs off 1, 2, 5, then 10 seconds and remains capped", () => {
    expect(CATALOG_POLL_DELAYS_MS).toEqual([1_000, 2_000, 5_000, 10_000]);
    expect([0, 1, 2, 3, 4, 50].map(catalogPollDelay)).toEqual([1_000, 2_000, 5_000, 10_000, 10_000, 10_000]);
    expect(() => catalogPollDelay(-1)).toThrow("non-negative integer");
  });

  it("stops only on sync terminal states", () => {
    expect(isTerminalCatalogSync("queued")).toBe(false);
    expect(isTerminalCatalogSync("running")).toBe(false);
    expect(isTerminalCatalogSync("succeeded")).toBe(true);
    expect(isTerminalCatalogSync("failed")).toBe(true);
  });

  it("reports fail-closed exact-commit failures", () => {
    expect(catalogIssueMessage("catalog-contract-invalid")).toContain("Repository schema");
    expect(catalogIssueMessage("github-content-unavailable")).toContain("active commit was not changed");
    expect(catalogIssueMessage("unknown-code")).toBe("unknown-code");
  });
});

describe("Organizer one-time contest secrets", () => {
  it("generates a copyable invite code from explicit entropy", () => {
    expect(generateContestInviteCode()).toHaveLength(48);
    expect(generateContestInviteCode(Uint8Array.from({ length: 16 }, (_, index) => index)))
      .toBe("000102030405060708090a0b0c0d0e0f");
    expect(() => generateContestInviteCode(new Uint8Array(15))).toThrow("at least 16 bytes");
  });
});
