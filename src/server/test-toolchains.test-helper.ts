import { statSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { WASM_OJ_CONTRACT_VERSION, WASM_OJ_SCHEMAS } from "../core/contract.ts";
import { LANGUAGES, type ServerToolchainSource, type ToolchainProfile } from "../core/types.ts";
import { PINNED_TOOLCHAIN_ASSET_SHA256 } from "../core/toolchains.ts";

const TEST_LANGUAGES = Object.freeze([...LANGUAGES, "java", "zig"]);
const PROFILES: readonly ToolchainProfile[] = Object.freeze(TEST_LANGUAGES.flatMap((language) => {
  const targets = language === "c" || language === "cpp" ? ["wasip1", "wasix"] as const : ["wasip1"] as const;
  return targets.flatMap((target) => (["debug", "release"] as const).map((optimization) => Object.freeze({
    language,
    target,
    optimization,
  })));
}));

export function testToolchains(
  directory = path.resolve("public/toolchains"),
  inventoryDirectory = directory,
): readonly ServerToolchainSource[] {
  const assets = Object.entries(PINNED_TOOLCHAIN_ASSET_SHA256).map(([assetPath, sha256]) => {
    const filename = path.basename(assetPath);
    return Object.freeze({
      path: assetPath,
      bytes: statSync(path.join(inventoryDirectory, filename)).size,
      sha256,
      exportPath: `./assets/${filename}`,
    });
  });
  return Object.freeze([Object.freeze({
    kind: "server" as const,
    descriptor: Object.freeze({
      schema: WASM_OJ_SCHEMAS.toolchainPackage,
      id: "test-distribution",
      version: "0.0.0-test",
      wasmOjContract: WASM_OJ_CONTRACT_VERSION,
      languages: TEST_LANGUAGES,
      profiles: PROFILES,
      assets: Object.freeze(assets),
    }),
    directory: pathToFileURL(`${directory}${path.sep}`),
  })]);
}
