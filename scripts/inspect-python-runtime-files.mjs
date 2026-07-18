import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import { init, Runtime, Wasmer } from "@wasmer/sdk/node";
import {
  PYTHON_RUNTIME_FILES_EXPORT_SCRIPT,
  decodeRuntimeFiles,
} from "../src/runner/runtime-files.ts";

if (process.argv.length !== 3) {
  throw new Error("Usage: node scripts/inspect-python-runtime-files.mjs PACKAGE.webc.gz.bin");
}

const packagePath = path.resolve(process.argv[2]);
let runtime;
let exitCode = 0;

try {
  await init({ log: "warn" });
  runtime = new Runtime({ registry: null });
  const packageBytes = gunzipSync(await readFile(packagePath));
  const pkg = await Wasmer.fromFile(new Uint8Array(packageBytes), runtime);
  const command = pkg.commands.python;
  if (!command) throw new Error(`Python package '${packagePath}' does not expose python.`);
  const output = await runPython(command, `${String.raw`
import hashlib
import importlib.util
import json
import sys
import sysconfig

sys.stderr.write("FORGE_SMOKE:" + json.dumps({
    "absSrcdir": sysconfig.get_config_var("abs_srcdir"),
    "compiled": bool(compile("value = 6 * 7", "<forge-smoke>", "exec")),
    "sha256": hashlib.sha256(b"forge").hexdigest(),
    "socketBuiltin": "_socket" in sys.builtin_module_names,
    "socketSpec": importlib.util.find_spec("_socket") is not None,
    "socketState": sysconfig.get_config_var("MODULE__SOCKET_STATE"),
    "sysPlatform": sys.platform,
    "version": list(sys.version_info[:3]),
}, sort_keys=True, separators=(",", ":")) + "\n")
`}
${PYTHON_RUNTIME_FILES_EXPORT_SCRIPT}`);
  const smokeLine = output.stderr.split("\n").find((line) => line.startsWith("FORGE_SMOKE:"));
  if (!smokeLine) throw new Error(`Python runtime smoke emitted no result: ${output.stderr}`);
  const smoke = JSON.parse(smokeLine.slice("FORGE_SMOKE:".length));
  const expectedSmoke = {
    absSrcdir: "/usr/src/cpython-3.14.6",
    compiled: true,
    sha256: "71b41d6dd48dc58eba8f5cf9edf30fef6597fdf285a521bb8fcbad4b3d50887d",
    socketBuiltin: false,
    socketSpec: false,
    socketState: "n/a",
    sysPlatform: "wasi",
    version: [3, 14, 6],
  };
  if (JSON.stringify(smoke) !== JSON.stringify(expectedSmoke)) {
    throw new Error(`Python runtime smoke mismatch: ${JSON.stringify(smoke)}.`);
  }
  const archive = output.stdoutBytes.slice();
  const files = decodeRuntimeFiles(archive);
  process.stdout.write(`FORGE_PYTHON_INSPECTION:${JSON.stringify({
    archiveSha256: createHash("sha256").update(archive).digest("hex"),
    archiveBytes: archive.byteLength,
    smoke,
    files: Object.fromEntries(
      Object.entries(files).map(([name, contents]) => [name, contents.byteLength]),
    ),
  })}\n`);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  exitCode = 1;
} finally {
  setTimeout(() => process.exit(exitCode), 50);
  try {
    runtime?.free();
  } catch (error) {
    process.stderr.write(`Unable to release the Python smoke runtime: ${String(error)}\n`);
    exitCode = 1;
  }
}

async function runPython(command, script) {
  const instance = await command.run({
    args: ["-c", script],
    env: {
      PYTHONHOME: "/usr/local",
      PYTHONHASHSEED: "0",
      PYTHONDONTWRITEBYTECODE: "1",
    },
  });
  const keepAlive = setInterval(() => {}, 1_000);
  let output;
  try {
    output = await instance.wait();
  } finally {
    clearInterval(keepAlive);
  }
  if (!output.ok) {
    throw new Error(`Python command failed with exit ${output.code}: ${output.stderr}`);
  }
  return output;
}
