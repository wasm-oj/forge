import { describe, expect, it } from "vitest";
import { contestPhase } from "./product";

const NOW = new Date("2026-08-11T12:00:00.000Z");

describe("contest phase", () => {
  it("derives upcoming, running, and ended from the schedule", () => {
    expect(contestPhase("2026-08-11T12:00:01.000Z", "2026-08-11T13:00:00.000Z", NOW)).toBe("upcoming");
    expect(contestPhase("2026-08-11T12:00:00.000Z", "2026-08-11T13:00:00.000Z", NOW)).toBe("running");
    expect(contestPhase("2026-08-11T11:00:00.000Z", "2026-08-11T12:00:00.000Z", NOW)).toBe("ended");
  });
});
