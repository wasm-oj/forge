const origin = (process.env.FORGE_PRODUCTION_ORIGIN ?? "https://wasm-oj-forge-production.jacob.workers.dev").replace(/\/$/, "");
const response = await fetch(`${origin}/api/problems`, { headers: { accept: "application/json" } });
if (!response.ok) throw new Error(`Production problem catalog returned HTTP ${response.status}.`);
const payload = await response.json();
if (!Array.isArray(payload?.collections) || payload.collections.length === 0) {
  throw new Error("Production problem catalog has no published collections.");
}
if (payload.collections[0]?.official !== true) {
  throw new Error("Production problem catalog does not place the official collection first.");
}
const officialProblems = payload.collections
  .filter((collection) => collection?.official === true)
  .flatMap((collection) => Array.isArray(collection.problems) ? collection.problems : []);
if (officialProblems.length !== 45) {
  throw new Error(`Production problem catalog contains ${officialProblems.length} official problems; expected 45.`);
}
process.stdout.write("Verified 45 production official problems with the official collection first.\n");
