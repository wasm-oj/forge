import { readFile } from "node:fs/promises";
import path from "node:path";
import { downloadRegistryArtifact, parseRegistryMetadata } from "./release-artifacts.mjs";

const [metadataArgument, destinationArgument] = process.argv.slice(2);
if (!metadataArgument || !destinationArgument || process.argv.length !== 4) {
  throw new Error("Usage: node scripts/download-registry-artifact.mjs <dist.json> <destination.tgz>");
}
const metadata = parseRegistryMetadata(await readFile(path.resolve(metadataArgument), "utf8"));
const destination = path.resolve(destinationArgument);
await downloadRegistryArtifact({ destination, metadata });
process.stdout.write(`Downloaded and verified ${path.basename(destination)} from ${metadata.tarball.origin}.\n`);
