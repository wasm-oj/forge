import { FORGE_SCHEMAS } from "../core/contract.ts";
import { sha256Hex } from "../core/hash.ts";

export const BUILD_NODE_KINDS = Object.freeze([
  "source",
  "header",
  "package",
  "pch",
  "object",
  "link-result",
] as const);
export type BuildNodeKind = (typeof BUILD_NODE_KINDS)[number];

export interface BuildGraphInput {
  kind: "source" | "header" | "package" | "pch" | "object";
  identity: string;
  bytes?: Uint8Array;
  digest?: string;
}

export interface IncrementalBuildNode {
  key: string;
  kind: BuildNodeKind;
  identity: string;
  digest: string;
  dependencies: readonly string[];
  byteLength: number;
}

interface LogicalManifest {
  kind: "pch" | "object" | "link-result";
  dependencies: readonly { kind: BuildGraphInput["kind"]; identity: string }[];
  nodeKey: string;
}

export interface IncrementalBuildGraphSnapshot {
  schema: typeof FORGE_SCHEMAS.incrementalBuildGraph;
  nodes: readonly IncrementalBuildNode[];
  storedBytes: number;
}

export interface IncrementalBuildGraphArchiveEntry {
  kind: LogicalManifest["kind"];
  logicalKey: string;
  inputs: readonly {
    kind: BuildGraphInput["kind"];
    identity: string;
    digest: string;
  }[];
  outputDigest: string;
  output: Uint8Array;
}

export interface IncrementalBuildGraphArchive {
  schema: typeof FORGE_SCHEMAS.incrementalBuildGraph;
  entries: readonly IncrementalBuildGraphArchiveEntry[];
}

/**
 * Content-addressed source → header/package → PCH/object → link-result graph.
 *
 * Logical manifests remember which inputs a tool actually observed. Reuse
 * rehashes every input and derives the structural node key again; no timestamp
 * or host path participates in identity.
 */
export class IncrementalBuildGraph {
  private readonly limitBytes: number;
  private readonly logical = new Map<string, LogicalManifest>();
  private readonly nodes = new Map<string, IncrementalBuildNode>();
  private readonly blobs = new Map<string, Uint8Array>();
  private storedBytes = 0;

  constructor(limitBytes: number) {
    if (!Number.isSafeInteger(limitBytes) || limitBytes <= 0) {
      throw new RangeError("Incremental build graph limit must be a positive safe integer.");
    }
    this.limitBytes = limitBytes;
  }

  async lookup(logicalKey: string, availableInputs: ReadonlyMap<string, BuildGraphInput>): Promise<Uint8Array | undefined> {
    const manifest = this.logical.get(logicalKey);
    if (!manifest) return undefined;
    const inputs: BuildGraphInput[] = [];
    for (const dependency of manifest.dependencies) {
      const input = availableInputs.get(dependency.identity);
      if (!input || input.kind !== dependency.kind) return undefined;
      inputs.push(input);
    }
    return this.lookupExact(manifest.kind, logicalKey, inputs);
  }

  async lookupExact(
    kind: LogicalManifest["kind"],
    logicalKey: string,
    inputs: readonly BuildGraphInput[],
  ): Promise<Uint8Array | undefined> {
    const dependencies = await this.internInputs(inputs);
    const key = await structuralKey(kind, logicalKey, dependencies.map((item) => item.key));
    const node = this.nodes.get(key);
    if (!node) return undefined;
    const blob = this.blobs.get(node.digest);
    if (!blob) return undefined;
    this.blobs.delete(node.digest);
    this.blobs.set(node.digest, blob);
    return blob.slice();
  }

  async store(
    kind: LogicalManifest["kind"],
    logicalKey: string,
    inputs: readonly BuildGraphInput[],
    output: Uint8Array,
  ): Promise<boolean> {
    if (output.byteLength > this.limitBytes) return false;
    const canonicalInputs = canonicalizeInputs(inputs);
    const dependencies = await this.internInputs(canonicalInputs);
    const key = await structuralKey(kind, logicalKey, dependencies.map((item) => item.key));
    const bytes = output.slice();
    const digest = await sha256Hex(bytes);
    this.ensureCapacity(bytes.byteLength, digest);
    if (!this.blobs.has(digest)) {
      this.blobs.set(digest, bytes);
      this.storedBytes += bytes.byteLength;
    }
    this.nodes.set(key, {
      key,
      kind,
      identity: logicalKey,
      digest,
      dependencies: dependencies.map((item) => item.key),
      byteLength: bytes.byteLength,
    });
    this.logical.set(logicalKey, {
      kind,
      dependencies: canonicalInputs.map(({ kind: inputKind, identity }) => ({ kind: inputKind, identity })),
      nodeKey: key,
    });
    return true;
  }

