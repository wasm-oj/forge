import { describe, expect, it } from "vitest";
import { submissionDetailReadable } from "./submissions";

describe("submission detail visibility", () => {
  const owner = "owner-user";

  it("lets an owner read every state and visibility", () => {
    expect(submissionDetailReadable({ user_id: owner, state: "running", visibility: "private" }, owner)).toBe(true);
  });

  it("lets anonymous and non-owners read only completed public results", () => {
    const published = { user_id: owner, state: "completed", visibility: "public" };
    expect(submissionDetailReadable(published)).toBe(true);
    expect(submissionDetailReadable(published, "other-user")).toBe(true);
    expect(submissionDetailReadable({ ...published, visibility: "private" })).toBe(false);
    expect(submissionDetailReadable({ ...published, state: "running" })).toBe(false);
  });
});
