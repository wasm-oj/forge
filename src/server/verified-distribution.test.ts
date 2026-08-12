import path from "node:path";
import { describe, expect, it } from "vitest";
import { PINNED_TOOLCHAIN_ASSET_SHA256 } from "../core/toolchains";
import { ServerCompiler } from "./server-compiler";
import {
  assertVerifiedServerDistribution,
  assertVerifiedToolchainDistribution,
  createVerifiedServerDistribution,
} from "./verified-distribution";
import { testToolchains } from "./test-toolchains.test-helper";

function evidence() {
  return {
    compilerExecutable: "/app/runtime/wasm-oj-compiler",
    compilerSha256: "1".repeat(64),
    runtimeExecutable: "/app/runtime/wasm-oj-runner",
    runnerSha256: "2".repeat(64),
    toolchains: testToolchains("/app/public/toolchains", path.resolve("public/toolchains")),
    toolchainRootSha256: "3".repeat(64),
    toolchainAssets: { ...PINNED_TOOLCHAIN_ASSET_SHA256 },
  };
}

describe("verified server distribution capability", () => {
  it("binds a process-local token to exact executable and toolchain paths", () => {
    const token = createVerifiedServerDistribution(evidence());
    const validEvidence = evidence();

    expect(() => assertVerifiedServerDistribution(token, validEvidence, validEvidence.toolchains)).not.toThrow();
    expect(() => assertVerifiedToolchainDistribution(token, validEvidence.toolchains)).not.toThrow();
    const replaced = testToolchains("/tmp/replaced-toolchains", path.resolve("public/toolchains"));
    expect(() => assertVerifiedServerDistribution(token, validEvidence, replaced)).toThrow("does not authorize");
  });

  it("rejects structurally similar objects and incomplete pinned inventories", () => {
    const validEvidence = evidence();
    expect(() => assertVerifiedServerDistribution(Object.freeze({
      compilerExecutable: validEvidence.compilerExecutable,
      runtimeExecutable: validEvidence.runtimeExecutable,
      toolchainAssetFiles: Object.fromEntries(validEvidence.toolchains.flatMap((source) => (
        source.descriptor.assets.map((asset) => [asset.path, path.join("/app/public/toolchains", path.basename(asset.path))])
      ))),
      toolchainRootSha256: validEvidence.toolchainRootSha256,
    }), validEvidence, validEvidence.toolchains)).toThrow("does not authorize");

    const [missing] = Object.keys(validEvidence.toolchainAssets);
    delete validEvidence.toolchainAssets[missing];
    expect(() => createVerifiedServerDistribution(validEvidence)).toThrow("does not exactly match");
  });

  it("does not let ordinary compiler callers fabricate isolated-stage inheritance", () => {
    expect(() => new ServerCompiler({
      compilerExecutable: "/app/runtime/wasm-oj-compiler",
      toolchains: evidence().toolchains,
      verifiedToolchain: true,
    })).toThrow("reserved for the isolated compiler stage");
  });
});
