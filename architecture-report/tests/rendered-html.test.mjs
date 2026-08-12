import assert from "node:assert/strict";
import test from "node:test";

async function render() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);

  return worker.fetch(
    new Request("http://localhost/", { headers: { accept: "text/html" } }),
    { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) } },
    { waitUntil() {}, passThroughOnException() {} },
  );
}

test("server-renders the complete Architecture v2 implementation report", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  assert.match(html, /<html lang="zh-Hant">/i);
  assert.match(html, /Architecture v2/);
  assert.match(html, /P0／P1/);
  assert.match(html, /CURRENT → TARGET/);
  assert.match(html, /SIMPLIFIED ER MODEL/);
  assert.match(html, /problem_version_details/);
  assert.match(html, /workflow_outbox/);
  assert.match(html, /VALIDATE/);
  assert.match(html, /PUBLISH/);
  assert.match(html, /SUBMIT/);
  assert.match(html, /REJUDGE/);
  assert.match(html, /R2 LIFECYCLE/);
  assert.match(html, /WASM-OJ \/ ARCHITECTURE v2/);
  assert.match(html, /WOJJDG02/);
  assert.match(html, /judge-packages\/v2/);
  assert.match(html, /submission-sources\/v2/);
  assert.doesNotMatch(html, /\bForge\b|FORGJDG1|judge-packages\/v1|submission-sources\/v1/);
  assert.match(html, /PERFORMANCE LAB/);
  assert.match(html, /myEvolutionTruncated/);
  assert.match(html, /baseline → efficient → optimal/);
  assert.match(html, /IMPLEMENTED, NOT YET EXECUTED/);
  assert.doesNotMatch(html, /CONDITIONAL GO/);
  assert.doesNotMatch(html, /Your site is taking shape/);
});

test("renders all R-01 through R-14 repairs with causal chain and v2 evidence", async () => {
  const response = await render();
  const html = await response.text();

  for (let index = 1; index <= 14; index += 1) {
    const id = `R-${String(index).padStart(2, "0")}`;
    const anchor = id.toLowerCase();
    assert.match(html, new RegExp(`id="${anchor}"`));
    assert.match(html, new RegExp(id));
  }

  for (const label of ["問題", "影響", "根因", "實作方案", "驗證", "必要修改 · 已實作"]) {
    assert.match(html, new RegExp(label));
  }

  assert.match(html, /migrations\/core\/0017_architecture_reset\.sql/);
  assert.match(html, /worker\/catalog-workflows\.ts/);
  assert.match(html, /worker\/account-erasure-tombstone\.test\.ts/);
  assert.match(html, /src\/storage\/draft-persistence\.ts/);
  assert.match(html, /worker\/dispatcher\.test\.ts/);
  assert.match(html, /container\/progress\.test\.mjs/);
  assert.match(html, /src\/features\/judge\/model\/performance-contract\.test\.ts/);
  assert.match(html, /src\/features\/judge\/components\/performance-lab\.test\.ts/);
});

test("exposes stable navigation, status semantics, and evidence classifications", async () => {
  const response = await render();
  const html = await response.text();

  for (const anchor of ["top", "content", "verdict", "architecture", "data-model", "flows", "r2", "repairs", "performance", "performance-lab", "cutover", "p2"]) {
    assert.match(html, new RegExp(`id="${anchor}"`));
  }

  assert.match(html, /Code/);
  assert.match(html, /COMPLETE/);
  assert.match(html, /Full regression/);
  assert.match(html, /PASS/);
  assert.match(html, /Production reset/);
  assert.match(html, /NOT RUN/);
  assert.match(html, /Public site/);
  assert.match(html, /READY TO PUBLISH/);
  assert.match(html, /程式路徑估算/);
  assert.match(html, /單元測試量測/);
  assert.match(html, /production P95/);
  assert.match(html, /24h cleanup/);
  assert.match(html, /cloudflare-architecture-v2-cutover\.yml/);
  assert.match(html, /maintenance-only token lane/);
  assert.match(html, /constant-time token/);
});
