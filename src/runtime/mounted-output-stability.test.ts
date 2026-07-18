import { describe, expect, it } from "vitest";
import { MountedOutputStabilityObserver } from "./mounted-output-stability";

describe("MountedOutputStabilityObserver", () => {
  it("returns a later copy only after identical bytes span the full interval", () => {
    const observer = new MountedOutputStabilityObserver(75);
    const initial = Uint8Array.of(0, 97, 115, 109, 1);

    expect(observer.observe(initial, 100)).toBeUndefined();
    expect(observer.observe(initial.slice(), 174.9)).toBeUndefined();
    const acceptedSnapshot = initial.slice();
    const result = observer.observe(acceptedSnapshot, 175);

    expect(result).toEqual(initial);
    expect(result).not.toBe(initial);
    expect(result).not.toBe(acceptedSnapshot);
  });

  it("restarts the interval when the mounted bytes change", () => {
    const observer = new MountedOutputStabilityObserver(50);

    expect(observer.observe(Uint8Array.of(1, 2), 0)).toBeUndefined();
    expect(observer.observe(Uint8Array.of(1, 2, 3), 50)).toBeUndefined();
    expect(observer.observe(Uint8Array.of(1, 2, 3), 99)).toBeUndefined();
    expect(observer.observe(Uint8Array.of(1, 2, 3), 100)).toEqual(Uint8Array.of(1, 2, 3));
  });

  it("restarts the interval after a missing or unreadable snapshot", () => {
    const observer = new MountedOutputStabilityObserver(25);

    expect(observer.observe(Uint8Array.of(1), 0)).toBeUndefined();
    expect(observer.observe(undefined, 25)).toBeUndefined();
    expect(observer.observe(Uint8Array.of(1), 26)).toBeUndefined();
    expect(observer.observe(Uint8Array.of(1), 51)).toEqual(Uint8Array.of(1));
  });

  it("rejects invalid intervals and timestamps", () => {
    expect(() => new MountedOutputStabilityObserver(0)).toThrow(/positive and finite/);
    const observer = new MountedOutputStabilityObserver();
    expect(() => observer.observe(Uint8Array.of(1), Number.NaN)).toThrow(/time must be finite/);
  });
});
