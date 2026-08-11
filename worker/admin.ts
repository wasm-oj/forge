import { requireMutationSession, requireSession } from "./auth";
import type { AuthenticatedSession, ForgeWorkerEnv } from "./env";
import { ApiError, jsonResponse, readJsonBody } from "./http";
import { requireFirstOrganizerApplicationTurnstile, requireStagingFormalAccess } from "./formal-access";
import { formalMutationStatus, setFormalMutationsEnabled } from "./formal-mutations";

function requireAdmin(session: AuthenticatedSession): void {
  if (!session.roles.includes("admin")) throw new ApiError(403, "admin-required", "An Admin role is required.");
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ApiError(400, "payload-invalid", "Payload must be an object.");
  return value as Record<string, unknown>;
}

export async function createOrganizerApplication(request: Request, env: ForgeWorkerEnv): Promise<Response> {
  const session = await requireMutationSession(request, env);
  await requireStagingFormalAccess(env, session.userId);
  if (session.roles.includes("organizer") || session.roles.includes("admin")) {
    throw new ApiError(409, "organizer-already-approved", "This account already has Organizer access.");
  }
  await requireFirstOrganizerApplicationTurnstile(request, env, session.userId);
  const body = record(await readJsonBody(request, 16 * 1024));
  if (Object.keys(body).length !== 1 || typeof body.statement !== "string") throw new ApiError(400, "application-invalid", "Application must contain only a statement.");
  const statement = body.statement.trim();
  if (statement.length < 40 || statement.length > 4_000) throw new ApiError(400, "application-invalid", "Statement must contain 40–4,000 characters.");
  const id = crypto.randomUUID();
  try {
    await env.CORE_DB.prepare("INSERT INTO organizer_applications (id, user_id, statement, status, created_at) VALUES (?, ?, ?, 'pending', ?)")
      .bind(id, session.userId, statement, new Date().toISOString()).run();
  } catch (error) {
    const pending = await env.CORE_DB.prepare("SELECT id, status, created_at FROM organizer_applications WHERE user_id=? AND status='pending'")
      .bind(session.userId).first();
    if (pending) return jsonResponse({ application: pending, replayed: true });
    throw error;
  }
  return jsonResponse({ application: { id, status: "pending" }, replayed: false }, 201);
}

export async function listOrganizerApplications(request: Request, env: ForgeWorkerEnv): Promise<Response> {
  const session = await requireSession(request, env);
  requireAdmin(session);
  const status = new URL(request.url).searchParams.get("status") ?? "pending";
  if (!['pending', 'approved', 'rejected'].includes(status)) throw new ApiError(400, "application-status-invalid", "Application status is invalid.");
  const applications = await env.CORE_DB.prepare(
    "SELECT organizer_applications.id, organizer_applications.user_id, organizer_applications.statement, organizer_applications.status, organizer_applications.created_at, organizer_applications.reviewed_at, github_identities.login, github_identities.avatar_url FROM organizer_applications JOIN github_identities ON github_identities.user_id=organizer_applications.user_id WHERE organizer_applications.status=? ORDER BY organizer_applications.created_at ASC LIMIT 100",
  ).bind(status).all();
  return jsonResponse({ applications: applications.results });
}

export async function reviewOrganizerApplication(
  request: Request,
  env: ForgeWorkerEnv,
  applicationId: string,
): Promise<Response> {
  const session = await requireMutationSession(request, env);
  requireAdmin(session);
  const body = record(await readJsonBody(request, 8 * 1024));
  if (Object.keys(body).length !== 1 || (body.decision !== "approved" && body.decision !== "rejected")) {
    throw new ApiError(400, "review-invalid", "Review decision must be approved or rejected.");
  }
  const reviewedAt = new Date().toISOString();
  const statements = [
    env.CORE_DB.prepare("UPDATE organizer_applications SET status=?, reviewed_by=?, reviewed_at=? WHERE id=? AND status='pending'")
      .bind(body.decision, session.userId, reviewedAt, applicationId),
  ];
  if (body.decision === "approved") {
    statements.push(env.CORE_DB.prepare(
      "INSERT INTO user_roles (user_id, role, granted_at, granted_by) SELECT user_id, 'organizer', ?, ? FROM organizer_applications WHERE id=? AND status='approved' AND reviewed_by=? ON CONFLICT(user_id, role) DO NOTHING",
    ).bind(reviewedAt, session.userId, applicationId, session.userId));
  }
  const [updated] = await env.CORE_DB.batch(statements);
  if (updated.meta.changes !== 1) throw new ApiError(409, "application-not-pending", "Organizer application is not pending.");
  return jsonResponse({ applicationId, status: body.decision, reviewedAt });
}

export async function getFormalMutationControl(request: Request, env: ForgeWorkerEnv): Promise<Response> {
  const session = await requireSession(request, env);
  requireAdmin(session);
  return jsonResponse(await formalMutationStatus(env));
}

export async function updateFormalMutationControl(
  request: Request,
  env: ForgeWorkerEnv,
  enabled: boolean,
): Promise<Response> {
  const session = await requireMutationSession(request, env);
  requireAdmin(session);
  const body = record(await readJsonBody(request, 8 * 1024));
  if (Object.keys(body).length !== 1 || typeof body.reason !== "string") {
    throw new ApiError(400, "formal-mutation-control-invalid", "A reason is required.");
  }
  return jsonResponse(await setFormalMutationsEnabled(env, enabled, body.reason));
}
