import { afterEach, describe, expect, it, vi } from "vitest";
import type { SequencedSubmissionEvent, SubmissionState } from "./contracts";
import {
  SubmissionEventPollingClient,
  SubmissionEventPollingError,
  parseOfficialSubmissionCancellation,
  parseOfficialSubmissionCreated,
  type SubmissionPollingConnectionState,
} from "./submission-event-polling";

const SUBMISSION_ID = "018f0d8a-7110-7cc8-9f08-15b28df8307b";
const EVENTS_URL = `https://judge.example/api/submissions/${SUBMISSION_ID}/events`;
const TIMESTAMP = "2026-08-09T01:02:03.000Z";

function event(sequence: number, payload: Record<string, unknown>): SequencedSubmissionEvent {
  return { ...payload, sequence, timestamp: TIMESTAMP } as unknown as SequencedSubmissionEvent;
}

function replay(events: readonly SequencedSubmissionEvent[], nextCursor: number, state: SubmissionState): Response {
  return Response.json({
    events,
    nextCursor,
    summary: {
      state,
      verdict: state === "completed" ? "accepted" : null,
      score: state === "completed" ? 100 : null,
      fullyPassedCases: state === "completed" ? 1 : null,
      deterministicCost: state === "completed" ? 10 : null,
      peakMemoryBytes: state === "completed" ? 65_536 : null,
      updatedAt: TIMESTAMP,
      completedAt: state === "completed" || state === "cancelled" ? TIMESTAMP : null,
    },
  });
}

class FakeFocusTarget {
  private listener?: () => void;

  addEventListener(type: "focus", listener: () => void): void {
    if (type === "focus") this.listener = listener;
  }

  removeEventListener(type: "focus", listener: () => void): void {
    if (type === "focus" && this.listener === listener) this.listener = undefined;
  }

  focus(): void {
    this.listener?.();
  }
}

afterEach(() => {
  vi.useRealTimers();
});

