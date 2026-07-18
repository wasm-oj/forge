import { execFile } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { createServer } from "node:http";
import { access, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium } from "playwright";
import { unpackNpmPackage } from "./packed-package.mjs";
import {
  COMPONENT_MANIFEST_PATH,
  readThirdPartyComponents,
} from "./third-party-components.mjs";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const run = promisify(execFile);
const serviceWorkerFile = "public/toolchain-cache-sw.js";
const browserWasmSources = new Map([
  ["wasmer_js_bg", await readFile(fileURLToPath(import.meta.resolve("@wasmer/sdk/wasm")))],
  ["runtime-core_bg", await readFile(path.join(root, "src/runner/generated/runtime-core_bg.wasm"))],
]);

const canonicalToolchainFiles = [
  "public/toolchains/README.md",
  "public/toolchains/clang-22.0.0-git20542-10.cc1-pins.json",
  "public/toolchains/clang-22.0.0-git20542-10.cpp-debug.pch.gz.bin",
  "public/toolchains/clang-22.0.0-git20542-10.cpp-release.pch.gz.bin",
  "public/toolchains/clang-22.0.0-git20542-10.libcxx-pch.json",
  "public/toolchains/clang-22.0.0-git20542-10.manifest.json",
  "public/toolchains/clang-22.0.0-git20542-10.webc.gz.bin",
  "public/toolchains/go-1.26.5-wasip1.manifest.json",
  "public/toolchains/go-1.26.5-wasip1.stdlib.gz.bin",
  "public/toolchains/go-1.26.5-wasip1.webc.gz.bin",
  "public/toolchains/python-3.14.6-wasip1.manifest.json",
  "public/toolchains/python-3.14.6-wasip1.webc.gz.bin",
  "public/toolchains/quickjs-0.15.1.wasm.gz.bin",
  "public/toolchains/rust-1.91.1-dev.manifest.json",
  "public/toolchains/rust-1.91.1-dev.webc.gz.bin",
  "public/toolchains/typescript-7.0.2.wasm.gz.bin",
];
const exactToolchainExports = Object.fromEntries(
  canonicalToolchainFiles
    .filter((relative) => relative !== "public/toolchains/README.md")
    .map((relative) => [
      `./toolchains/${path.posix.basename(relative)}`,
      `./${relative}`,
    ]),
);
const publicDeclarations = [
  "lib/core.d.ts",
  "lib/browser.d.ts",
  "lib/server.d.ts",
];
const publicJavaScript = [
  "lib/core.js",
  "lib/browser.js",
  "lib/server.js",
];
const serverCompilerStages = [
  "lib/server-build-stage.mjs",
  "lib/python-stage.mjs",
  "lib/rustc-stage.mjs",
  "lib/go-stage.mjs",
];
const serverRunnerStages = [
  "lib/server-runner-stage.mjs",
];
const serverStages = [...serverCompilerStages, ...serverRunnerStages];
const expectedWorkerRoles = [
  "compiler.worker",
  "runner.worker",
  "python-stage.worker",
  "rustc-stage.worker",
  "go-stage.worker",
  "wasmer-thread.worker",
];

async function filesBelow(directory, prefix) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const relative = `${prefix}/${entry.name}`;
    if (entry.isDirectory()) {
      files.push(...await filesBelow(path.join(directory, entry.name), relative));
    } else if (entry.isFile()) {
      files.push(relative);
    } else {
      throw new Error(`Package source boundary contains unsupported entry '${relative}'.`);
    }
  }
  return files;
}

async function packageDocumentationFiles() {
  const files = [];
  for (const directory of ["docs", "experiments"]) {
    files.push(...await filesBelow(path.join(root, directory), directory));
  }
  return files.sort();
}

async function packageRuntimeSourceFiles() {
  const rustSources = [
    ...await filesBelow(
      path.join(root, "crates/runtime-core/src"),
      "crates/runtime-core/src",
    ),
    ...await filesBelow(
      path.join(root, "vendor/shared-buffer/src"),
      "vendor/shared-buffer/src",
    ),
    ...await filesBelow(
      path.join(root, "vendor/virtual-fs/src"),
      "vendor/virtual-fs/src",
    ),
  ].sort();
  const nonRustSources = rustSources.filter((relative) => !relative.endsWith(".rs"));
  if (nonRustSources.length > 0) {
    throw new Error(
      `The native runtime source boundary contains non-Rust files: ${nonRustSources.join(", ")}.`,
    );
  }
  return [
    "rust-toolchain.toml",
    "crates/runtime-core/Cargo.lock",
    "crates/runtime-core/Cargo.toml",
    "crates/runtime-core/README.md",
    "vendor/shared-buffer/Cargo.toml",
    "vendor/shared-buffer/LICENSE_APACHE.md",
    "vendor/shared-buffer/LICENSE_MIT.md",
    "vendor/shared-buffer/README.md",
    "vendor/virtual-fs/Cargo.toml",
    "vendor/virtual-fs/LICENSE",
    ...rustSources,
  ].sort();
}

