import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);
const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const wrangler = fileURLToPath(new URL("../node_modules/.bin/wrangler", import.meta.url));
const database = "wasm-oj-core-development";
const contestV2Migration = "0020_contest_v2_runtime.sql";

test("pinned local Wrangler applies every core migration to a fresh D1 database", {
  timeout: 60_000,
}, async () => {
  const temporaryRoot = await mkdtemp(path.join(tmpdir(), "wasm-oj-d1-core-migrations-"));
  const xdgConfig = path.join(temporaryRoot, "xdg-config");
  const xdgCache = path.join(temporaryRoot, "xdg-cache");
  await Promise.all([
    mkdir(xdgConfig, { recursive: true }),
    mkdir(xdgCache, { recursive: true }),
  ]);
  const environment = {
    ...process.env,
    CI: "1",
    NO_COLOR: "1",
    WRANGLER_HIDE_BANNER: "true",
    WRANGLER_LOG_PATH: path.join(temporaryRoot, "wrangler.log"),
    WRANGLER_SEND_ERROR_REPORTS: "false",
    WRANGLER_SEND_METRICS: "false",
    XDG_CACHE_HOME: xdgCache,
    XDG_CONFIG_HOME: xdgConfig,
  };
  const commonArguments = [database, "--local", "--persist-to", temporaryRoot];

  try {
    await execFileAsync(wrangler, ["d1", "migrations", "apply", ...commonArguments], {
      cwd: repositoryRoot,
      env: environment,
      maxBuffer: 16 * 1024 * 1024,
      timeout: 45_000,
    });

    const query = [
      "SELECT blocker_kind, blocker_key FROM contest_v2_preflight_blockers ORDER BY blocker_kind, blocker_key",
      `SELECT COUNT(*) AS ledger_count FROM d1_migrations WHERE name='${contestV2Migration}'`,
      "PRAGMA foreign_key_check",
    ].join("; ");
    const { stdout } = await execFileAsync(wrangler, [
      "d1", "execute", ...commonArguments, "--command", query, "--json",
    ], {
      cwd: repositoryRoot,
      env: environment,
      maxBuffer: 4 * 1024 * 1024,
      timeout: 15_000,
    });
    const results = JSON.parse(stdout);

    assert.equal(results.length, 3);
    assert.ok(results.every((result) => result.success === true));
    assert.deepEqual(results[0].results, []);
    assert.deepEqual(results[1].results, [{ ledger_count: 1 }]);
    assert.deepEqual(results[2].results, []);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});