describe("official submission event polling client", () => {
  it("parses the exact admission and cancellation API projections", () => {
    expect(parseOfficialSubmissionCreated({
      submissionId: SUBMISSION_ID,
      state: "queued",
      eventCursor: 12,
      eventsUrl: EVENTS_URL,
      replayed: false,
    }, "https://judge.example")).toEqual({
      submissionId: SUBMISSION_ID,
      state: "queued",
      eventCursor: 12,
      eventsUrl: EVENTS_URL,
      replayed: false,
    });
    expect(parseOfficialSubmissionCancellation({ submissionId: SUBMISSION_ID, state: "cancelled", changed: true }, SUBMISSION_ID)).toEqual({
      submissionId: SUBMISSION_ID,
      state: "cancelled",
      changed: true,
    });
    expect(() => parseOfficialSubmissionCreated({
      submissionId: SUBMISSION_ID,
      state: "queued",
      eventCursor: 12,
      eventsUrl: "https://attacker.example/events",
      replayed: false,
    }, "https://judge.example")).toThrow("events URL");
    expect(() => parseOfficialSubmissionCancellation({ submissionId: SUBMISSION_ID, state: "cancelled", changed: true, output: "secret" }, SUBMISSION_ID)).toThrow("shape");
  });

  it("polls immediately, accepts non-contiguous cursors, and stops at a terminal state", async () => {
    vi.useFakeTimers();
    const observed: number[] = [];
    const requestedCursors: string[] = [];
    const statuses: SubmissionPollingConnectionState[] = [];
    let calls = 0;
    const client = new SubmissionEventPollingClient({
      eventsUrl: EVENTS_URL,
      focusTarget: null,
      fetch: vi.fn(async (url: string | URL | Request) => {
        requestedCursors.push(new URL(String(url)).searchParams.get("after") ?? "");
        calls += 1;
        return calls === 1
          ? replay([
            event(4, { kind: "state", state: "queued" }),
            event(9, { kind: "compile-progress", phase: "compile" }),
          ], 12, "compiling")
          : replay([event(17, { kind: "state", state: "completed" })], 17, "completed");
      }) as unknown as typeof fetch,
      onEvent: ({ sequence }) => observed.push(sequence),
      onStatus: ({ state }) => statuses.push(state),
    });

    const running = client.run();
    await vi.advanceTimersByTimeAsync(1_000);

    await expect(running).resolves.toEqual({ kind: "terminal", state: "completed", cursor: 17 });
    expect(requestedCursors).toEqual(["0", "12"]);
    expect(observed).toEqual([4, 9, 17]);
    expect(statuses).toEqual(expect.arrayContaining(["replaying", "connected", "completed"]));
  });

  it("uses 1/2/5/10 second transport backoff and retries from the same cursor", async () => {
    vi.useFakeTimers();
    const requestedCursors: string[] = [];
    const statuses: SubmissionPollingConnectionState[] = [];
    let calls = 0;
    const client = new SubmissionEventPollingClient({
      eventsUrl: EVENTS_URL,
      focusTarget: null,
      fetch: vi.fn(async (url: string | URL | Request) => {
        requestedCursors.push(new URL(String(url)).searchParams.get("after") ?? "");
        calls += 1;
        if (calls <= 6) return new Response(null, { status: 503 });
        return replay([event(21, { kind: "state", state: "completed" })], 21, "completed");
      }) as unknown as typeof fetch,
      onEvent: () => undefined,
      onStatus: ({ state }) => statuses.push(state),
    });

    const running = client.run();
    await vi.advanceTimersByTimeAsync(0);
    for (const delay of [1_000, 2_000, 5_000, 10_000, 10_000, 10_000]) {
      await vi.advanceTimersByTimeAsync(delay);
    }

    await expect(running).resolves.toEqual({ kind: "terminal", state: "completed", cursor: 21 });
    expect(requestedCursors).toEqual(Array.from({ length: 7 }, () => "0"));
    expect(statuses.filter((state) => state === "reconnecting")).toHaveLength(6);
  });

  it("backs off unchanged polls through 1/2/5/10 seconds and resets after an event", async () => {
    vi.useFakeTimers();
    let calls = 0;
    const client = new SubmissionEventPollingClient({
      eventsUrl: EVENTS_URL,
      focusTarget: null,
      fetch: vi.fn(async () => {
        calls += 1;
        if (calls <= 4) return replay([], 0, "running");
        if (calls === 5) return replay([event(1, { kind: "case-progress", completedCases: 1, totalCases: 2 })], 1, "running");
        return replay([event(2, { kind: "state", state: "completed" })], 2, "completed");
      }) as unknown as typeof fetch,
      onEvent: () => undefined,
    });

    const running = client.run();
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toBe(1);
    for (const [delay, expectedCalls] of [[1_000, 2], [2_000, 3], [5_000, 4], [10_000, 5], [1_000, 6]] as const) {
      await vi.advanceTimersByTimeAsync(delay);
      expect(calls).toBe(expectedCalls);
    }
    await expect(running).resolves.toMatchObject({ kind: "terminal", cursor: 2 });
  });

  it("polls immediately when the window regains focus", async () => {
    vi.useFakeTimers();
    const focusTarget = new FakeFocusTarget();
    let calls = 0;
    const client = new SubmissionEventPollingClient({
      eventsUrl: EVENTS_URL,
      focusTarget,
      fetch: vi.fn(async () => {
        calls += 1;
        return calls === 1
          ? replay([], 0, "queued")
          : replay([event(8, { kind: "state", state: "completed" })], 8, "completed");
      }) as unknown as typeof fetch,
      onEvent: () => undefined,
    });

    const running = client.run();
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toBe(1);
    focusTarget.focus();
    await vi.advanceTimersByTimeAsync(0);

    await expect(running).resolves.toEqual({ kind: "terminal", state: "completed", cursor: 8 });
    expect(calls).toBe(2);
  });

  it("stops from the authoritative terminal state even when no historical events exist", async () => {
    const client = new SubmissionEventPollingClient({
      eventsUrl: EVENTS_URL,
      focusTarget: null,
      initialCursor: 30,
      fetch: vi.fn(async () => replay([], 30, "cancelled")) as unknown as typeof fetch,
      onEvent: () => undefined,
    });

    await expect(client.run()).resolves.toEqual({ kind: "terminal", state: "cancelled", cursor: 30 });
  });

  it("drains a full event page immediately before accepting the terminal database state", async () => {
    const firstPage = Array.from({ length: 100 }, (_, index) => event(index + 1, {
      kind: "compile-progress",
      phase: `compile-${index + 1}`,
    }));
    const observed: number[] = [];
    const requestedCursors: string[] = [];
    let calls = 0;
    const fetchImplementation = vi.fn(async (url: string | URL | Request) => {
      requestedCursors.push(new URL(String(url)).searchParams.get("after") ?? "");
      calls += 1;
      return calls === 1
        ? replay(firstPage, 100, "completed")
        : replay([
          event(104, { kind: "resource-summary", deterministicCost: 123, peakMemoryBytes: 456 }),
          event(109, { kind: "state", state: "completed" }),
        ], 109, "completed");
    });
    const client = new SubmissionEventPollingClient({
      eventsUrl: EVENTS_URL,
      focusTarget: null,
      fetch: fetchImplementation as unknown as typeof fetch,
      onEvent: ({ sequence }) => observed.push(sequence),
    });

    await expect(client.run()).resolves.toEqual({ kind: "terminal", state: "completed", cursor: 109 });
    expect(fetchImplementation).toHaveBeenCalledTimes(2);
    expect(requestedCursors).toEqual(["0", "100"]);
    expect(observed).toHaveLength(102);
    expect(observed.at(-1)).toBe(109);
  });

  it("fails closed on output-like event fields without retrying", async () => {
    const fetchImplementation = vi.fn(async () => Response.json({
      events: [{
        ...event(1, { kind: "case-progress", completedCases: 1, totalCases: 2 }),
        stdout: "hidden-case-canary",
      }],
      nextCursor: 1,
      summary: {
        state: "running",
        verdict: null,
        score: null,
        fullyPassedCases: null,
        deterministicCost: null,
        peakMemoryBytes: null,
        updatedAt: TIMESTAMP,
        completedAt: null,
      },
    }));
    const client = new SubmissionEventPollingClient({
      eventsUrl: EVENTS_URL,
      focusTarget: null,
      fetch: fetchImplementation as unknown as typeof fetch,
      onEvent: () => undefined,
    });

    await expect(client.run()).rejects.toThrow("invalid shape");
    expect(fetchImplementation).toHaveBeenCalledTimes(1);
  });

  it("does not advance the durable cursor when the event consumer fails", async () => {
    const client = new SubmissionEventPollingClient({
      eventsUrl: EVENTS_URL,
      focusTarget: null,
      fetch: vi.fn(async () => replay([event(14, { kind: "state", state: "queued" })], 14, "queued")) as unknown as typeof fetch,
      onEvent: () => { throw new Error("render failed"); },
    });

    await expect(client.run()).rejects.toThrow("consumer failed");
    expect(client.cursor).toBe(0);
  });

  it("treats non-retryable HTTP responses as protocol errors", async () => {
    const client = new SubmissionEventPollingClient({
      eventsUrl: EVENTS_URL,
      focusTarget: null,
      fetch: vi.fn(async () => new Response(null, { status: 404 })) as unknown as typeof fetch,
      onEvent: () => undefined,
    });

    await expect(client.run()).rejects.toBeInstanceOf(SubmissionEventPollingError);
  });
});
