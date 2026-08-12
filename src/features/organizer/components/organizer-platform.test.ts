import { describe, expect, it } from "vitest";
import {
  CATALOG_POLL_DELAYS_MS,
  catalogIssueMessage,
  catalogPollDelay,
  contestInviteNeedsSaveConfirmation,
  generateContestInviteCode,
  isTerminalCatalogPublication,
  isTerminalCatalogValidation,
} from "./organizer-platform";

describe("Organizer catalog v2 polling", () => {
  it("backs off 1, 2, 5, then 10 seconds and remains capped", () => {
    expect(CATALOG_POLL_DELAYS_MS).toEqual([1_000, 2_000, 5_000, 10_000]);
    expect([0, 1, 2, 3, 4, 50].map(catalogPollDelay)).toEqual([1_000, 2_000, 5_000, 10_000, 10_000, 10_000]);
    expect(() => catalogPollDelay(-1)).toThrow("non-negative integer");
  });

  it("stops only on canonical validation and publication terminal states", () => {
    expect(isTerminalCatalogValidation("queued")).toBe(false);
    expect(isTerminalCatalogValidation("running")).toBe(false);
    expect(isTerminalCatalogValidation("valid")).toBe(true);
    expect(isTerminalCatalogValidation("invalid")).toBe(true);
    expect(isTerminalCatalogValidation("infrastructure-error")).toBe(true);
    expect(isTerminalCatalogPublication("queued")).toBe(false);
    expect(isTerminalCatalogPublication("materializing")).toBe(false);
    expect(isTerminalCatalogPublication("published")).toBe(true);
    expect(isTerminalCatalogPublication("failed")).toBe(true);
  });

  it("directs validation failures to a new exact-commit validation, not a legacy retry", () => {
    expect(catalogIssueMessage("catalog-contract-invalid")).toContain("validate a new exact commit");
    expect(catalogIssueMessage("catalog-validation-failed")).toContain("Static validation failed");
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

  it("blocks publication until the one-time invite code is explicitly saved", () => {
    expect(contestInviteNeedsSaveConfirmation({ contestId: "contest-1", acknowledged: false }, "contest-1")).toBe(true);
    expect(contestInviteNeedsSaveConfirmation({ contestId: "contest-1", acknowledged: true }, "contest-1")).toBe(false);
    expect(contestInviteNeedsSaveConfirmation({ contestId: "contest-2", acknowledged: false }, "contest-1")).toBe(false);
  });
});
