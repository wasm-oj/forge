import { describe, expect, it } from "vitest";
import { retentionIsDue } from "./reconciler";

describe("elapsed-time reconciliation cadence", () => {
  const now = new Date("2026-08-12T12:34:00.000Z");

  it("does not depend on a wall-clock hour or UTC midnight", () => {
    expect(retentionIsDue("2026-08-12T11:33:59.999Z", null, now)).toBe(true);
    expect(retentionIsDue("2026-08-12T11:34:00.001Z", null, now)).toBe(false);
  });

  it("starts a maintenance class that has never completed", () => {
    expect(retentionIsDue(null, null, now)).toBe(true);
  });

  it("continues a paginated pass without waiting for the next interval", () => {
    expect(retentionIsDue("2026-08-12T12:33:59.999Z", "next-page", now)).toBe(true);
  });

  it("rejects a corrupt durable completion timestamp", () => {
    expect(() => retentionIsDue("not-a-time", null, now)).toThrow(TypeError);
  });
});