  exportArchive(): IncrementalBuildGraphArchive {
    const entries: IncrementalBuildGraphArchiveEntry[] = [];
    for (const [logicalKey, manifest] of this.logical) {
      const node = this.nodes.get(manifest.nodeKey);
      if (!node) continue;
      const output = this.blobs.get(node.digest);
      if (!output) continue;
      const inputs = node.dependencies.map((key) => {
        const dependency = this.nodes.get(key);
        if (!dependency) throw new Error(`Build graph dependency '${key}' is missing.`);
        return {
          kind: dependency.kind as BuildGraphInput["kind"],
          identity: dependency.identity,
          digest: dependency.digest,
        };
      });
      entries.push({
        kind: manifest.kind,
        logicalKey,
        inputs,
        outputDigest: node.digest,
        output: output.slice(),
      });
    }
    return {
      schema: FORGE_SCHEMAS.incrementalBuildGraph,
      entries: entries.sort((left, right) => left.logicalKey.localeCompare(right.logicalKey)),
    };
  }

  async restoreArchive(archive: IncrementalBuildGraphArchive): Promise<void> {
    if (!archive || typeof archive !== "object" || archive.schema !== FORGE_SCHEMAS.incrementalBuildGraph
      || !Array.isArray(archive.entries)) {
      throw new Error("Incremental build graph archive does not use the active Forge contract.");
    }
    const logicalKeys = new Set<string>();
    const verified: Array<{
      kind: LogicalManifest["kind"];
      logicalKey: string;
      inputs: BuildGraphInput[];
      output: Uint8Array;
    }> = [];
    let totalBytes = 0;
    const outputDigests = new Set<string>();
    for (const candidate of archive.entries as readonly unknown[]) {
      if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
        throw new Error("Incremental build graph archive contains a malformed entry.");
      }
      const entry = candidate as Record<string, unknown>;
      const keys = Object.keys(entry).sort();
      if (keys.join(",") !== "inputs,kind,logicalKey,output,outputDigest") {
        throw new Error("Incremental build graph archive entry has an invalid shape.");
      }
      if (entry.kind !== "pch" && entry.kind !== "object" && entry.kind !== "link-result") {
        throw new Error("Incremental build graph archive entry has an invalid node kind.");
      }
      if (typeof entry.logicalKey !== "string" || !entry.logicalKey
        || entry.logicalKey !== entry.logicalKey.trim() || entry.logicalKey.length > 16_384) {
        throw new Error("Incremental build graph archive has an invalid logical key.");
      }
      if (logicalKeys.has(entry.logicalKey)) {
        throw new Error(`Incremental build graph archive repeats '${entry.logicalKey}'.`);
      }
      logicalKeys.add(entry.logicalKey);
      if (!(entry.output instanceof Uint8Array) || typeof entry.outputDigest !== "string"
        || !/^[0-9a-f]{64}$/.test(entry.outputDigest)
        || await sha256Hex(entry.output) !== entry.outputDigest) {
        throw new Error(`Incremental build graph output '${entry.logicalKey}' failed integrity verification.`);
      }
      if (!outputDigests.has(entry.outputDigest)) {
        outputDigests.add(entry.outputDigest);
        totalBytes += entry.output.byteLength;
        if (totalBytes > this.limitBytes) throw new Error("Incremental build graph archive exceeds its storage limit.");
      }
      if (!Array.isArray(entry.inputs)) {
        throw new Error(`Incremental build graph entry '${entry.logicalKey}' inputs must be an array.`);
      }
      const inputs = entry.inputs.map((input): BuildGraphInput => {
        if (!input || typeof input !== "object" || Array.isArray(input)) {
          throw new Error(`Incremental build graph entry '${entry.logicalKey as string}' has a malformed input.`);
        }
        const record = input as Record<string, unknown>;
        if (Object.keys(record).sort().join(",") !== "digest,identity,kind"
          || !BUILD_NODE_KINDS.slice(0, 5).includes(record.kind as never)
          || typeof record.identity !== "string"
          || typeof record.digest !== "string") {
          throw new Error(`Incremental build graph entry '${entry.logicalKey as string}' has an invalid input.`);
        }
        return {
          kind: record.kind as BuildGraphInput["kind"],
          identity: record.identity,
          digest: record.digest,
        };
      });
      canonicalizeInputs(inputs);
      verified.push({
        kind: entry.kind,
        logicalKey: entry.logicalKey,
        inputs,
        output: entry.output.slice(),
      });
    }

