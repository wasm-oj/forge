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
 * Identify the current committed source tree. Local edits are intentionally
 * ignored; this helper is descriptive and is not a deployment gate.
 */
export async function sourceTreeProvenance(root = process.cwd()): Promise<SourceTreeProvenance> {
  const headBytes = await gitBytes(root, ["rev-parse", "--verify", "HEAD^{commit}"]);
  const head = Buffer.from(headBytes).toString("ascii").trim();
  if (!/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(head)) {
    throw new Error("Formal source provenance requires one immutable HEAD commit.");
  }
  return sourceTreeProvenanceAtCommit(root, head);
}

/** Recompute the same source identity from one immutable Git commit tree. */
export async function sourceTreeProvenanceAtCommit(
  root: string,
  commit: string,
): Promise<SourceTreeProvenance> {
  if (!/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(commit)) {
    throw new Error("Historical source provenance requires a full lowercase Git commit ID.");
  }
  const tree = await gitBytes(root, ["ls-tree", "-r", "-z", "--full-tree", commit]);
  const index = treeFileEntries(tree)
    .filter((entry) => includedSource(entry.path))
    .sort((left, right) => compareUtf8(left.path, right.path));
  const blobs = await readGitBlobs(root, [...new Set(index.map((entry) => entry.objectId))]);
  const entries = index.map((entry): SourceEntry => {
    const contents = blobs.get(entry.objectId);
    if (!contents) throw new Error(`Git did not return committed blob '${entry.objectId}' for '${entry.path}'.`);
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
  return bytes.toString().split("\0").filter(Boolean);
}

function treeFileEntries(bytes: Buffer): IndexEntry[] {
  const entries: IndexEntry[] = [];
  for (const entry of nulPaths(bytes)) {
    const match = /^(100644|100755|120000) blob ([0-9a-f]{40,64})\t(.+)$/.exec(entry);
    if (!match) throw new Error(`Unexpected Git tree entry '${entry}'.`);
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
      throw new Error(`git cat-file returned an invalid immutable blob for '${requested}'.`);
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
