import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import {
  assertNoUnknownAppliedMigrations,
  assertContestV2CutoverReady,
  assertRepositoryCutoverReady,
  CONTEST_V2_CUTOVER_MIGRATION,
  CONTEST_V2_CUTOVER_PREFLIGHT_SQL,
  contestV2CutoverPreflightCounts,
  cutoverPreflightCounts,
  HISTORICAL_PRODUCTION_MIGRATIONS,
  PAUSE_REPOSITORY_CUTOVER_SQL,
  pendingMigrationNames,
  REPOSITORY_CUTOVER_PREFLIGHT_SQL,
  REPOSITORY_CUTOVER_MIGRATION,
  RESUME_REPOSITORY_CUTOVER_SQL,
} from "./production-migrations.mjs";

const migrations = [
  "0001_initial.sql",
  "0017_architecture_reset.sql",
  "0018_cli_auth.sql",
  REPOSITORY_CUTOVER_MIGRATION,
  CONTEST_V2_CUTOVER_MIGRATION,
];

test("migration inventory is exact and ordered", () => {
  assert.deepEqual(
    pendingMigrationNames(migrations, migrations.slice(0, 3)),
    [REPOSITORY_CUTOVER_MIGRATION, CONTEST_V2_CUTOVER_MIGRATION],
  );
  assert.doesNotThrow(() => assertNoUnknownAppliedMigrations(migrations, migrations.slice(0, 3)));
  assert.doesNotThrow(() => assertNoUnknownAppliedMigrations(
    migrations,
    [...migrations.slice(0, 3), ...HISTORICAL_PRODUCTION_MIGRATIONS],
  ));
  assert.throws(
    () => assertNoUnknownAppliedMigrations(migrations, [...migrations, "0020_unknown.sql"]),
    /absent from this checkout/u,
  );
});

test("historical production ledger names are exact and cannot hide unknown migrations", () => {
  assert.deepEqual(HISTORICAL_PRODUCTION_MIGRATIONS, [
    "0007_staging_acceptance.sql",
    "0008_staging_acceptance_controls.sql",
    "0009_release_drain_evidence.sql",
    "0011_release_transition_drain_nonce.sql",
    "0014_release_package_active_root.sql",
    "0015_release_package_mutation_lease.sql",
    "0016_staging_acceptance_fixture.sql",
  ]);
  assert.throws(
    () => assertNoUnknownAppliedMigrations(migrations, [
      ...HISTORICAL_PRODUCTION_MIGRATIONS,
      "0016_unrecognized_history.sql",
    ]),
    /0016_unrecognized_history\.sql/u,
  );
});

test("repository cutover accepts only an empty and fully drained operational boundary", () => {
  const ready = cutoverPreflightCounts([{ contests: 0, formal_enabled: 0, mutations: 0, outbox: 0 }]);
  assert.doesNotThrow(() => assertRepositoryCutoverReady(ready));
  for (const key of ["contests", "formal_enabled", "mutations", "outbox"]) {
    assert.throws(
      () => assertRepositoryCutoverReady({ ...ready, [key]: 1 }),
      /not drained/u,
    );
  }
  assert.throws(() => cutoverPreflightCounts([]), /no exact row/u);
  assert.throws(
    () => cutoverPreflightCounts([{ contests: 0, formal_enabled: 0, mutations: -1, outbox: 0 }]),
    /invalid counts/u,
  );
});

test("contest v2 cutover permits terminal history but rejects running contests and contest work", () => {
  const ready = contestV2CutoverPreflightCounts([
    { formal_enabled: 0, running: 0, mutations: 0, outbox: 0 },
  ]);
  assert.doesNotThrow(() => assertContestV2CutoverReady(ready));
  for (const key of ["formal_enabled", "running", "mutations", "outbox"]) {
    assert.throws(
      () => assertContestV2CutoverReady({ ...ready, [key]: 1 }),
      /not drained/u,
    );
  }
  assert.throws(() => contestV2CutoverPreflightCounts([]), /no exact row/u);
  assert.throws(
    () => contestV2CutoverPreflightCounts([
      { formal_enabled: 0, running: 0, mutations: -1, outbox: 0 },
    ]),
    /invalid counts/u,
  );
});

