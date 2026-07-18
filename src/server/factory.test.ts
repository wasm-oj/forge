import path from "node:path";
import { describe, expect, it } from "vitest";
import { createServerForge, resolveServerForgePaths } from "./factory";

describe("server Forge factory", () => {
  it("resolves a complete package-relative one-line configuration", () => {
    const paths = resolveServerForgePaths();

    expect(paths.compilerExecutable).toBe(path.join(
      paths.packageRoot,
      "crates",
      "runtime-core",
      "target",
      "release",
      process.platform === "win32" ? "forge-compiler.exe" : "forge-compiler",
    ));
    expect(paths.runtimeExecutable).toContain("forge-runner");
    expect(paths.toolchainDirectory).toBe(path.join(paths.packageRoot, "public", "toolchains"));
    expect(path.isAbsolute(paths.cacheDirectory)).toBe(true);
  });

  it("reports missing provisioned binaries through the stable initialization error", async () => {
    await expect(createServerForge({
      runtimeDirectory: path.join(process.cwd(), "does-not-exist"),
    })).rejects.toMatchObject({
      code: "initialization-failure",
      stage: "initialize",
      retryable: false,
    });
  });
});
