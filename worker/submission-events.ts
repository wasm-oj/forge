import {
  assertSubmissionTransition,
  isTerminalSubmissionState,
  parseSequencedSubmissionEvent,
  parseSubmissionState,
  publicSubmissionEvent,
  type SequencedSubmissionEvent,
  type SubmissionEventPayload,
  type SubmissionState,
} from "../src/online-judge/contracts";
import { sha256Hex } from "./crypto";
import type { ForgeWorkerEnv } from "./env";
import { ApiError } from "./http";

const TERMINAL_SQL = "'completed','compile-error','judge-error','infrastructure-error','cancelled'";

interface SubmissionEventRow {
  readonly id: number;
  readonly payload_json: string;
  readonly created_at: string;
}

export interface AppendSubmissionEventInput {
  readonly submissionId: string;
  readonly attempt: number;
  readonly attemptTokenHash: string;
  readonly eventKey: string;
  readonly event: unknown;
  readonly now?: Date;
}

export interface AppendedSubmissionEvent {
  readonly event: SequencedSubmissionEvent;
  readonly duplicate: boolean;
}

function eventFromRow(row: SubmissionEventRow): SequencedSubmissionEvent {
  let payload: unknown;
  try {
    payload = JSON.parse(row.payload_json) as unknown;
  } catch {
    throw new Error("Stored submission event payload is not valid JSON.");
  }
  return parseSequencedSubmissionEvent({
    ...publicSubmissionEvent(payload),
    sequence: row.id,
    timestamp: row.created_at,
  });
}

function validateEventKey(value: string): void {
  if (!value || value.length > 200 || !/^[A-Za-z0-9:._-]+$/.test(value)) {
    throw new TypeError("Submission event key is invalid.");
  }
}

async function existingEvent(
  env: ForgeWorkerEnv,
  submissionId: string,
  eventKey: string,
): Promise<SubmissionEventRow | null> {
  return env.DB.prepare(
    "SELECT id, payload_json, created_at FROM submission_events WHERE submission_id=? AND event_key=?",
  ).bind(submissionId, eventKey).first<SubmissionEventRow>();
}

async function currentSubmissionState(
  env: ForgeWorkerEnv,
  submissionId: string,
): Promise<SubmissionState> {
  const row = await env.DB.prepare("SELECT state FROM submissions WHERE id=?")
    .bind(submissionId).first<{ readonly state: unknown }>();
  if (!row) throw new ApiError(404, "submission-not-found", "Submission does not exist.");
  return parseSubmissionState(row.state);
}

export async function containerSubmissionEventKey(
  attempt: number,
  event: SubmissionEventPayload,
): Promise<string> {
  return `container:${attempt}:${await sha256Hex(new TextEncoder().encode(JSON.stringify(event)))}`;
}

export async function appendAuthorizedSubmissionEvent(
  env: ForgeWorkerEnv,
  input: AppendSubmissionEventInput,
): Promise<AppendedSubmissionEvent> {
  if (!Number.isSafeInteger(input.attempt) || input.attempt < 1 || !/^[0-9a-f]{64}$/.test(input.attemptTokenHash)) {
    throw new TypeError("Submission attempt authorization is invalid.");
  }
  validateEventKey(input.eventKey);
  const payload = publicSubmissionEvent(input.event);
  const payloadJson = JSON.stringify(payload);
  const timestamp = (input.now ?? new Date()).toISOString();
  const before = await currentSubmissionState(env, input.submissionId);

  let stateUpdate: D1PreparedStatement | undefined;
  let requiredState: SubmissionState | undefined;
  if (payload.kind === "state" && payload.state) {
    requiredState = payload.state;
    if (before !== payload.state) {
      if (isTerminalSubmissionState(before)) {
        throw new ApiError(409, "submission-terminal", "No event may be appended after a terminal state.");
      }
      assertSubmissionTransition(before, payload.state);
    }
    stateUpdate = env.DB.prepare(`UPDATE submissions
       SET state=?, updated_at=?
     WHERE id=? AND state=?
       AND EXISTS (
         SELECT 1 FROM submission_attempts
          WHERE submission_id=? AND attempt=? AND token_hash=?
            AND attempt=(SELECT MAX(latest.attempt) FROM submission_attempts AS latest WHERE latest.submission_id=?)
       )`).bind(payload.state, timestamp, input.submissionId, before, input.submissionId, input.attempt, input.attemptTokenHash, input.submissionId);
  } else if (isTerminalSubmissionState(before)) {
    throw new ApiError(409, "submission-terminal", "No event may be appended after a terminal state.");
  }

  const insertion = env.DB.prepare(`INSERT INTO submission_events
      (submission_id, event_key, payload_json, created_at)
    SELECT ?, ?, ?, ?
     WHERE EXISTS (
       SELECT 1 FROM submissions
        WHERE id=?
          AND state ${requiredState ? "=?" : `NOT IN (${TERMINAL_SQL})`}
          AND EXISTS (
            SELECT 1 FROM submission_attempts
             WHERE submission_id=submissions.id AND attempt=? AND token_hash=?
               AND attempt=(SELECT MAX(latest.attempt) FROM submission_attempts AS latest WHERE latest.submission_id=submissions.id)
          )
     )
    ON CONFLICT(submission_id, event_key) DO NOTHING`)
    .bind(
      input.submissionId,
      input.eventKey,
      payloadJson,
      timestamp,
      input.submissionId,
      ...(requiredState ? [requiredState] : []),
      input.attempt,
      input.attemptTokenHash,
    );

  const results = await env.DB.batch(stateUpdate ? [stateUpdate, insertion] : [insertion]);
  const inserted = results.at(-1)?.meta.changes === 1;
  const stored = await existingEvent(env, input.submissionId, input.eventKey);
  if (!stored) {
    throw new ApiError(409, "submission-event-rejected", "Submission event lost its state or attempt fence.");
  }
  if (stored.payload_json !== payloadJson) {
    throw new ApiError(409, "submission-event-conflict", "Submission event key is already bound to another payload.");
  }
  return { event: eventFromRow(stored), duplicate: !inserted };
}

