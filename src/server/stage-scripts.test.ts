import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import {
  resolveServerStageDirectory,
  serverStageScript,
} from "./stage-scripts";

describe("server stage package layout", () => {
  it("resolves the exact source and bundled package anchors", () => {
    expect(resolveServerStageDirectory(fileUrl("/repo/src/server/stage-scripts.ts")))
      .toBe(path.resolve("/repo/src/server"));
    expect(resolveServerStageDirectory(fileUrl("/unpacked/package/dist/index.js")))
      .toBe(path.resolve("/unpacked/package/dist"));
    expect(resolveServerStageDirectory(fileUrl("/unpacked/package/dist/server-build-stage.mjs")))
      .toBe(path.resolve("/unpacked/package/dist"));
  });

  it("rejects undeclared package anchors and stage names", () => {
    expect(() => resolveServerStageDirectory(fileUrl("/unpacked/package/dist/chunks/server.js")))
      .toThrow("Unsupported @wasm-oj/server module layout");
    expect(() => resolveServerStageDirectory(fileUrl("/unpacked/package/dist/other-stage.mjs")))
      .toThrow("Unsupported @wasm-oj/server module layout");
    expect(() => serverStageScript("relative/dist", "python-stage.mjs"))
      .toThrow("stage directory must be absolute");
    expect(() => serverStageScript(
      path.resolve("/unpacked/package/dist"),
      "unknown-stage.mjs" as "python-stage.mjs",
    )).toThrow("Unknown isolated server stage");
  });
});

function fileUrl(value: string): string {
  return pathToFileURL(path.resolve(value)).href;
}
