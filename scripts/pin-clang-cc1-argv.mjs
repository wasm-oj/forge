/**
 * Freeze the exact cc1 and wasm-ld jobs expanded by the pinned Clang driver.
 * Runtime builds execute these jobs directly through Wasmer, so the browser
 * never needs fork/exec and every cache key includes the complete frontend
 * and linker command line.
 */
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { FORGE_SCHEMAS } from "../src/core/contract.ts";

const VERSION = "22.0.0-git20542-10";
const TOOLCHAIN_DIRECTORY = path.resolve(
  process.env.FORGE_CLANG_TOOLCHAIN_DIRECTORY ?? "public/toolchains",
);
const WEBC_PATH = path.join(TOOLCHAIN_DIRECTORY, `clang-${VERSION}.webc`);
const OUTPUT_PATH = path.join(TOOLCHAIN_DIRECTORY, `clang-${VERSION}.cc1-pins.json`);
const COMPILER_BIN = path.resolve("crates/runtime-core/target/release/forge-compiler");
const INPUT_PLACEHOLDER = "__FORGE_INPUT__";
const OUTPUT_PLACEHOLDER = "__FORGE_OUTPUT__";
const MAIN_FILE_NAME_PLACEHOLDER = "__FORGE_MAIN_FILE_NAME__";
const OBJECTS_PLACEHOLDER = "__FORGE_OBJECTS__";

const CONFIGS = {
  "c-release": { language: "c", flags: ["-O2", "-DNDEBUG", "-std=c17"] },
  "c-debug": { language: "c", flags: ["-O0", "-g", "-std=c17"] },
  "cpp-release": {
    language: "cpp",
    flags: ["-O2", "-DNDEBUG", "-std=c++20", "-fno-exceptions", "-fno-rtti"],
  },
  "cpp-debug": {
    language: "cpp",
    flags: ["-O0", "-g", "-std=c++20", "-fno-exceptions", "-fno-rtti"],
  },
};

execFileSync("cargo", [
  "build", "--locked", "--manifest-path", path.resolve("crates/runtime-core/Cargo.toml"),
  "--release", "--bin", "forge-compiler",
], { stdio: "inherit" });

const webc = readFileSync(WEBC_PATH);
const sourceSha256 = sha256(webc);
const configKeys = Object.keys(CONFIGS).sort();
const responses = runCompilerBatch({
  schema: FORGE_SCHEMAS.compileBatch,
  packagePath: WEBC_PATH,
  memoryLimitBytes: 4_294_967_296,
  requests: configKeys.map((key) => pinRequest(CONFIGS[key])),
});

const configs = {};
for (const [index, key] of configKeys.entries()) {
  const response = responses[index];
  if (!response.ok || !response.result) {
    throw new Error(`driver -### failed for '${key}': ${response.error?.message ?? "no result"}`);
  }
  const stderr = Buffer.from(response.result.stderrBase64, "base64").toString("utf8");
  if (response.result.code !== 0) {
    throw new Error(`driver -### exited with ${response.result.code} for '${key}':\n${stderr}`);
  }
  configs[key] = pinTemplates(key, stderr);
}

const manifest = {
  schema: FORGE_SCHEMAS.clangPins,
  version: VERSION,
  source: path.basename(WEBC_PATH),
  sourceSha256,
  command: "clang",
  linkerCommand: "wasm-ld",
  placeholders: {
    input: INPUT_PLACEHOLDER,
    output: OUTPUT_PLACEHOLDER,
    mainFileName: MAIN_FILE_NAME_PLACEHOLDER,
    objects: OBJECTS_PLACEHOLDER,
  },
  configs,
};
const encoded = `${JSON.stringify(manifest, null, 2)}\n`;
writeFileSync(OUTPUT_PATH, encoded);
console.log(JSON.stringify({ output: OUTPUT_PATH, sha256: sha256(encoded) }));

function pinRequest(config) {
  const isCpp = config.language === "cpp";
  const entry = isCpp ? "src/main.cpp" : "src/main.c";
  const stub = isCpp ? "int main() { return 0; }\n" : "int main(void) { return 0; }\n";
  return {
    command: isCpp ? "clang++" : "clang",
    args: [
      "--target=wasm32-wasip1",
      "--sysroot=/usr",
      ...config.flags,
      "-fdiagnostics-color=never",
      "-I/project/src",
      `/project/${entry}`,
      "-o",
      "/project/build/app.wasm",
      "-###",
    ],
    env: { PATH: "/bin" },
    stdinBase64: "",
    filesBase64: {
      [`/project/${entry}`]: Buffer.from(stub).toString("base64"),
      "/project/build/.keep": "",
      "/tmp/.keep": "",
    },
    cwd: "/project",
    outputPaths: [],
    outputLimitBytes: 8 * 1024 * 1024,
  };
}

