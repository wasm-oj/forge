import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const retainedHistory = [
  ["collection_imports", "UPDATE collection_imports SET organizer_user_id=?"],
  ["managed_snapshots", "UPDATE managed_snapshots SET published_by=?"],
  ["contests", "UPDATE contests SET organizer_user_id=?"],
  ["rejudge_batches", "UPDATE rejudge_batches SET requested_by=?"],
] as const;

const privateState = [
  ["contest_participants", "DELETE FROM contest_participants WHERE user_id=?"],
  ["verified_solves", "DELETE FROM verified_solves WHERE user_id=?"],
  ["formal_submission_admissions", "DELETE FROM formal_submission_admissions WHERE user_id=?"],
  ["rejudge_verified_solves", "DELETE FROM rejudge_verified_solves WHERE user_id=?"],
] as const;

describe("account erasure schema coverage", () => {
  it("reparents every retained public-history owner and deletes private user state", async () => {
    const [initial, rejudge, implementation] = await Promise.all([
      readFile(new URL("../migrations/core/0001_initial.sql", import.meta.url), "utf8"),
      readFile(new URL("../migrations/core/0005_rejudge_pipeline.sql", import.meta.url), "utf8"),
      readFile(new URL("../worker/account-erasure.ts", import.meta.url), "utf8"),
    ]);
    const schema = `${initial}\n${rejudge}`;
    for (const [table, mutation] of [...retainedHistory, ...privateState]) {
      expect(schema).toContain(`CREATE TABLE ${table}`);
      expect(implementation).toContain(mutation);
    }
    expect(implementation).toContain("DELETE FROM repository_push_notices WHERE github_repository_id IN");
    expect(implementation).toContain("owner_login='erased-owner-' || github_repository_id");
    expect(implementation).toContain("account_github_id=-installation_id");
    expect(implementation).toContain("installed_by_user_id=NULL");
    expect(implementation).toContain("DELETE\",");
    expect(implementation).toContain("/app/installations/");
    expect(implementation).toContain("UPDATE organizer_applications SET reviewed_by=NULL");
    expect(implementation).toContain("UPDATE user_roles SET granted_by=NULL");
    expect(implementation).toContain("DELETE FROM users WHERE id=?");
    expect(implementation).toContain("DELETE FROM account_erasure_jobs WHERE id=?");
  });
});
