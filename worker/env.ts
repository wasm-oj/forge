import type { SubmissionWorkflowParameters } from "./submission-workflow-identity";
import type { CatalogWorkflowParameters } from "./catalog-workflow-identity";

export type WasmOjEnvironment = "development" | "staging" | "production";

export interface WasmOjWorkerEnv {
  readonly ASSETS: Fetcher;
  readonly DB: D1Database;
  readonly JUDGE_BUCKET: R2Bucket;
  readonly SUBMISSION_CONTAINER: DurableObjectNamespace;
  readonly SUBMISSION_WORKFLOW: Workflow<SubmissionWorkflowParameters>;
  readonly CATALOG_WORKFLOW: Workflow<CatalogWorkflowParameters>;
  readonly GITHUB_OAUTH_CLIENT_ID: string;
  readonly GITHUB_OAUTH_CLIENT_SECRET: string;
  readonly GITHUB_APP_ID: string;
  readonly GITHUB_APP_SLUG: string;
  readonly GITHUB_APP_PRIVATE_KEY: string;
  readonly GITHUB_WEBHOOK_SECRET: string;
  readonly WASM_OJ_BUILD_ID: string;
  readonly PUBLIC_ORIGIN: string;
  readonly ENVIRONMENT: WasmOjEnvironment;
  readonly STAGING_ALLOWED_GITHUB_USER_IDS: string;
  readonly TURNSTILE_SITE_KEY: string;
  readonly TURNSTILE_SECRET_KEY: string;
  readonly OFFICIAL_GITHUB_REPOSITORY_ID: string;
  readonly ACCOUNT_ERASURE_HMAC_SECRET: string;
  readonly INVITE_CODE_HMAC_SECRET: string;
  /** Optional outside a cutover; 32–256 byte secret used only by authenticated maintenance smoke requests. */
  readonly MAINTENANCE_SMOKE_TOKEN?: string;
  readonly CF_VERSION_METADATA: WorkerVersionMetadata;
}

export interface AuthenticatedSession {
  readonly userId: string;
  readonly login: string;
  readonly avatarUrl: string;
  readonly roles: readonly ("admin" | "organizer")[];
  readonly expiresAt: string;
}
