import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import { Directory, init, Runtime, Wasmer } from "@wasmer/sdk/node";
import { PYTHON_COMPILE_TIMEOUT_MS } from "../compiler/python-toolchain.ts";
import {
  PYTHON_COMPRESSED_PACKAGE_SHA256,
  PYTHON_PACKAGE,
  PYTHON_PACKAGE_ASSET_PATH,
  PYTHON_PACKAGE_SHA256,
} from "../core/toolchains.ts";

let runtime;
let exitCode = 0;

try {
  const encoded = JSON.parse(await readStdin());
  await init({ log: "warn" });
  runtime = new Runtime({ registry: null });
  const pythonFiles = encoded.request.files.filter((file) => file.path.endsWith(".py"));
  const project = new Directory(Object.fromEntries(encoded.request.files.map((file) => [`/${file.path}`, file.content])));
  await project.createDir("/build");
  const packagePath = path.join(encoded.toolchainDirectory, path.basename(PYTHON_PACKAGE_ASSET_PATH));
  const compressed = await readFile(packagePath);
  verifyDigest(packagePath, compressed, PYTHON_COMPRESSED_PACKAGE_SHA256);
  const packageBytes = gunzipSync(compressed);
  verifyDigest(packagePath, packageBytes, PYTHON_PACKAGE_SHA256);
  const pkg = await Wasmer.fromFile(new Uint8Array(packageBytes), runtime);
  const command = pkg.commands.python;
  if (!command) throw new Error(`Package '${PYTHON_PACKAGE}' does not expose python.`);
  const instance = await command.run({
    args: ["-c", compileScript(pythonFiles.map((file) => file.path))],
    cwd: "/project",
    env: {
      PYTHONHOME: "/usr/local",
      PYTHONHASHSEED: "0",
      PYTHONDONTWRITEBYTECODE: "1",
    },
    mount: { "/project": project },
  });
  let timer;
  const output = await Promise.race([
    instance.wait(),
    new Promise((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`Python compilation exceeded ${PYTHON_COMPILE_TIMEOUT_MS} ms.`)),
        PYTHON_COMPILE_TIMEOUT_MS,
      );
    }),
  ]);
  clearTimeout(timer);
  const bytecodeBase64 = {};
  if (output.ok) {
    for (const file of pythonFiles) {
      const compiledPath = `build/${file.path.replace(/\.py$/, ".pyc")}`;
      bytecodeBase64[compiledPath] = Buffer.from(await project.readFile(`/${compiledPath}`)).toString("base64");
    }
  }
  writeFileSync(3, JSON.stringify({
    ok: true,
    result: {
      success: output.ok,
      bytecodeBase64,
      stdout: output.stdout,
      stderr: output.stderr,
      diagnostics: [],
    },
  }));
} catch (error) {
  writeFileSync(3, JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }));
  exitCode = 1;
} finally {
  runtime?.free();
  setTimeout(() => process.exit(exitCode), 10);
}

function verifyDigest(filename, bytes, expected) {
  const actual = createHash("sha256").update(bytes).digest("hex");
  if (actual !== expected) {
    throw new Error(`Pinned Python package '${filename}' has digest ${actual}; expected ${expected}.`);
  }
}

function compileScript(files) {
  return [
    "import pathlib, py_compile",
    `files = ${JSON.stringify(files)}`,
    "for name in files:",
    "    output = pathlib.Path('/project/build') / pathlib.Path(name).with_suffix('.pyc')",
    "    output.parent.mkdir(parents=True, exist_ok=True)",
    "    py_compile.compile('/project/' + name, cfile=str(output), doraise=True, invalidation_mode=py_compile.PycInvalidationMode.CHECKED_HASH)",
  ].join("\n");
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}
