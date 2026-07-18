import { publishCargoLicenseInventory } from "./cargo-license-inventory.mjs";

const [rawPath, stagedReportPath, reportPath, inventoryPath] = process.argv.slice(2);
if (!rawPath || !stagedReportPath || !reportPath || !inventoryPath || process.argv.length !== 6) {
  throw new Error(
    "Usage: node scripts/compact-runtime-license-report.mjs "
    + "<cargo-about.json> <staged-report.html> <report.html> <inventory.json>",
  );
}

await publishCargoLicenseInventory({
  rawPath,
  stagedReportPath,
  reportPath,
  inventoryPath,
  schema: "wasm-oj-forge-v1/runtime-core-licenses",
  graph: {
    manifest: "crates/runtime-core/Cargo.toml",
    lockfile: "crates/runtime-core/Cargo.lock",
    target: "wasm32-unknown-unknown",
    defaultFeatures: false,
    features: ["web"],
    dependencyKinds: ["normal"],
  },
  reportRelativePath: "licenses/runtime-core-dependencies.html",
});
