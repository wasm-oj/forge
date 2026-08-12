import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import type { WasmOjWorkerEnv } from "./env";
import { reconcileRetention } from "./reconciler";

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
  async run(): Promise<{ readonly success: true; readonly meta: { readonly changes: number } }> {
    return this.execute();
  }
  execute(): { readonly success: true; readonly meta: { readonly changes: number } } {
    return {
      success: true,
      meta: { changes: Number(this.database.prepare(this.sql).run(...this.bindings).changes) },
    };
  }
}

class SqliteD1 {
  constructor(private readonly database: DatabaseSync) {}
  prepare(sql: string): SqliteStatement {
    return new SqliteStatement(this.database, sql);
  }
  async batch(statements: readonly SqliteStatement[]): Promise<readonly ReturnType<SqliteStatement["execute"]>[]> {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const results = statements.map((statement) => statement.execute());
      this.database.exec("COMMIT");
      return results;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }
}

class MemoryR2 {
  private readonly objects = new Map<string, R2Object>();
  failNextDelete = false;

  add(key: string, size: number, uploaded: Date): void {
    this.objects.set(key, {
      key,
      size,
      uploaded,
      version: "1",
      etag: "etag",
      httpEtag: '"etag"',
      checksums: { toJSON: () => ({}) },
      storageClass: "Standard",
      writeHttpMetadata: () => undefined,
    } as unknown as R2Object);
  }

  has(key: string): boolean {
    return this.objects.has(key);
  }

  async list(options?: R2ListOptions): Promise<R2Objects> {
    const objects = [...this.objects.values()]
      .filter((object) => !options?.prefix || object.key.startsWith(options.prefix))
      .sort((left, right) => left.key.localeCompare(right.key));
    return { objects, delimitedPrefixes: [], truncated: false };
  }

  async delete(key: string): Promise<void> {
    if (this.failNextDelete) {
      this.failNextDelete = false;
      throw new Error("injected R2 delete failure");
    }
    this.objects.delete(key);
  }

  async head(key: string): Promise<R2Object | null> {
    return this.objects.get(key) ?? null;
  }
}

function fixture(): { readonly database: DatabaseSync; readonly env: WasmOjWorkerEnv; readonly bucket: MemoryR2 } {
  const database = new DatabaseSync(":memory:");
  const bucket = new MemoryR2();
  database.exec(`CREATE TABLE submissions (
      id TEXT PRIMARY KEY, state TEXT NOT NULL, completed_at TEXT
    ) STRICT;
    CREATE TABLE submission_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT, submission_id TEXT NOT NULL,
      event_key TEXT NOT NULL, payload_json TEXT NOT NULL, created_at TEXT NOT NULL
    ) STRICT;
    CREATE TABLE catalog_validation_jobs (
      id TEXT PRIMARY KEY, state TEXT NOT NULL, finished_at TEXT
    ) STRICT;
    CREATE TABLE catalog_publish_jobs (
      id TEXT PRIMARY KEY, collection_revision_id TEXT, state TEXT NOT NULL, finished_at TEXT
    ) STRICT;
    CREATE TABLE collection_revision_problems (
      collection_revision_id TEXT NOT NULL, judge_package_sha256 TEXT NOT NULL
    ) STRICT;
    CREATE TABLE github_webhook_deliveries (
      delivery_id TEXT PRIMARY KEY, outcome TEXT NOT NULL, updated_at TEXT NOT NULL
    ) STRICT;
    CREATE TABLE workflow_outbox (
      id TEXT PRIMARY KEY, state TEXT NOT NULL, settled_at TEXT, updated_at TEXT NOT NULL
    ) STRICT;
    CREATE TABLE sessions (token_hash TEXT PRIMARY KEY, expires_at TEXT NOT NULL) STRICT;
    CREATE TABLE oauth_states (state_hash TEXT PRIMARY KEY, expires_at TEXT NOT NULL) STRICT;
    CREATE TABLE github_installation_states (state_hash TEXT PRIMARY KEY, expires_at TEXT NOT NULL) STRICT;
    CREATE TABLE github_installation_claim_proofs (
      installation_id INTEGER PRIMARY KEY, delivery_id TEXT, expires_at TEXT NOT NULL,
      FOREIGN KEY (delivery_id) REFERENCES github_webhook_deliveries(delivery_id) ON DELETE RESTRICT
    ) STRICT;
    CREATE TABLE judge_packages (
      sha256 TEXT PRIMARY KEY, bytes INTEGER NOT NULL,
      state TEXT NOT NULL, staged_at TEXT NOT NULL,
      ready_at TEXT, delete_token TEXT, lease_expires_at TEXT, last_error TEXT
    ) STRICT;
    CREATE TABLE maintenance_cursors (
      kind TEXT PRIMARY KEY, cursor TEXT, last_completed_at TEXT, updated_at TEXT NOT NULL
    ) STRICT;`);
  return {
    database,
    env: {
      DB: new SqliteD1(database) as unknown as D1Database,
      ENVIRONMENT: "development",
      JUDGE_BUCKET: bucket as unknown as R2Bucket,
    } as unknown as WasmOjWorkerEnv,
    bucket,
  };
}

