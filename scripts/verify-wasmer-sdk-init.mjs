import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const EXPECTED_VERSION = "0.10.0";
const EXPECTED_INTEGRITY = "sha512-YQ+s5tGag6P/I8kp9BTH+XhjoS9UFvWiZJvnWEEovClHffhYToKhprWr4UJG7wLP7c/2HQpGkF7ZrjoUvKjdmA==";
const EXPECTED_FILES = Object.freeze({
  "dist/index.mjs": "d5e0424d9de8173c0c7bc6a6b704aecde620d3f424050e0e6a079d863a44d58b",
  "dist/node.mjs": "6896c497347069f69432241648d5c64b4d265d689504a48e9804022139ac0dda",
  "dist/wasmer_js_bg.wasm": "49a6646209f5ab5e7c737eac33407d87d9a9959ac83e5ecaaab9261b2323589e",
  "package.json": "5c207c6ff1fc02bd633a13461a77d7f8fe47d14494cf2192763226f39cab373b",
});
const EXPECTED_SOURCE_REVISION = "93b8b738ebd3ee57e118da0f0eb795b97d5b999e";
const EXPECTED_CARGO_LOCK_SHA256 = "d352926f3f05e3d4308c4e261711d07db568e5c2b4387067180f920da074791f";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const forgePackage = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
const lock = JSON.parse(await readFile(path.join(root, "package-lock.json"), "utf8"));
const sdkPackagePath = fileURLToPath(import.meta.resolve("@wasmer/sdk/package.json"));
const sdkRoot = path.dirname(sdkPackagePath);
const sdkPackage = JSON.parse(await readFile(sdkPackagePath, "utf8"));
const licenseInventoryPath = path.join(root, "licenses/wasmer-sdk-dependencies.json");
const licenseReportPath = path.join(root, "licenses/wasmer-sdk-dependencies.html");
const [licenseInventoryBytes, licenseReportBytes] = await Promise.all([
  readFile(licenseInventoryPath),
  readFile(licenseReportPath),
]);
const licenseInventory = JSON.parse(licenseInventoryBytes.toString("utf8"));

if (forgePackage.dependencies?.["@wasmer/sdk"] !== EXPECTED_VERSION) {
  throw new Error(`Forge must pin @wasmer/sdk exactly to ${EXPECTED_VERSION}.`);
}
if (sdkPackage.name !== "@wasmer/sdk" || sdkPackage.version !== EXPECTED_VERSION) {
  throw new Error(
    `Expected the official @wasmer/sdk ${EXPECTED_VERSION} package, received `
    + `${String(sdkPackage.name)} ${String(sdkPackage.version)}.`,
  );
}

const lockedSdk = lock.packages?.["node_modules/@wasmer/sdk"];
if (
  lock.packages?.[""]?.dependencies?.["@wasmer/sdk"] !== EXPECTED_VERSION
  || lockedSdk?.version !== EXPECTED_VERSION
  || lockedSdk?.integrity !== EXPECTED_INTEGRITY
) {
  throw new Error(`package-lock.json does not bind the official @wasmer/sdk ${EXPECTED_VERSION} tarball.`);
}

for (const [relative, expected] of Object.entries(EXPECTED_FILES)) {
  const actual = createHash("sha256")
    .update(await readFile(path.join(sdkRoot, relative)))
    .digest("hex");
  if (actual !== expected) {
    throw new Error(
      `Installed @wasmer/sdk file '${relative}' differs from the official ${EXPECTED_VERSION} package: `
      + `expected ${expected}, received ${actual}.`,
    );
  }
}

if (
  licenseInventory.schema !== "wasm-oj-forge-v1/wasmer-sdk-licenses"
  || licenseInventory.generator?.name !== "cargo-about"
  || licenseInventory.generator?.version !== "0.9.1"
  || licenseInventory.graph?.package !== `@wasmer/sdk@${EXPECTED_VERSION}`
  || licenseInventory.graph?.sourceRevision !== EXPECTED_SOURCE_REVISION
  || licenseInventory.graph?.cargoLockSha256 !== EXPECTED_CARGO_LOCK_SHA256
  || licenseInventory.graph?.target !== "wasm32-unknown-unknown"
  || licenseInventory.graph?.defaultFeatures !== true
  || JSON.stringify(licenseInventory.graph?.features) !== "[]"
  || JSON.stringify(licenseInventory.graph?.dependencyKinds) !== '["normal"]'
) {
  throw new Error("The Wasmer SDK license inventory does not describe the pinned browser Wasm dependency graph.");
}
const reportSha256 = createHash("sha256").update(licenseReportBytes).digest("hex");
if (
  licenseInventory.report?.path !== "licenses/wasmer-sdk-dependencies.html"
  || licenseInventory.report?.sha256 !== reportSha256
) {
  throw new Error("The Wasmer SDK license inventory does not bind its distributed HTML report.");
}
const packageIdentities = new Set();
for (const item of licenseInventory.packages ?? []) {
  if (
    typeof item?.name !== "string"
    || typeof item.version !== "string"
    || (item.repository !== null && typeof item.repository !== "string")
    || !Array.isArray(item.selectedLicenses)
    || item.selectedLicenses.length === 0
    || item.selectedLicenses.some((license) => typeof license !== "string" || !license)
  ) {
    throw new Error("The Wasmer SDK license inventory contains an invalid package record.");
  }
  const identity = `${item.name}@${item.version}`;
  if (packageIdentities.has(identity)) throw new Error(`Duplicate Wasmer SDK license package '${identity}'.`);
  packageIdentities.add(identity);
  if (!licenseReportBytes.includes(Buffer.from(`${item.name} ${item.version}`))) {
    throw new Error(`The Wasmer SDK HTML license report omits '${identity}'.`);
  }
}
if (packageIdentities.size < 300 || licenseReportBytes.byteLength < 100_000) {
  throw new Error("The Wasmer SDK dependency license closure is unexpectedly incomplete.");
}

const { Runtime, init } = await import("@wasmer/sdk/node");
const browserSdk = await import("@wasmer/sdk");
if (typeof browserSdk.ThreadPoolWorker !== "function") {
  throw new Error("The official Wasmer SDK does not expose its required ThreadPoolWorker primitive.");
}
// SDK 0.10.0 internally invokes its wasm-bindgen loader through the deprecated
// positional form and therefore emits an upstream warning. Keep
// it visible: the verifier proves functionality without mutating or masking
// the official package.
await init({ log: "error" });
const runtime = new Runtime({ registry: null });
try {
  if (!(runtime instanceof Runtime) || runtime.__getClassname() !== "JsRuntime") {
    throw new Error("The official Wasmer SDK did not construct a Runtime instance.");
  }
} finally {
  runtime.free();
}

process.stdout.write(
  `Verified official @wasmer/sdk ${EXPECTED_VERSION} integrity and Runtime initialization.\n`,
);
