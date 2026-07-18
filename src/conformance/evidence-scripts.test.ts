import { execFileSync } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();

describe("evidence workflow scripts", () => {
  it("keeps generated baseline source stable across equivalent raw runs", () => {
    const moduleUrl = scriptUrl("scripts/transform-cost-baselines.mjs");
    const result = evaluate(`
      import { generatedModule } from ${JSON.stringify(moduleUrl)};
      const base = {
        experimentId: "experiment",
        specSha256: "a".repeat(64),
        costModel: "weighted",
        forgeContract: 1,
        rows: [{ profile: "profile", baselineCostPoints: 123 }],
      };
      const first = generatedModule({
        ...base,
        sourceRunId: "run-one",
        sourceRawSha256: "1".repeat(64),
      });
      const second = generatedModule({
        ...base,
        sourceRunId: "run-two",
        sourceRawSha256: "2".repeat(64),
      });
      const changedSpec = generatedModule({ ...base, specSha256: "b".repeat(64) });
      console.log(JSON.stringify({
        equal: first === second,
        specBound: first !== changedSpec,
        containsRunIdentity: first.includes("sourceRunId") || first.includes("sourceRawSha256"),
      }));
    `);
    expect(result).toEqual({ equal: true, specBound: true, containsRunIdentity: false });
  });

  it("allows only same-origin loopback HTTP requests", () => {
    const moduleUrl = scriptUrl("scripts/run-browser-conformance.mjs");
    const result = evaluate(`
      import { classifyBrowserHttpRequest, requireLocalBrowserOrigin } from ${JSON.stringify(moduleUrl)};
      const origin = requireLocalBrowserOrigin("http://127.0.0.1:4173/conformance");
      let remoteBaseRejected = false;
      try { requireLocalBrowserOrigin("https://compiler.example"); } catch { remoteBaseRejected = true; }
      console.log(JSON.stringify({
        origin,
        remoteBaseRejected,
        sameOrigin: classifyBrowserHttpRequest("http://127.0.0.1:4173/toolchains/a.wasm", origin),
        differentPort: classifyBrowserHttpRequest("http://127.0.0.1:4174/upload", origin),
        remote: classifyBrowserHttpRequest("https://compiler.example/upload", origin),
        localData: classifyBrowserHttpRequest("blob:http://127.0.0.1:4173/id", origin),
        malformed: classifyBrowserHttpRequest("not a URL", origin),
      }));
    `);
    expect(result).toEqual({
      origin: "http://127.0.0.1:4173",
      remoteBaseRejected: true,
      sameOrigin: { tracked: true, allowed: true, reason: "same-origin-loopback" },
      differentPort: { tracked: true, allowed: false, reason: "cross-origin" },
      remote: { tracked: true, allowed: false, reason: "non-loopback-host" },
      localData: { tracked: false, allowed: true, reason: "non-http" },
      malformed: { tracked: true, allowed: false, reason: "invalid-url" },
    });
  });

  it.skipIf(process.platform === "win32")("terminates the complete detached development-server process group", () => {
    const moduleUrl = scriptUrl("scripts/run-browser-conformance.mjs");
    const result = evaluate(`
      import { spawn } from "node:child_process";
      import { once } from "node:events";
      import { stopServer } from ${JSON.stringify(moduleUrl)};
      const grandchild = "setTimeout(() => {}, 30000)";
      const childSource = [
        "const { spawn } = require('node:child_process');",
        "spawn(process.execPath, ['--eval', " + JSON.stringify(grandchild) + "], { stdio: 'ignore' });",
        "setTimeout(() => {}, 30000);",
      ].join("\\n");
      const child = spawn(process.execPath, ["--eval", childSource], {
        detached: true,
        stdio: "ignore",
      });
      await once(child, "spawn");
      await new Promise((resolve) => setTimeout(resolve, 100));
      await stopServer(child);
      let groupAlive = true;
      try { process.kill(-child.pid, 0); } catch (error) {
        if (error.code === "ESRCH") groupAlive = false;
        else throw error;
      }
      console.log(JSON.stringify({ groupAlive, childExited: child.exitCode !== null || child.signalCode !== null }));
    `);
    expect(result).toEqual({ groupAlive: false, childExited: true });
  });

  it("stages every evidence output before replacing any destination", () => {
    const moduleUrl = scriptUrl("scripts/evidence-publication.mjs");
    const result = evaluate(`
      import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
      import os from "node:os";
      import path from "node:path";
      import { publishEvidenceFiles } from ${JSON.stringify(moduleUrl)};
      const root = await mkdtemp(path.join(os.tmpdir(), "forge-evidence-publication-"));
      try {
        const first = path.join(root, "first.txt");
        const second = path.join(root, "second.txt");
        const blockedParent = path.join(root, "not-a-directory");
        await writeFile(first, "old-first");
        await writeFile(second, "old-second");
        await writeFile(blockedParent, "file");
        let stagingFailed = false;
        try {
          await publishEvidenceFiles([
            { path: first, bytes: "partial-first" },
            { path: path.join(blockedParent, "child.txt"), bytes: "never" },
          ]);
        } catch { stagingFailed = true; }
        const preserved = await readFile(first, "utf8");
        await publishEvidenceFiles([
          { path: first, bytes: "new-first" },
          { path: second, bytes: "new-second" },
        ]);
        console.log(JSON.stringify({
          stagingFailed,
          preserved,
          first: await readFile(first, "utf8"),
          second: await readFile(second, "utf8"),
        }));
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    `);
    expect(result).toEqual({
      stagingFailed: true,
      preserved: "old-first",
      first: "new-first",
      second: "new-second",
    });
  });
});

function scriptUrl(relative: string): string {
  return pathToFileURL(path.join(ROOT, relative)).href;
}

function evaluate(source: string): unknown {
  const output = execFileSync(
    process.execPath,
    [
      "--experimental-strip-types",
      "--disable-warning=ExperimentalWarning",
      "--input-type=module",
      "--eval",
      source,
    ],
    { cwd: ROOT, encoding: "utf8" },
  );
  return JSON.parse(output.trim());
}
