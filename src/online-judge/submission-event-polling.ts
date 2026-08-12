import {
  isTerminalSubmissionState,
  parseSubmissionEventReplay,
  parseSubmissionState,
  type SequencedSubmissionEvent,
  type SubmissionState,
} from "./contracts";

const SUBMISSION_UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const POLL_BACKOFF_MS = [1_000, 2_000, 5_000, 10_000] as const;

function exactObject(value: unknown, keys: readonly string[], label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${label} must be an object.`);
  const record = value as Record<string, unknown>;
  if (Object.keys(record).sort().join("\0") !== [...keys].sort().join("\0")) throw new TypeError(`${label} has an invalid shape.`);
  return record;
}

function validatedOrigin(expectedOrigin: string): URL {
  const origin = new URL(expectedOrigin);
  if (origin.origin !== expectedOrigin || origin.pathname !== "/" || origin.search || origin.hash) {
    throw new TypeError("Official submission origin is invalid.");
  }
  return origin;
}

function validatedEventsUrl(value: string, submissionId: string, origin: URL): URL {
  const events = new URL(value, origin);
  const expected = new URL(`/api/submissions/${submissionId}/events`, origin);
  if (
    !["http:", "https:"].includes(events.protocol)
    || events.username
    || events.password
    || events.search
    || events.hash
    || events.origin !== origin.origin
    || events.toString() !== expected.toString()
  ) throw new TypeError("Official submission events URL is invalid.");
  return events;
}

export interface OfficialSubmissionCreated {
  readonly submissionId: string;
  readonly state: SubmissionState;
  readonly eventCursor: number;
  readonly eventsUrl: string;
  readonly replayed: boolean;
}

export interface OfficialSubmissionCancellation {
  readonly submissionId: string;
  readonly state: SubmissionState;
  readonly changed: boolean;
}

export function parseOfficialSubmissionCreated(value: unknown, expectedOrigin: string): OfficialSubmissionCreated {
  const record = exactObject(value, ["eventCursor", "eventsUrl", "replayed", "state", "submissionId"], "Official submission response");
  if (typeof record.submissionId !== "string" || !SUBMISSION_UUID_PATTERN.test(record.submissionId)) {
    throw new TypeError("Official submission identity is invalid.");
  }
  if (!Number.isSafeInteger(record.eventCursor) || (record.eventCursor as number) < 0) {
    throw new TypeError("Official submission cursor is invalid.");
  }
  if (typeof record.replayed !== "boolean" || typeof record.eventsUrl !== "string") {
    throw new TypeError("Official submission response is invalid.");
  }
  const eventsUrl = validatedEventsUrl(record.eventsUrl, record.submissionId, validatedOrigin(expectedOrigin));
  return {
    submissionId: record.submissionId,
    state: parseSubmissionState(record.state),
    eventCursor: record.eventCursor as number,
    eventsUrl: eventsUrl.toString(),
    replayed: record.replayed,
  };
}

export function parseOfficialSubmissionCancellation(value: unknown, expectedSubmissionId: string): OfficialSubmissionCancellation {
  const record = exactObject(value, ["changed", "state", "submissionId"], "Official submission cancellation");
  if (
    typeof record.submissionId !== "string"
    || record.submissionId !== expectedSubmissionId
    || !SUBMISSION_UUID_PATTERN.test(record.submissionId)
    || typeof record.changed !== "boolean"
  ) throw new TypeError("Official submission cancellation is invalid.");
  return {
    submissionId: record.submissionId,
    state: parseSubmissionState(record.state),
    changed: record.changed,
  };
}

export type SubmissionPollingConnectionState =
  | "replaying"
  | "connected"
  | "disconnected"
  | "reconnecting"
  | "completed"
  | "error";

export interface SubmissionPollingStatus {
  readonly state: SubmissionPollingConnectionState;
  readonly cursor: number;
  readonly reconnectAttempt: number;
  readonly reason?: string;
}

export type SubmissionEventPollingResult =
  | { readonly kind: "terminal"; readonly state: SubmissionState; readonly cursor: number }
  | { readonly kind: "disconnected"; readonly cursor: number; readonly reason: string };

interface FocusEventTarget {
  addEventListener(type: "focus", listener: () => void): void;
  removeEventListener(type: "focus", listener: () => void): void;
}

export interface SubmissionEventPollingOptions {
  readonly eventsUrl: string;
  readonly initialCursor?: number;
  readonly fetch?: typeof globalThis.fetch;
  readonly focusTarget?: FocusEventTarget | null;
  readonly onEvent: (event: SequencedSubmissionEvent) => void;
  readonly onStatus?: (status: SubmissionPollingStatus) => void;
}

export class SubmissionEventPollingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SubmissionEventPollingError";
  }
}

class SubmissionEventProtocolError extends SubmissionEventPollingError {
  constructor(message: string) {
    super(message);
    this.name = "SubmissionEventProtocolError";
  }
}

class SubmissionEventTransportError extends SubmissionEventPollingError {
  constructor(message: string) {
    super(message);
    this.name = "SubmissionEventTransportError";
  }
}

function validatedEndpoint(eventsUrl: string): URL {
  const events = new URL(eventsUrl);
  if (
    !["http:", "https:"].includes(events.protocol)
    || events.username
    || events.password
    || events.hash
    || events.search
    || !events.pathname.endsWith("/events")
  ) throw new TypeError("Submission event endpoint is invalid.");
  return events;
}

function withCursor(url: URL, cursor: number): string {
  const next = new URL(url);
  next.searchParams.set("after", String(cursor));
  return next.toString();
}

function defaultFocusTarget(): FocusEventTarget | null {
  return typeof window === "undefined" ? null : window;
}

/** Polls the durable D1 event log from an opaque, monotonically increasing cursor. */
export class SubmissionEventPollingClient {
  private readonly eventsUrl: URL;
  private readonly fetchImplementation: typeof globalThis.fetch;
  private readonly focusTarget: FocusEventTarget | null;
  private readonly onEvent: (event: SequencedSubmissionEvent) => void;
  private readonly onStatus?: (status: SubmissionPollingStatus) => void;
  private readonly onFocus = (): void => {
    this.idleBackoffIndex = 0;
    this.wake();
  };
  private cursorValue: number;
  private terminalState?: SubmissionState;
  private stoppedReason?: string;
  private activeAbort?: AbortController;
  private delayTimer?: ReturnType<typeof setTimeout>;
  private delayResolve?: () => void;
  private started = false;
  private idleBackoffIndex = 0;

  constructor(options: SubmissionEventPollingOptions) {
    if (!Number.isSafeInteger(options.initialCursor ?? 0) || (options.initialCursor ?? 0) < 0) {
      throw new TypeError("Initial submission cursor is invalid.");
    }
    this.eventsUrl = validatedEndpoint(options.eventsUrl);
    this.cursorValue = options.initialCursor ?? 0;
    this.fetchImplementation = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.focusTarget = options.focusTarget === undefined ? defaultFocusTarget() : options.focusTarget;
    this.onEvent = options.onEvent;
    this.onStatus = options.onStatus;
  }

  get cursor(): number {
    return this.cursorValue;
  }

  stop(reason = "stopped"): void {
    if (!this.stoppedReason) this.stoppedReason = reason;
    this.activeAbort?.abort();
    this.wake();
  }

  private wake(): void {
    this.delayResolve?.();
  }

  private wait(delayMs: number): Promise<void> {
    if (this.stoppedReason) return Promise.resolve();
    return new Promise((resolve) => {
      const finish = (): void => {
        if (this.delayTimer !== undefined) clearTimeout(this.delayTimer);
        this.delayTimer = undefined;
        this.delayResolve = undefined;
        resolve();
      };
      this.delayResolve = finish;
      this.delayTimer = setTimeout(finish, delayMs);
    });
  }

  private status(state: SubmissionPollingConnectionState, reconnectAttempt: number, reason?: string): void {
    this.onStatus?.({ state, cursor: this.cursorValue, reconnectAttempt, ...(reason ? { reason } : {}) });
  }

  private accept(event: SequencedSubmissionEvent): void {
    if (event.sequence <= this.cursorValue) return;
    try {
      this.onEvent(event);
    } catch (error) {
      throw new SubmissionEventProtocolError(error instanceof Error ? `Submission event consumer failed: ${error.message}` : "Submission event consumer failed.");
    }
    this.cursorValue = event.sequence;
  }

  private async poll(): Promise<{ readonly advanced: boolean; readonly fullPage: boolean }> {
    const cursorBeforePoll = this.cursorValue;
    this.activeAbort = new AbortController();
    let response: Response;
    try {
      response = await this.fetchImplementation(withCursor(this.eventsUrl, this.cursorValue), {
        method: "GET",
        credentials: "same-origin",
        headers: { accept: "application/json" },
        signal: this.activeAbort.signal,
      });
    } catch (error) {
      if (this.stoppedReason) return { advanced: false, fullPage: false };
      throw new SubmissionEventTransportError(error instanceof Error ? `Submission event poll failed: ${error.message}` : "Submission event poll failed.");
    } finally {
      this.activeAbort = undefined;
    }
    if (!response.ok) {
      const message = `Submission event poll failed with HTTP ${response.status}.`;
      if (response.status === 429 || response.status >= 500) throw new SubmissionEventTransportError(message);
      throw new SubmissionEventProtocolError(message);
    }
    let replay;
    try {
      replay = parseSubmissionEventReplay(await response.json());
    } catch (error) {
      throw new SubmissionEventProtocolError(error instanceof Error ? error.message : "Submission event replay is invalid.");
    }
    if (replay.nextCursor < this.cursorValue) {
      throw new SubmissionEventProtocolError("Submission event replay moved its cursor backwards.");
    }
    for (const event of replay.events) this.accept(event);
    if (replay.nextCursor < this.cursorValue) {
      throw new SubmissionEventProtocolError("Submission event replay cursor does not include all events.");
    }
    this.cursorValue = replay.nextCursor;
    const fullPage = replay.events.length === 100;
    if (!fullPage && isTerminalSubmissionState(replay.summary.state)) this.terminalState = replay.summary.state;
    return { advanced: this.cursorValue > cursorBeforePoll, fullPage };
  }

  async run(): Promise<SubmissionEventPollingResult> {
    if (this.started) throw new TypeError("Submission event polling client can only run once.");
    this.started = true;
    let failureCount = 0;
    let firstPoll = true;
    this.focusTarget?.addEventListener("focus", this.onFocus);
    try {
      while (!this.stoppedReason) {
        this.status(firstPoll ? "replaying" : "connected", failureCount);
        try {
          const { advanced, fullPage } = await this.poll();
          if (this.stoppedReason) break;
          failureCount = 0;
          firstPoll = false;
          this.status("connected", 0);
          if (this.terminalState) {
            this.status("completed", 0);
            return { kind: "terminal", state: this.terminalState, cursor: this.cursorValue };
          }
          if (!fullPage) {
            if (advanced) this.idleBackoffIndex = 0;
            const delay = POLL_BACKOFF_MS[this.idleBackoffIndex]!;
            if (!advanced) this.idleBackoffIndex = Math.min(this.idleBackoffIndex + 1, POLL_BACKOFF_MS.length - 1);
            await this.wait(delay);
          }
        } catch (error) {
          if (this.stoppedReason) break;
          if (error instanceof SubmissionEventProtocolError) throw error;
          failureCount += 1;
          const reason = error instanceof Error ? error.message : "event polling transport failed";
          this.status("disconnected", failureCount - 1, reason);
          this.status("reconnecting", failureCount);
          await this.wait(POLL_BACKOFF_MS[Math.min(failureCount - 1, POLL_BACKOFF_MS.length - 1)]!);
          firstPoll = false;
        }
      }
      const reason = this.stoppedReason ?? "stopped";
      this.status("disconnected", failureCount, reason);
      return { kind: "disconnected", cursor: this.cursorValue, reason };
    } catch (error) {
      const pollingError = error instanceof SubmissionEventPollingError
        ? error
        : new SubmissionEventPollingError(error instanceof Error ? error.message : "Submission event polling failed.");
      this.status("error", failureCount, pollingError.message);
      throw pollingError;
    } finally {
      this.focusTarget?.removeEventListener("focus", this.onFocus);
      this.activeAbort?.abort();
      this.wake();
    }
  }
}
