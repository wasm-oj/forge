import { requireMutationSession, requireSession } from "./auth";
import type { AuthenticatedSession, WasmOjWorkerEnv } from "./env";
import { ApiError, jsonResponse, readJsonBody } from "./http";
import { requireFirstOrganizerApplicationTurnstile, requireStagingFormalAccess } from "./formal-access";
import { formalMutationStatus, setFormalMutationsEnabled } from "./formal-mutations";
import { parseReleaseManifest, releaseManifestBytes } from "../src/release-manifest";
import { sha256Hex } from "./crypto";
import { activateRelease, assertActiveRelease } from "./release";

function requireAdmin(session: AuthenticatedSession): void {
  if (!session.roles.includes("admin")) throw new ApiError(403, "admin-required", "An Admin role is required.");
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ApiError(400, "payload-invalid", "Payload must be an object.");
  return value as Record<string, unknown>;
}

export async function createOrganizerApplication(request: Request, env: WasmOjWorkerEnv): Promise<Response> {
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
    await env.DB.prepare("INSERT INTO organizer_applications (id, user_id, statement, status, created_at) VALUES (?, ?, ?, 'pending', ?)")
      .bind(id, session.userId, statement, new Date().toISOString()).run();
  } catch (error) {
    const pending = await env.DB.prepare("SELECT id, status, created_at FROM organizer_applications WHERE user_id=? AND status='pending'")
      .bind(session.userId).first();
    if (pending) return jsonResponse({ application: pending, replayed: true });
    throw error;
  }
  return jsonResponse({ application: { id, status: "pending" }, replayed: false }, 201);
}

export async function listOrganizerApplications(request: Request, env: WasmOjWorkerEnv): Promise<Response> {
  const session = await requireSession(request, env);
  requireAdmin(session);
  const status = new URL(request.url).searchParams.get("status") ?? "pending";
  if (!['pending', 'approved', 'rejected'].includes(status)) throw new ApiError(400, "application-status-invalid", "Application status is invalid.");
  const applications = await env.DB.prepare(
    `SELECT organizer_applications.id, organizer_applications.user_id, organizer_applications.statement,
      organizer_applications.status, organizer_applications.created_at, organizer_applications.reviewed_at,
      organizer_applications.review_note, github_identities.login, github_identities.avatar_url,
      EXISTS(SELECT 1 FROM user_roles WHERE user_roles.user_id=organizer_applications.user_id AND user_roles.role='organizer') AS organizer_role_active,
      EXISTS(SELECT 1 FROM user_roles WHERE user_roles.user_id=organizer_applications.user_id AND user_roles.role='admin') AS admin_role_active
    FROM organizer_applications
    JOIN github_identities ON github_identities.user_id=organizer_applications.user_id
    WHERE organizer_applications.status=?
    ORDER BY organizer_applications.created_at ASC LIMIT 100`,
  ).bind(status).all();
  return jsonResponse({ applications: applications.results });
}

export async function reviewOrganizerApplication(
  request: Request,
  env: WasmOjWorkerEnv,
  applicationId: string,
): Promise<Response> {
  const session = await requireMutationSession(request, env);
  requireAdmin(session);
  const body = record(await readJsonBody(request, 8 * 1024));
  if (body.decision !== "approved" && body.decision !== "rejected") {
    throw new ApiError(400, "review-invalid", "Review decision must be approved or rejected.");
  }
  const keys = Object.keys(body);
  let reviewNote: string | null = null;
  if (body.decision === "approved") {
    if (keys.length !== 1) throw new ApiError(400, "review-invalid", "Approved applications must not include a rejection reason.");
  } else {
    if (keys.length !== 2 || typeof body.reason !== "string") throw new ApiError(400, "review-invalid", "Rejected applications require a reason.");
    reviewNote = body.reason.trim();
    if (reviewNote.length < 10 || reviewNote.length > 1_000) throw new ApiError(400, "review-invalid", "Rejection reason must contain 10–1,000 characters.");
  }
  const reviewedAt = new Date().toISOString();
  const statements = [
    env.DB.prepare("UPDATE organizer_applications SET status=?, reviewed_by=?, reviewed_at=?, review_note=? WHERE id=? AND status='pending'")
      .bind(body.decision, session.userId, reviewedAt, reviewNote, applicationId),
  ];
  if (body.decision === "approved") {
    statements.push(env.DB.prepare(
      "INSERT INTO user_roles (user_id, role, granted_at, granted_by) SELECT user_id, 'organizer', ?, ? FROM organizer_applications WHERE id=? AND status='approved' AND reviewed_by=? ON CONFLICT(user_id, role) DO NOTHING",
    ).bind(reviewedAt, session.userId, applicationId, session.userId));
  }
  const [updated] = await env.DB.batch(statements);
  if (updated.meta.changes !== 1) throw new ApiError(409, "application-not-pending", "Organizer application is not pending.");
  return jsonResponse({ applicationId, status: body.decision, reviewedAt, reviewNote });
}

