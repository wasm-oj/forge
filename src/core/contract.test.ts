import { describe, expect, it } from "vitest";
import {
  WASM_OJ_CONTRACT_ID,
  WASM_OJ_CONTRACT_VERSION,
  WASM_OJ_SCHEMAS,
  WASM_OJ_STORAGE,
} from "./contract";

describe("WASM-OJ contract identity", () => {
  it("derives every production schema from the single contract", () => {
    expect(WASM_OJ_CONTRACT_VERSION).toBe(2);
    expect(WASM_OJ_CONTRACT_ID).toBe("wasm-oj-v2");
    const schemas = Object.values(WASM_OJ_SCHEMAS);
    expect(new Set(schemas).size).toBe(schemas.length);
    expect(schemas.every((schema) => schema.startsWith(`${WASM_OJ_CONTRACT_ID}/`))).toBe(true);
  });

  it("starts browser storage from the same contract boundary", () => {
    expect(WASM_OJ_STORAGE.databaseVersion).toBe(WASM_OJ_CONTRACT_VERSION);
    expect(WASM_OJ_STORAGE.database.startsWith(`${WASM_OJ_CONTRACT_ID}:`)).toBe(true);
    expect(WASM_OJ_STORAGE.runtimeFilesCache.startsWith(`${WASM_OJ_CONTRACT_ID}:`)).toBe(true);
    expect(WASM_OJ_STORAGE.toolchainCache.startsWith(`${WASM_OJ_CONTRACT_ID}:`)).toBe(true);
  });
});
