#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const BUILD_ID = /^[0-9a-f]{40}$/;
const CONFIG_PLACEHOLDER = "__WASM_OJ_BUILD_ID__";
const CONFIG_PLACEHOLDER_COUNT = 2;
const CONTAINER_IMAGE = `registry.cloudflare.com/b1c3d1b89f9131a84a0f1f6a973232f1/wasm-oj-submission-production:${CONFIG_PLACEHOLDER}`;

export function renderProductionConfig(configSource, buildId) {
  if (!BUILD_ID.test(buildId)) throw new TypeError("Build ID must be a lowercase 40-character Git commit SHA.");
  if (configSource.split(CONFIG_PLACEHOLDER).length - 1 !== CONFIG_PLACEHOLDER_COUNT) {
    throw new Error("Production config must contain exactly two build-ID placeholders.");
  }
  const config = JSON.parse(configSource);
  if (config?.vars?.WASM_OJ_BUILD_ID !== CONFIG_PLACEHOLDER
    || config?.containers?.length !== 1
    || config.containers[0]?.image !== CONTAINER_IMAGE) {
    throw new Error("Production config build-ID placeholders must bind the Worker and exact Cloudflare Container image.");
  }
  return configSource.replaceAll(CONFIG_PLACEHOLDER, buildId);
}

export async function renderProductionFile({ buildId, configPath }) {
  const configSource = await readFile(configPath, "utf8");
  await writeFile(configPath, renderProductionConfig(configSource, buildId));
}

function main() {
  const { values } = parseArgs({
    options: {
      "build-id": { type: "string" },
      config: { type: "string", default: "wrangler.quick-production.jsonc" },
    },
    strict: true,
  });
  if (!values["build-id"]) throw new TypeError("--build-id is required.");
  return renderProductionFile({
    buildId: values["build-id"],
    configPath: path.resolve(values.config),
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
