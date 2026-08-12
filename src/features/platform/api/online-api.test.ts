import { afterEach, describe, expect, it } from "vitest";
import {
  configureWasmOjMaintenanceSmokeToken,
  wasmOjMaintenanceSmokeArmed,
  wasmOjMaintenanceSmokeHeaders,
} from "./online-api";

describe("in-memory maintenance smoke token", () => {
  afterEach(() => configureWasmOjMaintenanceSmokeToken());

  it("is disarmed by default and can be cleared", () => {
    expect(wasmOjMaintenanceSmokeArmed()).toBe(false);
    expect(wasmOjMaintenanceSmokeHeaders()).toEqual({});
    configureWasmOjMaintenanceSmokeToken("x".repeat(32));
    configureWasmOjMaintenanceSmokeToken();
    expect(wasmOjMaintenanceSmokeArmed()).toBe(false);
  });

  it("accepts only bounded printable ASCII and exposes the exact request header", () => {
    const token = "maintenance-smoke-production-token-01";
    configureWasmOjMaintenanceSmokeToken(token);
    expect(wasmOjMaintenanceSmokeArmed()).toBe(true);
    expect(wasmOjMaintenanceSmokeHeaders()).toEqual({
      "x-wasm-oj-maintenance-smoke-token": token,
    });
    expect(() => configureWasmOjMaintenanceSmokeToken("short")).toThrow("32–256");
    expect(() => configureWasmOjMaintenanceSmokeToken(`${"x".repeat(31)}\n`)).toThrow("32–256");
    expect(() => configureWasmOjMaintenanceSmokeToken("x".repeat(257))).toThrow("32–256");
  });
});
