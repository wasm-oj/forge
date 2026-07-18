import path from "node:path";
import { fileURLToPath } from "node:url";
import { readThirdPartyComponents } from "./third-party-components.mjs";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const { manifest } = await readThirdPartyComponents(root);

process.stdout.write(`Verified ${manifest.components.length} third-party components and their complete license closure.\n`);
