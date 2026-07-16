import type {
  BuildArtifact,
  BuildResult,
  CompilerRequest,
  CompilerResponse,
  Project,
  ProjectConfig,
  RunResult,
  WorkerProgress,
} from "@/src/core/types";
import CompilerWorker from "./compiler.worker?worker&inline";

type ProgressListener = (progress: WorkerProgress) => void;
type StreamListener = (stream: "stdout" | "stderr", chunk: string) => void;

interface PendingRequest<T> {
  resolve(value: T): void;
  reject(reason: Error): void;
}

type CompilerRequestWithoutId = CompilerRequest extends infer Request
  ? Request extends CompilerRequest
    ? Omit<Request, "requestId">
    : never
  : never;

export class CompilerClient {
  private worker: Worker;
  private readonly pending = new Map<string, PendingRequest<unknown>>();
  private progressListener?: ProgressListener;
  private streamListener?: StreamListener;
  private readyPromise: Promise<void>;

  constructor() {
    this.worker = this.createWorker();
    this.readyPromise = this.request<void>({ type: "initialize" });
  }

  onProgress(listener: ProgressListener): () => void {
    this.progressListener = listener;
    return () => {
      if (this.progressListener === listener) this.progressListener = undefined;
    };
  }

  onStream(listener: StreamListener): () => void {
    this.streamListener = listener;
    return () => {
      if (this.streamListener === listener) this.streamListener = undefined;
    };
  }

  ready(): Promise<void> {
    return this.readyPromise;
  }

  async build(project: Project, cacheKey: string): Promise<BuildResult> {
    await this.readyPromise;
    return this.request<BuildResult>({ type: "build", project, cacheKey });
  }

  async run(artifact: BuildArtifact, config: ProjectConfig): Promise<RunResult> {
    await this.readyPromise;
    return this.request<RunResult>({ type: "run", artifact, config });
  }

  async clearToolchainCache(): Promise<void> {
    await this.readyPromise;
    return this.request<void>({ type: "clear-toolchain-cache" });
  }

  cancel(): void {
    this.replaceWorker(new Error("Compilation cancelled."));
  }

  restart(): void {
    this.replaceWorker(new Error("Compiler worker restarted."));
  }

  dispose(): void {
    this.worker.terminate();
    const error = new Error("Compiler client disposed.");
    for (const request of this.pending.values()) request.reject(error);
    this.pending.clear();
  }

  private createWorker(): Worker {
    const worker = new CompilerWorker({ name: "localwasi-compiler" });
    worker.addEventListener("message", (event: MessageEvent<CompilerResponse>) => this.handleMessage(event.data));
    worker.addEventListener("error", (event) => {
      const error = new Error(event.message || "The compiler worker crashed.");
      for (const request of this.pending.values()) request.reject(error);
      this.pending.clear();
    });
    return worker;
  }

  private replaceWorker(error: Error): void {
    this.worker.terminate();
    for (const request of this.pending.values()) request.reject(error);
    this.pending.clear();
    this.worker = this.createWorker();
    this.readyPromise = this.request<void>({ type: "initialize" });
  }

  private request<T>(request: CompilerRequestWithoutId): Promise<T> {
    const requestId = crypto.randomUUID();
    return new Promise<T>((resolve, reject) => {
      this.pending.set(requestId, { resolve: resolve as (value: unknown) => void, reject });
      this.worker.postMessage({ ...request, requestId } as CompilerRequest);
    });
  }

  private handleMessage(response: CompilerResponse): void {
    if (response.type === "progress") {
      this.progressListener?.(response.progress);
      return;
    }
    if (response.type === "stream") {
      this.streamListener?.(response.stream, response.chunk);
      return;
    }

    const request = this.pending.get(response.requestId);
    if (!request) return;
    this.pending.delete(response.requestId);

    switch (response.type) {
      case "ready":
      case "cache-cleared":
        request.resolve(undefined);
        break;
      case "build-result":
        request.resolve(response.result);
        break;
      case "run-result":
        request.resolve(response.result);
        break;
      case "error":
        request.reject(Object.assign(new Error(response.message), { stack: response.stack }));
        break;
    }
  }
}