    this.clear();
    for (const entry of verified) {
      if (!await this.store(entry.kind, entry.logicalKey, entry.inputs, entry.output)) {
        throw new Error(`Incremental build graph entry '${entry.logicalKey}' exceeds its storage limit.`);
      }
    }
  }

  snapshot(): IncrementalBuildGraphSnapshot {
    return {
      schema: FORGE_SCHEMAS.incrementalBuildGraph,
      nodes: [...this.nodes.values()]
        .map((node) => ({ ...node, dependencies: [...node.dependencies] }))
        .sort((left, right) => left.key.localeCompare(right.key)),
      storedBytes: this.storedBytes,
    };
  }

  clear(): void {
    this.logical.clear();
    this.nodes.clear();
    this.blobs.clear();
    this.storedBytes = 0;
  }

  private async internInputs(inputs: readonly BuildGraphInput[]): Promise<IncrementalBuildNode[]> {
    return Promise.all(canonicalizeInputs(inputs).map(async (input) => {
      const digest = await inputDigest(input);
      const key = await sha256Hex(JSON.stringify({
        schema: FORGE_SCHEMAS.incrementalBuildGraph,
        kind: input.kind,
        identity: input.identity,
        digest,
      }));
      const node: IncrementalBuildNode = {
        key,
        kind: input.kind,
        identity: input.identity,
        digest,
        dependencies: [],
        byteLength: input.bytes?.byteLength ?? 0,
      };
      this.nodes.set(key, node);
      return node;
    }));
  }

  private ensureCapacity(incomingBytes: number, incomingDigest: string): void {
    if (this.blobs.has(incomingDigest)) return;
    while (this.storedBytes + incomingBytes > this.limitBytes && this.blobs.size > 0) {
      const oldestDigest = this.blobs.keys().next().value as string;
      const oldest = this.blobs.get(oldestDigest)!;
      this.blobs.delete(oldestDigest);
      this.storedBytes -= oldest.byteLength;
      for (const [key, node] of this.nodes) {
        if (node.digest === oldestDigest && node.dependencies.length > 0) this.nodes.delete(key);
      }
    }
  }
}

function canonicalizeInputs(inputs: readonly BuildGraphInput[]): BuildGraphInput[] {
  const byIdentity = new Map<string, BuildGraphInput>();
  for (const input of inputs) {
    if (!input.identity || input.identity !== input.identity.trim() || input.identity.length > 16_384) {
      throw new Error("Build graph input identities must be non-empty, trimmed strings.");
    }
    if (byIdentity.has(input.identity)) throw new Error(`Duplicate build graph input '${input.identity}'.`);
    if ((input.bytes === undefined) === (input.digest === undefined)) {
      throw new Error(`Build graph input '${input.identity}' must provide exactly one of bytes or digest.`);
    }
    byIdentity.set(input.identity, input);
  }
  return [...byIdentity.values()].sort((left, right) => left.identity.localeCompare(right.identity));
}

async function inputDigest(input: BuildGraphInput): Promise<string> {
  if (input.bytes) return sha256Hex(input.bytes);
  if (!/^[0-9a-f]{64}$/.test(input.digest!)) {
    throw new Error(`Build graph input '${input.identity}' has an invalid digest.`);
  }
  return input.digest!;
}

function structuralKey(kind: LogicalManifest["kind"], logicalKey: string, dependencies: readonly string[]): Promise<string> {
  return sha256Hex(JSON.stringify({
    schema: FORGE_SCHEMAS.incrementalBuildGraph,
    kind,
    logicalKey,
    dependencies,
  }));
}
