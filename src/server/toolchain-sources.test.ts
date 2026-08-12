import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { WASM_OJ_CONTRACT_VERSION, WASM_OJ_SCHEMAS } from "../core/contract.ts";
import {
  QUICKJS_ASSET_PATH,
  QUICKJS_ASSET_SHA256,
  TYPESCRIPT_ASSET_PATH,
  TYPESCRIPT_ASSET_SHA256,
} from "../core/toolchains.ts";
import type { Language, ServerToolchainSource } from "../core/types.ts";
import {
  deserializeServerToolchainSources,
  serializeServerToolchainSources,
  serverToolchainAssetFile,
  snapshotServerToolchainSources,
} from "./toolchain-sources.ts";

describe("server toolchain source routing", () => {
  it("resolves each asset from the package that declares it", () => {
    const root = path.resolve("separate-toolchain-packages");
    const javascript = source(root, "javascript", "javascript", QUICKJS_ASSET_PATH, QUICKJS_ASSET_SHA256);
    const typescript = source(root, "typescript", "typescript", TYPESCRIPT_ASSET_PATH, TYPESCRIPT_ASSET_SHA256);
    const sources = snapshotServerToolchainSources([javascript, typescript]);

    expect(serverToolchainAssetFile(sources, QUICKJS_ASSET_PATH)).toBe(
      path.join(root, "javascript", path.basename(QUICKJS_ASSET_PATH)),
    );
    expect(serverToolchainAssetFile(sources, TYPESCRIPT_ASSET_PATH)).toBe(
      path.join(root, "typescript", path.basename(TYPESCRIPT_ASSET_PATH)),
    );
    expect(() => serverToolchainAssetFile(sources, "/toolchains/undeclared.bin")).toThrow(
      "No explicit toolchain source declares asset",
    );
  });

  it("round-trips URL-backed sources across the isolated-process wire", () => {
    const sourceValue = source(
      path.resolve("isolated-toolchain-package"),
      "javascript",
      "javascript",
      QUICKJS_ASSET_PATH,
      QUICKJS_ASSET_SHA256,
    );
    const decoded = deserializeServerToolchainSources(serializeServerToolchainSources([sourceValue]));

    expect(decoded[0]?.directory).toBeInstanceOf(URL);
    expect(decoded[0]?.directory.href).toBe(sourceValue.directory.href);
    expect(decoded[0]?.descriptor).toEqual(sourceValue.descriptor);
  });
});

function source(
  root: string,
  id: string,
  language: Language,
  assetPath: string,
  sha256: string,
): ServerToolchainSource {
  const directory = path.join(root, id);
  return {
    kind: "server",
    descriptor: {
      schema: WASM_OJ_SCHEMAS.toolchainPackage,
      id,
      version: "1.0.0-test",
      wasmOjContract: WASM_OJ_CONTRACT_VERSION,
      languages: [language],
      profiles: [{ language, target: "wasip1", optimization: "release" }],
      assets: [{
        path: assetPath,
        bytes: 1,
        sha256,
        exportPath: `./assets/${path.basename(assetPath)}`,
      }],
    },
    directory: pathToFileURL(`${directory}${path.sep}`),
  };
}
