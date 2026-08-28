import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("contest product v2 runtime boundary", () => {
  it("delegates phase and freeze projection to the rule runtime without v1 schedule queries", () => {
    const source = readFileSync(path.join(process.cwd(), "worker/product.ts"), "utf8");
    expect(source).toContain("loadContestRuntimeSnapshot");
    expect(source).toContain("evidenceLogicalAtOrBefore");
    expect(source).toContain("contest_problem_prompt_contexts");
    expect(source).toContain("promptContextSha256");
    expect(source).not.toMatch(/contest_revisions|contest_revision_problems|contest_participants/);
    expect(source).not.toMatch(/revisions\.(?:starts_at|ends_at|freeze_at)/);
    expect(source).not.toContain("function contestPhase");
  });

  it("keeps Official Submit on the exact contest content revision and atomically fences due checkpoints", () => {
    const source = readFileSync(path.join(process.cwd(), "worker/submissions.ts"), "utf8");
    expect(source).toContain("loadSubmissionProblemRevisionForAdmission");
    expect(source).toContain("revisions.commit_sha=?");
    expect(source).toMatch(/\? IS NULL AND revisions\.practice_enabled=1\s+AND catalogs\.active_commit_sha=revisions\.commit_sha/);
    expect(source).not.toContain("activeProblemRevision");
    expect(source).toContain("AND NOT ${unadvancedDueCheckpointSql(CONTEST_CURRENT_LOGICAL_SQL)}");
    expect(source).toContain("checkpoint_decision.decision='advanced'");
    expect(source).toContain("checkpoint_run.state IN ('provisional','final')");
    expect(source).toContain("contest-checkpoint-not-advanced");
  });
});
