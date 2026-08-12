import { describe, expect, it } from "vitest";
import { WASM_OJ_CONTRACT_VERSION, WASM_OJ_SCHEMAS } from "./contract";
import {
  browserToolchainAssetUrl,
  snapshotBrowserToolchainSources,
  toolchainAssetSource,
  toolchainProfileSource,
  validateBrowserToolchainSources,
  validateServerToolchainSources,
  validateToolchainDescriptors,
} from "./toolchain-sources";
import { QUICKJS_ASSET_PATH, QUICKJS_ASSET_SHA256 } from "./toolchains";
import type {
  BrowserToolchainSource,
  ServerToolchainSource,
  ToolchainDescriptor,
} from "./types";

describe("explicit toolchain sources", () => {
  it("validates and snapshots a strict contract-v2 browser source", () => {
    const source = browserSource();
    const input = [source];
    expect(validateBrowserToolchainSources(input)).toBe(input);

    const snapshot = snapshotBrowserToolchainSources(input);
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot[0])).toBe(true);
    expect(Object.isFrozen(snapshot[0]!.descriptor.assets)).toBe(true);
    expect(snapshot).not.toBe(input);
    expect(snapshot[0]).not.toBe(source);
  });

  it("resolves the unique source, profile, and digest-addressed browser URL", () => {
    const sources = [browserSource("https://cdn.example.invalid/runtime/?tenant=judge")];
    expect(toolchainAssetSource(sources, QUICKJS_ASSET_PATH).source).toBe(sources[0]);
    expect(toolchainProfileSource(sources, "javascript", "wasip1", "release").source).toBe(sources[0]);
    expect(browserToolchainAssetUrl(sources, QUICKJS_ASSET_PATH, "https://app.example.invalid/").href).toBe(
      `https://cdn.example.invalid/runtime/quickjs-0.15.1.wasm.gz.bin?tenant=judge&sha256=${QUICKJS_ASSET_SHA256}`,
    );
  });

  it("rejects stale contracts, malformed profiles, and conflicting ownership", () => {
    const stale = browserSource();
    stale.descriptor = {
      ...stale.descriptor,
      wasmOjContract: 1 as typeof WASM_OJ_CONTRACT_VERSION,
    };
    expect(() => validateBrowserToolchainSources([stale])).toThrow("contract '1' is unsupported");

    const malformed = browserSource();
    malformed.descriptor = {
      ...malformed.descriptor,
      profiles: [{ language: "python", target: "wasip1", optimization: "release" }],
    };
    expect(() => validateBrowserToolchainSources([malformed])).toThrow("undeclared language 'python'");

    const duplicate = browserSource("/other/");
    duplicate.descriptor = { ...duplicate.descriptor, id: "other" };
    expect(() => validateBrowserToolchainSources([browserSource(), duplicate])).toThrow(
      "language 'javascript' is owned by more than one descriptor",
    );
  });

  it("rejects undeclared assets and a descriptor that contradicts a WASM-OJ digest pin", () => {
    const source = browserSource();
    expect(() => toolchainAssetSource([source], "/toolchains/missing.bin")).toThrow(
      "No explicit toolchain source",
    );
    source.descriptor = {
      ...source.descriptor,
      assets: [{ ...source.descriptor.assets[0]!, sha256: "0".repeat(64) }],
    };
    expect(() => validateBrowserToolchainSources([source])).toThrow("does not match the WASM-OJ pin");
  });

  it("keeps browser and server host source shapes disjoint", () => {
    const server: ServerToolchainSource = {
      kind: "server",
      directory: new URL("file:///opt/wasm-oj/toolchains/"),
      descriptor: descriptor(),
    };
    expect(validateServerToolchainSources([server])).toEqual([server]);
    expect(() => validateToolchainDescriptors([
      browserSource(),
      server,
    ] as Array<BrowserToolchainSource | ServerToolchainSource>)).toThrow("expected 'browser'");

    const remoteServer = { ...server, directory: new URL("https://cdn.example.invalid/") };
    expect(() => validateServerToolchainSources([remoteServer])).toThrow("file: protocol");
    expect(() => validateBrowserToolchainSources([browserSource("relative/")])).toThrow(
      "must be absolute or root-relative",
    );
  });
});

function browserSource(baseUrl = "/toolchains/"): BrowserToolchainSource {
  return { kind: "browser", baseUrl, descriptor: descriptor() };
}

function descriptor(): ToolchainDescriptor {
  return {
    schema: WASM_OJ_SCHEMAS.toolchainPackage,
    id: "javascript",
    version: "1.0.0",
    wasmOjContract: WASM_OJ_CONTRACT_VERSION,
    languages: ["javascript"],
    profiles: [{ language: "javascript", target: "wasip1", optimization: "release" }],
    assets: [{
      path: QUICKJS_ASSET_PATH,
      bytes: 1,
      sha256: QUICKJS_ASSET_SHA256,
      exportPath: "./assets/quickjs-0.15.1.wasm.gz.bin",
    }],
  };
}
