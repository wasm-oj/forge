import { publishCargoLicenseInventory } from "./cargo-license-inventory.mjs";

const [rawPath, stagedReportPath, reportPath, inventoryPath] = process.argv.slice(2);
if (!rawPath || !stagedReportPath || !reportPath || !inventoryPath || process.argv.length !== 6) {
  throw new Error(
    "Usage: node scripts/compact-wasmer-sdk-license-report.mjs "
    + "<cargo-about.json> <staged-report.html> <report.html> <inventory.json>",
  );
}

await publishCargoLicenseInventory({
  rawPath,
  stagedReportPath,
  reportPath,
  inventoryPath,
  schema: "wasm-oj-forge-v1/wasmer-sdk-licenses",
  graph: {
    package: "@wasmer/sdk@0.10.0",
    sourceRevision: "93b8b738ebd3ee57e118da0f0eb795b97d5b999e",
    cargoLockSha256: "d352926f3f05e3d4308c4e261711d07db568e5c2b4387067180f920da074791f",
    target: "wasm32-unknown-unknown",
    defaultFeatures: true,
    features: [],
    dependencyKinds: ["normal"],
  },
  reportRelativePath: "licenses/wasmer-sdk-dependencies.html",
});
