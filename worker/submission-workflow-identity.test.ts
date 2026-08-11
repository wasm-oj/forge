import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { sha256Hex } from "./crypto";
import type { ForgeWorkerEnv } from "./env";
import { formalSubmissionAdmissionClaimSha256 } from "./formal-admissions";
import { reconcileSubmissionOutboxById } from "./reconciler";
import {
  deriveSubmissionAttemptToken,
  parseSubmissionWorkflowParameters,
  type SubmissionWorkflowParameters,
} from "./submission-workflow-identity";
import { hydrateSubmissionWorkflow } from "./submission-workflow-context";

type Binding = null | number | bigint | string | NodeJS.ArrayBufferView;

class SqliteStatement {
  private bindings: readonly Binding[] = [];
  constructor(private readonly database: DatabaseSync, private readonly sql: string) {}
  bind(...values: Binding[]): SqliteStatement { this.bindings = values; return this; }
  async first<T>(): Promise<T | null> { return (this.database.prepare(this.sql).get(...this.bindings) as T | undefined) ?? null; }
  async all<T>(): Promise<{ readonly results: readonly T[] }> { return { results: this.database.prepare(this.sql).all(...this.bindings) as T[] }; }
  async run(): Promise<{ readonly meta: { readonly changes: number } }> {
    return { meta: { changes: Number(this.database.prepare(this.sql).run(...this.bindings).changes) } };
  }
}

class SqliteD1 {
  constructor(private readonly database: DatabaseSync) {}
  prepare(sql: string): SqliteStatement { return new SqliteStatement(this.database, sql); }
}

const SUBMISSION_ID = "0198dbd3-5c00-7000-8000-000000000301";
const USER_ID = "0198dbd3-5c00-7000-8000-000000000302";
const ANONYMOUS_ID = "anon:0198dbd3-5c00-7000-8000-000000000303";
const PROBLEM_ID = "0198dbd3-5c00-7000-8000-000000000304";
const RELEASE_ID = "0198dbd3-5c00-7000-8000-000000000305";
const OUTBOX_ID = "0198dbd3-5c00-7000-8000-000000000306";
const DIGEST = "a".repeat(64);
const SECRET = "submission-workflow-test-secret-32-bytes-minimum";
const NOW = "2026-08-09T00:00:00.000Z";

function parameters(): SubmissionWorkflowParameters {
  return { submissionId: SUBMISSION_ID, attempt: 1, expectedReleaseId: RELEASE_ID, expectedManifestSha256: DIGEST };
}

