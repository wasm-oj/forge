import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { ForgeWorkerEnv } from "./env";
import {
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

function fixture(environment: ForgeWorkerEnv["ENVIRONMENT"]): { readonly database: DatabaseSync; readonly env: ForgeWorkerEnv } {
  const database = new DatabaseSync(":memory:");
  database.exec(readFileSync(path.join(process.cwd(), "migrations/core/0015_formal_mutation_control.sql"), "utf8"));
  return {
    database,
    env: {
      ENVIRONMENT: environment,
      DB: new SqliteD1(database) as unknown as D1Database,
    } as unknown as ForgeWorkerEnv,
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
});
