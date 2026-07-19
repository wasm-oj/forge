import { readFile } from "node:fs/promises";
import { githubReleaseAssetsMatch } from "./release-artifacts.mjs";

const [metadataFile, ...files] = process.argv.slice(2);
if (!metadataFile || files.length === 0) {
  throw new Error(
    "Usage: node scripts/verify-github-release-assets.mjs <release.json> <artifact> [...artifact]",
  );
}

let release;
try {
  release = JSON.parse(await readFile(metadataFile, "utf8"));
} catch (error) {
  throw new Error("GitHub Release metadata must be valid JSON.", { cause: error });
}

if (await githubReleaseAssetsMatch({ assets: release?.assets, files })) {
  process.stdout.write("Existing GitHub Release assets match the canonical registry artifacts.\n");
} else {
  process.stderr.write("GitHub Release assets are absent or differ from the canonical registry artifacts.\n");
  process.exitCode = 10;
}
