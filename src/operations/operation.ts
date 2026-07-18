import type { WorkerProgress } from "../core/types";
import { asForgeError, ForgeError, type ForgeErrorRecord } from "../core/errors";
import type { JudgeProjectResult } from "../sdk/engine";
import type { JudgeCaseVerdict, JudgeRunOptions } from "../judge/engine";
import type { JudgeSpec } from "../judge/spec";
import type { CompileInput } from "../sdk/project";
import type { CompileOptions } from "../sdk/types";

export type ForgeOperationKind = "submission";
export type ForgeOperationState = "queued" | "running" | "succeeded" | "failed" | "cancelled";

export type ForgeOperationEventPayload =
  | { type: "state"; state: ForgeOperationState }
  | { type: "progress"; progress: WorkerProgress }
  | { type: "stream"; stream: "stdout" | "stderr"; chunk: string }
  | {
    type: "build";
    success: boolean;
    cacheHit: boolean;
    diagnosticCount: number;
    artifact?: { id: string; kind: "wasm" | "runtime-bundle"; size: number };
  }
  | {
    type: "case";
    caseId: string;
    verdict: JudgeCaseVerdict;
    message?: string;
    completed: number;
    total: number;
  }
  | { type: "error"; error: ForgeErrorRecord };

export type ForgeOperationEvent = ForgeOperationEventPayload & {
  operationId: string;
  sequence: number;
};

export interface ForgeSubmissionRequest {
  id?: string;
  input: CompileInput;
  spec: JudgeSpec;
  compile?: CompileOptions;
  judge?: Omit<JudgeRunOptions, "onCase">;
  signal?: AbortSignal;
}

export interface ForgeOperation<T> {
  readonly id: string;
  readonly kind: ForgeOperationKind;
  readonly signal: AbortSignal;
  readonly result: Promise<T>;
  state(): ForgeOperationState;
  cancel(reason?: string): void;
  onEvent(listener: (event: ForgeOperationEvent) => void): () => void;
}

export type ForgeSubmissionOperation = ForgeOperation<JudgeProjectResult>;

export interface ForgeOperationSchedulerHost {
  executeSubmission(
    request: ForgeSubmissionRequest,
    observe: (event: ForgeOperationEventPayload) => void,
  ): Promise<JudgeProjectResult>;
  cancelActiveSubmission(): void;
}

export class ForgeOperationScheduler {
  private readonly queue: SubmissionEntry[] = [];
  private readonly identities = new Set<string>();
  private active: SubmissionEntry | undefined;
  private disposed = false;

  constructor(
    private readonly host: ForgeOperationSchedulerHost,
    private readonly observe?: (event: ForgeOperationEvent) => void,
  ) {
    if (!host || typeof host.executeSubmission !== "function"
      || typeof host.cancelActiveSubmission !== "function") {
      throw new TypeError("ForgeOperationScheduler requires a submission execution host.");
    }
  }

  submit(request: ForgeSubmissionRequest): ForgeSubmissionOperation {
    if (this.disposed) throw new ForgeError("Forge operation scheduler is disposed.", {
      code: "disposed",
      stage: "operation",
    });
    if (!request || typeof request !== "object") {
      throw new ForgeError("Forge submission request must be an object.", {
        code: "invalid-input",
        stage: "operation",
      });
    }
    const id = submissionId(request.id);
    if (this.identities.has(id)) {
      throw new ForgeError(`Forge submission operation '${id}' already exists.`, {
        code: "operation-conflict",
        stage: "operation",
        operationId: id,
      });
    }
    this.identities.add(id);
    const entry = new SubmissionEntry(
      id,
      request,
      (payload) => this.emit(entry, payload),
      () => this.cancelEntry(entry),
    );
    this.queue.push(entry);
    entry.emit({ type: "state", state: "queued" });
    queueMicrotask(() => void this.drain());
    return entry.operation;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.active) {
      this.active.disposal = true;
      this.active.cancel("Forge operation scheduler was disposed.");
      this.host.cancelActiveSubmission();
    }
    for (const entry of this.queue.splice(0)) {
      entry.disposal = true;
      entry.cancel("Forge operation scheduler was disposed.");
      this.settleCancellation(entry);
    }
  }

  hasPending(): boolean {
    return this.active !== undefined || this.queue.some((entry) => !entry.settled);
  }

  cancelActive(reason = "Forge submission operation was cancelled."): boolean {
    if (!this.active) return false;
    this.active.cancel(reason);
    return true;
  }

  private cancelEntry(entry: SubmissionEntry): void {
    if (entry.settled) return;
    if (this.active === entry) this.host.cancelActiveSubmission();
    else {
      const index = this.queue.indexOf(entry);
      if (index >= 0) this.queue.splice(index, 1);
      this.settleCancellation(entry);
    }
  }

  private async drain(): Promise<void> {
    if (this.disposed || this.active) return;
    const entry = this.queue.shift();
    if (!entry) return;
    if (entry.signal.aborted) {
      this.settleCancellation(entry);
      queueMicrotask(() => void this.drain());
      return;
    }
    this.active = entry;
    entry.setState("running");
    try {
      const result = await this.host.executeSubmission(
        { ...entry.request, id: entry.id, signal: entry.signal },
        entry.emit,
      );
      if (entry.signal.aborted) this.settleCancellation(entry);
      else {
        entry.setState("succeeded");
        entry.resolve(result);
      }
    } catch (error) {
      if (entry.signal.aborted) this.settleCancellation(entry, error);
      else {
        const failure = asForgeError(error, {
          code: "internal-failure",
          stage: "operation",
          retryable: false,
          operationId: entry.id,
        });
        entry.emit({ type: "error", error: failure.toJSON() });
        entry.setState("failed");
        entry.reject(failure);
      }
    } finally {
      entry.cleanup();
      if (this.active === entry) this.active = undefined;
      queueMicrotask(() => void this.drain());
    }
  }

  private settleCancellation(entry: SubmissionEntry, cause?: unknown): void {
    if (entry.settled) return;
    const failure = new ForgeError(
      entry.cancelReason ?? "Forge submission operation was cancelled.",
      {
        code: entry.disposal ? "disposed" : "operation-cancelled",
        stage: "operation",
        operationId: entry.id,
        cause,
      },
    );
    entry.emit({ type: "error", error: failure.toJSON() });
    entry.setState("cancelled");
    entry.reject(failure);
    entry.cleanup();
  }

  private emit(entry: SubmissionEntry, payload: ForgeOperationEventPayload): void {
    const event = Object.freeze({
      ...payload,
      operationId: entry.id,
      sequence: entry.nextSequence(),
    }) as ForgeOperationEvent;
    entry.notify(event);
    this.observe?.(event);
  }
}

