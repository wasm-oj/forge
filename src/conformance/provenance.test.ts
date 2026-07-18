import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { sourceTreeProvenance } from "./provenance";

const execFileAsync = promisify(execFile);

describe("sourceTreeProvenance", () => {
  it("deterministically binds the current tracked and untracked source tree", async () => {
    const first = await sourceTreeProvenance();
    const second = await sourceTreeProvenance();
    expect(second).toEqual(first);
    expect(first.algorithm).toBe("forge-source-tree-sha256");
    expect(first.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(first.files).toBeGreaterThan(100);
  });

  it("excludes generated reports without excluding implementation sources", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "forge-provenance-"));
    try {
      await mkdir(path.join(root, "docs"), { recursive: true });
      await writeFile(path.join(root, "source.ts"), "export const value = 1;\n");
      await writeFile(path.join(root, "docs/conformance-report.md"), "first report\n");
      await execFileAsync("git", ["init", "--quiet"], { cwd: root });
      await execFileAsync("git", ["add", "source.ts", "docs/conformance-report.md"], { cwd: root });
      const first = await sourceTreeProvenance(root);
      await writeFile(path.join(root, "docs/conformance-report.md"), "different generated report\n");
      expect(await sourceTreeProvenance(root)).toEqual(first);
      await writeFile(path.join(root, "source.ts"), "export const value = 2;\n");
      expect((await sourceTreeProvenance(root)).sha256).not.toBe(first.sha256);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