export async function revokeOrganizerRole(
  request: Request,
  env: WasmOjWorkerEnv,
  userId: string,
): Promise<Response> {
  const session = await requireMutationSession(request, env);
  requireAdmin(session);
  const body = record(await readJsonBody(request, 1_024));
  if (Object.keys(body).length !== 0) throw new ApiError(400, "revoke-invalid", "Organizer revocation payload must be empty.");
  const admin = await env.DB.prepare("SELECT 1 AS active FROM user_roles WHERE user_id=? AND role='admin'")
    .bind(userId).first();
  if (admin) throw new ApiError(409, "organizer-revoke-admin", "Admin accounts retain Organizer access and cannot be revoked here.");
  const result = await env.DB.prepare("DELETE FROM user_roles WHERE user_id=? AND role='organizer'")
    .bind(userId).run();
  return jsonResponse({
    userId,
    organizerRoleActive: false,
    effectiveOrganizerAccess: "revoked",
    changed: result.meta.changes === 1,
  });
}

export async function getFormalMutationControl(request: Request, env: WasmOjWorkerEnv): Promise<Response> {
  const session = await requireSession(request, env);
  requireAdmin(session);
  return jsonResponse(await formalMutationStatus(env));
}

export async function updateFormalMutationControl(
  request: Request,
  env: WasmOjWorkerEnv,
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

export async function activateProductionRelease(request: Request, env: WasmOjWorkerEnv): Promise<Response> {
  const session = await requireMutationSession(request, env);
  requireAdmin(session);
  const body = record(await readJsonBody(request, 300 * 1024));
  if (
    Object.keys(body).sort().join("\0") !== ["expectedCurrentReleaseId", "manifest"].sort().join("\0")
    || (body.expectedCurrentReleaseId !== null && typeof body.expectedCurrentReleaseId !== "string")
  ) throw new ApiError(400, "release-activation-invalid", "Release activation payload has an invalid shape.");
  const manifest = parseReleaseManifest(body.manifest);
  const manifestBytes = releaseManifestBytes(manifest);
  const manifestSha256 = await sha256Hex(manifestBytes);
  if (
    manifest.releaseId !== env.WASM_OJ_RELEASE_ID
    || manifestSha256 !== env.WASM_OJ_RELEASE_MANIFEST_SHA256
  ) throw new ApiError(409, "release-worker-mismatch", "Release manifest does not identify the deployed Worker and Container release.");
  const manifestJson = new TextDecoder("utf-8", { fatal: true }).decode(manifestBytes);
  await activateRelease(env.DB, {
    releaseId: manifest.releaseId,
    version: manifest.version,
    manifestJson,
    manifestBytes: manifestBytes.byteLength,
    manifestSha256,
    sourceGitCommit: manifest.source.commit,
    createdAt: manifest.createdAt,
    activatedBy: session.userId,
    environment: env.ENVIRONMENT,
    expectedCurrentReleaseId: body.expectedCurrentReleaseId as string | null,
  });
  const active = await assertActiveRelease(env.DB, env.ENVIRONMENT, manifest.releaseId, manifestSha256);
  return jsonResponse({
    release: {
      id: active.releaseId,
      manifestSha256: active.manifestSha256,
      environment: env.ENVIRONMENT,
      status: "active",
    },
  });
}
