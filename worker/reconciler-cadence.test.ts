import { describe, expect, it } from "vitest";
import { reconciliationCadence } from "./reconciler";

describe("scheduled reconciliation cadence", () => {
  it("runs only recovery work during an ordinary minute", () => {
    expect(reconciliationCadence(new Date("2026-08-11T12:34:00.000Z"))).toEqual({
      hourlyCleanup: false,
      dailyCleanup: false,
    });
  });

  it("adds lightweight cleanup at the start of each UTC hour", () => {
    expect(reconciliationCadence(new Date("2026-08-11T12:00:00.000Z"))).toEqual({
      hourlyCleanup: true,
      dailyCleanup: false,
    });
  });

  it("adds retention and object GC once per UTC day", () => {
    expect(reconciliationCadence(new Date("2026-08-12T00:00:00.000Z"))).toEqual({
      hourlyCleanup: true,
      dailyCleanup: true,
    });
  });
});
