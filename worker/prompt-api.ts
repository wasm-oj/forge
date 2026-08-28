import { requireBrowserOrBearerMutationSession, requireSession } from "./auth";
import type { WasmOjWorkerEnv } from "./env";
import { requireStagingFormalAccess } from "./formal-access";
import { requireFormalMutationsEnabled } from "./formal-mutations";
import { ApiError, jsonResponse, readJsonBody } from "./http";
import { PromptAttemptService } from "./prompt-attempts";
import { hostPromptCompilerRegistry } from "./prompt-compiler-registry";
import { createPromptAttemptHost } from "./submissions";
import { lookupWorkflowInstance } from "./workflow-instance-status";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA256 = /^[0-9a-f]{64}$/;

interface PromptCreateBody {
  readonly contestId: string;
  readonly problemId: string;
  readonly timelineGeneration: number;
  readonly rulesEpoch: number;
  readonly problemEpoch: number;
  readonly publicContextSha256: string;
  readonly prompt: string;
  readonly idempotencyKey: string;
}

function exactObject(value: unknown, keys: readonly string[], label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ApiError(400, "prompt-request-invalid", `${label} must be an object.`);
  const input = value as Record<string, unknown>;
  if (JSON.stringify(Object.keys(input).sort()) !== JSON.stringify([...keys].sort())) {
    throw new ApiError(400, "prompt-request-invalid", `${label} has an invalid shape.`);
  }
  return input;
}

function parseCreateBody(value: unknown): PromptCreateBody {
  const input = exactObject(value, [
    "contestId", "idempotencyKey", "problemEpoch", "problemId", "prompt",
    "publicContextSha256", "rulesEpoch", "timelineGeneration",
  ], "Prompt attempt request");
  if (typeof input.contestId !== "string" || !UUID.test(input.contestId)) throw new ApiError(400, "contest-id-invalid", "contestId must be a UUID.");
  if (typeof input.problemId !== "string" || !UUID.test(input.problemId)) throw new ApiError(400, "problem-id-invalid", "problemId must be a UUID.");
  if (typeof input.publicContextSha256 !== "string" || !SHA256.test(input.publicContextSha256)) throw new ApiError(400, "prompt-context-invalid", "publicContextSha256 must be a SHA-256 digest.");
  if (typeof input.prompt !== "string") throw new ApiError(400, "prompt-invalid", "prompt must be a UTF-8 string.");
  const epoch = (candidate: unknown, label: string): number => {
    if (!Number.isSafeInteger(candidate) || (candidate as number) < 1) throw new ApiError(400, "contest-epoch-invalid", `${label} must be a positive integer.`);
    return candidate as number;
  };
  if (typeof input.idempotencyKey !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$/.test(input.idempotencyKey)) {
    throw new ApiError(400, "prompt-idempotency-key-invalid", "idempotencyKey is invalid.");
  }
  return {
    contestId: input.contestId,
    problemId: input.problemId,
    timelineGeneration: epoch(input.timelineGeneration, "timelineGeneration"),
    rulesEpoch: epoch(input.rulesEpoch, "rulesEpoch"),
    problemEpoch: epoch(input.problemEpoch, "problemEpoch"),
    publicContextSha256: input.publicContextSha256,
    prompt: input.prompt,
    idempotencyKey: input.idempotencyKey,
  };
}

function readService(env: WasmOjWorkerEnv): PromptAttemptService {
  return new PromptAttemptService({
    database: env.DB,
    registry: hostPromptCompilerRegistry(),
    host: createPromptAttemptHost(env),
  });
}

export async function createPromptAttempt(request: Request, env: WasmOjWorkerEnv): Promise<Response> {
  const session = await requireBrowserOrBearerMutationSession(request, env);
  await requireStagingFormalAccess(env, session.userId);
  const input = parseCreateBody(await readJsonBody(request, 128 * 1024));
  await requireFormalMutationsEnabled(env, request);
  const attemptId = crypto.randomUUID();
  const service = readService(env);
  const reservation = await service.reserve({ ownerUserId: session.userId, ...input }, attemptId);
  const reservedAttemptId = reservation.attempt.attemptId;
  const base = new URL(request.url);
  base.pathname = `/api/prompt-attempts/${reservedAttemptId}`;
  base.search = "";
  if (reservation.created) {
    let workflowExists = false;
    try {
      await env.PROMPT_ATTEMPT_WORKFLOW.create({
        id: reservedAttemptId,
        params: { attemptId: reservedAttemptId },
      });
      workflowExists = true;
    } catch {
      try {
        workflowExists = (await lookupWorkflowInstance(
          env.PROMPT_ATTEMPT_WORKFLOW,
          reservedAttemptId,
        )).found;
      } catch {
        // The durable pending dispatch is the authority when Workflow status is unavailable.
      }
    }
    if (workflowExists) {
      try {
        await service.markWorkflowDispatched(reservedAttemptId);
      } catch {
        // The deterministic Workflow ID lets the scheduled dispatcher repair this lost acknowledgement.
      }
    }
  }
  return jsonResponse({
    promptAttemptId: reservedAttemptId,
    state: reservation.attempt.state,
    replayed: !reservation.created,
    detailUrl: base.toString(),
    eventsUrl: `${base.toString()}/events`,
  }, 202);
}

export async function getPromptAttempt(
  request: Request,
  env: WasmOjWorkerEnv,
  attemptId: string,
): Promise<Response> {
  const session = await requireSession(request, env);
  return jsonResponse({ promptAttempt: await readService(env).detail(attemptId, session.userId) });
}

export async function getPromptAttemptEvents(
  request: Request,
  env: WasmOjWorkerEnv,
  attemptId: string,
): Promise<Response> {
  const session = await requireSession(request, env);
  const raw = new URL(request.url).searchParams.get("after") ?? "0";
  if (!/^(?:0|[1-9][0-9]*)$/.test(raw) || !Number.isSafeInteger(Number(raw))) {
    throw new ApiError(400, "cursor-invalid", "after must be a non-negative safe integer.");
  }
  const after = Number(raw);
  const events = await readService(env).events({ ownerUserId: session.userId, attemptId, after });
  return jsonResponse({ events, nextCursor: events.at(-1)?.sequence ?? after });
}

export async function listPromptAttempts(request: Request, env: WasmOjWorkerEnv): Promise<Response> {
  const session = await requireSession(request, env);
  const url = new URL(request.url);
  const contestId = url.searchParams.get("contestId");
  const problemId = url.searchParams.get("problemId") ?? undefined;
  if (!contestId || !UUID.test(contestId)) throw new ApiError(400, "contest-id-invalid", "contestId must be a UUID.");
  if (problemId && !UUID.test(problemId)) throw new ApiError(400, "problem-id-invalid", "problemId must be a UUID.");
  const history = await readService(env).history({ ownerUserId: session.userId, contestId, problemId });
  return jsonResponse({ promptAttempts: history });
}
