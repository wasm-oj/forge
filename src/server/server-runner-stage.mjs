import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { serialize } from "node:v8";
import { gunzipSync } from "node:zlib";
import { init, Runtime, Wasmer } from "@wasmer/sdk/node";
import {
  PYTHON_COMPRESSED_PACKAGE_SHA256,
  PYTHON_PACKAGE,
  PYTHON_PACKAGE_ASSET_PATH,
  PYTHON_PACKAGE_SHA256,
} from "../core/toolchains.ts";

const MAX_INPUT_BYTES = 1024 * 1024;
const MAX_RESULT_BYTES = 256 * 1024 * 1024;
const MAX_ERROR_CHARACTERS = 64 * 1024;

let runtime;
let pkg;
let commands = [];
let response;
let exitCode = 0;

try {
  const input = parseInput(JSON.parse(await readStdin()));
  await init({ log: "warn" });
  runtime = new Runtime({ registry: null });
  const packagePath = resolvePackagePath(input.toolchainDirectory);
  const compressed = await readFile(packagePath);
  verifyDigest(packagePath, compressed, PYTHON_COMPRESSED_PACKAGE_SHA256);
  const expanded = new Uint8Array(gunzipSync(compressed));
  verifyDigest(packagePath, expanded, PYTHON_PACKAGE_SHA256);
  pkg = await Wasmer.fromFile(expanded, runtime);

  const commandMap = pkg.commands;
  commands = uniqueCommands(commandMap);
  const command = commandMap[input.request.command];
  if (!command) {
    throw new Error(
      `Package '${input.request.packageSpecifier}' does not expose '${input.request.command}'.`,
    );
  }

  let bytes;
  if (input.request.operation === "command-binary") {
    bytes = command.binary().slice();
    if (!WebAssembly.validate(bytes)) {
      throw new Error(
        `Package '${input.request.packageSpecifier}' command '${input.request.command}' returned invalid WebAssembly.`,
      );
    }
  } else {
    const instance = await command.run({
      args: input.request.args,
      env: {
        PYTHONHOME: "/usr/local",
        PYTHONHASHSEED: "0",
        PYTHONDONTWRITEBYTECODE: "1",
      },
    });
    const output = await instance.wait();
    if (!output.ok) {
      throw new Error(
        `Unable to export runtime files from ${input.request.packageSpecifier}: `
        + `exit ${output.code}: ${boundedText(output.stderr)}`,
      );
    }
    bytes = output.stdoutBytes.slice();
  }

  if (bytes.byteLength > MAX_RESULT_BYTES) {
    throw new Error(
      `Runner stage result is ${bytes.byteLength} bytes; the limit is ${MAX_RESULT_BYTES} bytes.`,
    );
  }
  response = {
    ok: true,
    result: { operation: input.request.operation, bytes },
  };
} catch (error) {
  response = { ok: false, error: boundedText(error instanceof Error ? error.message : String(error)) };
  exitCode = 1;
} finally {
  const cleanupErrors = [];
  for (const command of commands) {
    try {
      command.free();
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  try {
    pkg?.free();
  } catch (error) {
    cleanupErrors.push(error);
  }
  try {
    runtime?.free();
  } catch (error) {
    cleanupErrors.push(error);
  }
  if (cleanupErrors.length > 0) {
    response = {
      ok: false,
      error: boundedText(
        `Unable to release isolated Wasmer resources: ${cleanupErrors.map(errorText).join("; ")}`,
      ),
    };
    exitCode = 1;
  }
  try {
    writeFileSync(requiredResponsePath(), serialize(response), {
      flag: "wx",
      mode: 0o600,
    });
  } catch (error) {
    process.stderr.write(`Unable to write the runner-stage response: ${errorText(error)}\n`);
    exitCode = 1;
  }
  setTimeout(() => process.exit(exitCode), 10);
}

function parseInput(value) {
  if (!isRecord(value) || typeof value.toolchainDirectory !== "string" || !isRecord(value.request)) {
    throw new Error("The runner stage received an invalid request envelope.");
  }
  const request = value.request;
  if (
    request.packageSpecifier !== PYTHON_PACKAGE
    || request.command !== "python"
    || (request.operation !== "command-binary" && request.operation !== "runtime-files")
  ) {
    throw new Error("The runner stage request does not name a pinned Forge runtime command.");
  }
  if (
    request.operation === "runtime-files"
    && (!Array.isArray(request.args) || request.args.some((argument) => typeof argument !== "string"))
  ) {
    throw new Error("The runner stage runtime-files arguments are invalid.");
  }
  return {
    toolchainDirectory: path.resolve(value.toolchainDirectory),
    request: request.operation === "command-binary"
      ? {
          operation: request.operation,
          packageSpecifier: request.packageSpecifier,
          command: request.command,
        }
      : {
          operation: request.operation,
          packageSpecifier: request.packageSpecifier,
          command: request.command,
          args: [...request.args],
        },
  };
}

function resolvePackagePath(toolchainDirectory) {
  const packagePath = path.resolve(toolchainDirectory, path.basename(PYTHON_PACKAGE_ASSET_PATH));
  const relative = path.relative(toolchainDirectory, packagePath);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Pinned package path escapes '${toolchainDirectory}'.`);
  }
  return packagePath;
}

function verifyDigest(filename, bytes, expected) {
  const actual = createHash("sha256").update(bytes).digest("hex");
  if (actual !== expected) {
    throw new Error(`Pinned package '${filename}' has digest ${actual}; expected ${expected}.`);
  }
}

function uniqueCommands(commandMap) {
  const unique = new Set();
  for (const command of Object.values(commandMap)) {
    if (command && typeof command.free === "function") unique.add(command);
  }
  return [...unique];
}

function requiredResponsePath() {
  const value = process.env.FORGE_RUNNER_STAGE_RESPONSE;
  if (!value) throw new Error("FORGE_RUNNER_STAGE_RESPONSE is required.");
  return value;
}

async function readStdin() {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of process.stdin) {
    bytes += chunk.byteLength;
    if (bytes > MAX_INPUT_BYTES) {
      throw new Error(`Runner stage input exceeds ${MAX_INPUT_BYTES} bytes.`);
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function boundedText(value) {
  const text = String(value);
  return text.length <= MAX_ERROR_CHARACTERS
    ? text
    : `${text.slice(0, MAX_ERROR_CHARACTERS)}…`;
}

function errorText(error) {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
