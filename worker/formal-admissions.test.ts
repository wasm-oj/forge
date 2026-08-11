import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import type { ForgeWorkerEnv } from "./env";
import {
  abortFormalSubmissionAdmission,
  cleanupAbortedFormalSubmissionAdmission,
  cleanupFormalSubmissionAdmissionsForUser,
  commitFormalSubmissionAdmission,
  formalSubmissionAdmissionClaimSha256,
  formalSubmissionWorkflowFence,
  reconcileConcurrentFormalSubmissionWinner,
  reconcileFormalSubmissionAdmissions,
} from "./formal-admissions";

type Binding = null | number | bigint | string | NodeJS.ArrayBufferView;

class SqliteStatement {
  private bindings: readonly Binding[] = [];

  constructor(private readonly database: DatabaseSync, private readonly sql: string) {}

  bind(...values: Binding[]): SqliteStatement {
    this.bindings = values;
    return this;
  }

  async first<T>(): Promise<T | null> {
    return (this.database.prepare(this.sql).get(...this.bindings) as T | undefined) ?? null;
  }

  async all<T>(): Promise<{ readonly results: readonly T[] }> {
    return { results: this.database.prepare(this.sql).all(...this.bindings) as T[] };
  }

  async run(): Promise<{ readonly meta: { readonly changes: number } }> {
    const changes = this.database.prepare(this.sql).run(...this.bindings).changes;
    return { meta: { changes: Number(changes) } };
  }
}

class SqliteD1 {
  constructor(private readonly database: DatabaseSync) {}

  prepare(sql: string): SqliteStatement {
    return new SqliteStatement(this.database, sql);
  }
}

class FakeBucket {
  readonly objects = new Map<string, Uint8Array>();
  deleteFailures = 0;

  async delete(key: string): Promise<void> {
    if (this.deleteFailures > 0) {
      this.deleteFailures -= 1;
      throw new Error("injected-r2-delete-failure");
    }
    this.objects.delete(key);
  }

  async head(key: string): Promise<{ readonly key: string } | null> {
    return this.objects.has(key) ? { key } : null;
  }
}

const USER_ID = "00000000-0000-4000-8000-000000000001";
const PROBLEM_ID = "00000000-0000-4000-8000-000000000002";
const SUBMISSION_ID = "00000000-0000-4000-8000-000000000003";
const LOSER_ID = "00000000-0000-4000-8000-000000000004";
const SOURCE_DIGEST = "a".repeat(64);
const ADMITTED_AT = "2026-01-01T00:00:00.000Z";

interface Fixture {
  readonly core: DatabaseSync;
  readonly submissions: DatabaseSync;
  readonly primary: FakeBucket;
  readonly mirror: FakeBucket;
  readonly env: ForgeWorkerEnv;
}

function fixture(): Fixture {
  const core = new DatabaseSync(":memory:");
  core.exec(`CREATE TABLE formal_submission_admissions (
    submission_id TEXT PRIMARY KEY,
    managed_problem_version_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    contest_id TEXT,
    admitted_at TEXT NOT NULL,
    state TEXT NOT NULL,
    source_r2_key TEXT,
    source_sha256 TEXT,
    cleanup_state TEXT NOT NULL,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  ) STRICT`);
  const submissions = new DatabaseSync(":memory:");
  submissions.exec(`CREATE TABLE submissions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    managed_problem_version_id TEXT NOT NULL,
    contest_id TEXT,
    source_r2_key TEXT NOT NULL,
    source_digest TEXT NOT NULL,
    formal_admitted_at TEXT,
    formal_admission_claim_sha256 TEXT,
    rejudge_batch_id TEXT
  ) STRICT`);
  const primary = new FakeBucket();
  const mirror = new FakeBucket();
  return {
    core,
    submissions,
    primary,
    mirror,
    env: {
      CORE_DB: new SqliteD1(core) as unknown as D1Database,
      SUBMISSIONS_DB: new SqliteD1(submissions) as unknown as D1Database,
      JUDGE_BUCKET: primary as unknown as R2Bucket,
      JUDGE_MIRROR_BUCKET: mirror as unknown as R2Bucket,
    } as unknown as ForgeWorkerEnv,
  };
}

function sourceKey(submissionId: string): string {
  return `sources/${USER_ID}/${submissionId}.${SOURCE_DIGEST}.json`;
}

function insertMarker(database: DatabaseSync, expiresAt = "2999-01-01T00:00:00.000Z", submissionId = SUBMISSION_ID): void {
  database.prepare("INSERT INTO formal_submission_admissions (submission_id, managed_problem_version_id, user_id, contest_id, admitted_at, state, source_r2_key, source_sha256, cleanup_state, created_at, expires_at, updated_at) VALUES (?, ?, ?, NULL, ?, 'pending', ?, ?, 'pending', ?, ?, ?)")
    .run(submissionId, PROBLEM_ID, USER_ID, ADMITTED_AT, sourceKey(submissionId), SOURCE_DIGEST, ADMITTED_AT, expiresAt, ADMITTED_AT);
}

