import { WASM_OJ_SCHEMAS } from "../core/contract.ts";
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
  schema: typeof WASM_OJ_SCHEMAS.incrementalBuildGraph;
  nodes: readonly IncrementalBuildNode[];
  storedBytes: number;
}

export interface IncrementalBuildGraphManifestEntry {
  kind: LogicalManifest["kind"];
  logicalKey: string;
  inputs: readonly {
    kind: BuildGraphInput["kind"];
    identity: string;
    digest: string;
  }[];
  outputDigest: string;
  outputByteLength: number;
}

export interface IncrementalBuildGraphManifest {
  schema: typeof WASM_OJ_SCHEMAS.incrementalBuildGraph;
  version: 2;
  generation: number;
  entries: readonly IncrementalBuildGraphManifestEntry[];
}

export interface IncrementalBuildGraphBlob {
  digest: string;
  bytes: Uint8Array;
}

/**
 * Worker-neutral persistence state. Logical metadata is intentionally kept
 * separate from unique content-addressed output bytes so IndexedDB never has
 * to clone one large monolithic archive merely to update access metadata.
 */
export interface IncrementalBuildGraphState {
  manifest: IncrementalBuildGraphManifest;
  blobs: readonly IncrementalBuildGraphBlob[];
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
  private generation = 0;

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
    const previousManifest = this.logical.get(logicalKey);
    const previousNode = previousManifest ? this.nodes.get(previousManifest.nodeKey) : undefined;
    let changed = false;
    if (previousNode && (previousNode.key !== key || previousNode.digest !== digest)) {
      this.logical.delete(logicalKey);
      this.nodes.delete(previousNode.key);
      if (![...this.logical.values()].some((manifest) => this.nodes.get(manifest.nodeKey)?.digest === previousNode.digest)) {
        const removed = this.blobs.get(previousNode.digest);
        if (removed) {
          this.blobs.delete(previousNode.digest);
          this.storedBytes -= removed.byteLength;
        }
      }
      changed = true;
    }
    changed = this.ensureCapacity(bytes.byteLength, digest) || changed;
    if (!this.blobs.has(digest)) {
      this.blobs.set(digest, bytes);
      this.storedBytes += bytes.byteLength;
      changed = true;
    }
    const nextNode: IncrementalBuildNode = {
      key,
      kind,
      identity: logicalKey,
      digest,
      dependencies: dependencies.map((item) => item.key),
      byteLength: bytes.byteLength,
    };
    const nextManifest: LogicalManifest = {
      kind,
      dependencies: canonicalInputs.map(({ kind: inputKind, identity }) => ({ kind: inputKind, identity })),
      nodeKey: key,
    };
    const currentNode = this.nodes.get(key);
    const currentManifest = this.logical.get(logicalKey);
    if (!sameNode(currentNode, nextNode) || !sameLogicalManifest(currentManifest, nextManifest)) changed = true;
    this.nodes.set(key, nextNode);
    this.logical.set(logicalKey, nextManifest);
    if (changed) this.generation += 1;
    return true;
  }

  exportState(): IncrementalBuildGraphState {
    const entries: IncrementalBuildGraphManifestEntry[] = [];
    const referencedDigests = new Set<string>();
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
        outputByteLength: output.byteLength,
      });
      referencedDigests.add(node.digest);
    }
    return {
      manifest: {
        schema: WASM_OJ_SCHEMAS.incrementalBuildGraph,
        version: 2,
        generation: this.generation,
        entries: entries.sort((left, right) => compareText(left.logicalKey, right.logicalKey)),
      },
      blobs: [...referencedDigests]
        .sort()
        .map((digest) => ({ digest, bytes: this.blobs.get(digest)! })),
    };
  }

  async restoreState(state: IncrementalBuildGraphState): Promise<void> {
    if (!state || typeof state !== "object" || Array.isArray(state)
      || Object.keys(state).sort().join(",") !== "blobs,manifest") {
      throw new Error("Incremental build graph state does not use the active WASM-OJ contract.");
    }
    const { manifest } = state;
    if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)
      || Object.keys(manifest).sort().join(",") !== "entries,generation,schema,version"
      || manifest.schema !== WASM_OJ_SCHEMAS.incrementalBuildGraph
      || manifest.version !== 2
      || !Number.isSafeInteger(manifest.generation)
      || manifest.generation < 0
      || !Array.isArray(manifest.entries)
      || !Array.isArray(state.blobs)) {
      throw new Error("Incremental build graph manifest does not use the active WASM-OJ contract.");
    }
    const blobs = new Map<string, Uint8Array>();
    let totalBytes = 0;
    let previousDigest = "";
    for (const candidate of state.blobs as readonly unknown[]) {
      if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
        throw new Error("Incremental build graph state contains a malformed blob.");
      }
      const blob = candidate as Record<string, unknown>;
      if (Object.keys(blob).sort().join(",") !== "bytes,digest"
        || typeof blob.digest !== "string"
        || !/^[0-9a-f]{64}$/.test(blob.digest)
        || blob.digest <= previousDigest
        || !(blob.bytes instanceof Uint8Array)
        || await sha256Hex(blob.bytes) !== blob.digest) {
        throw new Error("Incremental build graph state contains an invalid content-addressed blob.");
      }
      previousDigest = blob.digest;
      totalBytes += blob.bytes.byteLength;
      if (!Number.isSafeInteger(totalBytes) || totalBytes > this.limitBytes) {
        throw new Error("Incremental build graph state exceeds its storage limit.");
      }
      blobs.set(blob.digest, blob.bytes);
    }
    const logicalKeys = new Set<string>();
    const verified: Array<{
      kind: LogicalManifest["kind"];
      logicalKey: string;
      inputs: BuildGraphInput[];
      output: Uint8Array;
    }> = [];
    const referencedDigests = new Set<string>();
    let previousLogicalKey = "";
    for (const candidate of manifest.entries as readonly unknown[]) {
      if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
        throw new Error("Incremental build graph manifest contains a malformed entry.");
      }
      const entry = candidate as Record<string, unknown>;
      const keys = Object.keys(entry).sort();
      if (keys.join(",") !== "inputs,kind,logicalKey,outputByteLength,outputDigest") {
        throw new Error("Incremental build graph manifest entry has an invalid shape.");
      }
      if (entry.kind !== "pch" && entry.kind !== "object" && entry.kind !== "link-result") {
        throw new Error("Incremental build graph manifest entry has an invalid node kind.");
      }
      if (typeof entry.logicalKey !== "string" || !entry.logicalKey
        || entry.logicalKey !== entry.logicalKey.trim() || entry.logicalKey.length > 16_384
        || (previousLogicalKey !== "" && compareText(previousLogicalKey, entry.logicalKey) >= 0)) {
        throw new Error("Incremental build graph manifest has an invalid or non-canonical logical key.");
      }
      previousLogicalKey = entry.logicalKey;
      if (logicalKeys.has(entry.logicalKey)) {
        throw new Error(`Incremental build graph manifest repeats '${entry.logicalKey}'.`);
      }
      logicalKeys.add(entry.logicalKey);
      if (typeof entry.outputDigest !== "string"
        || !/^[0-9a-f]{64}$/.test(entry.outputDigest)
        || !Number.isSafeInteger(entry.outputByteLength)
        || (entry.outputByteLength as number) < 0) {
        throw new Error(`Incremental build graph output '${entry.logicalKey}' has invalid metadata.`);
      }
      const output = blobs.get(entry.outputDigest);
      if (!output || output.byteLength !== entry.outputByteLength) {
        throw new Error(`Incremental build graph output '${entry.logicalKey}' is missing or has the wrong size.`);
      }
      referencedDigests.add(entry.outputDigest);
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
      const canonicalInputs = canonicalizeInputs(inputs);
      if (canonicalInputs.some((input, index) => input.identity !== inputs[index]?.identity)) {
        throw new Error(`Incremental build graph entry '${entry.logicalKey}' inputs are not canonical.`);
      }
      verified.push({
        kind: entry.kind,
        logicalKey: entry.logicalKey,
        inputs,
        output,
      });
    }
    if (referencedDigests.size !== blobs.size) {
      throw new Error("Incremental build graph state contains an unreferenced content-addressed blob.");
    }

    this.clear();
    for (const entry of verified) {
      if (!await this.store(entry.kind, entry.logicalKey, entry.inputs, entry.output)) {
        throw new Error(`Incremental build graph entry '${entry.logicalKey}' exceeds its storage limit.`);
      }
    }
    this.generation = manifest.generation;
  }

  snapshot(): IncrementalBuildGraphSnapshot {
    return {
      schema: WASM_OJ_SCHEMAS.incrementalBuildGraph,
      nodes: [...this.nodes.values()]
        .map((node) => ({ ...node, dependencies: [...node.dependencies] }))
        .sort((left, right) => compareText(left.key, right.key)),
      storedBytes: this.storedBytes,
    };
  }

  clear(): void {
    const changed = this.logical.size > 0 || this.nodes.size > 0 || this.blobs.size > 0;
    this.logical.clear();
    this.nodes.clear();
    this.blobs.clear();
    this.storedBytes = 0;
    if (changed) this.generation += 1;
  }

  private async internInputs(inputs: readonly BuildGraphInput[]): Promise<IncrementalBuildNode[]> {
    return Promise.all(canonicalizeInputs(inputs).map(async (input) => {
      const digest = await inputDigest(input);
      const key = await sha256Hex(JSON.stringify({
        schema: WASM_OJ_SCHEMAS.incrementalBuildGraph,
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

  private ensureCapacity(incomingBytes: number, incomingDigest: string): boolean {
    if (this.blobs.has(incomingDigest)) return false;
    let changed = false;
    while (this.storedBytes + incomingBytes > this.limitBytes && this.blobs.size > 0) {
      const oldestDigest = this.blobs.keys().next().value as string;
      const oldest = this.blobs.get(oldestDigest)!;
      this.blobs.delete(oldestDigest);
      this.storedBytes -= oldest.byteLength;
      changed = true;
      for (const [key, node] of this.nodes) {
        if (node.digest !== oldestDigest || node.dependencies.length === 0) continue;
        this.nodes.delete(key);
        for (const [logicalKey, manifest] of this.logical) {
          if (manifest.nodeKey === key) this.logical.delete(logicalKey);
        }
      }
    }
    return changed;
  }
}

function sameNode(left: IncrementalBuildNode | undefined, right: IncrementalBuildNode): boolean {
  return left?.key === right.key
    && left.kind === right.kind
    && left.identity === right.identity
    && left.digest === right.digest
    && left.byteLength === right.byteLength
    && left.dependencies.length === right.dependencies.length
    && left.dependencies.every((dependency, index) => dependency === right.dependencies[index]);
}

function sameLogicalManifest(left: LogicalManifest | undefined, right: LogicalManifest): boolean {
  return left?.kind === right.kind
    && left.nodeKey === right.nodeKey
    && left.dependencies.length === right.dependencies.length
    && left.dependencies.every((dependency, index) => dependency.kind === right.dependencies[index]?.kind
      && dependency.identity === right.dependencies[index]?.identity);
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
  return [...byIdentity.values()].sort((left, right) => compareText(left.identity, right.identity));
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
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
    schema: WASM_OJ_SCHEMAS.incrementalBuildGraph,
    kind,
    logicalKey,
    dependencies,
  }));
}
