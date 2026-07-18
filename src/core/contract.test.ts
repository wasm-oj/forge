import { describe, expect, it } from "vitest";
import {
  FORGE_CONTRACT_ID,
  FORGE_CONTRACT_VERSION,
  FORGE_SCHEMAS,
  FORGE_STORAGE,
} from "./contract";

describe("Forge contract identity", () => {
  it("derives every production schema from the single contract", () => {
    expect(FORGE_CONTRACT_VERSION).toBe(1);
    expect(FORGE_CONTRACT_ID).toBe("wasm-oj-forge-v1");
    const schemas = Object.values(FORGE_SCHEMAS);
    expect(new Set(schemas).size).toBe(schemas.length);
    expect(schemas.every((schema) => schema.startsWith(`${FORGE_CONTRACT_ID}/`))).toBe(true);
  });

  it("starts browser storage from the same contract boundary", () => {
    expect(FORGE_STORAGE.databaseVersion).toBe(FORGE_CONTRACT_VERSION);
    expect(FORGE_STORAGE.database.startsWith(`${FORGE_CONTRACT_ID}:`)).toBe(true);
    expect(FORGE_STORAGE.runtimeFilesCache.startsWith(`${FORGE_CONTRACT_ID}:`)).toBe(true);
    expect(FORGE_STORAGE.toolchainCache.startsWith(`${FORGE_CONTRACT_ID}:`)).toBe(true);
  });
});