describe("cursor-based retention", () => {
  it("resumes a small-quota pass and lets every retention class finish independently", async () => {
    const { database, env } = fixture();
    const old = "2026-06-01T00:00:00.000Z";
    const recent = "2026-08-12T11:00:00.000Z";
    database.prepare("INSERT INTO submissions VALUES ('terminal', 'completed', ?)").run(old);
    database.prepare("INSERT INTO submissions VALUES ('recent', 'completed', ?)").run(recent);
    for (let index = 0; index < 55; index += 1) {
      database.prepare("INSERT INTO submission_events (submission_id, event_key, payload_json, created_at) VALUES ('terminal', ?, '{}', ?)")
        .run(`old-${index}`, old);
    }
    database.prepare("INSERT INTO submission_events (submission_id, event_key, payload_json, created_at) VALUES ('recent', 'keep', '{}', ?)")
      .run(recent);
    database.prepare("INSERT INTO catalog_validation_jobs VALUES ('validation-old', 'valid', ?)").run(old);
    database.prepare("INSERT INTO catalog_publish_jobs VALUES ('publish-old', NULL, 'failed', ?)").run(old);
    database.prepare("INSERT INTO github_webhook_deliveries VALUES ('delivery-old', 'accepted', ?)").run(old);
    database.prepare("INSERT INTO github_installation_claim_proofs VALUES (1, 'delivery-old', ?)").run(old);
    database.prepare("INSERT INTO workflow_outbox VALUES ('outbox-old', 'delivered', ?, ?)").run(old, old);
    database.prepare("INSERT INTO sessions VALUES ('session-old', ?)").run(old);
    database.prepare("INSERT INTO oauth_states VALUES ('oauth-old', ?)").run(old);
    database.prepare("INSERT INTO github_installation_states VALUES ('install-old', ?)").run(old);

    const now = new Date("2026-08-12T12:34:00.000Z");
    const first = await reconcileRetention(env, now);
    expect(first.submissionEvents).toBe(50);
    expect(first.catalogJobs).toBe(2);
    expect(first.auth).toBe(4);
    expect(first.webhooks).toBe(1);
    expect(first.outbox).toBe(1);
    expect(database.prepare("SELECT COUNT(*) AS count FROM submission_events").get()).toEqual({ count: 6 });

    const second = await reconcileRetention(env, now);
    expect(second.submissionEvents).toBe(5);
    expect(database.prepare("SELECT COUNT(*) AS count FROM submission_events").get()).toEqual({ count: 1 });
    expect(database.prepare("SELECT cursor, last_completed_at FROM maintenance_cursors WHERE kind='submission-events'").get())
      .toEqual({ cursor: null, last_completed_at: now.toISOString() });

    const third = await reconcileRetention(env, now);
    expect(third).toEqual({
      submissionEvents: 0,
      catalogJobs: 0,
      webhooks: 0,
      outbox: 0,
      auth: 0,
      orphanJudgePackages: 0,
    });
  });

  it("deletes only per-digest fenced staging and R2-only packages", async () => {
    const { database, env, bucket } = fixture();
    const now = new Date("2026-08-12T12:34:00.000Z");
    const old = "2026-08-10T00:00:00.000Z";
    const stagingDigest = "a".repeat(64);
    const readyDigest = "b".repeat(64);
    const r2OnlyDigest = "c".repeat(64);
    const activeDigest = "d".repeat(64);
    const insertPackage = database.prepare(`INSERT INTO judge_packages
      (sha256, bytes, state, staged_at, ready_at,
       delete_token, lease_expires_at, last_error)
      VALUES (?, 10, ?, ?, ?, NULL, NULL, NULL)`);
    insertPackage.run(stagingDigest, "staging", old, null);
    insertPackage.run(readyDigest, "ready", old, old);
    insertPackage.run(activeDigest, "staging", old, null);
    database.prepare("INSERT INTO catalog_publish_jobs VALUES ('active', 'revision', 'materializing', NULL)").run();
    database.prepare("INSERT INTO collection_revision_problems VALUES ('revision', ?)").run(activeDigest);
    for (const digest of [stagingDigest, readyDigest, r2OnlyDigest, activeDigest]) {
      bucket.add(`judge-packages/v2/${digest}`, 10, new Date(old));
    }

    const result = await reconcileRetention(env, now);
    expect(result.orphanJudgePackages).toBe(2);
    expect(bucket.has(`judge-packages/v2/${stagingDigest}`)).toBe(false);
    expect(bucket.has(`judge-packages/v2/${r2OnlyDigest}`)).toBe(false);
    expect(bucket.has(`judge-packages/v2/${readyDigest}`)).toBe(true);
    expect(bucket.has(`judge-packages/v2/${activeDigest}`)).toBe(true);
    expect(database.prepare("SELECT state FROM judge_packages WHERE sha256=?").get(stagingDigest)).toBeUndefined();
    expect(database.prepare("SELECT state FROM judge_packages WHERE sha256=?").get(r2OnlyDigest)).toBeUndefined();
    expect(database.prepare("SELECT state FROM judge_packages WHERE sha256=?").get(readyDigest)).toEqual({ state: "ready" });
    expect(database.prepare("SELECT state FROM judge_packages WHERE sha256=?").get(activeDigest)).toEqual({ state: "staging" });
  });

  it("keeps a failed deletion fenced and resumes it only after the lease expires", async () => {
    const { database, env, bucket } = fixture();
    const digest = "e".repeat(64);
    const key = `judge-packages/v2/${digest}`;
    const firstNow = new Date("2026-08-12T12:34:00.000Z");
    database.prepare(`INSERT INTO judge_packages
      (sha256, bytes, state, staged_at)
      VALUES (?, 10, 'staging', '2026-08-10T00:00:00.000Z')`)
      .run(digest);
    bucket.add(key, 10, new Date("2026-08-10T00:00:00.000Z"));
    bucket.failNextDelete = true;

    expect((await reconcileRetention(env, firstNow)).orphanJudgePackages).toBe(0);
    const fenced = database.prepare("SELECT state, delete_token, last_error FROM judge_packages WHERE sha256=?")
      .get(digest) as { readonly state: string; readonly delete_token: string; readonly last_error: string };
    expect(fenced.state).toBe("deleting");
    expect(fenced.delete_token).toMatch(/^[0-9a-f-]{36}$/);
    expect(fenced.last_error).toBe("injected R2 delete failure");
    expect(bucket.has(key)).toBe(true);

    expect((await reconcileRetention(env, new Date(firstNow.getTime() + 4 * 60 * 1_000))).orphanJudgePackages).toBe(0);
    expect(bucket.has(key)).toBe(true);
    expect((await reconcileRetention(env, new Date(firstNow.getTime() + 6 * 60 * 1_000))).orphanJudgePackages).toBe(1);
    expect(bucket.has(key)).toBe(false);
    expect(database.prepare("SELECT state FROM judge_packages WHERE sha256=?").get(digest)).toBeUndefined();
  });
});
