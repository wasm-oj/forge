import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
const fixtures = JSON.parse(await readFile(new URL("./fixtures/java-client.json", import.meta.url), "utf8"));
const child = spawn(process.execPath, [new URL("./verify-browser-csp.mjs", import.meta.url).pathname,
  ...fixtures.map(fixture => fixture.label)], {
  env: { ...process.env, CSP_OUTPUT_DIRECTORY: "output/playwright/java-client" },
  stdio: "inherit",
});
child.on("error", error => { throw error; });
child.on("exit", code => { process.exitCode = code ?? 1; });
