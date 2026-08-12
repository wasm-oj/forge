import { authenticatedSession, requireSession } from "./auth";
import { randomToken, sha256Hex } from "./crypto";
import type { WasmOjWorkerEnv } from "./env";
import {
  githubApiJson,
  githubAppJwt,
  githubInstallationProvisioningToken,
  githubReadOnlyInstallationAuthorization,
  requireOrganizer,
  verifyGithubWebhook,
} from "./github";
import {
  activateGithubInstallationClaim,
  bindGithubInstallationClaim,
  finalizeGithubInstallationClaim,
  GITHUB_INSTALLATION_PROOF_SECONDS,
  recordGithubInstallationCreatedProof,
} from "./github-installation-claims";
import { ApiError, jsonResponse, readBoundedResponseJson } from "./http";
import { requireStagingFormalAccess } from "./formal-access";

const INSTALL_STATE_COOKIE = "wasm_oj_install_state";
const INSTALL_STATE_SECONDS = 10 * 60;

interface RepositoryRow {
  readonly github_repository_id: number;
  readonly installation_id: number;
  readonly owner_login: string;
  readonly name: string;
  readonly is_private: number;
}

function setCookie(name: string, value: string, maxAge: number): string {
  if (!/^[A-Za-z0-9_-]+$/.test(name) || /[;\r\n]/.test(value)) throw new TypeError("Invalid cookie.");
  return `${name}=${value}; Path=/; Max-Age=${maxAge}; Secure; HttpOnly; SameSite=Lax`;
}

function cookie(request: Request, name: string): string | undefined {
  for (const part of (request.headers.get("cookie") ?? "").split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return rest.join("=");
  }
  return undefined;
}

function configuredGithubAppId(env: WasmOjWorkerEnv): number {
  const appId = Number(env.GITHUB_APP_ID);
  if (!Number.isSafeInteger(appId) || appId < 1) throw new ApiError(503, "github-app-config-invalid", "GitHub App identity is not configured.");
  return appId;
}

