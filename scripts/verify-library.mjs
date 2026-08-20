import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import {
  CODE_PACKAGES,
  CODE_VERSION,
  PUBLIC_PACKAGE_BY_NAME,
  PUBLIC_PACKAGES,
  TOOLCHAIN_DESCRIPTOR_SCHEMA,
  TOOLCHAIN_PACKAGES,
  WASM_OJ_CONTRACT_VERSION,
  packagesRoot,
  repositoryRoot,
} from "./library-packages.mjs";
import { containsPrivateSourcePath } from "./library-private-path.mjs";

const run = promisify(execFile);
const selectedName = parseSelection(process.argv.slice(2));
const selected = selectedName ? [requiredPackage(selectedName)] : PUBLIC_PACKAGES;

await verifyWorkspaceGraph();
await verifyReleaseWorkflows();
for (const definition of selected) await verifyPackage(definition);

process.stdout.write(`Verified ${selected.length} packed WASM-OJ package${selected.length === 1 ? "" : "s"}.\n`);

function parseSelection(arguments_) {
  if (arguments_.length === 0) return undefined;
  if (arguments_.length !== 2 || arguments_[0] !== "--package" || !arguments_[1]) {
    throw new Error("Usage: node scripts/verify-library.mjs [--package @wasm-oj/<name>]");
  }
  return arguments_[1];
}

function requiredPackage(name) {
  const definition = PUBLIC_PACKAGE_BY_NAME.get(name);
  if (!definition) throw new Error(`Unknown public package '${name}'.`);
  return definition;
}

