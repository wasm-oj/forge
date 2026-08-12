import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { WasmOjWorkerEnv } from "./env";
import {
  MAINTENANCE_SMOKE_HEADER,
  formalMutationStatus,
  requireFormalMutationsEnabled,
  setFormalMutationsEnabled,
} from "./formal-mutations";

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

  async run(): Promise<{ readonly meta: { readonly changes: number } }> {
    return { meta: { changes: Number(this.database.prepare(this.sql).run(...this.bindings).changes) } };
  }
}

class SqliteD1 {
  constructor(private readonly database: DatabaseSync) {}
  prepare(sql: string): SqliteStatement { return new SqliteStatement(this.database, sql); }
}

function fixture(
  environment: WasmOjWorkerEnv["ENVIRONMENT"],
  maintenanceSmokeToken?: string,
): { readonly database: DatabaseSync; readonly env: WasmOjWorkerEnv } {
  const database = new DatabaseSync(":memory:");
  database.exec(readFileSync(path.join(process.cwd(), "migrations/core/0015_formal_mutation_control.sql"), "utf8"));
  return {
    database,
    env: {
      ENVIRONMENT: environment,
      MAINTENANCE_SMOKE_TOKEN: maintenanceSmokeToken,
      DB: new SqliteD1(database) as unknown as D1Database,
    } as unknown as WasmOjWorkerEnv,
  };
}

describe("D1 formal mutation control", () => {
  it("starts development open and production closed", async () => {
    await expect(formalMutationStatus(fixture("development").env)).resolves.toMatchObject({
      enabled: true,
      reason: "development-default-open",
    });
    await expect(formalMutationStatus(fixture("production").env)).resolves.toMatchObject({
      enabled: false,
      reason: "deployment-default-closed",
    });
  });

  it("pauses and resumes one environment without a lease or generation", async () => {
    const { database, env } = fixture("development");
    await expect(setFormalMutationsEnabled(env, false, "manual deployment pause")).resolves.toMatchObject({
      enabled: false,
      reason: "manual deployment pause",
    });
    await expect(requireFormalMutationsEnabled(env)).rejects.toMatchObject({
      status: 503,
      code: "formal-mutations-paused",
    });
    await expect(setFormalMutationsEnabled(env, true, "deployment smoke passed")).resolves.toMatchObject({
      enabled: true,
      reason: "deployment smoke passed",
    });
    await expect(requireFormalMutationsEnabled(env)).resolves.toBeUndefined();
    expect(database.prepare("SELECT formal_mutations_enabled FROM formal_mutation_controls WHERE environment='staging'").get()).toEqual({
      formal_mutations_enabled: 0,
    });
  });

  it("fails closed on missing control state and rejects ambiguous reasons", async () => {
    const { database, env } = fixture("production");
    database.prepare("DELETE FROM formal_mutation_controls WHERE environment='production'").run();
    await expect(formalMutationStatus(env)).rejects.toMatchObject({
      status: 503,
      code: "formal-mutation-control-unavailable",
    });
    await expect(setFormalMutationsEnabled(env, true, "ok")).rejects.toThrow("4–500");
  });

  it("keeps public mutations paused while an exact production smoke token opens only the cutover lane", async () => {
    const token = "maintenance-smoke-token-2026-08-12-architecture-v2";
    const { database, env } = fixture("production", token);
    database.prepare(`UPDATE formal_mutation_controls
      SET reason='architecture-reset-maintenance'
      WHERE environment='production'`).run();
    const authorized = new Request("https://wasm-oj.example/api/submissions", {
      headers: { [MAINTENANCE_SMOKE_HEADER]: token },
    });
    const wrong = new Request("https://wasm-oj.example/api/submissions", {
      headers: { [MAINTENANCE_SMOKE_HEADER]: `${token}-wrong` },
    });
    await expect(requireFormalMutationsEnabled(env)).rejects.toMatchObject({ status: 503 });
    await expect(requireFormalMutationsEnabled(env, wrong)).rejects.toMatchObject({ status: 503 });
    await expect(requireFormalMutationsEnabled(env, authorized)).resolves.toBeUndefined();

    database.prepare(`UPDATE formal_mutation_controls
      SET reason='manual-incident-pause'
      WHERE environment='production'`).run();
    await expect(requireFormalMutationsEnabled(env, authorized)).rejects.toMatchObject({ status: 503 });
    await expect(requireFormalMutationsEnabled(fixture("staging", token).env, authorized)).rejects.toMatchObject({ status: 503 });
  });

  it("gates every reset-domain admission while leaving drain operations available", () => {
    const submissions = readFileSync(path.join(process.cwd(), "worker/submissions.ts"), "utf8");
    const product = readFileSync(path.join(process.cwd(), "worker/product.ts"), "utf8");
    const erasure = readFileSync(path.join(process.cwd(), "worker/account-erasure.ts"), "utf8");
    const catalog = readFileSync(path.join(process.cwd(), "worker/catalog.ts"), "utf8");
    const rejudge = readFileSync(path.join(process.cwd(), "worker/rejudge.ts"), "utf8");
    expect(submissions).toMatch(/createSubmission[\s\S]*requireFormalMutationsEnabled\(env, request\)[\s\S]*INSERT INTO submission_sources/);
    expect(submissions).toMatch(/updateSubmissionVisibility[\s\S]*requireFormalMutationsEnabled\(env, request\)[\s\S]*UPDATE submissions SET visibility/);
    expect(product).toMatch(/joinContest[\s\S]*requireFormalMutationsEnabled\(env, request\)[\s\S]*INSERT OR IGNORE INTO contest_participants/);
    expect(erasure).toMatch(/eraseAccount[\s\S]*requireFormalMutationsEnabled\(env, request\)[\s\S]*INSERT INTO account_erasure_jobs/);
    expect(catalog).toMatch(/organizerMutation[\s\S]*requireFormalMutationsEnabled\(env, request\)/);
    expect(rejudge).toMatch(/createRejudgeBatch[\s\S]*requireFormalMutationsEnabled\(env, request\)/);
    const cancelStart = submissions.indexOf("export async function cancelSubmission");
    const cancelEnd = submissions.indexOf("export async function updateSubmissionVisibility", cancelStart);
    expect(submissions.slice(cancelStart, cancelEnd)).not.toContain("requireFormalMutationsEnabled");
  });
});
