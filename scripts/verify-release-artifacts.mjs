import path from "node:path";
import { verifyReleaseArtifacts } from "./release-artifacts.mjs";

const [candidateArgument, canonicalArgument] = process.argv.slice(2);
if (!candidateArgument || !canonicalArgument || process.argv.length !== 4) {
  throw new Error("Usage: pnpm run release:artifacts:verify <candidate.tgz> <registry.tgz>");
}
const result = await verifyReleaseArtifacts({
  candidate: path.resolve(candidateArgument),
  canonical: path.resolve(canonicalArgument),
});
process.stdout.write(
  `Verified canonical registry artifact (sha256 ${result.canonicalSha256}); `
  + `the ${result.payloadBytes}-byte tar payload exactly matches the release candidate.\n`,
);
