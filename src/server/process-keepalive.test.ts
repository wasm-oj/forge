import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);

describe("isolated stage process keepalive", () => {
  it("keeps Node alive for a promise whose own timer is unreferenced", async () => {
    const moduleUrl = pathToFileURL(path.resolve("src/server/process-keepalive.mjs")).href;
    const source = `
      import { withProcessKeepalive } from ${JSON.stringify(moduleUrl)};
      const result = await withProcessKeepalive(new Promise((resolve) => {
        const completion = setTimeout(() => resolve("settled"), 25);
        completion.unref();
      }));
      process.stdout.write(result);
    `;
    const { stdout, stderr } = await execFileAsync(process.execPath, [
      "--input-type=module",
      "--eval",
      source,
    ]);
    expect(stdout).toBe("settled");
    expect(stderr).toBe("");
  });
});