async function insertMatchingSubmission(database: DatabaseSync, submissionId = SUBMISSION_ID): Promise<void> {
  const claim = await formalSubmissionAdmissionClaimSha256({
    submissionId,
    managedProblemVersionId: PROBLEM_ID,
    userId: USER_ID,
    contestId: null,
    admittedAt: ADMITTED_AT,
    sourceR2Key: sourceKey(submissionId),
    sourceSha256: SOURCE_DIGEST,
  });
  database.prepare(
    `INSERT INTO submissions
       (id, user_id, managed_problem_version_id, contest_id, source_r2_key, source_digest,
        formal_admitted_at, formal_admission_claim_sha256, rejudge_batch_id)
     VALUES (?, ?, ?, NULL, ?, ?, ?, ?, NULL)`,
  ).run(submissionId, USER_ID, PROBLEM_ID, sourceKey(submissionId), SOURCE_DIGEST, ADMITTED_AT, claim);
}

describe("formal submission cross-D1 admission saga", () => {
  it("repairs a committed submission after the CORE_DB acknowledgement was lost", async () => {
    const { core, submissions, env } = fixture();
    insertMarker(core);
    await insertMatchingSubmission(submissions);

    await expect(reconcileFormalSubmissionAdmissions(env)).resolves.toEqual({ committed: 1, aborted: 0, pending: 0 });
    expect(core.prepare("SELECT state, cleanup_state FROM formal_submission_admissions WHERE submission_id=?").get(SUBMISSION_ID)).toEqual({ state: "committed", cleanup_state: "retained" });
    await expect(commitFormalSubmissionAdmission(env, {
      submissionId: SUBMISSION_ID,
      managedProblemVersionId: PROBLEM_ID,
      userId: USER_ID,
    })).resolves.toBe(false);
  });

  it("rejects Workflow start when the SUBMISSIONS claim no longer matches the committed CORE marker", async () => {
    const { core, submissions, env } = fixture();
    insertMarker(core);
    await insertMatchingSubmission(submissions);
    core.prepare("UPDATE formal_submission_admissions SET state='committed', cleanup_state='retained' WHERE submission_id=?")
      .run(SUBMISSION_ID);

    await expect(formalSubmissionWorkflowFence(env, SUBMISSION_ID)).resolves.toBe("start");
    submissions.prepare("UPDATE submissions SET formal_admission_claim_sha256=? WHERE id=?")
      .run("b".repeat(64), SUBMISSION_ID);
    await expect(formalSubmissionWorkflowFence(env, SUBMISSION_ID)).resolves.toBe("reject");
  });

  it("aborts only an expired marker that has no committed submission", async () => {
    const { core, env } = fixture();
    insertMarker(core, "2000-01-01T00:00:00.000Z");

    await expect(reconcileFormalSubmissionAdmissions(env)).resolves.toEqual({ committed: 0, aborted: 1, pending: 0 });
    expect(core.prepare("SELECT state FROM formal_submission_admissions WHERE submission_id=?").get(SUBMISSION_ID)).toEqual({ state: "aborted" });
  });

  it("fails closed on a cross-database identity mismatch", async () => {
    const { core, submissions, env } = fixture();
    insertMarker(core);
    await insertMatchingSubmission(submissions);
    submissions.prepare("UPDATE submissions SET user_id='different-user' WHERE id=?").run(SUBMISSION_ID);
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      await expect(reconcileFormalSubmissionAdmissions(env)).resolves.toEqual({ committed: 0, aborted: 0, pending: 1 });
      expect(core.prepare("SELECT state FROM formal_submission_admissions WHERE submission_id=?").get(SUBMISSION_ID)).toEqual({ state: "pending" });
      expect(log).toHaveBeenCalledOnce();
    } finally {
      log.mockRestore();
    }
  });

  it("never resurrects an aborted cleanup claim when a delayed D1 commit loses the fence", async () => {
    const { core, submissions, primary, mirror, env } = fixture();
    insertMarker(core);
    core.prepare("UPDATE formal_submission_admissions SET state='aborted' WHERE submission_id=?").run(SUBMISSION_ID);
    await insertMatchingSubmission(submissions);
    primary.objects.set(sourceKey(SUBMISSION_ID), new Uint8Array([1]));
    mirror.objects.set(sourceKey(SUBMISSION_ID), new Uint8Array([1]));

    await expect(commitFormalSubmissionAdmission(env, {
      submissionId: SUBMISSION_ID,
      managedProblemVersionId: PROBLEM_ID,
      userId: USER_ID,
    })).rejects.toThrow("lost its cross-database commit fence");
    await expect(cleanupAbortedFormalSubmissionAdmission(env, SUBMISSION_ID)).resolves.toBe("cleaned");
    expect(core.prepare("SELECT state, cleanup_state FROM formal_submission_admissions WHERE submission_id=?").get(SUBMISSION_ID)).toEqual({
      state: "aborted",
      cleanup_state: "complete",
    });
    expect(submissions.prepare("SELECT id FROM submissions WHERE id=?").get(SUBMISSION_ID)).toEqual({ id: SUBMISSION_ID });
    expect(primary.objects.size + mirror.objects.size).toBe(0);
  });

  it("settles an identical concurrent loser to one authoritative source", async () => {
    const { core, submissions, primary, mirror, env } = fixture();
    insertMarker(core);
    insertMarker(core, "2999-01-01T00:00:00.000Z", LOSER_ID);
    for (const id of [SUBMISSION_ID, LOSER_ID]) {
      primary.objects.set(sourceKey(id), new Uint8Array([1]));
      mirror.objects.set(sourceKey(id), new Uint8Array([1]));
    }
    await insertMatchingSubmission(submissions);

    await reconcileConcurrentFormalSubmissionWinner(env, {
      winner: { submissionId: SUBMISSION_ID, managedProblemVersionId: PROBLEM_ID, userId: USER_ID },
      loser: { submissionId: LOSER_ID, managedProblemVersionId: PROBLEM_ID, userId: USER_ID },
    });

    expect(core.prepare("SELECT submission_id, state, cleanup_state FROM formal_submission_admissions ORDER BY submission_id").all()).toEqual([
      { submission_id: SUBMISSION_ID, state: "committed", cleanup_state: "retained" },
      { submission_id: LOSER_ID, state: "aborted", cleanup_state: "complete" },
    ]);
    expect([...primary.objects.keys()]).toEqual([sourceKey(SUBMISSION_ID)]);
    expect([...mirror.objects.keys()]).toEqual([sourceKey(SUBMISSION_ID)]);
  });

  it("retains a durable cleanup claim across partial R2 failures", async () => {
    const { core, primary, mirror, env } = fixture();
    insertMarker(core);
    primary.objects.set(sourceKey(SUBMISSION_ID), new Uint8Array([1]));
    primary.deleteFailures = 1;

    await expect(abortFormalSubmissionAdmission(env, {
      submissionId: SUBMISSION_ID,
      managedProblemVersionId: PROBLEM_ID,
      userId: USER_ID,
    })).rejects.toThrow();
    expect(core.prepare("SELECT state, cleanup_state, source_r2_key FROM formal_submission_admissions WHERE submission_id=?").get(SUBMISSION_ID)).toEqual({
      state: "aborted",
      cleanup_state: "pending",
      source_r2_key: sourceKey(SUBMISSION_ID),
    });

    await expect(cleanupAbortedFormalSubmissionAdmission(env, SUBMISSION_ID)).resolves.toBe("cleaned");
    expect(primary.objects.size).toBe(0);
    expect(mirror.objects.size).toBe(0);
    expect(core.prepare("SELECT state, cleanup_state, source_r2_key, source_sha256 FROM formal_submission_admissions WHERE submission_id=?").get(SUBMISSION_ID)).toEqual({
      state: "aborted",
      cleanup_state: "complete",
      source_r2_key: null,
      source_sha256: null,
    });
  });

  it("retries a failed mirror deletion without losing the source claim", async () => {
    const { core, primary, mirror, env } = fixture();
    insertMarker(core);
    primary.objects.set(sourceKey(SUBMISSION_ID), new Uint8Array([1]));
    mirror.objects.set(sourceKey(SUBMISSION_ID), new Uint8Array([1]));
    mirror.deleteFailures = 1;

    await expect(abortFormalSubmissionAdmission(env, {
      submissionId: SUBMISSION_ID,
      managedProblemVersionId: PROBLEM_ID,
      userId: USER_ID,
    })).rejects.toThrow("partially applied");
    expect(primary.objects.size).toBe(0);
    expect(mirror.objects.size).toBe(1);
    expect(core.prepare("SELECT state, cleanup_state, source_r2_key FROM formal_submission_admissions WHERE submission_id=?").get(SUBMISSION_ID)).toEqual({
      state: "aborted",
      cleanup_state: "pending",
      source_r2_key: sourceKey(SUBMISSION_ID),
    });
    await expect(cleanupAbortedFormalSubmissionAdmission(env, SUBMISSION_ID)).resolves.toBe("cleaned");
    expect(mirror.objects.size).toBe(0);
  });

  it("drains orphan admission claims before account erasure removes their owner", async () => {
    const { core, primary, mirror, env } = fixture();
    insertMarker(core);
    primary.objects.set(sourceKey(SUBMISSION_ID), new Uint8Array([1]));
    mirror.objects.set(sourceKey(SUBMISSION_ID), new Uint8Array([1]));

    await cleanupFormalSubmissionAdmissionsForUser(env, USER_ID);
    expect(core.prepare("SELECT state, cleanup_state FROM formal_submission_admissions WHERE submission_id=?").get(SUBMISSION_ID)).toEqual({
      state: "aborted",
      cleanup_state: "complete",
    });
    expect(primary.objects.size + mirror.objects.size).toBe(0);
  });
});