function pinTemplates(key, stderr) {
  const jobs = stderr
    .split("\n")
    .filter((line) => /^\s*"/.test(line))
    .map(tokenizeJobLine);
  const cc1Jobs = jobs.filter((tokens) => tokens.includes("-cc1"));
  const linkJobs = jobs.filter((tokens) => tokens.some((token) => basename(token) === "wasm-ld"));
  if (cc1Jobs.length !== 1 || linkJobs.length !== 1 || jobs.length !== 2) {
    throw new Error(
      `unexpected -### job list for '${key}' (${jobs.length} jobs, ${cc1Jobs.length} cc1, ${linkJobs.length} link):\n${stderr}`,
    );
  }

  const cc1Start = cc1Jobs[0].indexOf("-cc1");
  const cc1 = cc1Jobs[0].slice(cc1Start);
  const inputIndex = cc1.findIndex((token) => /^\/project\/src\/main\.(?:c|cpp)$/.test(token));
  if (inputIndex < 0) throw new Error(`cc1 job for '${key}' does not reference its project input.`);
  cc1[inputIndex] = INPUT_PLACEHOLDER;
  replaceFlagValue(cc1, "-main-file-name", MAIN_FILE_NAME_PLACEHOLDER, key);
  const objectOutput = readFlagValue(cc1, "-o", key);
  replaceFlagValue(cc1, "-o", OUTPUT_PLACEHOLDER, key);

  const linkerStart = linkJobs[0].findIndex((token) => basename(token) === "wasm-ld");
  const link = linkJobs[0].slice(linkerStart + 1);
  const objectIndex = link.indexOf(objectOutput);
  if (objectIndex < 0) throw new Error(`link job for '${key}' does not reference '${objectOutput}'.`);
  link.splice(objectIndex, 1, OBJECTS_PLACEHOLDER);
  replaceFlagValue(link, "-o", OUTPUT_PLACEHOLDER, key);

  for (const token of [...cc1, ...link]) {
    if (token !== OBJECTS_PLACEHOLDER && /\/tmp\/|-[a-f0-9]{6}\.o$/.test(token)) {
      throw new Error(`pinned template for '${key}' still references a temporary path: ${token}`);
    }
  }
  return { cc1, link };
}

function tokenizeJobLine(line) {
  const tokens = [];
  const pattern = /"((?:[^"\\]|\\.)*)"/g;
  for (let match = pattern.exec(line); match; match = pattern.exec(line)) {
    tokens.push(match[1].replace(/\\(.)/g, "$1"));
  }
  if (tokens.length === 0) throw new Error(`failed to tokenize driver job line: ${line}`);
  return tokens;
}

function basename(value) {
  return value.slice(value.lastIndexOf("/") + 1);
}

function readFlagValue(tokens, flag, key) {
  const index = tokens.indexOf(flag);
  if (index < 0 || index + 1 >= tokens.length) {
    throw new Error(`pinned job for '${key}' is missing '${flag}'.`);
  }
  return tokens[index + 1];
}

function replaceFlagValue(tokens, flag, replacement, key) {
  const index = tokens.indexOf(flag);
  if (index < 0 || index + 1 >= tokens.length) {
    throw new Error(`pinned job for '${key}' is missing '${flag}'.`);
  }
  tokens[index + 1] = replacement;
}

function runCompilerBatch(request) {
  const result = spawnSync(COMPILER_BIN, [], {
    input: JSON.stringify(request),
    maxBuffer: 256 * 1024 * 1024,
    encoding: "utf8",
  });
  if (result.error) throw result.error;
  if (result.status !== 0 && !result.stdout) {
    throw new Error(`forge-compiler failed (${result.status}):\n${result.stderr}`);
  }
  const parsed = JSON.parse(result.stdout);
  if (!Array.isArray(parsed.responses) || parsed.responses.length !== request.requests.length) {
    throw new Error("forge-compiler returned a malformed batch response.");
  }
  return parsed.responses;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}