async function verifyWorkspaceGraph() {
  const rootManifest = await readJson(path.join(repositoryRoot, "package.json"));
  if (rootManifest.name !== "wasm-oj-platform" || rootManifest.version !== CODE_VERSION || rootManifest.private !== true) {
    throw new Error(`Root package must be private wasm-oj-platform@${CODE_VERSION}.`);
  }
  if (rootManifest.repository?.url !== "git+https://github.com/wasm-oj/forge.git"
    || rootManifest.homepage !== "https://github.com/wasm-oj/forge#readme"
    || rootManifest.bugs?.url !== "https://github.com/wasm-oj/forge/issues") {
    throw new Error("Root package must retain wasm-oj/forge repository metadata.");
  }
  for (const legacy of ["exports", "files", "bin", "publishConfig", "types"]) {
    if (Object.hasOwn(rootManifest, legacy)) throw new Error(`Root app manifest must not expose publish field '${legacy}'.`);
  }
  if (rootManifest.scripts?.["packages:bootstrap"] !== "node scripts/build-library.mjs"
    || rootManifest.scripts?.predev !== "pnpm run packages:bootstrap"
    || rootManifest.scripts?.prebuild !== "pnpm run packages:bootstrap"
    || rootManifest.scripts?.pretypecheck !== "pnpm run packages:bootstrap") {
    throw new Error("Root dev/build/typecheck commands must bootstrap workspace packages without recursion.");
  }
  if (Object.values(rootManifest.scripts ?? {}).some((command) => command.includes("FORGE_RUN_"))) {
    throw new Error("Root scripts contain a retired Forge integration environment variable.");
  }

  const manifests = new Map();
  for (const definition of PUBLIC_PACKAGES) {
    const manifest = await readJson(path.join(packagesRoot, definition.directory, "package.json"));
    manifests.set(definition.name, manifest);
    if (manifest.name !== definition.name || manifest.private === true) {
      throw new Error(`${definition.directory} must be publishable as ${definition.name}.`);
    }
    if (!isSafeSemver(manifest.version)) throw new Error(`${definition.name} must use a safe semantic version.`);
    if (manifest.repository?.url !== "git+https://github.com/wasm-oj/forge.git"
      || manifest.repository?.directory !== `packages/${definition.directory}`
      || manifest.homepage !== "https://github.com/wasm-oj/forge#readme"
      || manifest.bugs?.url !== "https://github.com/wasm-oj/forge/issues") {
      throw new Error(`${definition.name} must retain wasm-oj/forge repository metadata.`);
    }
    if (manifest.publishConfig?.access !== "public" || manifest.publishConfig?.registry !== "https://registry.npmjs.org/") {
      throw new Error(`${definition.name} must publish publicly to npmjs.org.`);
    }
    const expectedLicense = definition.kind === "toolchain" ? "SEE LICENSE IN THIRD_PARTY_NOTICES.md" : "MIT";
    if (manifest.license !== expectedLicense || manifest.type !== "module" || manifest.sideEffects !== false) {
      throw new Error(`${definition.name} must declare its exact package license, use ESM, and be side-effect free.`);
    }
    if (manifest.engines?.node !== ">=24.18.0 <25") {
      throw new Error(`${definition.name} must use the workspace's exact supported Node.js line.`);
    }
  }

  for (const definition of PUBLIC_PACKAGES) {
    const version = manifests.get(definition.name).version;
    const expected = `workspace:${version}`;
    if (rootManifest.dependencies?.[definition.name] !== expected) {
      throw new Error(`Root application dependency ${definition.name} must be exact ${expected}.`);
    }
  }

  for (const definition of CODE_PACKAGES) {
    const manifest = manifests.get(definition.name);
    if (manifest.version !== CODE_VERSION) throw new Error(`${definition.name} must use synchronized version ${CODE_VERSION}.`);
    setEqual(
      `${definition.name} dependencies`,
      new Set(definition.runtimeDependencies),
      new Set(Object.keys(manifest.dependencies ?? {})),
    );
    for (const [name, version] of Object.entries(manifest.dependencies ?? {})) {
      if (name.startsWith("@wasm-oj/") && !name.startsWith("@wasm-oj/toolchain-") && version !== `workspace:${CODE_VERSION}`) {
        throw new Error(`${definition.name} dependency ${name} must be exact workspace:${CODE_VERSION}.`);
      }
      if (!name.startsWith("@wasm-oj/") && version !== rootManifest.dependencies?.[name]) {
        throw new Error(`${definition.name} dependency ${name} must match the root's exact runtime pin.`);
      }
    }
  }
  const umbrella = manifests.get("@wasm-oj/sdk");
  if (Object.keys(umbrella.dependencies ?? {}).some((name) => name.startsWith("@wasm-oj/toolchain-"))) {
    throw new Error("@wasm-oj/sdk must not depend on toolchain packages.");
  }
  if (Object.keys(manifests.get("@wasm-oj/contracts").dependencies ?? {}).length !== 0) {
    throw new Error("@wasm-oj/contracts must have zero runtime dependencies.");
  }
  for (const definition of TOOLCHAIN_PACKAGES) {
    const manifest = manifests.get(definition.name);
    setEqual(
      `${definition.name} dependencies`,
      new Set(["@wasm-oj/contracts"]),
      new Set(Object.keys(manifest.dependencies ?? {})),
    );
    if (manifest.dependencies?.["@wasm-oj/contracts"] !== `workspace:${CODE_VERSION}`) {
      throw new Error(`${definition.name} must type its source through exact contracts ${CODE_VERSION}.`);
    }
  }
}