async function verifyLocalMarkdownLinks(packageRoot, packedFiles, markdownFiles) {
  for (const relative of markdownFiles) {
    const source = await readFile(path.join(packageRoot, relative), "utf8");
    for (const match of source.matchAll(/(?<!!)\[[^\]]*\]\(([^)\s]+)(?:\s+['\"][^'\"]*['\"])?\)/g)) {
      const reference = match[1];
      if (
        reference.startsWith("#")
        || reference.startsWith("/")
        || /^[A-Za-z][A-Za-z0-9+.-]*:/.test(reference)
      ) continue;
      const pathname = reference.split("#", 1)[0].split("?", 1)[0];
      if (!pathname) continue;
      const target = path.posix.normalize(path.posix.join(path.posix.dirname(relative), decodeURIComponent(pathname)));
      if (target === ".." || target.startsWith("../")) {
        throw new Error(`Packed Markdown '${relative}' escapes the package through '${reference}'.`);
      }
      const directoryPrefix = target.endsWith("/") ? target : `${target}/`;
      if (!packedFiles.has(target) && ![...packedFiles].some((file) => file.startsWith(directoryPrefix))) {
        throw new Error(`Packed Markdown '${relative}' references missing local target '${reference}'.`);
      }
    }
  }
}

function failSetDifference(label, expected, actual) {
  const missing = [...expected].filter((value) => !actual.has(value)).sort();
  const unexpected = [...actual].filter((value) => !expected.has(value)).sort();
  if (missing.length > 0 || unexpected.length > 0) {
    throw new Error(
      `${label} differs from the canonical package surface.`
      + `${missing.length > 0 ? ` Missing: ${missing.join(", ")}.` : ""}`
      + `${unexpected.length > 0 ? ` Unexpected: ${unexpected.join(", ")}.` : ""}`,
    );
  }
}

function localExecutableReferences(source, from, stageBasenames) {
  const references = new Set();
  for (const match of source.matchAll(/\bnew URL\(\s*["'`]([^"'`]+)["'`]\s*,\s*import\.meta\.url\s*\)/g)) {
    const specifier = match[1];
    if (specifier.startsWith("/")) {
      throw new Error(`Packed executable '${from}' contains site-root asset URL '${specifier}'.`);
    }
    // The SDK facade is emitted only as the protocol's sdkUrl value. Forge's
    // custom secondary worker validates but deliberately does not import that
    // URL; every executable SDK instance receives the verified hashed module
    // explicitly. Do not turn wasm-bindgen's unreachable default literal into
    // a second, unhashed copy of the same 6.6 MB binary.
    if (
      (specifier === "wasmer_js_bg.wasm" || specifier === "index.mjs")
      && /^lib\/assets\/index-[A-Za-z0-9_-]+\.mjs$/.test(from)
      && ["ThreadPoolWorker", "initSync", "setSDKUrl"].every((symbol) => source.includes(symbol))
    ) {
      continue;
    }
    if (/\.(?:m?js|wasm)$/.test(specifier)) {
      references.add(path.posix.normalize(path.posix.join(path.posix.dirname(from), specifier)));
    }
  }
  const specifierPatterns = [
    /(?:^|\n)\s*(?:import|export)\s+(?:[^"'\n]*?\sfrom\s*)?["']([^"']+)["']/g,
    /\bimport\(\s*["']([^"']+)["']\s*\)/g,
    /["'`](\/?assets\/[A-Za-z0-9._-]+\.(?:m?js|wasm))["'`]/g,
  ];
  for (const pattern of specifierPatterns) {
    for (const match of source.matchAll(pattern)) {
      const specifier = match[1];
      if (specifier.startsWith("/assets/")) {
        throw new Error(`Packed executable '${from}' contains site-root asset URL '${specifier}'.`);
      } else if (specifier.startsWith("assets/")) {
        references.add(`lib/${specifier.replace(/^\//, "")}`);
      } else if (specifier.startsWith("./") || specifier.startsWith("../")) {
        references.add(path.posix.normalize(path.posix.join(path.posix.dirname(from), specifier)));
      }
    }
  }
  for (const basename of stageBasenames) {
    if (
      source.includes(`"${basename}"`)
      || source.includes(`'${basename}'`)
      || source.includes(`\`${basename}\``)
    ) {
      references.add(`lib/${basename}`);
    }
  }
  return references;
}

async function executableReachability(packageRoot, executableFiles, binaryFiles) {
  const reachable = new Set();
  const edges = new Map();
  const pending = [...publicJavaScript];
  const runtimeFiles = new Set([...executableFiles, ...binaryFiles]);
  const stageBasenames = serverStages.map((file) => path.posix.basename(file));
  while (pending.length > 0) {
    const relative = pending.pop();
    if (reachable.has(relative)) continue;
    if (!executableFiles.has(relative)) {
      throw new Error(`Packed JavaScript graph references missing executable '${relative}'.`);
    }
    reachable.add(relative);
    const source = await readFile(path.join(packageRoot, relative), "utf8");
    const references = localExecutableReferences(source, relative, stageBasenames);
    edges.set(relative, references);
    for (const reference of references) {
      if (!runtimeFiles.has(reference)) {
        throw new Error(`Packed runtime '${relative}' references missing local file '${reference}'.`);
      }
      if (executableFiles.has(reference)) pending.push(reference);
      else reachable.add(reference);
    }
  }
  return { reachable, edges };
}

function workerRole(relative) {
  const match = /^lib\/assets\/(.+\.worker)-[A-Za-z0-9_-]+\.js$/.exec(relative);
  return match?.[1];
}

function browserWasmRole(relative) {
  const match = /^lib\/assets\/(wasmer_js_bg|runtime-core_bg)-[A-Za-z0-9_-]+\.wasm$/.exec(relative);
  return match?.[1];
}

function requireEdge(edges, from, to, description) {
  if (!edges.get(from)?.has(to)) {
    throw new Error(`${description}: '${from}' must directly reference '${to}'.`);
  }
}

const sourceComponents = await readThirdPartyComponents(root);
const documentationFiles = await packageDocumentationFiles();
const runtimeSourceFiles = await packageRuntimeSourceFiles();
const sourceServiceWorker = await readFile(path.join(root, serviceWorkerFile));
const packed = await unpackNpmPackage(root, "forge-package-verification-");
try {
  const { packageRoot, packedFiles } = packed;
  const packageJson = JSON.parse(await readFile(path.join(packageRoot, "package.json"), "utf8"));
  const packedComponents = await readThirdPartyComponents(packageRoot);
  if (!packedComponents.manifestBytes.equals(sourceComponents.manifestBytes)) {
    throw new Error(`Packed '${COMPONENT_MANIFEST_PATH}' differs from the verified source manifest.`);
  }
  const packedLicenseFiles = [...sourceComponents.expectedLicenseFiles].sort();

  const required = [
    ...publicJavaScript,
    ...publicDeclarations,
    ...serverStages,
    serviceWorkerFile,
    ...runtimeSourceFiles,
    "LICENSE",
    "README.md",
    "THIRD_PARTY_NOTICES.md",
    ...documentationFiles,
    ...packedLicenseFiles,
    ...canonicalToolchainFiles,
  ];
  for (const relative of required) {
    if (!packedFiles.has(relative)) throw new Error(`Packed library is missing required file '${relative}'.`);
    await access(path.join(packageRoot, relative));
  }
  for (const relative of packedLicenseFiles) {
    const bytes = await readFile(path.join(packageRoot, relative));
    if (bytes.byteLength === 0) throw new Error(`Packed license material '${relative}' is empty.`);
  }
  const packedServiceWorker = await readFile(path.join(packageRoot, serviceWorkerFile));
  if (!packedServiceWorker.equals(sourceServiceWorker)) {
    throw new Error("The packed toolchain-cache service worker differs from its verified source asset.");
  }
  for (const relative of runtimeSourceFiles) {
    const [sourceBytes, packedBytes] = await Promise.all([
      readFile(path.join(root, relative)),
      readFile(path.join(packageRoot, relative)),
    ]);
    if (!packedBytes.equals(sourceBytes)) {
      throw new Error(`Packed native runtime source '${relative}' differs from the repository source.`);
    }
  }

  const forbiddenPaths = [...packedFiles].filter((relative) => (
    /(?:^|\/)sdk\/index(?:\.|\/)/.test(relative)
    || /(?:^|\/)templates(?:\.|\/)/.test(relative)
    || /rust-link-stage/.test(relative)
    || relative.startsWith("lib/types/")
  ));
  if (forbiddenPaths.length > 0) {
    throw new Error(`Packed library contains removed or private files: ${forbiddenPaths.sort().join(", ")}.`);
  }

  const declarations = new Set([...packedFiles].filter((relative) => relative.endsWith(".d.ts")));
  failSetDifference("Packed declaration entrypoints", new Set(publicDeclarations), declarations);

  const toolchainFiles = new Set([...packedFiles].filter((relative) => relative.startsWith("public/toolchains/")));
  failSetDifference("Packed toolchain assets", new Set(canonicalToolchainFiles), toolchainFiles);

  const executableFiles = new Set([...packedFiles].filter((relative) => (
    relative.startsWith("lib/") && (relative.endsWith(".js") || relative.endsWith(".mjs"))
  )));
  const browserWasmFiles = new Set([...packedFiles].filter((relative) => (
    relative.startsWith("lib/assets/") && relative.endsWith(".wasm")
  )));
  const browserRuntimeFiles = new Set([...executableFiles, ...browserWasmFiles]);
  const { reachable, edges } = await executableReachability(
    packageRoot,
    executableFiles,
    browserWasmFiles,
  );
  failSetDifference("Packed browser runtime graph", browserRuntimeFiles, reachable);

  const workersByRole = new Map();
  for (const relative of executableFiles) {
    if (!relative.startsWith("lib/assets/")) continue;
    const role = workerRole(relative);
    if (!role) {
      if (relative.includes(".worker-")) {
        throw new Error(`Packed browser Worker '${relative}' has no canonical role.`);
      }
      continue;
    }
    if (workersByRole.has(role)) throw new Error(`Packed browser Worker role '${role}' is emitted more than once.`);
    workersByRole.set(role, relative);
  }
  failSetDifference("Packed browser Worker roles", new Set(expectedWorkerRoles), new Set(workersByRole.keys()));

  const browserWasmByRole = new Map();
  for (const relative of browserWasmFiles) {
    const role = browserWasmRole(relative);
    if (!role) throw new Error(`Packed browser Wasm asset '${relative}' has no canonical role.`);
    if (browserWasmByRole.has(role)) throw new Error(`Packed browser Wasm role '${role}' is emitted more than once.`);
    const expected = browserWasmSources.get(role);
    const actual = await readFile(path.join(packageRoot, relative));
    if (!expected?.equals(actual)) {
      throw new Error(`Packed browser Wasm role '${role}' differs from its verified source module.`);
    }
    browserWasmByRole.set(role, relative);
  }
  failSetDifference(
    "Packed browser Wasm roles",
    new Set(browserWasmSources.keys()),
    new Set(browserWasmByRole.keys()),
  );
  const wasmerWasm = browserWasmByRole.get("wasmer_js_bg");
  const runtimeCoreWasm = browserWasmByRole.get("runtime-core_bg");
  requireEdge(edges, "lib/browser.js", workersByRole.get("compiler.worker"), "Compiler Worker reachability");
  requireEdge(edges, "lib/browser.js", workersByRole.get("runner.worker"), "Runner Worker reachability");
  const compilerWorker = workersByRole.get("compiler.worker");
  const runnerWorker = workersByRole.get("runner.worker");
  const pythonWorker = workersByRole.get("python-stage.worker");
  const rustWorker = workersByRole.get("rustc-stage.worker");
  const goWorker = workersByRole.get("go-stage.worker");
  const wasmerThreadWorker = workersByRole.get("wasmer-thread.worker");
  requireEdge(edges, compilerWorker, pythonWorker, "Python stage Worker reachability");
  requireEdge(edges, compilerWorker, rustWorker, "Rust stage Worker reachability");
  requireEdge(edges, compilerWorker, goWorker, "Go stage Worker reachability");
  for (const [parent, description] of [
    [compilerWorker, "Compiler Wasmer thread Worker reachability"],
    [runnerWorker, "Runner Wasmer thread Worker reachability"],
    [pythonWorker, "Python Wasmer thread Worker reachability"],
    [rustWorker, "Rust Wasmer thread Worker reachability"],
  ]) {
    requireEdge(edges, parent, wasmerThreadWorker, description);
    requireEdge(edges, parent, wasmerWasm, `${description} SDK module`);
  }
  requireEdge(edges, runnerWorker, runtimeCoreWasm, "Runner runtime-core module reachability");
  requireEdge(edges, goWorker, runtimeCoreWasm, "Go stage runtime-core module reachability");

  const serverCompilerChunk = "lib/chunks/server-compiler.js";
  if (!reachable.has(serverCompilerChunk)) {
    throw new Error(`Canonical server compiler chunk '${serverCompilerChunk}' is not reachable from the server entrypoint.`);
  }
  for (const stage of serverCompilerStages) {
    requireEdge(edges, serverCompilerChunk, stage, "Server compiler stage reachability");
  }
  for (const stage of serverRunnerStages) {
    const parents = [...edges]
      .filter(([, references]) => references.has(stage))
      .map(([relative]) => relative)
      .sort();
    if (parents.length !== 1 || !reachable.has(parents[0])) {
      throw new Error(
        `Server runner stage '${stage}' must have exactly one reachable executable parent; `
        + `received ${parents.join(", ") || "none"}.`,
      );
    }
  }

  const exactSurface = new Set([
    "package.json",
    "README.md",
    "LICENSE",
    "THIRD_PARTY_NOTICES.md",
    ...documentationFiles,
    ...packedLicenseFiles,
    ...canonicalToolchainFiles,
    serviceWorkerFile,
    ...runtimeSourceFiles,
    ...publicDeclarations,
    ...executableFiles,
    ...browserWasmFiles,
  ]);
  failSetDifference("Packed npm files", exactSurface, packedFiles);
  await verifyLocalMarkdownLinks(
    packageRoot,
    packedFiles,
    [
      "README.md",
      "THIRD_PARTY_NOTICES.md",
      "crates/runtime-core/README.md",
      "public/toolchains/README.md",
      ...documentationFiles,
    ].filter((relative) => relative.endsWith(".md")),
  );

  const thirdPartyNotices = await readFile(path.join(packageRoot, "THIRD_PARTY_NOTICES.md"), "utf8");
  if (/distribution blocker/i.test(thirdPartyNotices)) {
    throw new Error("THIRD_PARTY_NOTICES.md contains an unresolved distribution blocker.");
  }
  const referencedLicenseFiles = new Set(
    [...thirdPartyNotices.matchAll(/`(licenses\/[A-Za-z0-9._-]+)`/g)]
      .map((match) => match[1]),
  );
  failSetDifference(
    "THIRD_PARTY_NOTICES.md license references",
    sourceComponents.expectedLicenseFiles,
    referencedLicenseFiles,
  );

  if (packageJson.private === true) throw new Error("The Forge library package must be publishable.");
  if (packageJson.license !== "MIT" || typeof packageJson.description !== "string") {
    throw new Error("The Forge library package must declare its MIT license and description.");
  }
  if (packageJson.publishConfig?.access !== "public") {
    throw new Error("The scoped Forge library package must publish with public access.");
  }
  if (packageJson.dependencies?.["@wasmer/sdk"] !== "0.10.0") {
    throw new Error("The Forge library package must pin the verified @wasmer/sdk 0.10.0 release.");
  }
  for (const lifecycle of ["preinstall", "install", "postinstall"]) {
    if (Object.hasOwn(packageJson.scripts ?? {}, lifecycle)) {
      throw new Error(`The Forge library must not mutate consumer installs through '${lifecycle}'.`);
    }
  }

  const expectedExports = {
    ".": { import: "./lib/core.js", types: "./lib/core.d.ts" },
    "./browser": { import: "./lib/browser.js", types: "./lib/browser.d.ts" },
    "./server": { import: "./lib/server.js", types: "./lib/server.d.ts" },
    "./toolchain-cache-sw.js": `./${serviceWorkerFile}`,
    ...exactToolchainExports,
    "./package.json": "./package.json",
  };
  failSetDifference("Package export keys", new Set(Object.keys(expectedExports)), new Set(Object.keys(packageJson.exports ?? {})));
  if (packageJson.types !== "./lib/core.d.ts") {
    throw new Error("Package-level types must resolve to './lib/core.d.ts'.");
  }
  if (
    packageJson.scripts?.["runtime:build-native"]
    !== "cargo build --locked --manifest-path crates/runtime-core/Cargo.toml --release --bins"
  ) {
    throw new Error("The packed native compiler/runner build command must use the locked runtime-core source contract.");
  }
  for (const [key, expected] of Object.entries(expectedExports)) {
    const actual = packageJson.exports[key];
    if (typeof expected === "string") {
      if (actual !== expected) throw new Error(`Package export '${key}' must resolve to '${expected}'.`);
      if (expected.startsWith("./") && !packedFiles.has(expected.slice(2))) {
        throw new Error(`Package export '${key}' targets unpacked file '${expected}'.`);
      }
      continue;
    }
    if (actual?.import !== expected.import || actual?.types !== expected.types) {
      throw new Error(
        `Package export '${key}' must resolve import/types to '${expected.import}' and '${expected.types}'.`,
      );
    }
    failSetDifference(
      `Package export '${key}' conditions`,
      new Set(["import", "types"]),
      new Set(Object.keys(actual)),
    );
    for (const target of Object.values(expected)) {
      if (!packedFiles.has(target.slice(2))) {
        throw new Error(`Package export '${key}' targets unpacked file '${target}'.`);
      }
    }
  }

  for (const relative of [...publicJavaScript, ...publicDeclarations]) {
    const source = await readFile(path.join(packageRoot, relative), "utf8");
    if (source.includes("@/src/") || source.includes("lib/types/") || source.includes("src/sdk/index")) {
      throw new Error(`Built library '${relative}' contains a private source reference.`);
    }
  }

  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  await run(npm, [
    "install",
    "--dry-run=false",
    "--ignore-scripts",
    "--no-package-lock",
    "--no-save",
    "--omit=dev",
    "--prefer-offline",
    "--no-audit",
    "--no-fund",
  ], {
    cwd: packageRoot,
    env: { ...process.env, NO_COLOR: "1" },
    maxBuffer: 16 * 1024 * 1024,
  });

  await verifyPackedBrowserRuntime(packageRoot, workersByRole, browserWasmByRole);

  const core = await import(pathToFileURL(path.join(packageRoot, "lib/core.js")).href);
  const browser = await import(pathToFileURL(path.join(packageRoot, "lib/browser.js")).href);
  const server = await import(pathToFileURL(path.join(packageRoot, "lib/server.js")).href);
  for (const name of [
    "createForgeEngine",
    "ForgeEngine",
    "ForgeCompilerRegistry",
    "createExtendedCostBaselineRegistry",
    "costProfileId",
    "resolveArtifactCostBudget",
  ]) {
    if (typeof core[name] !== "function") throw new Error(`The core package entry is missing '${name}'.`);
  }
  if (
    "Forge" in core
    || "BrowserForgeCompiler" in core
    || "ServerForgeCompiler" in core
    || "LanguageDriverRegistry" in core
  ) {
    throw new Error("The environment-neutral package entry leaks a host or removed implementation.");
  }
  if (
    typeof browser.Forge !== "function"
    || typeof browser.BrowserForgeCompiler !== "function"
    || typeof browser.registerToolchainCache !== "function"
  ) {
    throw new Error("The browser package entry is missing its host implementations.");
  }
  if (typeof server.ServerForgeCompiler !== "function" || typeof server.ServerForgeRunner !== "function") {
    throw new Error("The server package entry is missing its host implementations.");
  }

  const { compilerExecutable, runtimeExecutable } = await buildPackedNativeRuntime(packageRoot);
  const compiler = new server.ServerForgeCompiler({
    compilerExecutable,
    toolchainDirectory: path.join(packageRoot, "public/toolchains"),
  });
  let runner;
  const runtimeCacheDirectory = await mkdtemp(path.join(os.tmpdir(), "forge-packed-runner-cache-"));
  try {
    await compiler.ready();
    const project = core.createSdkProject({
      language: "typescript",
      target: "wasip1",
      optimization: "release",
      entry: "src/main.ts",
      files: {
        "src/main.ts": 'import * as std from "std";\nconst answer: number = 40 + 2;\nstd.out.puts(`${answer}\\n`);\n',
      },
      name: "package-verification",
      projectId: "forge:package-verification",
    });
    const result = await compiler.build(project, "forge:package-verification:typescript");
    if (!result.success || result.artifact?.kind !== "runtime-bundle") {
      throw new Error(
        `The packaged server compiler failed its TypeScript integration check:\n${result.stderr}\n${JSON.stringify(result.diagnostics)}`,
      );
    }
    const emitted = result.artifact.files["src/main.js"];
    if (typeof emitted !== "string" || !emitted.includes("answer")) {
      throw new Error("The packaged server compiler did not emit the expected TypeScript output.");
    }
    const artifact = result.artifact;
    const runtimeDrivers = core.createDefaultRuntimeDrivers(
      new core.CostBaselineRegistry({ [artifact.costProfile]: 0 }),
    );
    runner = new server.ServerForgeRunner({
      runtimeExecutable,
      toolchainDirectory: path.join(packageRoot, "public/toolchains"),
      cacheDirectory: runtimeCacheDirectory,
      runtimeDrivers,
    });
    await runner.ready();
    const execution = await runner.run(artifact, {
      args: [],
      stdin: "",
      env: {},
      determinism: {
        randomSeed: 0x5eed_1234,
        realtimeEpochMs: 946_684_800_000,
        clockStepNs: 1_000_000,
      },
      resources: {
        instructionBudget: 100_000_000,
        logicalTimeLimitMs: 60_000,
        memoryLimitBytes: 256 * 1024 * 1024,
        outputLimitBytes: 1024 * 1024,
        filesystemWriteLimitBytes: 64 * 1024 * 1024,
        filesystemEntryLimit: 4_096,
        wallTimeLimitMs: 60_000,
      },
    });
    if (execution.code !== 0 || execution.termination !== "exited" || execution.stdout !== "42\n") {
      throw new Error(
        "The packed ServerForgeRunner failed its compiled TypeScript execution check: "
        + JSON.stringify({
          code: execution.code,
          termination: execution.termination,
          stdout: execution.stdout,
          stderr: execution.stderr,
          trapMessage: execution.trapMessage,
        }),
      );
    }
  } finally {
    try {
      runner?.dispose();
    } finally {
      try {
        compiler.dispose();
      } finally {
        await rm(runtimeCacheDirectory, { recursive: true, force: true });
      }
    }
  }
} finally {
  await packed.cleanup();
}

process.stdout.write("Forge packed library package verified.\n");

async function verifyPackedBrowserRuntime(packageRoot, workersByRole, browserWasmByRole) {
  const requests = [];
  const server = createServer(async (request, response) => {
    const headers = {
      "Cross-Origin-Embedder-Policy": "require-corp",
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Resource-Policy": "same-origin",
      "Cache-Control": "no-store",
    };
    try {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      requests.push(url.pathname);
      if (url.pathname === "/smoke.html") {
        response.writeHead(200, { ...headers, "Content-Type": "text/html; charset=utf-8" });
        response.end("<!doctype html><meta charset=utf-8><title>Forge packed browser smoke</title>");
        return;
      }
      const decoded = url.pathname === "/toolchain-cache-sw.js"
        ? serviceWorkerFile
        : decodeURIComponent(url.pathname).replace(/^\/+/, "");
      const absolute = path.resolve(packageRoot, decoded);
      const relative = path.relative(packageRoot, absolute);
      if (!decoded || relative.startsWith("..") || path.isAbsolute(relative)) {
        response.writeHead(404, headers);
        response.end();
        return;
      }
      const bytes = await readFile(absolute);
      const contentType = absolute.endsWith(".js") || absolute.endsWith(".mjs")
        ? "text/javascript; charset=utf-8"
        : absolute.endsWith(".wasm")
          ? "application/wasm"
          : "application/octet-stream";
      response.writeHead(200, {
        ...headers,
        "Content-Type": contentType,
        "Content-Length": bytes.byteLength,
        ...(url.pathname === "/toolchain-cache-sw.js" ? { "Service-Worker-Allowed": "/" } : {}),
      });
      response.end(bytes);
    } catch (error) {
      response.writeHead(500, { ...headers, "Content-Type": "text/plain; charset=utf-8" });
      response.end(error instanceof Error ? error.message : String(error));
    }
  });
  let browser;
  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Packed browser smoke server has no TCP address.");
    const origin = `http://127.0.0.1:${address.port}`;
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ serviceWorkers: "allow" });
    const page = await context.newPage();
    const pageErrors = [];
    const consoleErrors = [];
    const consoleMessages = [];
    const requestFailures = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));
    page.on("console", (message) => {
      consoleMessages.push(`${message.type()}: ${message.text()}`);
      if (consoleMessages.length > 100) consoleMessages.shift();
      if (message.type() === "error") consoleErrors.push(message.text());
    });
    page.on("requestfailed", (request) => {
      requestFailures.push(`${request.method()} ${request.url()}: ${request.failure()?.errorText ?? "unknown"}`);
    });
    await page.goto(`${origin}/smoke.html`, { waitUntil: "domcontentloaded", timeout: 120_000 });
    let verification;
    try {
      verification = await withDeadline(page.evaluate(async () => {
      const browserModule = await import("/lib/browser.js");
      const forge = await browserModule.Forge.create({
        artifactCache: false,
        assetBaseUrl: "/public/toolchains/",
      });
      const compileDurationsMs = [];
      const progress = [];
      const removeProgress = forge.onProgress((event) => {
        progress.push(`${event.phase}: ${event.label}`);
        if (progress.length > 100) progress.shift();
      });
      let artifact;
      try {
        for (let index = 0; index < 6; index += 1) {
          const startedAt = performance.now();
          const build = await forge.compile({
            language: "rust",
            target: "wasip1",
            optimization: "release",
            entry: "src/main.rs",
            files: { "src/main.rs": "fn main() { println!(\"42\"); }\n" },
          }, { cache: false });
          compileDurationsMs.push(performance.now() - startedAt);
          if (!build.success || build.artifact?.kind !== "wasm") {
            throw new Error(
              `Packed Rust build ${index + 1} failed: ${build.stderr || JSON.stringify(build.diagnostics)}`,
            );
          }
          artifact = build.artifact;
        }
        const execution = await forge.run(artifact);
        if (execution.code !== 0 || execution.termination !== "exited" || execution.stdout !== "42\n") {
          throw new Error(`Packed Rust execution failed: ${JSON.stringify(execution)}`);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`${message}\nProgress:\n${progress.join("\n")}`);
      } finally {
        removeProgress();
        forge.dispose();
      }
      const registration = await browserModule.registerToolchainCache({
        scriptUrl: "/toolchain-cache-sw.js",
        scope: "/",
      });
      const active = registration?.active?.state === "activated";
      await registration?.unregister();
      return { active, compileDurationsMs };
      }), 300_000, "Packed browser Rust lifecycle, execution, and service-worker registration");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`${message}\nBrowser console:\n${consoleMessages.join("\n")}`);
    }
    if (
      verification?.active !== true
      || verification.compileDurationsMs?.length !== 6
      || pageErrors.length > 0
      || consoleErrors.length > 0
      || requestFailures.length > 0
    ) {
      throw new Error(
        "Packed browser runtime failed: "
        + [
          ...pageErrors,
          ...consoleErrors,
          ...requestFailures,
          ...(verification?.active === true ? [] : ["service-worker activation returned false"]),
        ].join("; "),
      );
    }
    for (const role of ["compiler.worker", "runner.worker", "rustc-stage.worker", "wasmer-thread.worker"]) {
      const expected = `/${workersByRole.get(role)}`;
      if (!requests.includes(expected)) {
        throw new Error(`Packed browser smoke did not load '${expected}'.`);
      }
    }
    for (const relative of browserWasmByRole.values()) {
      const expected = `/${relative}`;
      if (!requests.includes(expected)) {
        throw new Error(`Packed browser smoke did not load '${expected}'.`);
      }
    }
    for (const inactiveDefault of ["wasmer_js_bg.wasm", "index.mjs"]) {
      if (requests.includes(`/lib/assets/${inactiveDefault}`)) {
        throw new Error(`Packed browser runtime requested inactive SDK default '${inactiveDefault}'.`);
      }
    }
    if (!requests.includes("/toolchain-cache-sw.js")) {
      throw new Error("Packed browser smoke did not register the exported toolchain-cache service worker.");
    }
  } finally {
    try {
      await browser?.close();
    } finally {
      if (server.listening) {
        await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      }
    }
  }
}

async function buildPackedNativeRuntime(packageRoot) {
  const targetDirectory = path.join(root, "crates/runtime-core/target");
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  await run(npm, [
    "run",
    "runtime:build-native",
    "--",
    "--target-dir", targetDirectory,
  ], {
    cwd: packageRoot,
    env: {
      ...process.env,
      NO_COLOR: "1",
    },
    timeout: 20 * 60 * 1_000,
    killSignal: "SIGKILL",
    maxBuffer: 32 * 1024 * 1024,
  });
  const suffix = process.platform === "win32" ? ".exe" : "";
  const compilerExecutable = path.join(targetDirectory, "release", `forge-compiler${suffix}`);
  const runtimeExecutable = path.join(targetDirectory, "release", `forge-runner${suffix}`);
  await Promise.all([
    access(compilerExecutable, fsConstants.X_OK),
    access(runtimeExecutable, fsConstants.X_OK),
  ]);
  return { compilerExecutable, runtimeExecutable };
}

async function withDeadline(operation, timeoutMs, label) {
  let timer;
  try {
    return await Promise.race([
      operation,
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${label} exceeded ${timeoutMs} ms.`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
