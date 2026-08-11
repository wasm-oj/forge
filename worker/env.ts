import type { ValidationWorkflowParameters } from "./workflows";
import type { SubmissionWorkflowParameters } from "./submission-workflow-identity";

export type ForgeEnvironment = "development" | "staging" | "production";

export interface ForgeWorkerEnv {
  readonly ASSETS: Fetcher;
  readonly CORE_DB: D1Database;
  readonly SUBMISSIONS_DB: D1Database;
  readonly JUDGE_BUCKET: R2Bucket;
  readonly JUDGE_MIRROR_BUCKET: R2Bucket;
  readonly SUBMISSION_CONTAINER: DurableObjectNamespace;
  readonly VALIDATION_CONTAINER: DurableObjectNamespace;
  readonly SUBMISSION_WORKFLOW: Workflow<SubmissionWorkflowParameters>;
  readonly VALIDATION_WORKFLOW: Workflow<ValidationWorkflowParameters>;
  readonly GITHUB_OAUTH_CLIENT_ID: string;
  readonly GITHUB_OAUTH_CLIENT_SECRET: string;
  readonly GITHUB_APP_ID: string;
  readonly GITHUB_APP_SLUG: string;
  readonly GITHUB_APP_PRIVATE_KEY: string;
  readonly GITHUB_WEBHOOK_SECRET: string;
  readonly FORGE_RELEASE_ID: string;
  readonly FORGE_RELEASE_MANIFEST_SHA256: string;
  readonly PUBLIC_ORIGIN: string;
  readonly ENVIRONMENT: ForgeEnvironment;
  readonly STAGING_ALLOWED_GITHUB_USER_IDS: string;
  readonly TURNSTILE_SITE_KEY: string;
  readonly TURNSTILE_SECRET_KEY: string;
  readonly OFFICIAL_GITHUB_REPOSITORY_ID: string;
  readonly ACCOUNT_ERASURE_HMAC_SECRET: string;
  readonly INVITE_CODE_HMAC_SECRET: string;
  readonly CF_VERSION_METADATA: WorkerVersionMetadata;
}

export interface AuthenticatedSession {
  readonly userId: string;
  readonly login: string;
  readonly avatarUrl: string;
  readonly roles: readonly ("admin" | "organizer")[];
  readonly expiresAt: string;
}
