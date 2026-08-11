import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { formalSubmissionAdmissionClaimSha256 } from "./formal-admissions";
import {
  INSERT_FORMAL_SUBMISSION_ADMISSION_SQL,
  INSERT_OFFICIAL_SUBMISSION_OUTBOX_SQL,
  INSERT_OFFICIAL_SUBMISSION_SQL,
} from "./submissions";

const SUBMISSION_ID = "0198dbd3-5c00-7000-8000-000000000601";
const USER_ID = "0198dbd3-5c00-7000-8000-000000000602";
const PROBLEM_ID = "0198dbd3-5c00-7000-8000-000000000603";
const CONTEST_ID = "0198dbd3-5c00-7000-8000-000000000604";
const OUTBOX_ID = "0198dbd3-5c00-7000-8000-000000000605";
const RELEASE_ID = "0198dbd3-5c00-7000-8000-000000000606";
const SOURCE_DIGEST = "a".repeat(64);
const SOURCE_KEY = `sources/${USER_ID}/${SUBMISSION_ID}.${SOURCE_DIGEST}.json`;
const CREATED_AT = "2026-08-09T00:00:00.000Z";

function coreDatabase(): DatabaseSync {
  const database = new DatabaseSync(":memory:");
  database.exec(`CREATE TABLE users (id TEXT PRIMARY KEY, status TEXT NOT NULL) STRICT;
    CREATE TABLE account_erasure_jobs (id TEXT PRIMARY KEY, user_id TEXT NOT NULL) STRICT;
    CREATE TABLE rejudge_batches (old_problem_version_id TEXT NOT NULL, status TEXT NOT NULL) STRICT;
    CREATE TABLE effective_problem_versions (original_problem_version_id TEXT NOT NULL) STRICT;
    CREATE TABLE contests (
      id TEXT PRIMARY KEY, status TEXT NOT NULL, access_mode TEXT NOT NULL,
      starts_at TEXT NOT NULL, ends_at TEXT NOT NULL
    ) STRICT;
    CREATE TABLE contest_problems (contest_id TEXT NOT NULL, managed_problem_version_id TEXT NOT NULL) STRICT;
    CREATE TABLE contest_participants (contest_id TEXT NOT NULL, user_id TEXT NOT NULL) STRICT;
    CREATE TABLE formal_submission_admissions (
      submission_id TEXT PRIMARY KEY, managed_problem_version_id TEXT NOT NULL, user_id TEXT NOT NULL,
      contest_id TEXT, admitted_at TEXT, state TEXT NOT NULL, source_r2_key TEXT, source_sha256 TEXT,
      cleanup_state TEXT NOT NULL, created_at TEXT NOT NULL, expires_at TEXT NOT NULL, updated_at TEXT NOT NULL
    ) STRICT;`);
  database.prepare("INSERT INTO users VALUES (?, 'active')").run(USER_ID);
  database.prepare("INSERT INTO contests VALUES (?, 'running', 'public', '2000-01-01T00:00:00.000Z', '2999-01-01T00:00:00.000Z')")
    .run(CONTEST_ID);
  database.prepare("INSERT INTO contest_problems VALUES (?, ?)").run(CONTEST_ID, PROBLEM_ID);
  return database;
}

function insertMarker(database: DatabaseSync): number {
  return Number(database.prepare(INSERT_FORMAL_SUBMISSION_ADMISSION_SQL).run(
    SUBMISSION_ID,
    PROBLEM_ID,
    USER_ID,
    CONTEST_ID,
    SOURCE_KEY,
    SOURCE_DIGEST,
    CREATED_AT,
    "2999-01-01T00:00:00.000Z",
    CREATED_AT,
  ).changes);
}

function submissionsDatabase(): DatabaseSync {
  const database = new DatabaseSync(":memory:");
  const directory = path.join(process.cwd(), "migrations/submissions");
  for (const migration of readdirSync(directory).filter((name) => name.endsWith(".sql")).sort()) {
    database.exec(readFileSync(path.join(directory, migration), "utf8"));
  }
  return database;
}

describe("contest formal admission fence", () => {
  it("rejects the marker when the contest closes after a preliminary open read", () => {
    const core = coreDatabase();
    expect(core.prepare("SELECT status FROM contests WHERE id=? AND ends_at>strftime('%Y-%m-%dT%H:%M:%fZ', 'now')").get(CONTEST_ID))
      .toEqual({ status: "running" });

    core.prepare("UPDATE contests SET ends_at='2001-01-01T00:00:00.000Z' WHERE id=?").run(CONTEST_ID);
    expect(insertMarker(core)).toBe(0);
    expect(core.prepare("SELECT COUNT(*) AS count FROM formal_submission_admissions").get()).toEqual({ count: 0 });
  });

  it("uses the D1 admission time and requires its exact claim before creating an outbox row", async () => {
    const core = coreDatabase();
    expect(insertMarker(core)).toBe(1);
    const marker = core.prepare(
      "SELECT contest_id, admitted_at FROM formal_submission_admissions WHERE submission_id=?",
    ).get(SUBMISSION_ID) as { readonly contest_id: string; readonly admitted_at: string };
    expect(marker.contest_id).toBe(CONTEST_ID);
    expect(marker.admitted_at > "2000-01-01T00:00:00.000Z" && marker.admitted_at < "2999-01-01T00:00:00.000Z").toBe(true);

    const claim = await formalSubmissionAdmissionClaimSha256({
      submissionId: SUBMISSION_ID,
      managedProblemVersionId: PROBLEM_ID,
      userId: USER_ID,
      contestId: CONTEST_ID,
      admittedAt: marker.admitted_at,
      sourceR2Key: SOURCE_KEY,
      sourceSha256: SOURCE_DIGEST,
    });
    const submissions = submissionsDatabase();
    expect(submissions.prepare(INSERT_OFFICIAL_SUBMISSION_SQL).run(
      SUBMISSION_ID, USER_ID, PROBLEM_ID, CONTEST_ID, marker.admitted_at, claim,
      "c", "wasip1", "release", "main.c", SOURCE_KEY, SOURCE_DIGEST,
      RELEASE_ID, SOURCE_DIGEST, marker.admitted_at, marker.admitted_at, USER_ID,
    ).changes).toBe(1);
    const outbox = (admittedAt: string, claimSha256: string, contestId: string | null) => Number(
      submissions.prepare(INSERT_OFFICIAL_SUBMISSION_OUTBOX_SQL).run(
        OUTBOX_ID, SUBMISSION_ID, "{}", marker.admitted_at,
        SUBMISSION_ID, USER_ID, SOURCE_KEY, SOURCE_DIGEST, admittedAt, claimSha256, contestId,
      ).changes,
    );
    expect(outbox(marker.admitted_at, "b".repeat(64), CONTEST_ID)).toBe(0);
    expect(outbox(marker.admitted_at, claim, null)).toBe(0);
    expect(outbox(marker.admitted_at, claim, CONTEST_ID)).toBe(1);
  });
});