describe("opaque submission Workflow identity", () => {
  it("derives a stable domain-separated capability and rejects persisted sensitive fields", async () => {
    const token = await deriveSubmissionAttemptToken(SECRET, SUBMISSION_ID, 1);
    expect(token).toHaveLength(43);
    expect(await deriveSubmissionAttemptToken(SECRET, SUBMISSION_ID, 1)).toBe(token);
    expect(await deriveSubmissionAttemptToken(SECRET, SUBMISSION_ID, 2)).not.toBe(token);
    expect(parseSubmissionWorkflowParameters(parameters())).toEqual(parameters());
    expect(() => parseSubmissionWorkflowParameters({ ...parameters(), attemptToken: token })).toThrow("Workflow reference is invalid");
    expect(() => parseSubmissionWorkflowParameters({ ...parameters(), sourceR2Key: "sources/private" })).toThrow("Workflow reference is invalid");
  });

  it("terminates a Workflow created by a stale outbox read after the erasure drain and blocks hydration", async () => {
    const submissions = new DatabaseSync(":memory:");
    for (const migration of ["0001_initial.sql", "0002_rejudge_pipeline.sql", "0003_account_erasure_fence.sql", "0004_projection_outbox_uniqueness.sql", "0005_formal_admission_claim.sql"]) {
      submissions.exec(readFileSync(path.join(process.cwd(), "migrations/submissions", migration), "utf8"));
    }
    const token = await deriveSubmissionAttemptToken(SECRET, SUBMISSION_ID, 1);
    const sourceR2Key = `sources/${USER_ID}/${SUBMISSION_ID}.${DIGEST}.json`;
    const admissionClaim = await formalSubmissionAdmissionClaimSha256({
      submissionId: SUBMISSION_ID,
      managedProblemVersionId: PROBLEM_ID,
      userId: USER_ID,
      contestId: null,
      admittedAt: NOW,
      sourceR2Key,
      sourceSha256: DIGEST,
    });
    submissions.prepare(`INSERT INTO submissions
      (id, user_id, managed_problem_version_id, contest_id, formal_admitted_at, formal_admission_claim_sha256,
       language, target, optimization, entry_path,
       source_r2_key, source_digest, forge_release_id, forge_manifest_sha256, state,
       visibility, created_at, updated_at)
      VALUES (?, ?, ?, NULL, ?, ?, 'c', 'wasip1', 'release', 'main.c', ?, ?, ?, ?, 'admitting', 'private', ?, ?)`)
      .run(SUBMISSION_ID, USER_ID, PROBLEM_ID, NOW, admissionClaim, sourceR2Key, DIGEST, RELEASE_ID, DIGEST, NOW, NOW);
    submissions.prepare("INSERT INTO submission_attempts (submission_id, attempt, token_hash, container_key, state) VALUES (?, 1, ?, ?, 'created')")
      .run(SUBMISSION_ID, await sha256Hex(token), `${SUBMISSION_ID}:1`);
    submissions.prepare("INSERT INTO submission_outbox (id, submission_id, kind, payload_json, created_at) VALUES (?, ?, 'start-workflow', ?, ?)")
      .run(OUTBOX_ID, SUBMISSION_ID, JSON.stringify(parameters()), NOW);

    const core = new DatabaseSync(":memory:");
    core.exec(`CREATE TABLE formal_submission_admissions (
      submission_id TEXT PRIMARY KEY, managed_problem_version_id TEXT NOT NULL, user_id TEXT NOT NULL,
      contest_id TEXT, admitted_at TEXT NOT NULL, state TEXT NOT NULL, source_r2_key TEXT,
      source_sha256 TEXT, cleanup_state TEXT NOT NULL, expires_at TEXT NOT NULL, updated_at TEXT NOT NULL
    ) STRICT`);
    core.prepare(`INSERT INTO formal_submission_admissions
      (submission_id, managed_problem_version_id, user_id, contest_id, admitted_at, state,
       source_r2_key, source_sha256, cleanup_state, expires_at, updated_at)
      VALUES (?, ?, ?, NULL, ?, 'committed', ?, ?, 'retained', ?, ?)`)
      .run(SUBMISSION_ID, PROBLEM_ID, USER_ID, NOW, sourceR2Key, DIGEST, "2999-01-01T00:00:00.000Z", NOW);

    let workflowStatus = "unknown";
    let creates = 0;
    let terminates = 0;
    let captured: unknown;
    const workflow = {
      create: async ({ params }: { readonly params: unknown }) => {
        // The erasure pass observed no Workflow and committed its D1 fence
        // after the reconciler's final pre-create read but before create.
        submissions.exec("BEGIN IMMEDIATE");
        submissions.prepare("INSERT INTO submission_owner_erasure_fences (owner_user_id, erasure_job_id, anonymous_user_id, fenced_at) VALUES (?, 'erasure-1', ?, ?)")
          .run(USER_ID, ANONYMOUS_ID, NOW);
        submissions.prepare("UPDATE submissions SET state='cancelled', updated_at=?, completed_at=? WHERE id=?").run(NOW, NOW, SUBMISSION_ID);
        submissions.prepare("UPDATE submission_attempts SET state='cancelled', finished_at=? WHERE submission_id=?").run(NOW, SUBMISSION_ID);
        submissions.prepare("UPDATE submission_outbox SET delivered_at=?, payload_json='{}' WHERE submission_id=?").run(NOW, SUBMISSION_ID);
        submissions.exec("COMMIT");
        captured = params;
        creates += 1;
        workflowStatus = "running";
      },
      get: async () => ({
        status: async () => ({ status: workflowStatus }),
        terminate: async () => { terminates += 1; workflowStatus = "terminated"; },
      }),
    };
    const env = {
      CORE_DB: new SqliteD1(core) as unknown as D1Database,
      SUBMISSIONS_DB: new SqliteD1(submissions) as unknown as D1Database,
      ACCOUNT_ERASURE_HMAC_SECRET: SECRET,
      SUBMISSION_WORKFLOW: workflow,
    } as unknown as ForgeWorkerEnv;

    await expect(reconcileSubmissionOutboxById(env, OUTBOX_ID)).resolves.toBe(true);
    expect({ creates, terminates, workflowStatus }).toEqual({ creates: 1, terminates: 1, workflowStatus: "terminated" });
    expect(captured).toEqual(parameters());
    expect(JSON.stringify(captured)).not.toMatch(/attemptToken|sourceR2|judgeR2|userId|owner/i);
    expect(submissions.prepare("SELECT state FROM submissions WHERE id=?").get(SUBMISSION_ID)).toEqual({ state: "cancelled" });
    expect(submissions.prepare("SELECT delivered_at, payload_json FROM submission_outbox WHERE id=?").get(OUTBOX_ID)).toEqual({ delivered_at: NOW, payload_json: "{}" });
    await expect(hydrateSubmissionWorkflow(env, parameters())).rejects.toThrow("does not match its immutable submission row");
  });
});
