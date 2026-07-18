import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readFile, readlink } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const EVIDENCE_RUN = /^experiments\/[^/]+\/runs\//;
const GENERATED_EVIDENCE = new Set(["docs/conformance-report.md"]);

export interface SourceTreeProvenance {
  algorithm: "forge-source-tree-sha256";
  sha256: string;
  files: number;
}

interface SourceEntry {
  path: string;
  kind: "file" | "symlink" | "deleted";
  executable: boolean;
  bytes: number;
  sha256: string;
}

/**
 * Bind evidence to exact tracked and untracked source bytes. Generated evidence
 * directories are excluded so writing a record cannot change its own digest.
 */
export async function sourceTreeProvenance(root = process.cwd()): Promise<SourceTreeProvenance> {
  const [tracked, untracked] = await Promise.all([
    gitBytes(root, ["ls-files", "--cached", "--stage", "-z"]),
    gitBytes(root, ["ls-files", "--others", "--exclude-standard", "-z"]),
  ]);
  const trackedModes = trackedFileModes(tracked);
  const files = [...new Set([
    ...trackedModes.keys(),
    ...nulPaths(untracked),
  ])]
    .filter((value) => !EVIDENCE_RUN.test(value) && !GENERATED_EVIDENCE.has(value))
    .sort(compareUtf8);
  const entries = await Promise.all(files.map((relative) => sourceEntry(root, relative, trackedModes.get(relative))));
  const manifest = entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n";
  return {
    algorithm: "forge-source-tree-sha256",
    sha256: createHash("sha256").update(manifest).digest("hex"),
    files: entries.length,
  };
}

async function sourceEntry(root: string, relative: string, trackedMode?: string): Promise<SourceEntry> {
  const absolute = path.join(root, relative);
  try {
    const stats = await lstat(absolute);
    const executable = trackedMode === undefined
      ? (stats.mode & 0o111) !== 0
      : trackedMode === "100755";
    if (stats.isSymbolicLink()) {
      const target = Buffer.from(await readlink(absolute));
      return {
        path: relative,
        kind: "symlink",
        executable,
        bytes: target.byteLength,
        sha256: createHash("sha256").update(target).digest("hex"),
      };
    }
    if (!stats.isFile()) throw new Error(`Source entry '${relative}' is not a regular file or symlink.`);
    const contents = await readFile(absolute);
    return {
      path: relative,
      kind: "file",
      executable,
      bytes: contents.byteLength,
      sha256: createHash("sha256").update(contents).digest("hex"),
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return {
      path: relative,
      kind: "deleted",
      executable: false,
      bytes: 0,
      sha256: createHash("sha256").update("").digest("hex"),
    };
  }
}

async function gitBytes(root: string, arguments_: string[]): Promise<Buffer> {
  const { stdout } = await execFileAsync("git", arguments_, {
    cwd: root,
    encoding: "buffer",
    maxBuffer: 32 * 1024 * 1024,
  });
  return Buffer.from(stdout);
}

function nulPaths(bytes: Buffer): string[] {
  return bytes.toString("utf8").split("\0").filter(Boolean);
}

function trackedFileModes(bytes: Buffer): Map<string, string> {
  const modes = new Map<string, string>();
  for (const entry of nulPaths(bytes)) {
    const match = /^(100644|100755|120000) [0-9a-f]{40,64} 0\t(.+)$/.exec(entry);
    if (!match) throw new Error(`Unexpected Git index entry '${entry}'.`);
    modes.set(match[2]!, match[1]!);
  }
  return modes;
}

function compareUtf8(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left), Buffer.from(right));
}
