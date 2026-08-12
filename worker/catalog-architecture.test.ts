import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { contentClientResponse } from "./catalog";

describe("catalog v2 architecture boundary", () => {
  it("keeps validation static and outside R2 and Containers", async () => {
    const source = await readFile(new URL("./catalog-workflows.ts", import.meta.url), "utf8");
    const validation = source.slice(source.indexOf("async function runValidation"), source.indexOf("function r2Sha256"));
    expect(validation).not.toMatch(/JUDGE_BUCKET|Container|tar\.gz|archive|R2/);
    expect(validation).toContain("exactCommitTree");
    expect(validation).toContain("validateOneProblem");
    expect(validation).toContain("persistValidRevision");
    expect(source.slice(source.indexOf("async function validateOneProblem"), source.indexOf("async function runValidation")))
      .toContain("validateJudgePackage");
  });

  it("streams each judge package into R2 with its declared fixed length", async () => {
    const source = await readFile(new URL("./catalog-workflows.ts", import.meta.url), "utf8");
    const materialization = source.slice(
      source.indexOf("async function materializeJudgePackage"),
      source.indexOf("async function publishContext"),
    );
    const streamDeclaration = materialization.match(
      /\bconst\s+([A-Za-z_$][\w$]*)\s*=\s*new FixedLengthStream\(\s*problem\.judge_package_bytes\s*\)\s*;/,
    );
    expect(streamDeclaration).not.toBeNull();
    const streamName = streamDeclaration![1]!;
    const transferDeclaration = materialization.match(new RegExp(
      `\\bconst\\s+([A-Za-z_$][\\w$]*)\\s*=\\s*response\\.body\\.pipeTo\\(\\s*${streamName}\\.writable\\s*,`,
    ));
    expect(transferDeclaration).not.toBeNull();
    const transferName = transferDeclaration![1]!;
    const upload = materialization.match(new RegExp(
      `await\\s+env\\.JUDGE_BUCKET\\.put\\(\\s*key\\s*,\\s*${streamName}\\.readable\\s*,`,
    ));
    expect(upload).not.toBeNull();
    expect(materialization.indexOf(transferDeclaration![0])).toBeLessThan(materialization.indexOf(upload![0]));
    expect(materialization).toContain(`await ${transferName};`);
    expect(materialization.match(new RegExp(`await\\s+${transferName}\\.catch`, "g"))).toHaveLength(2);
  });

  it("does not retain the removed validation execution modules", async () => {
    const [worker, container] = await Promise.all([
      readFile(new URL("./index.ts", import.meta.url), "utf8"),
      readFile(new URL("../container/server.mjs", import.meta.url), "utf8"),
    ]);
    expect(worker).not.toMatch(/ValidationJudgeContainer|VALIDATION_JUDGE_CONTAINER/);
    expect(container).not.toMatch(/validation-source|github-archive|validate-collection/);
  });

  it("never exposes authorized contest bytes through a shared client cache", async () => {
    const edgeCached = new Response('{"redacted":true}', {
      headers: { "cache-control": "public, max-age=300", "content-type": "application/json" },
    });
    const contest = contentClientResponse(edgeCached, "contest-public");
    expect(contest.headers.get("cache-control")).toBe("private, no-store");
    expect(contest.headers.get("vary")).toBe("Cookie");
    await expect(contest.text()).resolves.toBe('{"redacted":true}');

    const practice = contentClientResponse(new Response("{}"), "practice");
    expect(practice.headers.get("cache-control")).toBe("public, max-age=300");
    expect(practice.headers.has("vary")).toBe(false);
  });

  it("rechecks repository and installation authority before every cache lookup", async () => {
    const source = await readFile(new URL("./catalog.ts", import.meta.url), "utf8");
    const pointer = source.slice(source.indexOf("async function contentPointer"), source.indexOf("export async function publicProblemContent"));
    expect(pointer.match(/repositories\.authorization_status='authorized'/g)).toHaveLength(2);
    expect(pointer.match(/installations\.status='active'/g)).toHaveLength(2);
    expect(pointer.match(/installations\.installed_by_user_id IS NOT NULL/g)).toHaveLength(2);
    expect(source.indexOf("await contentPointer")).toBeLessThan(source.indexOf("await cache.match"));
  });

  it("uses normalized catalog and contest authorities without constant mirrors", async () => {
    const [workflow, catalog, product, leaderboards, release] = await Promise.all([
      readFile(new URL("./catalog-workflows.ts", import.meta.url), "utf8"),
      readFile(new URL("./catalog.ts", import.meta.url), "utf8"),
      readFile(new URL("./product.ts", import.meta.url), "utf8"),
      readFile(new URL("./leaderboards.ts", import.meta.url), "utf8"),
      readFile(new URL("./release.ts", import.meta.url), "utf8"),
    ]);
    expect(workflow).toContain("(id, catalog_publication_id, problem_series_id, execution_semantic_sha256, created_at)");
    expect(`${catalog}\n${product}`).not.toMatch(/\bproblem_versions AS\b/);
    expect(`${workflow}\n${catalog}\n${product}`).not.toMatch(/publish_state|validation_state|problem_mode/);
    expect(`${catalog}\n${product}`).toContain("problem_version_details");
    expect(leaderboards).toContain("JOIN contest_problems AS contest_problem");
    expect(leaderboards).not.toContain("json_each");
    expect(release).not.toMatch(/release\.status|status='(?:candidate|active|retired)'/);
    expect(release).toContain("release.revoked_at IS NULL");
  });
});