test("repository cutover SQL targets the real 0017 control and active-job schema", () => {
  const database = new DatabaseSync(":memory:");
  database.exec(`
    CREATE TABLE formal_mutation_controls (
      environment TEXT PRIMARY KEY,
      formal_mutations_enabled INTEGER NOT NULL,
      reason TEXT NOT NULL,
      updated_at TEXT NOT NULL
    ) STRICT;
    CREATE TABLE contests (id TEXT PRIMARY KEY) STRICT;
    CREATE TABLE catalog_validation_jobs (id TEXT PRIMARY KEY, state TEXT NOT NULL) STRICT;
    CREATE TABLE catalog_publish_jobs (id TEXT PRIMARY KEY, state TEXT NOT NULL) STRICT;
    CREATE TABLE submissions (id TEXT PRIMARY KEY, state TEXT NOT NULL) STRICT;
    CREATE TABLE rejudge_batches (id TEXT PRIMARY KEY, state TEXT NOT NULL) STRICT;
    CREATE TABLE rejudge_jobs (id TEXT PRIMARY KEY, state TEXT NOT NULL) STRICT;
    CREATE TABLE workflow_outbox (id TEXT PRIMARY KEY, state TEXT NOT NULL) STRICT;
    INSERT INTO formal_mutation_controls VALUES (
      'production', 1, 'production-open', '2026-08-26T00:00:00.000Z'
    );
  `);
  database.prepare(PAUSE_REPOSITORY_CUTOVER_SQL).run();
  const ready = cutoverPreflightCounts([database.prepare(REPOSITORY_CUTOVER_PREFLIGHT_SQL).get()]);
  assert.deepEqual({ ...ready }, { formal_enabled: 0, contests: 0, outbox: 0, mutations: 0 });
  assert.doesNotThrow(() => assertRepositoryCutoverReady(ready));

  database.prepare("INSERT INTO catalog_publish_jobs VALUES ('publish', 'materializing')").run();
  assert.equal(database.prepare(REPOSITORY_CUTOVER_PREFLIGHT_SQL).get().mutations, 1);
  database.prepare("DELETE FROM catalog_publish_jobs").run();
  database.prepare("INSERT INTO rejudge_jobs VALUES ('rejudge', 'dispatched')").run();
  assert.equal(database.prepare(REPOSITORY_CUTOVER_PREFLIGHT_SQL).get().mutations, 1);
  database.prepare("DELETE FROM rejudge_jobs").run();

  assert.deepEqual({ ...database.prepare(RESUME_REPOSITORY_CUTOVER_SQL).get() }, {
    enabled: 1,
    reason: "repository-source-truth-production-smoke-passed",
  });
  assert.equal(database.prepare(RESUME_REPOSITORY_CUTOVER_SQL).get(), undefined);
});

test("contest v2 preflight targets repository-v1 contest facts without requiring empty history", () => {
  const database = new DatabaseSync(":memory:");
  database.exec(`
    CREATE TABLE formal_mutation_controls (
      environment TEXT PRIMARY KEY, formal_mutations_enabled INTEGER NOT NULL,
      reason TEXT NOT NULL, updated_at TEXT NOT NULL
    ) STRICT;
    CREATE TABLE catalogs (id TEXT PRIMARY KEY, active_commit_sha TEXT) STRICT;
    CREATE TABLE contest_series (id TEXT PRIMARY KEY, catalog_id TEXT NOT NULL) STRICT;
    CREATE TABLE contest_revisions (
      contest_id TEXT NOT NULL, commit_sha TEXT NOT NULL, status TEXT NOT NULL,
      starts_at TEXT NOT NULL, ends_at TEXT NOT NULL
    ) STRICT;
    CREATE TABLE catalog_sync_jobs (id TEXT PRIMARY KEY, state TEXT NOT NULL) STRICT;
    CREATE TABLE submissions (
      id TEXT PRIMARY KEY, contest_id TEXT, state TEXT NOT NULL
    ) STRICT;
    CREATE TABLE rejudge_batches (
      id TEXT PRIMARY KEY, contest_id TEXT, state TEXT NOT NULL
    ) STRICT;
    CREATE TABLE workflow_outbox (
      id TEXT PRIMARY KEY, catalog_sync_job_id TEXT, submission_id TEXT, state TEXT NOT NULL
    ) STRICT;
    INSERT INTO formal_mutation_controls VALUES (
      'production', 0, 'repository-source-truth-cutover', '2026-08-26T00:00:00.000Z'
    );
    INSERT INTO catalogs VALUES ('catalog', '${"a".repeat(40)}');
    INSERT INTO contest_series VALUES ('contest', 'catalog');
    INSERT INTO contest_revisions VALUES (
      'contest', '${"a".repeat(40)}', 'archived',
      '2020-01-01T00:00:00.000Z', '2020-01-01T01:00:00.000Z'
    );
    INSERT INTO submissions VALUES ('terminal', 'contest', 'completed');
  `);
  const ready = contestV2CutoverPreflightCounts([
    database.prepare(CONTEST_V2_CUTOVER_PREFLIGHT_SQL).get(),
  ]);
  assert.deepEqual({ ...ready }, { formal_enabled: 0, running: 0, outbox: 0, mutations: 0 });
  assert.doesNotThrow(() => assertContestV2CutoverReady(ready));

  database.prepare("INSERT INTO submissions VALUES ('pending', 'contest', 'running')").run();
  assert.equal(database.prepare(CONTEST_V2_CUTOVER_PREFLIGHT_SQL).get().mutations, 1);
  database.prepare("DELETE FROM submissions WHERE id='pending'").run();
  database.prepare("INSERT INTO workflow_outbox VALUES ('outbox', NULL, 'terminal', 'pending')").run();
  assert.equal(database.prepare(CONTEST_V2_CUTOVER_PREFLIGHT_SQL).get().outbox, 1);
});
