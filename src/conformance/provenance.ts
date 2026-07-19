import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
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
  kind: "file" | "symlink";
  executable: boolean;
  bytes: number;
  sha256: string;
}

interface IndexEntry {
  path: string;
  mode: "100644" | "100755" | "120000";
  objectId: string;
}

/**
 * Bind evidence to exact staged Git blobs. Generated evidence directories are
 * excluded so writing a record cannot change its own digest. Unstaged and
 * untracked source is rejected instead of acquiring host-specific clean-filter,
 * line-ending, executable-mode, or LFS checkout semantics.
 */
export async function sourceTreeProvenance(root = process.cwd()): Promise<SourceTreeProvenance> {
  const [tracked, unstaged, untracked] = await Promise.all([
    gitBytes(root, ["ls-files", "--cached", "--stage", "-z"]),
    gitBytes(root, ["diff", "--name-only", "-z"]),
    gitBytes(root, ["ls-files", "--others", "--exclude-standard", "-z"]),
  ]);
  const dirty = [...new Set([...nulPaths(unstaged), ...nulPaths(untracked)])]
    .filter((value) => includedSource(value))
    .sort(compareUtf8);
  if (dirty.length > 0) {
    throw new Error(`Stage every source change before collecting provenance: ${dirty.join(", ")}.`);
  }
  const index = trackedFileEntries(tracked)
    .filter((entry) => includedSource(entry.path))
    .sort((left, right) => compareUtf8(left.path, right.path));
  const blobs = await readGitBlobs(root, [...new Set(index.map((entry) => entry.objectId))]);
  const entries = index.map((entry): SourceEntry => {
    const contents = blobs.get(entry.objectId);
    if (!contents) throw new Error(`Git did not return staged blob '${entry.objectId}' for '${entry.path}'.`);
    return {
      path: entry.path,
      kind: entry.mode === "120000" ? "symlink" : "file",
      executable: entry.mode === "100755",
      bytes: contents.byteLength,
      sha256: createHash("sha256").update(contents).digest("hex"),
    };
  });
  const manifest = entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n";
  return {
    algorithm: "forge-source-tree-sha256",
    sha256: createHash("sha256").update(manifest).digest("hex"),
    files: entries.length,
  };
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

function trackedFileEntries(bytes: Buffer): IndexEntry[] {
  const entries: IndexEntry[] = [];
  for (const entry of nulPaths(bytes)) {
    const match = /^(100644|100755|120000) ([0-9a-f]{40,64}) 0\t(.+)$/.exec(entry);
    if (!match) throw new Error(`Unexpected Git index entry '${entry}'.`);
    entries.push({
      path: match[3]!,
      mode: match[1]! as IndexEntry["mode"],
      objectId: match[2]!,
    });
  }
  return entries;
}

function includedSource(relative: string): boolean {
  return !EVIDENCE_RUN.test(relative) && !GENERATED_EVIDENCE.has(relative);
}

async function readGitBlobs(root: string, objectIds: string[]): Promise<Map<string, Buffer>> {
  const child = spawn("git", ["cat-file", "--batch"], {
    cwd: root,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
  child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
  const completion = new Promise<void>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code) => code === 0
      ? resolve()
      : reject(new Error(`git cat-file exited with ${code}: ${Buffer.concat(stderr).toString("utf8")}`)));
  });
  child.stdin.end(`${objectIds.join("\n")}\n`);
  await completion;

  const output = Buffer.concat(stdout);
  const blobs = new Map<string, Buffer>();
  let offset = 0;
  for (const requested of objectIds) {
    const headerEnd = output.indexOf(0x0a, offset);
    if (headerEnd < 0) throw new Error(`git cat-file omitted the header for '${requested}'.`);
    const header = output.subarray(offset, headerEnd).toString("ascii");
    const match = /^([0-9a-f]{40,64}) blob (\d+)$/.exec(header);
    if (!match || match[1] !== requested) throw new Error(`Unexpected git cat-file response '${header}'.`);
    const size = Number(match[2]);
    const start = headerEnd + 1;
    const end = start + size;
    if (!Number.isSafeInteger(size) || output.byteLength <= end || output[end] !== 0x0a) {
      throw new Error(`git cat-file returned an invalid staged blob for '${requested}'.`);
    }
    blobs.set(requested, output.subarray(start, end));
    offset = end + 1;
  }
  if (offset !== output.byteLength) throw new Error("git cat-file returned trailing data.");
  return blobs;
}

function compareUtf8(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left), Buffer.from(right));
}