class SubmissionEntry {
  readonly controller = new AbortController();
  readonly signal = this.controller.signal;
  readonly operation: ForgeSubmissionOperation;
  readonly result: Promise<JudgeProjectResult>;
  readonly emit: (payload: ForgeOperationEventPayload) => void;
  private readonly listeners = new Set<(event: ForgeOperationEvent) => void>();
  private lastStateEvent?: ForgeOperationEvent;
  private readonly externalSignal?: AbortSignal;
  private readonly onExternalAbort: () => void;
  private sequence = 0;
  private currentState: ForgeOperationState = "queued";
  private resolveResult!: (result: JudgeProjectResult) => void;
  private rejectResult!: (error: ForgeError) => void;
  settled = false;
  disposal = false;
  cancelReason: string | undefined;

  constructor(
    readonly id: string,
    readonly request: ForgeSubmissionRequest,
    emit: (payload: ForgeOperationEventPayload) => void,
    cancelEntry: () => void,
  ) {
    this.emit = emit;
    this.result = new Promise<JudgeProjectResult>((resolve, reject) => {
      this.resolveResult = resolve;
      this.rejectResult = reject;
    });
    void this.result.catch(() => undefined);
    this.externalSignal = request.signal;
    this.onExternalAbort = () => {
      this.cancel(abortReason(this.externalSignal?.reason));
      cancelEntry();
    };
    if (this.externalSignal?.aborted) this.controller.abort(this.externalSignal.reason);
    else this.externalSignal?.addEventListener("abort", this.onExternalAbort, { once: true });
    this.operation = Object.freeze({
      id,
      kind: "submission" as const,
      signal: this.signal,
      result: this.result,
      state: () => this.currentState,
      cancel: (reason?: string) => {
        this.cancel(reason);
        cancelEntry();
      },
      onEvent: (listener: (event: ForgeOperationEvent) => void) => {
        if (typeof listener !== "function") throw new TypeError("Forge operation event listener must be a function.");
        this.listeners.add(listener);
        if (this.lastStateEvent) this.notifyListener(listener, this.lastStateEvent);
        return () => this.listeners.delete(listener);
      },
    });
  }

  cancel(reason?: string): void {
    if (this.settled || this.signal.aborted) return;
    this.cancelReason = validCancelReason(reason);
    this.controller.abort(this.cancelReason);
  }

  setState(state: ForgeOperationState): void {
    if (this.settled) return;
    this.currentState = state;
    this.emit({ type: "state", state });
    if (state === "succeeded" || state === "failed" || state === "cancelled") this.settled = true;
  }

  resolve(result: JudgeProjectResult): void {
    if (!this.settled) this.settled = true;
    this.resolveResult(result);
  }

  reject(error: ForgeError): void {
    if (!this.settled) this.settled = true;
    this.rejectResult(error);
  }

  nextSequence(): number {
    return this.sequence++;
  }

  notify(event: ForgeOperationEvent): void {
    if (event.type === "state") this.lastStateEvent = event;
    for (const listener of this.listeners) this.notifyListener(listener, event);
  }

  private notifyListener(listener: (event: ForgeOperationEvent) => void, event: ForgeOperationEvent): void {
    try {
      listener(event);
    } catch {
      this.listeners.delete(listener);
    }
  }

  cleanup(): void {
    this.externalSignal?.removeEventListener("abort", this.onExternalAbort);
  }
}

function submissionId(requested: string | undefined): string {
  if (requested === undefined) return crypto.randomUUID();
  if (typeof requested !== "string" || !requested || requested !== requested.trim() || requested.length > 128) {
    throw new ForgeError("Forge submission ID must be non-empty, trimmed, and at most 128 characters.", {
      code: "invalid-input",
      stage: "operation",
    });
  }
  return requested;
}

function validCancelReason(reason: string | undefined): string {
  if (reason === undefined) return "Forge submission operation was cancelled.";
  if (typeof reason !== "string" || !reason || reason !== reason.trim() || reason.length > 512) {
    throw new TypeError("Forge cancellation reason must be non-empty, trimmed, and at most 512 characters.");
  }
  return reason;
}

function abortReason(reason: unknown): string {
  return typeof reason === "string" && reason && reason === reason.trim() && reason.length <= 512
    ? reason
    : "Forge submission operation was aborted.";
}
