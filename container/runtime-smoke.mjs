import { rm } from "node:fs/promises";
import { createServerEngine } from "@wasm-oj/server";
import { serverSource as clangToolchain } from "@wasm-oj/toolchain-clang";
import { serverSource as goToolchain } from "@wasm-oj/toolchain-go";
import { serverSource as javascriptToolchain } from "@wasm-oj/toolchain-javascript";
import { serverSource as pythonToolchain } from "@wasm-oj/toolchain-python";
import { serverSource as rustToolchain } from "@wasm-oj/toolchain-rust";
import { loadEmbeddedContainerIdentity } from "./identity.mjs";

const CACHE_DIRECTORY = "/tmp/wasm-oj-image-runtime-smoke";
const EXPECTED_STDOUT = "42\n";

const toolchains = Object.freeze([
  clangToolchain(),
  rustToolchain(),
  pythonToolchain(),
  javascriptToolchain(),
  goToolchain(),
].map((source) => Object.freeze({
  ...source,
  directory: new URL("file:///app/public/toolchains/"),
})));

const identity = await loadEmbeddedContainerIdentity({ toolchains });
const engine = await createServerEngine({
  runtimeDirectory: "/app/runtime",
  toolchains,
  cacheDirectory: CACHE_DIRECTORY,
  artifactCache: false,
  verifiedDistribution: identity.verifiedDistribution,
});

try {
  const execution = await engine.execute({
    language: "python",
    target: "wasip1",
    optimization: "release",
    entry: "src/main.py",
    files: { "src/main.py": "print(6 * 7)\n" },
    name: "container-runtime-smoke",
    projectId: "container-runtime-smoke",
  }, {}, { cache: false });
  if (!execution.build.success || !execution.build.artifact) {
    throw new Error(`Container runtime smoke compilation failed: ${execution.build.stderr}`);
  }
  if (
    !execution.run
    || execution.run.code !== 0
    || execution.run.termination !== "exited"
    || execution.run.stdout !== EXPECTED_STDOUT
    || execution.run.stderr !== ""
  ) {
    throw new Error(`Container runtime smoke execution failed: ${JSON.stringify(execution.run)}`);
  }
} finally {
  engine.dispose();
  await rm(CACHE_DIRECTORY, { recursive: true, force: true });
}
