import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { activateRelease, type ReleaseActivation } from "./release";

type Binding = null | number | bigint | string | NodeJS.ArrayBufferView;

class Statement {
  private bindings: readonly Binding[] = [];
  constructor(private readonly database: DatabaseSync, private readonly sql: string) {}
  bind(...bindings: Binding[]): Statement { this.bindings = bindings; return this; }
  execute(): void { this.database.prepare(this.sql).run(...this.bindings); }
}

class Database {
  constructor(readonly sqlite: DatabaseSync) {}
  prepare(sql: string): Statement { return new Statement(this.sqlite, sql); }
  async batch(statements: readonly Statement[]): Promise<readonly D1Result[]> {
    this.sqlite.exec("BEGIN IMMEDIATE");
    try {
      for (const statement of statements) statement.execute();
      this.sqlite.exec("COMMIT");
      return [];
    } catch (error) {
      this.sqlite.exec("ROLLBACK");
      throw error;
    }
  }
}

const firstId = "00000000-0000-4000-8000-000000000001";
const secondId = "00000000-0000-4000-8000-000000000002";

function fixture(): { readonly sqlite: DatabaseSync; readonly database: D1Database } {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(`CREATE TABLE formal_mutation_controls (
      environment TEXT PRIMARY KEY,
      formal_mutations_enabled INTEGER NOT NULL CHECK(formal_mutations_enabled IN (0,1)),
      reason TEXT NOT NULL,
      updated_at TEXT NOT NULL
    ) STRICT;
    INSERT INTO formal_mutation_controls VALUES ('production', 0, 'maintenance', '2026-08-12T00:00:00.000Z');
    CREATE TABLE wasm_oj_releases (
      id TEXT PRIMARY KEY, version TEXT NOT NULL UNIQUE, manifest_json TEXT NOT NULL,
      manifest_bytes INTEGER NOT NULL, manifest_sha256 TEXT NOT NULL,
      source_git_commit TEXT NOT NULL, created_at TEXT NOT NULL, revoked_at TEXT
    ) STRICT;
    CREATE TABLE wasm_oj_active_releases (
      environment TEXT PRIMARY KEY, wasm_oj_release_id TEXT NOT NULL REFERENCES wasm_oj_releases(id),
      activated_by TEXT NOT NULL, activated_at TEXT NOT NULL
    ) STRICT;`);
  return { sqlite, database: new Database(sqlite) as unknown as D1Database };
}

function activation(
  releaseId: string,
  expectedCurrentReleaseId: string | null,
  environment: ReleaseActivation["environment"] = "production",
): ReleaseActivation {
  const manifestJson = `{"releaseId":"${releaseId}"}\n`;
  return {
    releaseId,
    version: releaseId === firstId ? "1.0.0" : "2.0.0",
    manifestJson,
    manifestBytes: new TextEncoder().encode(manifestJson).byteLength,
    manifestSha256: (releaseId === firstId ? "a" : "b").repeat(64),
    sourceGitCommit: (releaseId === firstId ? "1" : "2").repeat(40),
    createdAt: "2026-08-12T00:00:00.000Z",
    activatedBy: "admin",
    environment,
    expectedCurrentReleaseId,
  };
}

describe("atomic WASM-OJ release activation", () => {
  it("activates a fresh release then atomically advances the environment pointer", async () => {
    const { sqlite, database } = fixture();
    await activateRelease(database, activation(firstId, null));
    await activateRelease(database, activation(secondId, firstId));
    expect(sqlite.prepare("SELECT id, revoked_at FROM wasm_oj_releases ORDER BY id").all()).toEqual([
      { id: firstId, revoked_at: null },
      { id: secondId, revoked_at: null },
    ]);
    expect(sqlite.prepare("SELECT wasm_oj_release_id FROM wasm_oj_active_releases WHERE environment='production'").get())
      .toEqual({ wasm_oj_release_id: secondId });
  });

  it("rolls the whole batch back when the expected active release is stale", async () => {
    const { sqlite, database } = fixture();
    await activateRelease(database, activation(firstId, null));
    await expect(activateRelease(database, activation(secondId, null))).rejects.toThrow();
    expect(sqlite.prepare("SELECT id, revoked_at FROM wasm_oj_releases").all()).toEqual([{ id: firstId, revoked_at: null }]);
    expect(sqlite.prepare("SELECT wasm_oj_release_id FROM wasm_oj_active_releases").get()).toEqual({ wasm_oj_release_id: firstId });
  });

  it("rejects a conflicting manifest for an existing immutable release ID", async () => {
    const { sqlite, database } = fixture();
    await activateRelease(database, activation(firstId, null));
    await expect(activateRelease(database, {
      ...activation(firstId, firstId),
      version: "1.0.1",
    })).rejects.toThrow();
    expect(sqlite.prepare("SELECT version FROM wasm_oj_releases WHERE id=?").get(firstId))
      .toEqual({ version: "1.0.0" });
    expect(sqlite.prepare("SELECT wasm_oj_release_id FROM wasm_oj_active_releases").get())
      .toEqual({ wasm_oj_release_id: firstId });
  });

  it("fails closed when the environment maintenance-control row is missing", async () => {
    const { sqlite, database } = fixture();
    sqlite.prepare("DELETE FROM formal_mutation_controls WHERE environment='production'").run();

    await expect(activateRelease(database, activation(firstId, null))).rejects.toThrow();
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM wasm_oj_releases").get()).toEqual({ count: 0 });
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM wasm_oj_active_releases").get()).toEqual({ count: 0 });
  });

  it("fails closed while formal mutations are enabled", async () => {
    const { sqlite, database } = fixture();
    sqlite.prepare("UPDATE formal_mutation_controls SET formal_mutations_enabled=1 WHERE environment='production'").run();

    await expect(activateRelease(database, activation(firstId, null))).rejects.toThrow();
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM wasm_oj_releases").get()).toEqual({ count: 0 });
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM wasm_oj_active_releases").get()).toEqual({ count: 0 });
  });

  it("keeps independent active pointers for environments sharing one D1", async () => {
    const { sqlite, database } = fixture();
    sqlite.prepare("INSERT INTO formal_mutation_controls VALUES ('staging', 0, 'maintenance', ?)")
      .run("2026-08-12T00:00:00.000Z");
    await activateRelease(database, activation(firstId, null, "production"));
    await activateRelease(database, activation(secondId, null, "staging"));
    expect(sqlite.prepare("SELECT environment, wasm_oj_release_id FROM wasm_oj_active_releases ORDER BY environment").all())
      .toEqual([
        { environment: "production", wasm_oj_release_id: firstId },
        { environment: "staging", wasm_oj_release_id: secondId },
      ]);
  });

  it("refuses to activate a revoked immutable manifest", async () => {
    const { sqlite, database } = fixture();
    await activateRelease(database, activation(firstId, null));
    sqlite.prepare("UPDATE wasm_oj_releases SET revoked_at=? WHERE id=?")
      .run("2026-08-12T01:00:00.000Z", firstId);
    await expect(activateRelease(database, activation(firstId, firstId))).rejects.toThrow();
    expect(sqlite.prepare("SELECT wasm_oj_release_id FROM wasm_oj_active_releases").get())
      .toEqual({ wasm_oj_release_id: firstId });
  });
});
