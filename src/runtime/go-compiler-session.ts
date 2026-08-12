export interface RuntimeCoreCompileStage {
  command: string;
  args: string[];
  env: Record<string, string>;
  stdin: Uint8Array;
  files: Record<string, Uint8Array>;
  cwd: string | null;
  outputPaths: string[];
  outputLimitBytes: number;
}

const utf8Encoder = new TextEncoder();

export interface RuntimeCorePipelineResponse<Result = unknown> {
  ok: boolean;
  result?: Result;
  error?: { code: string; message: string };
}

export interface RuntimeCoreGoSessionEnvelope<Result = unknown> {
  digest: string;
  generation: number;
  response: RuntimeCorePipelineResponse<Result>;
}

export interface RuntimeCoreGoSessionBinding<Result = unknown> {
  readonly digest: string;
  readonly generation: number;
  compilePipeline(request: {
    digest: string;
    sourceDelta: {
      generation: number;
      upsertFiles: Record<string, Uint8Array>;
      removePaths: string[];
    };
    stages: RuntimeCoreCompileStage[];
  }): Promise<RuntimeCoreGoSessionEnvelope<Result>>;
  free(): void;
}

export interface RuntimeCoreGoSessionConstructor<Result = unknown> {
  new(config: {
    digest: string;
    toolchain: { package: Uint8Array; memoryLimitBytes: number };
    standardLibraryFiles: Record<string, Uint8Array>;
  }): RuntimeCoreGoSessionBinding<Result>;
}

/**
 * Owns one digest-bound runtime-core Go session and converts complete mutable
 * source snapshots into monotonic deltas. The immutable WebC and standard
 * library are accepted only by `hydrate`; compile calls can never resend them.
 */
export class BrowserGoCompilerSession<Result = unknown> {
  private readonly digest: string;
  private readonly binding: RuntimeCoreGoSessionBinding<Result>;
  private generation = 0;
  private files = new Map<string, Uint8Array>();
  private inFlight = false;
  private disposed = false;

  static hydrate<Result>(
    Session: RuntimeCoreGoSessionConstructor<Result>,
    config: ConstructorParameters<RuntimeCoreGoSessionConstructor<Result>>[0],
  ): BrowserGoCompilerSession<Result> {
    requireDigest(config.digest);
    const binding = new Session(config);
    if (binding.digest !== config.digest || binding.generation !== 0) {
      binding.free();
      throw new Error("The runtime-core Go session did not bind the admitted toolchain digest at generation zero.");
    }
    return new BrowserGoCompilerSession(config.digest, binding);
  }

  private constructor(digest: string, binding: RuntimeCoreGoSessionBinding<Result>) {
    this.digest = digest;
    this.binding = binding;
  }

  async compile(
    files: Readonly<Record<string, Uint8Array>>,
    stages: readonly RuntimeCoreCompileStage[],
  ): Promise<RuntimeCorePipelineResponse<Result>> {
    if (this.disposed) throw new Error("The browser Go compiler session is disposed.");
    if (this.inFlight) throw new Error("The browser Go compiler session accepts one build at a time.");
    if (this.generation >= 0xffff_ffff) throw new Error("The browser Go compiler session generation is exhausted.");
    const nextFiles = canonicalFileSnapshot(files);
    const upsertFiles: Record<string, Uint8Array> = {};
    for (const [path, bytes] of nextFiles) {
      const previous = this.files.get(path);
      if (previous === undefined || !equalBytes(previous, bytes)) upsertFiles[path] = bytes;
    }
    const removePaths = [...this.files.keys()]
      .filter((path) => !nextFiles.has(path))
      .sort(compareUtf8);
    const generation = this.generation + 1;
    this.inFlight = true;
    try {
      const envelope = await this.binding.compilePipeline({
        digest: this.digest,
        sourceDelta: { generation, upsertFiles, removePaths },
        stages: stages.map(cloneStageRequest),
      });
      if (
        envelope.digest !== this.digest
        || envelope.generation !== generation
        || this.binding.digest !== this.digest
        || this.binding.generation !== generation
      ) {
        throw new Error("The runtime-core Go session returned a stale or mismatched generation.");
      }
      if (!isPipelineResponse(envelope.response)) {
        throw new Error("The runtime-core Go session returned an invalid compiler response.");
      }
      this.files = nextFiles;
      this.generation = generation;
      return envelope.response;
    } finally {
      this.inFlight = false;
    }
  }

  dispose(): void {
    if (this.disposed) return;
    if (this.inFlight) throw new Error("The browser Go compiler session cannot be disposed during a build.");
    this.disposed = true;
    this.files.clear();
    this.binding.free();
  }
}

function canonicalFileSnapshot(files: Readonly<Record<string, Uint8Array>>): Map<string, Uint8Array> {
  return new Map(Object.entries(files)
    .sort(([left], [right]) => compareUtf8(left, right))
    .map(([path, bytes]) => [path, Uint8Array.from(bytes)]));
}

function compareUtf8(left: string, right: string): number {
  const leftBytes = utf8Encoder.encode(left);
  const rightBytes = utf8Encoder.encode(right);
  const length = Math.min(leftBytes.byteLength, rightBytes.byteLength);
  for (let index = 0; index < length; index += 1) {
    if (leftBytes[index] !== rightBytes[index]) return leftBytes[index] - rightBytes[index];
  }
  return leftBytes.byteLength - rightBytes.byteLength;
}

function cloneStageRequest(stage: RuntimeCoreCompileStage): RuntimeCoreCompileStage {
  return {
    command: stage.command,
    args: [...stage.args],
    env: { ...stage.env },
    stdin: stage.stdin,
    files: { ...stage.files },
    cwd: stage.cwd,
    outputPaths: [...stage.outputPaths],
    outputLimitBytes: stage.outputLimitBytes,
  };
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

function requireDigest(digest: string): void {
  if (!/^[a-f0-9]{64}$/.test(digest)) {
    throw new Error("The browser Go compiler session digest must be a lowercase SHA-256.");
  }
}

function isPipelineResponse<Result>(value: unknown): value is RuntimeCorePipelineResponse<Result> {
  if (typeof value !== "object" || value === null) return false;
  const response = value as Record<string, unknown>;
  if (typeof response.ok !== "boolean") return false;
  if (response.ok) return Object.hasOwn(response, "result") && response.error === undefined;
  if (response.result !== undefined) return false;
  return typeof response.error === "object"
    && response.error !== null
    && typeof (response.error as Record<string, unknown>).code === "string"
    && typeof (response.error as Record<string, unknown>).message === "string";
}
