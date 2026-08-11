const ACCOUNT_ID_PATTERN = /^[0-9a-f]{32}$/;
const DATABASE_ID = "514a6ae0-719b-4de0-ad8e-46db42421b64";
const DATABASE_NAME = "wasm-oj-submissions-production-00";

function requiredEnvironment(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

const accountId = requiredEnvironment("CLOUDFLARE_ACCOUNT_ID");
const token = requiredEnvironment("CLOUDFLARE_API_TOKEN");
if (!ACCOUNT_ID_PATTERN.test(accountId)) throw new Error("CLOUDFLARE_ACCOUNT_ID is invalid.");

const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/d1/database/${DATABASE_ID}`;
const current = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
if (current.status === 404) {
  process.stdout.write("Retired submissions D1 database is already absent.\n");
} else {
  const currentPayload = await current.json().catch(() => null);
  if (!current.ok || currentPayload?.success !== true || currentPayload?.result?.uuid !== DATABASE_ID || currentPayload.result.name !== DATABASE_NAME) {
    throw new Error("Retired submissions D1 database identity could not be verified.");
  }
  const response = await fetch(url, { method: "DELETE", headers: { authorization: `Bearer ${token}` } });
  const payload = await response.json().catch(() => null);
  if (!response.ok || payload?.success !== true) {
    const detail = Array.isArray(payload?.errors)
      ? payload.errors.map((error) => error?.message).filter(Boolean).join("; ")
      : "invalid Cloudflare response";
    throw new Error(`Unable to delete retired submissions D1 database: HTTP ${response.status}: ${detail}.`);
  }
  process.stdout.write("Deleted retired submissions D1 database.\n");
}
