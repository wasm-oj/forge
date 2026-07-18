import { createContext, Script } from "node:vm";
import { describe, expect, it } from "vitest";
import { DEFAULT_DETERMINISM } from "../core/determinism";
import { deterministicEnvironment, quickJsDeterminismPrelude } from "./determinism";

interface ScriptObservations {
  random: number[];
  dates: number[];
  performance: number[];
  bytes: number[];
  uuid: string;
}

function observeScript(seed: number): ScriptObservations {
  let elapsedMs = 0;
  const hostNow = () => {
    const value = DEFAULT_DETERMINISM.realtimeEpochMs + elapsedMs;
    elapsedMs += DEFAULT_DETERMINISM.clockStepNs / 1_000_000;
    return value;
  };
  const hostDateTarget = function HostDate() {};
  Object.setPrototypeOf(hostDateTarget, Date);
  Object.defineProperty(hostDateTarget, "now", { value: hostNow });
  const hostDate = new Proxy(hostDateTarget, {
    apply: () => new Date(hostNow()).toString(),
    construct: (_Target, args) => Reflect.construct(
      Date,
      args.length === 0 ? [hostNow()] : args,
    ),
  });
  const context = createContext({
    Date: hostDate,
    __forge_determinism_seed: () => seed,
    __forge_determinism_epoch_ms: () => DEFAULT_DETERMINISM.realtimeEpochMs,
    __forge_determinism_step_ns: () => DEFAULT_DETERMINISM.clockStepNs,
  });
  const script = new Script(`${quickJsDeterminismPrelude({ ...DEFAULT_DETERMINISM, randomSeed: seed })}
globalThis.__result = {
  random: [Math.random(), Math.random(), Math.random()],
  dates: [Date.now(), new Date().getTime(), Date.now()],
  performance: [performance.now(), performance.now()],
  bytes: Array.from(crypto.getRandomValues(new Uint8Array(8))),
  uuid: crypto.randomUUID(),
};`);
  script.runInContext(context);
  return context.__result as ScriptObservations;
}

describe("runtime determinism adapters", () => {
  it("produces the same JavaScript clock and entropy transcript for the same seed", () => {
    const first = observeScript(42);
    expect(observeScript(42)).toEqual(first);
    expect(observeScript(43).random).not.toEqual(first.random);
    expect(first.dates).toEqual([
      DEFAULT_DETERMINISM.realtimeEpochMs,
      DEFAULT_DETERMINISM.realtimeEpochMs + 1,
      DEFAULT_DETERMINISM.realtimeEpochMs + 2,
    ]);
    expect(first.performance).toEqual([3, 4]);
    expect(first.uuid).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it("pins locale, timezone, Python hashing, clock, and entropy environment", () => {
    expect(deterministicEnvironment({ USER_VALUE: "kept" }, { ...DEFAULT_DETERMINISM, randomSeed: 7 })).toEqual({
      USER_VALUE: "kept",
      FORGE_RANDOM_SEED: "0000000007",
      FORGE_REALTIME_EPOCH_MS: String(DEFAULT_DETERMINISM.realtimeEpochMs).padStart(14, "0"),
      FORGE_CLOCK_STEP_NS: String(DEFAULT_DETERMINISM.clockStepNs).padStart(10, "0"),
      PYTHONHASHSEED: "0",
      TZ: "UTC",
      LC_ALL: "C",
    });
  });

  it("keeps the JavaScript bootstrap source independent of deterministic values", () => {
    const sources = [0, 1, 42, 0x5eed_1234, 0xffff_ffff].map((randomSeed) => (
      quickJsDeterminismPrelude({ ...DEFAULT_DETERMINISM, randomSeed })
    ));
    expect(new Set(sources)).toEqual(new Set([sources[0]]));
    expect(observeScript(0).random).not.toEqual(observeScript(1).random);
  });

  it("does not allow callers to shadow reserved deterministic inputs", () => {
    expect(() => deterministicEnvironment({ TZ: "Asia/Taipei" }, { ...DEFAULT_DETERMINISM })).toThrow("reserved");
  });
});
