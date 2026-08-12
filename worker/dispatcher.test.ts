import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { claimOldestSubmission } from "./dispatcher";
import type { WasmOjWorkerEnv } from "./env";
import { submissionCapacitySnapshot } from "./submission-capacity";

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
}

function fixture(): { readonly database: DatabaseSync; readonly env: WasmOjWorkerEnv } {
  const database = new DatabaseSync(":memory:");
  database.exec(`CREATE TABLE submissions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      state TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      wasm_oj_release_id TEXT NOT NULL,
      wasm_oj_manifest_sha256 TEXT NOT NULL
    ) STRICT;
    CREATE TABLE submission_attempts (
      submission_id TEXT NOT NULL,
      attempt INTEGER NOT NULL,
      PRIMARY KEY (submission_id, attempt)
    ) STRICT;
    CREATE TABLE workflow_outbox (
      submission_id TEXT NOT NULL,
      state TEXT NOT NULL
    ) STRICT;
    CREATE TABLE rejudge_jobs (
      new_submission_id TEXT PRIMARY KEY
    ) STRICT;`);
  return {
    database,
    env: {
      DB: {
        prepare: (sql: string) => new SqliteStatement(database, sql),
      } as unknown as D1Database,
    } as WasmOjWorkerEnv,
  };
}

function insertSubmission(
  database: DatabaseSync,
  input: {
    readonly id: string;
    readonly user: string;
    readonly state: string;
    readonly created: string;
    readonly rejudge?: boolean;
  },
): void {
  database.prepare(`INSERT INTO submissions
      (id, user_id, state, created_at, updated_at, wasm_oj_release_id, wasm_oj_manifest_sha256)
    VALUES (?, ?, ?, ?, ?, 'release', ?)`)
    .run(input.id, input.user, input.state, input.created, input.created, "f".repeat(64));
  if (input.state === "queued") {
    database.prepare("INSERT INTO submission_attempts VALUES (?, 1)").run(input.id);
    database.prepare("INSERT INTO workflow_outbox VALUES (?, 'pending')").run(input.id);
  }
  if (input.rejudge) database.prepare("INSERT INTO rejudge_jobs VALUES (?)").run(input.id);
}

describe("D1 FIFO submission capacity", () => {
  it("allows two concurrent dispatchers to claim one queued submission only once", async () => {
    const { database, env } = fixture();
    insertSubmission(database, {
      id: "only-job",
      user: "alice",
      state: "queued",
      created: "2026-08-12T00:00:00.000Z",
    });

    const claims = await Promise.all([
      claimOldestSubmission(env, new Date("2026-08-12T12:00:00.000Z")),
      claimOldestSubmission(env, new Date("2026-08-12T12:00:00.000Z")),
    ]);
    expect(claims.filter((claim) => claim?.id === "only-job")).toHaveLength(1);
    expect(claims.filter((claim) => claim === null)).toHaveLength(1);
    expect(database.prepare("SELECT state FROM submissions WHERE id='only-job'").get())
      .toEqual({ state: "preparing" });
  });

  it("counts the 500 queued rows independently from 50 active rows", async () => {
    const { database, env } = fixture();
    for (let index = 0; index < 500; index += 1) {
      insertSubmission(database, {
        id: `queued-${String(index).padStart(3, "0")}`,
        user: index < 3 ? "target" : `user-${index}`,
        state: "queued",
        created: `2026-08-12T00:${String(Math.floor(index / 60)).padStart(2, "0")}:${String(index % 60).padStart(2, "0")}.000Z`,
      });
    }
    for (let index = 0; index < 50; index += 1) {
      insertSubmission(database, {
        id: `active-${index}`,
        user: `active-user-${index}`,
        state: "running",
        created: `2026-08-11T23:59:${String(index).padStart(2, "0")}.000Z`,
      });
    }

    await expect(submissionCapacitySnapshot(env, "target")).resolves.toEqual({
      globalQueued: 500,
      userQueued: 3,
    });
    await expect(claimOldestSubmission(env)).resolves.toBeNull();

    database.prepare("UPDATE submissions SET state='completed' WHERE id='active-0'").run();
    await expect(claimOldestSubmission(env, new Date("2026-08-12T12:00:00.000Z"))).resolves
      .toMatchObject({ id: "queued-000", attempt: 1 });
  });

  it("skips a user's second active job while preserving oldest-eligible order", async () => {
    const { database, env } = fixture();
    insertSubmission(database, { id: "alice-active", user: "alice", state: "compiling", created: "2026-08-12T00:00:00.000Z" });
    insertSubmission(database, { id: "alice-oldest", user: "alice", state: "queued", created: "2026-08-12T00:01:00.000Z" });
    insertSubmission(database, { id: "bob-next", user: "bob", state: "queued", created: "2026-08-12T00:02:00.000Z" });

    await expect(claimOldestSubmission(env)).resolves.toMatchObject({ id: "bob-next" });
    expect(database.prepare("SELECT state FROM submissions WHERE id='alice-oldest'").get()).toEqual({ state: "queued" });
  });

  it("reserves at most ten active rejudge slots while ordinary jobs borrow every idle slot", async () => {
    const capped = fixture();
    for (let index = 0; index < 10; index += 1) {
      insertSubmission(capped.database, {
        id: `active-rejudge-${index}`,
        user: `rejudge-user-${index}`,
        state: "running",
        created: "2026-08-12T00:00:00.000Z",
        rejudge: true,
      });
    }
    for (let index = 0; index < 39; index += 1) {
      insertSubmission(capped.database, {
        id: `active-ordinary-${index}`,
        user: `ordinary-user-${index}`,
        state: "running",
        created: "2026-08-12T00:00:00.000Z",
      });
    }
    insertSubmission(capped.database, { id: "old-rejudge", user: "r", state: "queued", created: "2026-08-12T00:01:00.000Z", rejudge: true });
    insertSubmission(capped.database, { id: "next-ordinary", user: "n", state: "queued", created: "2026-08-12T00:02:00.000Z" });
    await expect(claimOldestSubmission(capped.env)).resolves.toMatchObject({ id: "next-ordinary" });

    const borrowed = fixture();
    for (let index = 0; index < 49; index += 1) {
      insertSubmission(borrowed.database, {
        id: `busy-${index}`,
        user: `busy-user-${index}`,
        state: "running",
        created: "2026-08-12T00:00:00.000Z",
      });
    }
    insertSubmission(borrowed.database, { id: "borrower", user: "borrower", state: "queued", created: "2026-08-12T00:01:00.000Z" });
    await expect(claimOldestSubmission(borrowed.env)).resolves.toMatchObject({ id: "borrower" });
  });
});
