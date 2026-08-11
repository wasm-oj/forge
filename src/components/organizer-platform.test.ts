import { describe, expect, it } from "vitest";
import { collectionImportIssueMessage, collectionPublicationMessage, contestInviteNeedsSaveConfirmation, generateContestInviteCode } from "./organizer-platform";

describe("Organizer collection publication response", () => {
  it("handles an idempotent publication replay without assuming a problems array", () => {
    expect(collectionPublicationMessage({
      snapshotId: "018f0d8a-7110-7cc8-9f08-15b28df8307b",
      status: "published",
      replayed: true,
    }, "official-practice")).toBe("Collection was already published as official-practice.");
  });

  it("reports the problem count for a new publication", () => {
    expect(collectionPublicationMessage({
      snapshotId: "018f0d8a-7110-7cc8-9f08-15b28df8307b",
      status: "published",
      replayed: false,
      problems: [{ id: "problem-1" }, { id: "problem-2" }],
    }, "contest")).toBe("Published 2 problems as contest.");
  });

  it("rejects a fresh publication that omits its problem list", () => {
    expect(() => collectionPublicationMessage({
      snapshotId: "018f0d8a-7110-7cc8-9f08-15b28df8307b",
      status: "published",
      replayed: false,
    }, "official-practice")).toThrow("missing its problems");
  });
});

describe("Organizer recovery copy", () => {
  it("distinguishes retryable infrastructure failures from invalid collections", () => {
    expect(collectionImportIssueMessage("validation-workflow-errored")).toContain("retry this exact commit");
    expect(collectionImportIssueMessage("validation-failed")).toContain("Fix it in the repository");
  });

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
