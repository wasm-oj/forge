import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { sourceTreeProvenance } from "./provenance";

const execFileAsync = promisify(execFile);

describe("sourceTreeProvenance", () => {
  it("deterministically binds the current staged source tree", async () => {
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
      await expect(sourceTreeProvenance(root)).rejects.toThrow("Stage every source change");
      await execFileAsync("git", ["add", "source.ts"], { cwd: root });
      expect((await sourceTreeProvenance(root)).sha256).not.toBe(first.sha256);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("uses the Git index mode instead of host checkout permissions", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "forge-provenance-mode-"));
    try {
      const source = path.join(root, "source.ts");
      await writeFile(source, "export const value = 1;\n", { mode: 0o644 });
      await execFileAsync("git", ["init", "--quiet"], { cwd: root });
      await execFileAsync("git", ["add", "source.ts"], { cwd: root });
      const first = await sourceTreeProvenance(root);
      await execFileAsync("git", ["config", "core.filemode", "false"], { cwd: root });
      await chmod(source, 0o755);
      expect(await sourceTreeProvenance(root)).toEqual(first);
      await execFileAsync("git", ["update-index", "--chmod=+x", "source.ts"], { cwd: root });
      expect((await sourceTreeProvenance(root)).sha256).not.toBe(first.sha256);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
