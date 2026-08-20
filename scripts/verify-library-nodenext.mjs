import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { promisify } from "node:util";
import { resolveTypeScriptCli } from "./typescript-cli.mjs";
import { PUBLIC_PACKAGES, packagesRoot, repositoryRoot } from "./library-packages.mjs";

const run = promisify(execFile);
const require = createRequire(import.meta.url);
const temporary = await mkdtemp(path.join(os.tmpdir(), "wasm-oj-nodenext-consumer-"));

try {
  const consumerRoot = path.join(temporary, "consumer");
  const tarballs = new Map();
  await mkdir(consumerRoot, { recursive: true });
  for (const definition of PUBLIC_PACKAGES) {
    tarballs.set(definition.name, await packPackage(path.join(packagesRoot, definition.directory), definition.name));
  }
  const externalTarballs = await packInstalledRuntimeDependencies();
  const packageOverrides = new Map([...tarballs, ...externalTarballs]);

  await writeFile(path.join(consumerRoot, "package.json"), `${JSON.stringify({
    name: "wasm-oj-nodenext-consumer",
    private: true,
    type: "module",
    dependencies: Object.fromEntries([...tarballs].map(([name, tarball]) => [name, `file:${tarball}`])),
    pnpm: {
      overrides: Object.fromEntries([...packageOverrides].map(([name, tarball]) => [name, `file:${tarball}`])),
    },
  }, null, 2)}\n`);
  await writeFile(path.join(consumerRoot, "tsconfig.json"), `${JSON.stringify({
    compilerOptions: {
      target: "ES2022",
      lib: ["ES2022", "DOM", "DOM.Iterable"],
      module: "NodeNext",
      moduleResolution: "NodeNext",
      strict: true,
      noEmit: true,
      skipLibCheck: false,
      verbatimModuleSyntax: true,
      forceConsistentCasingInFileNames: true,
    },
    files: ["consumer.ts"],
  }, null, 2)}\n`);
  await writeFile(path.join(consumerRoot, "consumer.ts"), `
import {
  WASM_OJ_CONTRACT_ID,
  WASM_OJ_CONTRACT_VERSION,
  type BrowserToolchainSource,
  type ServerToolchainSource,
  type ToolchainDescriptor,
} from "@wasm-oj/contracts";
import {
  Engine,
  WasmOjError,
  CompilerRegistry,
  DependencyManager,
  createEngine,
  type ArtifactStore,
  type Compiler,
  type Runner,
} from "@wasm-oj/core";
import {
  BrowserCompiler,
  BrowserRunner,
  StorageCoordinator,
  createBrowserEngine,
} from "@wasm-oj/browser";
import {
  ServerCompiler,
  ServerRunner,
  createServerEngine,
  createVerifiedServerDistribution,
} from "@wasm-oj/server";
import { runCollectionCli } from "@wasm-oj/organizer";
import { Engine as UmbrellaEngine } from "@wasm-oj/sdk";
import { createBrowserEngine as UmbrellaBrowser } from "@wasm-oj/sdk/browser";
import { createServerEngine as UmbrellaServer } from "@wasm-oj/sdk/server";
import { runCollectionCli as UmbrellaOrganizer } from "@wasm-oj/sdk/organizer";
import { WASM_OJ_CONTRACT_ID as UmbrellaContract } from "@wasm-oj/sdk/contracts";
import { browserSource as clangBrowser, serverSource as clangServer } from "@wasm-oj/toolchain-clang";
import { browserSource as rustBrowser } from "@wasm-oj/toolchain-rust";
import { browserSource as goBrowser } from "@wasm-oj/toolchain-go";
import { browserSource as pythonBrowser } from "@wasm-oj/toolchain-python";
import { browserSource as javascriptBrowser } from "@wasm-oj/toolchain-javascript";
import { browserSource as javaBrowser, serverSource as javaServer } from "@wasm-oj/toolchain-java";

const browserSources: readonly BrowserToolchainSource[] = [
  clangBrowser("/assets/wasm-oj/clang/"),
  rustBrowser("/assets/wasm-oj/rust/"),
  goBrowser("/assets/wasm-oj/go/"),
  pythonBrowser("/assets/wasm-oj/python/"),
  javascriptBrowser("/assets/wasm-oj/javascript/"),
  javaBrowser("/assets/wasm-oj/java/"),
];
const serverSources: readonly ServerToolchainSource[] = [clangServer(), javaServer()];
const descriptor: ToolchainDescriptor = browserSources[0]!.descriptor;
const browserEngine: Promise<Engine> = createBrowserEngine({ toolchains: browserSources });
const serverEngine: Promise<Engine> = createServerEngine({
  runtimeDirectory: "/opt/wasm-oj/bin",
  toolchains: serverSources,
});

export interface PublicSurface {
  artifactStore?: ArtifactStore;
  compiler: Compiler;
  runner: Runner;
  engine: Engine;
}

export const publicValues = [
  WASM_OJ_CONTRACT_ID,
  WASM_OJ_CONTRACT_VERSION,
  Engine,
  WasmOjError,
  CompilerRegistry,
  DependencyManager,
  createEngine,
  BrowserCompiler,
  BrowserRunner,
  StorageCoordinator,
  createBrowserEngine,
  ServerCompiler,
  ServerRunner,
  createServerEngine,
  createVerifiedServerDistribution,
  runCollectionCli,
  UmbrellaEngine,
  UmbrellaBrowser,
  UmbrellaServer,
  UmbrellaOrganizer,
  UmbrellaContract,
  descriptor,
  browserEngine,
  serverEngine,
  serverSources,
] as const;
`);

  await writeFile(path.join(consumerRoot, "consumer-runtime.mjs"), `
import * as contracts from "@wasm-oj/contracts";
import * as core from "@wasm-oj/core";
import * as browser from "@wasm-oj/browser";
import * as server from "@wasm-oj/server";
import * as organizer from "@wasm-oj/organizer";
import * as sdk from "@wasm-oj/sdk";
import * as sdkBrowser from "@wasm-oj/sdk/browser";
import * as sdkContracts from "@wasm-oj/sdk/contracts";
import * as sdkOrganizer from "@wasm-oj/sdk/organizer";
import * as sdkServer from "@wasm-oj/sdk/server";

if (contracts.WASM_OJ_CONTRACT_VERSION !== 2 || contracts.WASM_OJ_CONTRACT_ID !== "wasm-oj-v2") {
  throw new Error("Packed contracts do not expose the contract 2 identity.");
}
if (
  sdk.Engine !== core.Engine
  || browser.Engine !== core.Engine
  || browser.WasmOjError !== core.WasmOjError
  || organizer.parseProblemCollectionIndex !== core.parseProblemCollectionIndex
  || sdkContracts.WASM_OJ_CONTRACT_ID !== contracts.WASM_OJ_CONTRACT_ID
  || core.WasmOjError !== contracts.WasmOjError
  || core.LANGUAGES !== contracts.LANGUAGES
  || sdkBrowser.createBrowserEngine !== browser.createBrowserEngine
  || sdkServer.createServerEngine !== server.createServerEngine
  || sdkOrganizer.runCollectionCli !== organizer.runCollectionCli
) {
  throw new Error("Umbrella entrypoints created a second core/contracts identity.");
}
`);

  await run("pnpm", ["install", "--offline", "--ignore-scripts"], {
    cwd: consumerRoot,
    env: { ...process.env, NO_COLOR: "1" },
    maxBuffer: 32 * 1024 * 1024,
  });

  const typescript = await resolveTypeScriptCli();
  await run(process.execPath, [typescript, "--project", "tsconfig.json", "--pretty", "false"], {
    cwd: consumerRoot,
    env: { ...process.env, NO_COLOR: "1" },
    maxBuffer: 16 * 1024 * 1024,
  });
  await run(process.execPath, ["consumer-runtime.mjs"], {
    cwd: consumerRoot,
    env: { ...process.env, NO_COLOR: "1" },
    maxBuffer: 16 * 1024 * 1024,
  });

  process.stdout.write("Verified packed WASM-OJ packages in a clean NodeNext consumer.\n");
} finally {
  await rm(temporary, { recursive: true, force: true });
}

