import { describe, expect, it } from "vitest";
import { collectionPublicationMessage } from "./organizer-platform";

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