async function verifyReleaseWorkflows() {
  const codeRelease = await readFile(path.join(repositoryRoot, ".github/workflows/release.yml"), "utf8");
  const toolchainRelease = await readFile(path.join(repositoryRoot, ".github/workflows/release-toolchain.yml"), "utf8");
  for (const [label, source] of [["code", codeRelease], ["toolchain", toolchainRelease]]) {
    for (const required of [
      "id-token: write",
      "node-version: 24.18.0",
      "package-manager-cache: false",
      "npm publish",
    ]) {
      if (!source.includes(required)) throw new Error(`${label} release workflow is missing '${required}'.`);
    }
    if (source.includes("pnpm publish")) throw new Error(`${label} release workflow must publish through npm's OIDC-aware CLI.`);
  }
  const publishOrder = ["contracts", "core", "browser", "server", "organizer", "cli", "sdk"]
    .map((name) => codeRelease.indexOf(`npm publish release-tarballs/wasm-oj-${name}-`));
  if (publishOrder.some((position) => position < 0)
    || publishOrder.some((position, index) => index > 0 && position <= publishOrder[index - 1])) {
    throw new Error("Synchronized packages must publish in dependency-topological order.");
  }
  for (const required of [
    "workflow_dispatch:",
    "pnpm run toolchain:verify",
    "scripts/pack-library.mjs --package",
    'npm publish "release-tarballs/wasm-oj-${PACKAGE_NAME}-${RELEASE_VERSION}.tgz"',
  ]) {
    if (!toolchainRelease.includes(required)) throw new Error(`Toolchain release workflow is missing '${required}'.`);
  }
  for (const definition of TOOLCHAIN_PACKAGES) {
    if (!toolchainRelease.includes(`- ${definition.directory}`)) {
      throw new Error(`Toolchain release workflow omits ${definition.name}.`);
    }
  }
}

async function verifyPackage(definition) {
  const packageRoot = path.join(packagesRoot, definition.directory);
  const manifest = await readJson(path.join(packageRoot, "package.json"));
  const packed = await packAndExtract(packageRoot, definition.directory);
  try {
    const packedManifest = await readJson(path.join(packed.root, "package.json"));
    if (packedManifest.name !== definition.name || packedManifest.version !== manifest.version) {
      throw new Error(`${definition.name} packed a different identity.`);
    }
    if (JSON.stringify(packedManifest.dependencies ?? {}) !== JSON.stringify(publishedDependencies(manifest.dependencies ?? {}))) {
      throw new Error(`${definition.name} packed dependencies are not exact published workspace versions.`);
    }
    for (const required of ["package.json", "README.md", "LICENSE"]) requireFile(packed.files, definition.name, required);
    verifyPackagedLicenses(definition, packed.files);
    verifyExportTargets(definition.name, packedManifest.exports, packed.files);
    await verifyNoSourceLeaks(definition, packed.root, packed.files);
    if (definition.kind === "toolchain") await verifyToolchain(definition, packed.root, packed.files, packedManifest);
    else await verifyCode(definition, packed.root, packed.files, packedManifest);
  } finally {
    await packed.cleanup();
  }
}

function publishedDependencies(dependencies) {
  return Object.fromEntries(Object.entries(dependencies).map(([name, version]) => [
    name,
    typeof version === "string" && version.startsWith("workspace:") ? version.slice("workspace:".length) : version,
  ]));
}

function verifyExportTargets(packageName, exports, files) {
  if (!exports || typeof exports !== "object" || Array.isArray(exports)) {
    throw new Error(`${packageName} must declare explicit exports.`);
  }
  for (const [subpath, target] of Object.entries(exports)) {
    const targets = typeof target === "string" ? [target] : Object.values(target ?? {});
    for (const value of targets) {
      if (typeof value !== "string" || !value.startsWith("./") || value.includes("..")) {
        throw new Error(`${packageName} export '${subpath}' has unsafe target '${String(value)}'.`);
      }
      requireFile(files, packageName, value.slice(2));
    }
  }
}