export function prepareSubmissionEventInsert(
  database: D1Database,
  input: {
    readonly submissionId: string;
    readonly eventKey: string;
    readonly event: unknown;
    readonly timestamp: string;
    readonly requiredState: SubmissionState;
    readonly requiredAttempt?: number;
    readonly requiredOwnerUserId?: string;
  },
): D1PreparedStatement {
  validateEventKey(input.eventKey);
  if (Number.isNaN(Date.parse(input.timestamp)) || new Date(input.timestamp).toISOString() !== input.timestamp) {
    throw new TypeError("Submission event timestamp is invalid.");
  }
  const payload = publicSubmissionEvent(input.event);
  const attemptFence = input.requiredAttempt === undefined
    ? ""
    : " AND effective_attempt=?";
  const ownerFence = input.requiredOwnerUserId === undefined
    ? ""
    : " AND user_id=?";
  return database.prepare(`INSERT INTO submission_events
      (submission_id, event_key, payload_json, created_at)
    SELECT ?, ?, ?, ?
     WHERE EXISTS (
       SELECT 1 FROM submissions WHERE id=? AND state=?${attemptFence}${ownerFence}
     )
    ON CONFLICT(submission_id, event_key) DO NOTHING`)
    .bind(
      input.submissionId,
      input.eventKey,
      JSON.stringify(payload),
      input.timestamp,
      input.submissionId,
      input.requiredState,
      ...(input.requiredAttempt === undefined ? [] : [input.requiredAttempt]),
      ...(input.requiredOwnerUserId === undefined ? [] : [input.requiredOwnerUserId]),
    );
}

export async function replaySubmissionEvents(
  env: ForgeWorkerEnv,
  submissionId: string,
  after: number,
  limit = 100,
): Promise<readonly SequencedSubmissionEvent[]> {
  const rows = await env.DB.prepare(`SELECT id, payload_json, created_at
      FROM submission_events
     WHERE submission_id=? AND id>?
     ORDER BY id ASC
     LIMIT ?`)
    .bind(submissionId, after, limit).all<SubmissionEventRow>();
  return rows.results.map(eventFromRow);
}

export async function latestSubmissionEventCursor(
  env: ForgeWorkerEnv,
  submissionId: string,
): Promise<number> {
  const row = await env.DB.prepare(
    "SELECT COALESCE(MAX(id), 0) AS cursor FROM submission_events WHERE submission_id=?",
  ).bind(submissionId).first<{ readonly cursor: number }>();
  return row?.cursor ?? 0;
}

export async function terminalizeSubmissionWithEvent(
  env: ForgeWorkerEnv,
  input: {
    readonly submissionId: string;
    readonly state: SubmissionState;
    readonly eventKey: string;
    readonly ownerUserId?: string;
    readonly now?: Date;
  },
): Promise<{ readonly changed: boolean; readonly eventCursor: number }> {
  if (!isTerminalSubmissionState(input.state)) throw new TypeError("Terminal submission state is required.");
  validateEventKey(input.eventKey);
  const timestamp = (input.now ?? new Date()).toISOString();
  const ownerFence = input.ownerUserId === undefined ? "" : " AND user_id=?";
  const update = env.DB.prepare(`UPDATE submissions
      SET state=?, updated_at=?, completed_at=COALESCE(completed_at, ?)
    WHERE id=?${ownerFence}
      AND state NOT IN (${TERMINAL_SQL})`)
    .bind(input.state, timestamp, timestamp, input.submissionId, ...(input.ownerUserId === undefined ? [] : [input.ownerUserId]));
  const insertion = prepareSubmissionEventInsert(env.DB, {
    submissionId: input.submissionId,
    eventKey: input.eventKey,
    event: { kind: "state", state: input.state },
    timestamp,
    requiredState: input.state,
    requiredOwnerUserId: input.ownerUserId,
  });
  const [updated] = await env.DB.batch([update, insertion]);
  const row = await env.DB.prepare("SELECT state, user_id FROM submissions WHERE id=?")
    .bind(input.submissionId).first<{ readonly state: string; readonly user_id: string }>();
  if (!row) throw new ApiError(404, "submission-not-found", "Submission does not exist.");
  if (input.ownerUserId !== undefined && row.user_id !== input.ownerUserId) {
    throw new ApiError(404, "submission-not-found", "Submission does not exist.");
  }
  if (row.state !== input.state) {
    throw new ApiError(409, "submission-terminal", "Submission already has a different terminal state.");
  }
  const event = await existingEvent(env, input.submissionId, input.eventKey);
  if (!event) throw new Error("Terminal submission event was not persisted.");
  return { changed: updated?.meta.changes === 1, eventCursor: event.id };
}
