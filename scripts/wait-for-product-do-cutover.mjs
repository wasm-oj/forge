import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const REQUIRED_ENV = [
  "CLOUDFLARE_API_TOKEN",
  "CLOUDFLARE_ACCOUNT_ID",
];

function requiredEnvironment(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

export function parseD1Rows(payload) {
  if (!payload || payload.success !== true || !Array.isArray(payload.result)) {
    throw new Error("Cloudflare D1 returned an invalid response.");
  }
  const rows = payload.result.flatMap((entry) => Array.isArray(entry?.results) ? entry.results : []);
  return rows.map((row) => {
    if (typeof row?.kind !== "string" || !Number.isSafeInteger(row.active) || row.active < 0) {
      throw new Error("Cloudflare D1 returned an invalid active-work row.");
    }
    return { kind: row.kind, active: row.active };
  });
}

const SUBMISSIONS_SQL = `SELECT 'submission' AS kind, COUNT(*) AS active
FROM submissions
WHERE state IN ('admitting','queued','waiting-capacity','preparing','compiling','running','finalizing')
UNION ALL
SELECT 'submission-start-outbox', COUNT(*)
FROM submission_outbox
WHERE kind='start-workflow' AND delivered_at IS NULL
UNION ALL
SELECT 'rejudge-job', COUNT(*)
FROM rejudge_jobs
WHERE state IN ('pending','dispatched')`;

const CORE_SQL = `SELECT 'validation-import' AS kind, COUNT(*) AS active
FROM collection_imports
WHERE status IN ('queued','downloading','validating')
UNION ALL
SELECT 'validation-start-outbox', COUNT(*)
FROM core_outbox
WHERE kind='start-validation-workflow' AND delivered_at IS NULL
UNION ALL
SELECT 'rejudge-batch', COUNT(*)
FROM rejudge_batches
WHERE status IN ('queued','running','ready')
UNION ALL
SELECT 'rejudge-materialize-outbox', COUNT(*)
FROM core_outbox
WHERE kind='materialize-rejudge' AND delivered_at IS NULL
UNION ALL
SELECT 'formal-admission', COUNT(*)
FROM formal_submission_admissions
WHERE state='pending'`;

async function queryD1(accountId, databaseId, token, sql) {
  const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}/d1/database/${databaseId}/query`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ sql }),
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) throw new Error(`Cloudflare D1 query failed with HTTP ${response.status}.`);
  return parseD1Rows(payload);
}

export async function waitForProductDoCutover({
  fetchRows,
  sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  intervalMilliseconds = 5_000,
  maximumAttempts = 120,
}) {
  let consecutiveEmpty = 0;
  for (let attempt = 1; attempt <= maximumAttempts; attempt += 1) {
    const rows = await fetchRows();
    const active = rows.filter((row) => row.active !== 0);
    process.stdout.write(`[cutover ${attempt}/${maximumAttempts}] ${rows.map((row) => `${row.kind}=${row.active}`).join(" ")}\n`);
    consecutiveEmpty = active.length === 0 ? consecutiveEmpty + 1 : 0;
    if (consecutiveEmpty === 2) return;
    if (attempt < maximumAttempts) await sleep(intervalMilliseconds);
  }
  throw new Error("Timed out waiting for product-state Durable Object work to finish.");
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  REQUIRED_ENV.forEach(requiredEnvironment);
  const token = requiredEnvironment("CLOUDFLARE_API_TOKEN");
  const accountId = requiredEnvironment("CLOUDFLARE_ACCOUNT_ID");
  const config = JSON.parse(await readFile(process.env.FORGE_WRANGLER_CONFIG ?? "wrangler.quick-production.jsonc", "utf8"));
  const databaseId = (binding) => {
    const value = config.d1_databases?.find((database) => database.binding === binding)?.database_id;
    if (typeof value !== "string" || !/^[0-9a-f-]{36}$/.test(value)) throw new Error(`${binding} database ID is invalid.`);
    return value;
  };
  const coreDatabaseId = databaseId("CORE_DB");
  const submissionsDatabaseId = databaseId("SUBMISSIONS_DB");
  await waitForProductDoCutover({
    fetchRows: async () => [
      ...await queryD1(accountId, coreDatabaseId, token, CORE_SQL),
      ...await queryD1(accountId, submissionsDatabaseId, token, SUBMISSIONS_SQL),
    ],
  });
}
