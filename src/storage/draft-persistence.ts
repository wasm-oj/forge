import type { Project } from "../core/types";
import { encodeDraftSourceExport, restoreProjectSources } from "./draft-recovery";

export type DraftPersistencePhase = "clean" | "dirty" | "saving" | "saved" | "error";

export interface DraftPersistenceState {
  readonly phase: DraftPersistencePhase;
  readonly revision: number;
  readonly persistedRevision: number;
  readonly error?: string;
}

export interface DraftPersistenceOptions {
  readonly debounceMs?: number;
  readonly setTimer?: (callback: () => void, milliseconds: number) => ReturnType<typeof setTimeout>;
  readonly clearTimer?: (timer: ReturnType<typeof setTimeout>) => void;
}

type DraftPersistenceListener = (state: DraftPersistenceState) => void;

const INITIAL_STATE: DraftPersistenceState = Object.freeze({
  phase: "clean",
  revision: 0,
  persistedRevision: 0,
});

/**
 * Serializes project writes and retains the newest in-memory snapshot until it
 * has been durably committed. A rejected write never advances the persisted
 * revision, so an explicit retry always writes the latest draft.
 */
export class DraftPersistenceController {
  private readonly persist: (project: Project) => Promise<void>;
  private readonly debounceMs: number;
  private readonly setTimer: NonNullable<DraftPersistenceOptions["setTimer"]>;
  private readonly clearTimer: NonNullable<DraftPersistenceOptions["clearTimer"]>;
  private readonly listeners = new Set<DraftPersistenceListener>();
  private state: DraftPersistenceState = INITIAL_STATE;
  private latestDraft: Project | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private drainPromise: Promise<void> | undefined;

  constructor(
    persist: (project: Project) => Promise<void>,
    options: DraftPersistenceOptions = {},
  ) {
    this.persist = persist;
    this.debounceMs = nonNegativeInteger(options.debounceMs ?? 350, "draft debounce");
    const setTimer = options.setTimer;
    const clearTimer = options.clearTimer;
    this.setTimer = setTimer
      ? (callback, milliseconds) => setTimer(callback, milliseconds)
      : (callback, milliseconds) => globalThis.setTimeout(callback, milliseconds);
    this.clearTimer = clearTimer
      ? (timer) => clearTimer(timer)
      : (timer) => globalThis.clearTimeout(timer);
  }

  snapshot(): DraftPersistenceState {
    return this.state;
  }

  hasPendingDraft(): boolean {
    return this.state.persistedRevision < this.state.revision;
  }

  subscribe(listener: DraftPersistenceListener): () => void {
    this.listeners.add(listener);
    listener(this.state);
    return () => this.listeners.delete(listener);
  }

  update(project: Project): void {
    this.latestDraft = structuredClone(project);
    const revision = this.state.revision + 1;
    this.publish({
      phase: this.state.phase === "saving" ? "saving" : "dirty",
      revision,
      persistedRevision: this.state.persistedRevision,
    });
    this.cancelTimer();
    this.timer = this.setTimer(() => {
      this.timer = undefined;
      // Failure is observable through state; catching here prevents a rejected
      // background autosave from becoming an unhandled Promise rejection.
      void this.flush().catch(() => undefined);
    }, this.debounceMs);
  }

  flush(): Promise<void> {
    this.cancelTimer();
    if (!this.hasPendingDraft()) return Promise.resolve();
    this.drainPromise ??= this.drain().finally(() => {
      this.drainPromise = undefined;
    });
    return this.drainPromise;
  }

  retry(): Promise<void> {
    return this.flush();
  }

  exportSources(project: Project): string {
    return encodeDraftSourceExport(project);
  }

  importSources(input: string | Uint8Array, current: Project, updatedAt = Date.now()): Project {
    const restored = restoreProjectSources(current, input, updatedAt);
    this.update(restored);
    return structuredClone(restored);
  }

  private async drain(): Promise<void> {
    while (this.state.persistedRevision < this.state.revision) {
      const project = this.latestDraft;
      if (!project) throw new Error("Draft persistence has a pending revision without a project snapshot.");
      const targetRevision = this.state.revision;
      this.publish({
        phase: "saving",
        revision: this.state.revision,
        persistedRevision: this.state.persistedRevision,
      });
      try {
        await this.persist(project);
      } catch (error) {
        this.publish({
          phase: "error",
          revision: this.state.revision,
          persistedRevision: this.state.persistedRevision,
          error: errorMessage(error),
        });
        throw error;
      }
      const revision = this.state.revision;
      this.publish({
        phase: targetRevision === revision ? "saved" : "dirty",
        revision,
        persistedRevision: targetRevision,
      });
    }
    this.cancelTimer();
  }

  private cancelTimer(): void {
    if (this.timer === undefined) return;
    this.clearTimer(this.timer);
    this.timer = undefined;
  }

  private publish(state: DraftPersistenceState): void {
    this.state = Object.freeze(state);
    for (const listener of this.listeners) listener(this.state);
  }
}

function nonNegativeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`WASM-OJ ${label} must be a non-negative safe integer.`);
  }
  return value;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