async function packInstalledRuntimeDependencies() {
  const publicNames = new Set(PUBLIC_PACKAGES.map((definition) => definition.name));
  const queue = PUBLIC_PACKAGES.flatMap((definition) => (definition.runtimeDependencies ?? [])
    .map((name) => ({ name, from: repositoryRoot })))
    .filter(({ name }) => !publicNames.has(name));
  const tarballs = new Map();
  while (queue.length > 0) {
    const { name, from } = queue.shift();
    if (tarballs.has(name)) continue;
    const packageRoot = await resolvePackageRoot(name, from);
    const manifest = JSON.parse(await readFile(path.join(packageRoot, "package.json"), "utf8"));
    if (manifest.name !== name) throw new Error(`Installed dependency '${name}' has package identity '${manifest.name}'.`);
    tarballs.set(name, await packPackage(packageRoot, name));
    for (const dependency of Object.keys(manifest.dependencies ?? {})) {
      if (!publicNames.has(dependency) && !tarballs.has(dependency)) queue.push({ name: dependency, from: packageRoot });
    }
  }
  return tarballs;
}

async function resolvePackageRoot(name, from) {
  let current = path.dirname(require.resolve(name, { paths: [from] }));
  while (current !== path.dirname(current)) {
    try {
      const manifest = JSON.parse(await readFile(path.join(current, "package.json"), "utf8"));
      if (manifest.name === name) return current;
    } catch {
      // Keep walking until the package boundary is found.
    }
    current = path.dirname(current);
  }
  throw new Error(`Unable to locate package root for '${name}'.`);
}

async function packPackage(packageRoot, packageName) {
  const output = path.join(temporary, `pack-${packageName.replaceAll("/", "-").replaceAll("@", "")}`);
  await mkdir(output);
  const { stdout } = await run("pnpm", [
    "--config.ignore-scripts=true",
    "pack",
    "--json",
    "--pack-destination",
    output,
  ], { cwd: packageRoot, maxBuffer: 16 * 1024 * 1024 });
  const result = JSON.parse(stdout);
  return path.resolve(result.filename);
}
