import { mkdir, writeFile } from "node:fs/promises";

function required(name, pattern) {
  const value = process.env[name];
  if (!value || !pattern.test(value)) throw new Error(`${name} is required and invalid.`);
  return value;
}

const identity = {
  buildId: required("WASM_OJ_BUILD_ID", /^[0-9a-f]{40}$/),
  contract: 2,
  protocol: "wasm-oj-container-v2",
  schema: "wasm-oj-platform/container-identity/v3",
};
await mkdir("/app/release", { recursive: true });
await writeFile("/app/release/container-identity.json", `${JSON.stringify(identity)}\n`, { flag: "wx", mode: 0o444 });
process.stdout.write(`${identity.buildId}\n`);
