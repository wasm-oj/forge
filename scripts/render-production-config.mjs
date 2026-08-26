#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const BUILD_ID = /^[0-9a-f]{40}$/;
const CONFIG_PLACEHOLDER = "__WASM_OJ_BUILD_ID__";
const DOCKER_ARG = /^ARG WASM_OJ_BUILD_ID=.*$/mu;

export function renderProductionSources(configSource, dockerfileSource, buildId) {
  if (!BUILD_ID.test(buildId)) throw new TypeError("Build ID must be a lowercase 40-character Git commit SHA.");
  if (configSource.split(CONFIG_PLACEHOLDER).length !== 2) {
    throw new Error("Production config must contain exactly one build-ID placeholder.");
  }
  const dockerMatches = dockerfileSource.match(DOCKER_ARG);
  if (!dockerMatches || dockerfileSource.match(new RegExp(DOCKER_ARG.source, "gmu"))?.length !== 1) {
    throw new Error("Dockerfile must declare exactly one WASM_OJ_BUILD_ID argument.");
  }
  return Object.freeze({
    config: configSource.replace(CONFIG_PLACEHOLDER, buildId),
    dockerfile: dockerfileSource.replace(DOCKER_ARG, `ARG WASM_OJ_BUILD_ID=${buildId}`),
  });
}

export async function renderProductionFiles({ buildId, configPath, dockerfilePath }) {
  const [configSource, dockerfileSource] = await Promise.all([
    readFile(configPath, "utf8"),
    readFile(dockerfilePath, "utf8"),
  ]);
  const rendered = renderProductionSources(configSource, dockerfileSource, buildId);
  await Promise.all([
    writeFile(configPath, rendered.config),
    writeFile(dockerfilePath, rendered.dockerfile),
  ]);
}

function main() {
  const { values } = parseArgs({
    options: {
      "build-id": { type: "string" },
      config: { type: "string", default: "wrangler.quick-production.jsonc" },
      dockerfile: { type: "string", default: "Dockerfile" },
    },
    strict: true,
  });
  if (!values["build-id"]) throw new TypeError("--build-id is required.");
  return renderProductionFiles({
    buildId: values["build-id"],
    configPath: path.resolve(values.config),
    dockerfilePath: path.resolve(values.dockerfile),
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
