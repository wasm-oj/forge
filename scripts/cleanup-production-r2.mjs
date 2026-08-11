import { parseArgs } from "node:util";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const PRIMARY_BUCKET = "wasm-oj-judge-production";
const RETIRED_MIRROR_BUCKET = "wasm-oj-judge-mirror-production";
const API_ROOT = "https://api.cloudflare.com/client/v4";

function requiredEnvironment(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

function objectPath(accountId, bucket, key = null) {
  const base = `/accounts/${encodeURIComponent(accountId)}/r2/buckets/${encodeURIComponent(bucket)}/objects`;
  if (key === null) return base;
  return `${base}/${key.split("/").map(encodeURIComponent).join("/")}`;
}

async function cloudflareRequest(path, init = {}) {
  const token = requiredEnvironment("CLOUDFLARE_API_TOKEN");
  const response = await fetch(`${API_ROOT}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${token}`, ...init.headers },
  });
  const payload = await response.json().catch(() => null);
  if (response.status === 404) return null;
  if (!response.ok || payload?.success !== true) {
    const detail = Array.isArray(payload?.errors)
      ? payload.errors.map((error) => error?.message).filter(Boolean).join("; ")
      : "invalid Cloudflare response";
    throw new Error(`Cloudflare R2 request failed with HTTP ${response.status}: ${detail}.`);
  }
  return payload;
}

async function d1Query(accountId, databaseId, sql) {
  const payload = await cloudflareRequest(
    `/accounts/${encodeURIComponent(accountId)}/d1/database/${encodeURIComponent(databaseId)}/query`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sql }),
    },
  );
  if (!Array.isArray(payload?.result)) throw new Error("Cloudflare D1 query response is invalid.");
  return payload.result;
}

async function runPendingSubmissionObjectReset({ accountId, databaseId }) {
  const observations = await d1Query(
    accountId,
    databaseId,
    "SELECT formal_mutations_enabled, reason FROM formal_mutation_controls WHERE environment='production'",
  );
  const rows = observations.flatMap((entry) => Array.isArray(entry?.results) ? entry.results : []);
  if (rows.length !== 1) throw new Error("Production formal-mutation control is missing.");
  const [control] = rows;
  if (control.reason !== "single-store-object-reset-pending") {
    process.stdout.write("Single-store submission object reset is already complete; skipping.\n");
    return;
  }
  if (control.formal_mutations_enabled !== 0) {
    throw new Error("Submission object reset requires formal mutations to remain disabled.");
  }
  await runProductionR2Cleanup("reset-submissions", { accountId });
  const updates = await d1Query(
    accountId,
    databaseId,
    "UPDATE formal_mutation_controls SET reason='production-deployment', updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE environment='production' AND formal_mutations_enabled=0 AND reason='single-store-object-reset-pending'",
  );
  const changes = updates.reduce((total, entry) => total + Number(entry?.meta?.changes ?? 0), 0);
  if (changes !== 1) throw new Error("Submission object reset lost its production cutover marker.");
}

async function deletePrefix({ accountId, bucket, prefix, request }) {
  let deleted = 0;
  for (;;) {
    const query = new URLSearchParams({ per_page: "1000" });
    if (prefix) query.set("prefix", prefix);
    const listed = await request(`${objectPath(accountId, bucket)}?${query}`, { method: "GET" });
    if (listed === null) return { deleted, bucketExists: false };
    if (!Array.isArray(listed.result)) throw new Error("Cloudflare R2 object listing is invalid.");
    const keys = listed.result.map((entry) => entry?.key);
    if (keys.some((key) => typeof key !== "string" || key.length === 0)) {
      throw new Error("Cloudflare R2 object listing contains an invalid key.");
    }
    if (keys.length === 0) return { deleted, bucketExists: true };
    for (let offset = 0; offset < keys.length; offset += 25) {
      await Promise.all(keys.slice(offset, offset + 25).map((key) => request(
        objectPath(accountId, bucket, key),
        { method: "DELETE" },
      )));
    }
    deleted += keys.length;
  }
}

export async function runProductionR2Cleanup(operation, {
  accountId,
  request = cloudflareRequest,
  log = (line) => process.stdout.write(`${line}\n`),
}) {
  if (!/^[0-9a-f]{32}$/.test(accountId)) throw new Error("CLOUDFLARE_ACCOUNT_ID is invalid.");
  if (operation === "reset-submissions") {
    for (const prefix of ["sources/", "audits/"]) {
      const result = await deletePrefix({ accountId, bucket: PRIMARY_BUCKET, prefix, request });
      if (!result.bucketExists) throw new Error(`Authoritative bucket '${PRIMARY_BUCKET}' does not exist.`);
      log(`Deleted ${result.deleted} objects under ${PRIMARY_BUCKET}/${prefix}.`);
    }
    return;
  }
  if (operation === "delete-mirror") {
    const result = await deletePrefix({ accountId, bucket: RETIRED_MIRROR_BUCKET, prefix: "", request });
    if (!result.bucketExists) {
      log(`Retired bucket '${RETIRED_MIRROR_BUCKET}' is already absent.`);
      return;
    }
    await request(`/accounts/${encodeURIComponent(accountId)}/r2/buckets/${encodeURIComponent(RETIRED_MIRROR_BUCKET)}`, {
      method: "DELETE",
    });
    log(`Deleted ${result.deleted} objects and retired bucket '${RETIRED_MIRROR_BUCKET}'.`);
    return;
  }
  throw new Error(`Unknown production R2 cleanup operation '${operation}'.`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: { operation: { type: "string" } },
    strict: true,
  });
  if (!values.operation) throw new Error("--operation is required.");
  const accountId = requiredEnvironment("CLOUDFLARE_ACCOUNT_ID");
  if (values.operation === "reset-submissions") {
    const config = JSON.parse(await readFile(process.env.FORGE_WRANGLER_CONFIG ?? "wrangler.quick-production.jsonc", "utf8"));
    const databaseId = config.d1_databases?.find((database) => database.binding === "DB")?.database_id;
    if (typeof databaseId !== "string" || !/^[0-9a-f-]{36}$/.test(databaseId)) {
      throw new Error("DB database ID is invalid.");
    }
    await runPendingSubmissionObjectReset({ accountId, databaseId });
  } else {
    await runProductionR2Cleanup(values.operation, { accountId });
  }
}