async function installationJson(path: string, env: WasmOjWorkerEnv): Promise<Record<string, unknown>> {
  const response = await fetch(`https://api.github.com${path}`, {
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${await githubAppJwt(env)}`,
      "user-agent": "wasm-oj",
      "x-github-api-version": "2022-11-28",
    },
    redirect: "manual",
  });
  if (!response.ok) throw new ApiError(502, "github-app-error", `GitHub App request failed with HTTP ${response.status}.`);
  const value = await readBoundedResponseJson(response, 1024 * 1024);
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ApiError(502, "github-app-response-invalid", "GitHub App returned invalid metadata.");
  }
  return value as Record<string, unknown>;
}

async function upsertRepository(
  env: WasmOjWorkerEnv,
  installationId: number,
  value: unknown,
  claim?: { readonly userId: string; readonly stateHash: string },
): Promise<void> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ApiError(502, "github-repository-invalid", "GitHub returned invalid repository metadata.");
  const repository = value as Record<string, unknown>;
  const owner = repository.owner as Record<string, unknown> | undefined;
  if (
    !Number.isSafeInteger(repository.id) || (repository.id as number) < 1
    || typeof repository.name !== "string" || typeof owner?.login !== "string"
    || typeof repository.private !== "boolean"
  ) throw new ApiError(502, "github-repository-invalid", "GitHub returned invalid repository metadata.");
  const now = new Date().toISOString();
  const statement = claim
    ? env.DB.prepare(`INSERT INTO github_repositories
        (github_repository_id, installation_id, owner_login, name, is_private, authorization_status, updated_at)
      SELECT ?, installations.installation_id, ?, ?, ?, 'authorized', ?
      FROM github_installations AS installations
      JOIN github_installation_claim_proofs AS proofs ON proofs.installation_id=installations.installation_id
      WHERE installations.installation_id=? AND installations.installed_by_user_id=?
        AND installations.status IN ('suspended','active')
        AND proofs.state_hash=? AND proofs.claimed_by_user_id=? AND proofs.claimed_at IS NOT NULL
      ON CONFLICT(github_repository_id) DO UPDATE SET owner_login=excluded.owner_login,
        name=excluded.name, is_private=excluded.is_private, authorization_status='authorized',
        updated_at=excluded.updated_at WHERE github_repositories.installation_id=excluded.installation_id`)
      .bind(repository.id, owner.login, repository.name, repository.private ? 1 : 0, now,
        installationId, claim.userId, claim.stateHash, claim.userId)
    : env.DB.prepare(`INSERT INTO github_repositories
        (github_repository_id, installation_id, owner_login, name, is_private, authorization_status, updated_at)
      SELECT ?, installation_id, ?, ?, ?, 'authorized', ? FROM github_installations
      WHERE installation_id=? AND installed_by_user_id IS NOT NULL AND status='active'
      ON CONFLICT(github_repository_id) DO UPDATE SET owner_login=excluded.owner_login,
        name=excluded.name, is_private=excluded.is_private, authorization_status='authorized',
        updated_at=excluded.updated_at WHERE github_repositories.installation_id=excluded.installation_id`)
      .bind(repository.id, owner.login, repository.name, repository.private ? 1 : 0, now, installationId);
  const result = await statement.run();
  if (result.meta.changes !== 1) throw new ApiError(409, "github-repository-ownership-conflict", "GitHub repository ownership changed while synchronizing the installation.");
}

async function associateInstallation(env: WasmOjWorkerEnv, installationId: number, userId: string, stateHash: string): Promise<void> {
  const now = new Date().toISOString();
  const claim = await bindGithubInstallationClaim(env.DB, { stateHash, userId, installationId, now });
  if (claim.active) return;
  const installation = await installationJson(`/app/installations/${installationId}`, env);
  const account = installation.account as Record<string, unknown> | undefined;
  if (
    installation.id !== installationId || installation.app_id !== configuredGithubAppId(env)
    || !Number.isSafeInteger(account?.id) || typeof account?.login !== "string"
  ) throw new ApiError(502, "github-installation-invalid", "GitHub returned an invalid installation.");
  if (account.id !== claim.accountGithubId) throw new ApiError(409, "github-installation-account-mismatch", "The signed GitHub installation account does not match App metadata.");
  if (installation.suspended_at !== null && installation.suspended_at !== undefined) throw new ApiError(409, "github-installation-suspended", "The GitHub App installation is suspended.");
  const authorization = githubReadOnlyInstallationAuthorization(installation.permissions, installation.repository_selection);
  const finalized = await finalizeGithubInstallationClaim(env.DB, {
    stateHash,
    userId,
    metadata: {
      installationId,
      accountGithubId: account.id as number,
      accountLogin: account.login,
      permissionsJson: authorization.permissionsJson,
      repositorySelection: authorization.repositorySelection,
    },
    now: new Date().toISOString(),
  });
  if (finalized.active) return;
  const token = await githubInstallationProvisioningToken(env, installationId, userId, stateHash);
  const repositories = await githubApiJson<{ readonly total_count: number; readonly repositories: readonly unknown[] }>(
    "/installation/repositories?per_page=100",
    token,
  );
  if (
    !Number.isSafeInteger(repositories.total_count) || repositories.total_count < 0
    || !Array.isArray(repositories.repositories) || repositories.total_count !== repositories.repositories.length
    || repositories.total_count > 100
  ) throw new ApiError(409, "github-repository-limit", "WASM-OJ supports at most 100 repositories per installation.");
  for (const repository of repositories.repositories) await upsertRepository(env, installationId, repository, { userId, stateHash });
  await activateGithubInstallationClaim(env.DB, { stateHash, userId, installationId, now: new Date().toISOString() });
}

export async function beginGithubAppInstall(request: Request, env: WasmOjWorkerEnv): Promise<Response> {
  const session = await requireSession(request, env);
  await requireStagingFormalAccess(env, session.userId);
  await requireOrganizer(env, session);
  const state = randomToken();
  const now = new Date();
  await env.DB.prepare("INSERT INTO github_installation_states (state_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)")
    .bind(await sha256Hex(state), session.userId, now.toISOString(), new Date(now.getTime() + INSTALL_STATE_SECONDS * 1000).toISOString()).run();
  const location = new URL(`https://github.com/apps/${encodeURIComponent(env.GITHUB_APP_SLUG)}/installations/new`);
  location.searchParams.set("state", state);
  return new Response(null, { status: 302, headers: {
    location: location.toString(),
    "set-cookie": setCookie(INSTALL_STATE_COOKIE, state, INSTALL_STATE_SECONDS),
    "cache-control": "no-store",
  } });
}

export async function completeGithubAppInstall(request: Request, env: WasmOjWorkerEnv): Promise<Response> {
  const redirect = (result: string) => new Response(null, { status: 302, headers: {
    location: `/organizer/repositories?github=${encodeURIComponent(result)}`,
    "set-cookie": setCookie(INSTALL_STATE_COOKIE, "", 0),
    "cache-control": "no-store",
  } });
  try {
    const session = await requireSession(request, env);
    await requireStagingFormalAccess(env, session.userId);
    await requireOrganizer(env, session);
    const url = new URL(request.url);
    const state = url.searchParams.get("state");
    const installationId = Number(url.searchParams.get("installation_id"));
    if (!state || cookie(request, INSTALL_STATE_COOKIE) !== state || !Number.isSafeInteger(installationId) || installationId < 1) {
      throw new ApiError(400, "github-install-callback-invalid", "GitHub installation callback is invalid.");
    }
    await associateInstallation(env, installationId, session.userId, await sha256Hex(state));
    return redirect("connected");
  } catch (error) {
    if (!(error instanceof ApiError)) throw error;
    const result = new Map([
      ["authentication-required", "sign-in-required"],
      ["github-install-callback-invalid", "invalid-callback"],
      ["github-installation-account-mismatch", "account-mismatch"],
      ["github-installation-suspended", "installation-suspended"],
      ["github-repository-limit", "repository-limit"],
      ["github-app-error", "github-unavailable"],
      ["github-app-response-invalid", "github-unavailable"],
    ]).get(error.code);
    if (!result) throw error;
    return redirect(result);
  }
}

export async function listOrganizerRepositories(request: Request, env: WasmOjWorkerEnv): Promise<Response> {
  const session = await requireSession(request, env);
  await requireStagingFormalAccess(env, session.userId);
  await requireOrganizer(env, session);
  const rows = await env.DB.prepare(`SELECT repositories.github_repository_id, repositories.owner_login,
      repositories.name, repositories.is_private, repositories.updated_at
    FROM github_repositories AS repositories
    JOIN github_installations AS installations ON installations.installation_id=repositories.installation_id
    WHERE installations.installed_by_user_id=? AND installations.status='active'
      AND repositories.authorization_status='authorized'
    ORDER BY repositories.owner_login, repositories.name`).bind(session.userId).all<RepositoryRow>();
  return jsonResponse({ repositories: rows.results });
}

export async function githubWebhook(request: Request, env: WasmOjWorkerEnv): Promise<Response> {
  const delivery = await verifyGithubWebhook(request, env);
  const bodySha256 = await sha256Hex(delivery.body);
  delivery.body.fill(0);
  const now = new Date().toISOString();
  const inserted = await env.DB.prepare(`INSERT OR IGNORE INTO github_webhook_deliveries
      (delivery_id, event_name, body_sha256, received_at, updated_at, attempts, outcome)
    VALUES (?, ?, ?, ?, ?, 1, 'processing')`)
    .bind(delivery.deliveryId, delivery.eventName, bodySha256, now, now).run();
  if (inserted.meta.changes !== 1) {
    const existing = await env.DB.prepare(`SELECT event_name, body_sha256, outcome FROM github_webhook_deliveries
      WHERE delivery_id=?`).bind(delivery.deliveryId).first<{
      readonly event_name: string;
      readonly body_sha256: string;
      readonly outcome: string;
    }>();
    if (!existing || existing.event_name !== delivery.eventName || existing.body_sha256 !== bodySha256) {
      throw new ApiError(409, "github-webhook-delivery-conflict", "GitHub delivery identity conflicts with a prior payload.");
    }
    if (existing.outcome === "accepted") return jsonResponse({ accepted: true, replayed: true });
    if (existing.outcome === "failed") {
      const reclaimed = await env.DB.prepare(`UPDATE github_webhook_deliveries
          SET outcome='processing', attempts=attempts+1, updated_at=?
        WHERE delivery_id=? AND event_name=? AND body_sha256=? AND outcome='failed'`)
        .bind(now, delivery.deliveryId, delivery.eventName, bodySha256).run();
      if (reclaimed.meta.changes !== 1) {
        throw new ApiError(503, "github-webhook-processing", "This GitHub delivery has not reached a stable outcome.");
      }
    } else {
      throw new ApiError(503, "github-webhook-processing", "This GitHub delivery has not reached a stable outcome.");
    }
  }
  try {
    const payload = delivery.payload;
    const installation = payload.installation as Record<string, unknown> | undefined;
    const installationId = Number(installation?.id);
    if (delivery.eventName === "installation") {
      if (!Number.isSafeInteger(installationId) || installationId < 1 || installation?.app_id !== configuredGithubAppId(env)) {
        throw new ApiError(400, "github-installation-event-invalid", "GitHub installation event is invalid.");
      }
      const action = payload.action;
      if (action === "created") {
        const sender = payload.sender as Record<string, unknown> | undefined;
        const account = installation.account as Record<string, unknown> | undefined;
        const installerGithubUserId = sender?.id;
        const accountGithubId = account?.id;
        if (!Number.isSafeInteger(installerGithubUserId) || !Number.isSafeInteger(accountGithubId)) {
          throw new ApiError(400, "github-installation-proof-invalid", "GitHub installation ownership payload is invalid.");
        }
        await recordGithubInstallationCreatedProof(env.DB, {
          installationId,
          installerGithubUserId: installerGithubUserId as number,
          accountGithubId: accountGithubId as number,
          deliveryId: delivery.deliveryId,
          receivedAt: now,
          expiresAt: new Date(Date.parse(now) + GITHUB_INSTALLATION_PROOF_SECONDS * 1000).toISOString(),
        });
      } else if (action === "deleted" || action === "suspend") {
        await env.DB.prepare(`UPDATE github_installations SET status=?, authority_generation=authority_generation+1,
          updated_at=? WHERE installation_id=?`)
          .bind(action === "deleted" ? "removed" : "suspended", now, installationId).run();
      } else if (action === "new_permissions_accepted" || action === "unsuspend") {
        let authorization: ReturnType<typeof githubReadOnlyInstallationAuthorization> | undefined;
        try {
          authorization = githubReadOnlyInstallationAuthorization(installation.permissions, installation.repository_selection);
        } catch (error) {
          if (!(error instanceof ApiError)) throw error;
          await env.DB.prepare(`UPDATE github_installations
              SET status='suspended', authority_generation=authority_generation+1, updated_at=?
            WHERE installation_id=? AND installed_by_user_id IS NOT NULL AND status!='removed'`)
            .bind(now, installationId).run();
        }
        if (authorization) {
          await env.DB.prepare(`UPDATE github_installations
              SET status=CASE WHEN ?='unsuspend' THEN 'active' ELSE status END,
                  permissions_json=?, repository_selection=?,
                  authority_generation=authority_generation+1, updated_at=?
            WHERE installation_id=? AND installed_by_user_id IS NOT NULL AND status!='removed'`)
            .bind(action, authorization.permissionsJson, authorization.repositorySelection, now, installationId).run();
        }
      }
    } else if (delivery.eventName === "installation_repositories") {
      if (!Number.isSafeInteger(installationId) || installationId < 1) throw new ApiError(400, "github-installation-event-invalid", "GitHub repository event is invalid.");
      for (const repository of Array.isArray(payload.repositories_added) ? payload.repositories_added : []) {
        await upsertRepository(env, installationId, repository);
      }
      for (const value of Array.isArray(payload.repositories_removed) ? payload.repositories_removed : []) {
        const repository = value as Record<string, unknown>;
        if (Number.isSafeInteger(repository.id)) {
          await env.DB.prepare(`UPDATE github_repositories SET authorization_status='removed', updated_at=?
            WHERE github_repository_id=? AND installation_id=?`).bind(now, repository.id, installationId).run();
        }
      }
    }
    // Push events intentionally have no product handler. Versions move only
    // through explicit exact-commit validation and publication requests.
    await env.DB.prepare(`UPDATE github_webhook_deliveries SET outcome='accepted', updated_at=?
      WHERE delivery_id=? AND event_name=? AND body_sha256=? AND outcome='processing'`)
      .bind(new Date().toISOString(), delivery.deliveryId, delivery.eventName, bodySha256).run();
    return jsonResponse({ accepted: true, replayed: false });
  } catch (error) {
    await env.DB.prepare(`UPDATE github_webhook_deliveries SET outcome='failed', updated_at=?
      WHERE delivery_id=? AND outcome='processing'`).bind(new Date().toISOString(), delivery.deliveryId).run();
    throw error;
  }
}

export async function organizerStatus(request: Request, env: WasmOjWorkerEnv): Promise<Response> {
  const session = await authenticatedSession(request, env);
  const organizer = Boolean(session?.roles.includes("organizer") || session?.roles.includes("admin"));
  const application = session && !organizer
    ? await env.DB.prepare(`SELECT id, status, created_at, reviewed_at, review_note FROM organizer_applications
      WHERE user_id=? ORDER BY created_at DESC LIMIT 1`).bind(session.userId).first()
    : undefined;
  const access = !session ? "signed-out" : organizer ? "active"
    : (application as { readonly status?: string } | undefined)?.status ?? "eligible";
  return jsonResponse({ authenticated: Boolean(session), organizer, access, application: application ?? null });
}