async function verifyCode(definition, packedRoot, packedFiles, manifest) {
  requireFile(packedFiles, definition.name, "dist/index.js");
  requireFile(packedFiles, definition.name, "dist/index.d.ts");
  const entryJavaScript = await readFile(path.join(packedRoot, "dist/index.js"), "utf8");
  const requiredSharedPackages = definition.name === "@wasm-oj/core"
    ? ["@wasm-oj/contracts"]
    : definition.browser || definition.server
      ? ["@wasm-oj/contracts", "@wasm-oj/core"]
      : definition.organizer
        ? ["@wasm-oj/core"]
      : [];
  for (const dependency of requiredSharedPackages) {
    if (!hasTopLevelModuleImport(entryJavaScript, dependency)) {
      throw new Error(`${definition.name} top-level bundle must externalize ${dependency}.`);
    }
  }
  const toolchainAssets = [...packedFiles].filter((file) => file.startsWith("assets/") || file.includes("toolchains/"));
  if (toolchainAssets.length > 0) {
    throw new Error(`${definition.name} code package contains toolchain assets: ${toolchainAssets.join(", ")}.`);
  }
  if (!definition.cli && Object.hasOwn(manifest, "bin")) {
    throw new Error(`${definition.name} must not expose a CLI.`);
  }
  if (definition.cli) {
    if (JSON.stringify(manifest.bin) !== JSON.stringify({ woj: "./bin/woj.js" })) {
      throw new Error("@wasm-oj/cli must expose only the 'woj' executable.");
    }
    requireFile(packedFiles, definition.name, "bin/woj.js");
    const executable = await readFile(path.join(packedRoot, "bin/woj.js"), "utf8");
    if (!executable.startsWith("#!/usr/bin/env node\n")
      || !executable.includes('import { main } from "../dist/index.js";')
      || !executable.includes("process.exitCode = await main(process.argv.slice(2));")) {
      throw new Error("@wasm-oj/cli packed an invalid executable entry point.");
    }
  }
  if (definition.server) {
    for (const required of [
      "dist/server-build-stage.mjs",
      "dist/server-runner-stage.mjs",
      "dist/python-stage.mjs",
      "dist/rustc-stage.mjs",
      "dist/go-stage.mjs",
    ]) requireFile(packedFiles, definition.name, required);
    for (const required of [
      "crates/runtime-core/Cargo.lock",
      "crates/runtime-core/Cargo.toml",
      "crates/runtime-core/src/bin/wasm-oj-compiler.rs",
      "crates/runtime-core/src/bin/wasm-oj-runner.rs",
      "rust-toolchain.toml",
      "testdata/wojjdg02-v2-text.hex",
      "vendor/shared-buffer/Cargo.toml",
      "vendor/virtual-fs/Cargo.toml",
    ]) requireFile(packedFiles, definition.name, required);
  }
  if (definition.sdk) {
    const expected = new Set([".", "./contracts", "./browser", "./server", "./organizer", "./package.json"]);
    setEqual("@wasm-oj/sdk exports", expected, new Set(Object.keys(manifest.exports ?? {})));
    for (const file of ["contracts", "browser", "server", "organizer"]) {
      const source = await readFile(path.join(packedRoot, `dist/${file}.js`), "utf8");
      if (!source.includes(`@wasm-oj/${file}`)) throw new Error(`SDK ${file} facade does not re-export its direct package.`);
    }
  }
  const declarations = [...packedFiles].filter((file) => /\.d\.(?:c|m)?ts$/u.test(file));
  for (const file of declarations) {
    const source = await readFile(path.join(packedRoot, file), "utf8");
    if (source.includes("@/") || /(?:^|["'])\.\.?\/.*(?:src|packages)\//mu.test(source)) {
      throw new Error(`${definition.name} declaration '${file}' leaks a workspace/source path.`);
    }
  }
}

async function verifyToolchain(definition, packedRoot, packedFiles, manifest) {
  const expectedAssets = new Set(definition.assets.map((file) => `assets/${file}`));
  const actualAssets = new Set([...packedFiles].filter((file) => file.startsWith("assets/")));
  setEqual(`${definition.name} assets`, expectedAssets, actualAssets);
  const expectedAssetExports = new Set(definition.assets.map((file) => `./assets/${file}`));
  const actualAssetExports = new Set(Object.keys(manifest.exports ?? {}).filter((subpath) => subpath.startsWith("./assets/")));
  setEqual(`${definition.name} asset exports`, expectedAssetExports, actualAssetExports);

  const moduleUrl = pathToFileURL(path.join(packedRoot, "dist/index.js"));
  moduleUrl.searchParams.set("verify", String(Date.now()));
  const importedModule = await import(moduleUrl.href);
  const { descriptor } = importedModule;
  if (descriptor?.schema !== TOOLCHAIN_DESCRIPTOR_SCHEMA
    || descriptor?.id !== definition.id
    || descriptor?.version !== definition.toolchainVersion
    || descriptor?.wasmOjContract !== WASM_OJ_CONTRACT_VERSION) {
    throw new Error(`${definition.name} has an invalid descriptor identity.`);
  }
  if (!Object.isFrozen(descriptor)
    || !Object.isFrozen(descriptor.assets)
    || !Object.isFrozen(descriptor.languages)
    || !Object.isFrozen(descriptor.profiles)
    || descriptor.assets.some((asset) => !Object.isFrozen(asset))
    || descriptor.profiles.some((profile) => !Object.isFrozen(profile))) {
    throw new Error(`${definition.name} descriptor must be deeply immutable.`);
  }
  if (JSON.stringify(descriptor.languages) !== JSON.stringify(definition.languages)
    || JSON.stringify(descriptor.profiles) !== JSON.stringify(definition.profiles)) {
    throw new Error(`${definition.name} descriptor languages/profiles differ from the package contract.`);
  }
  if (descriptor.assets.length !== definition.assets.length
    || new Set(descriptor.assets.map((asset) => asset.path)).size !== descriptor.assets.length) {
    throw new Error(`${definition.name} descriptor assets must be complete and unique.`);
  }
  for (const asset of descriptor.assets) {
    const filename = path.posix.basename(asset.path);
    if (asset.path !== `/toolchains/${filename}` || asset.exportPath !== `./assets/${filename}`) {
      throw new Error(`${definition.name} descriptor has a non-canonical asset path.`);
    }
    const bytes = await readFile(path.join(packedRoot, "assets", filename));
    if (asset.bytes !== bytes.byteLength || asset.sha256 !== createHash("sha256").update(bytes).digest("hex")) {
      throw new Error(`${definition.name} descriptor does not bind '${filename}' exactly.`);
    }
  }
  assertThrows(() => importedModule.browserSource(undefined), "browser source must require baseUrl");
  assertThrows(() => importedModule.browserSource("relative/assets"), "browser source must reject relative URL");
  assertThrows(() => importedModule.browserSource("//cdn.example/assets"), "browser source must reject protocol-relative URL");
  assertThrows(() => importedModule.browserSource("file:///tmp/assets"), "browser source must reject non-HTTP URL");
  assertThrows(() => importedModule.browserSource("https://user:pass@cdn.example/assets"), "browser source must reject credentials");
  const rootRelative = importedModule.browserSource("/assets/wasm-oj");
  if (!Object.isFrozen(rootRelative)
    || rootRelative.kind !== "browser"
    || rootRelative.baseUrl !== "/assets/wasm-oj/"
    || rootRelative.descriptor !== descriptor) {
    throw new Error(`${definition.name} returned an invalid root-relative browser source.`);
  }
  const absolute = importedModule.browserSource("https://cdn.example/sdk?release=1");
  if (absolute.baseUrl !== "https://cdn.example/sdk/?release=1") {
    throw new Error(`${definition.name} did not normalize its absolute browser source.`);
  }
  const server = importedModule.serverSource();
  if (!Object.isFrozen(server) || server.kind !== "server" || !(server.directory instanceof URL)
    || server.directory.protocol !== "file:" || server.descriptor !== descriptor) {
    throw new Error(`${definition.name} returned an invalid explicit server source.`);
  }
}

async function verifyNoSourceLeaks(definition, packedRoot, files) {
  const textExtensions = /\.(?:js|mjs|cjs|ts|mts|cts|json|md)$/u;
  const forbiddenTokens = ["wasm-oj-forge-v1", "FORGEFS1", "forgeContract", "__FORGE_"];
  for (const file of files) {
    const bytes = await readFile(path.join(packedRoot, file));
    for (const forbidden of forbiddenTokens) {
      if (bytes.includes(forbidden)) throw new Error(`${definition.name} packed '${file}' with retired token '${forbidden}'.`);
    }
    if (textExtensions.test(file)) {
      const source = bytes.toString("utf8");
      if (containsPrivateSourcePath(source, repositoryRoot) || source.includes("@/")) {
        throw new Error(`${definition.name} packed '${file}' with a private source path.`);
      }
    }
  }
}

function hasTopLevelModuleImport(source, packageName) {
  const escaped = packageName.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return new RegExp(`(?:from\\s*|import\\s*\\()(["'])${escaped}(?:/[^"']+)?\\1`, "u").test(source);
}

function isSafeSemver(value) {
  return typeof value === "string"
    && /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u.test(value);
}

function verifyPackagedLicenses(definition, files) {
  const expected = new Set(definition.licenses.map((file) => `licenses/${file}`));
  const actual = new Set([...files].filter((file) => file.startsWith("licenses/")));
  setEqual(`${definition.name} license files`, expected, actual);
  if (definition.licenses.length > 0) requireFile(files, definition.name, "THIRD_PARTY_NOTICES.md");
  else if (files.has("THIRD_PARTY_NOTICES.md")) {
    throw new Error(`${definition.name} packed an undeclared third-party notice.`);
  }
}

async function packAndExtract(packageRoot, prefix) {
  const temporary = await mkdtemp(path.join(os.tmpdir(), `wasm-oj-${prefix}-`));
  const extractRoot = path.join(temporary, "package");
  try {
    await run("pnpm", ["--config.ignore-scripts=true", "pack", "--pack-destination", temporary], {
      cwd: packageRoot,
      maxBuffer: 16 * 1024 * 1024,
    });
    const tarballs = (await readdir(temporary)).filter((file) => file.endsWith(".tgz"));
    if (tarballs.length !== 1) throw new Error(`Expected one tarball for ${packageRoot}.`);
    const actualTarball = path.join(temporary, tarballs[0]);
    await access(actualTarball);
    await mkdir(extractRoot);
    await run("tar", ["-xzf", actualTarball, "-C", extractRoot, "--strip-components=1"]);
    return {
      root: extractRoot,
      files: new Set(await filesBelow(extractRoot)),
      cleanup: () => rm(temporary, { recursive: true, force: true }),
    };
  } catch (error) {
    await rm(temporary, { recursive: true, force: true });
    throw error;
  }
}

async function filesBelow(directory, prefix = "") {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...await filesBelow(path.join(directory, entry.name), relative));
    else if (entry.isFile()) files.push(relative);
    else throw new Error(`Packed package contains unsupported entry '${relative}'.`);
  }
  return files.sort();
}

function requireFile(files, packageName, file) {
  if (!files.has(file)) throw new Error(`${packageName} packed tarball is missing '${file}'.`);
}

function setEqual(label, expected, actual) {
  const missing = [...expected].filter((value) => !actual.has(value));
  const unexpected = [...actual].filter((value) => !expected.has(value));
  if (missing.length || unexpected.length) {
    throw new Error(`${label} differs.${missing.length ? ` Missing: ${missing.join(", ")}.` : ""}${unexpected.length ? ` Unexpected: ${unexpected.join(", ")}.` : ""}`);
  }
}

function assertThrows(operation, label) {
  try {
    operation();
  } catch {
    return;
  }
  throw new Error(`Expected ${label}.`);
}

async function readJson(file) {
  return JSON.parse(await readFile(file, "utf8"));
}
