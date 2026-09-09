import { readFile, writeFile, copyFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

if (process.argv.length !== 3) throw new Error("Usage: node scripts/import-java-client-toolchain.mjs JAVA_CLIENT_BUILD_DIRECTORY");
const root = fileURLToPath(new URL("../", import.meta.url));
const source = path.resolve(process.argv[2]);
const evidence = [];
for (const profile of ["debug", "release"]) {
  const records = (await readFile(path.join(source, `gc-${profile}.log`), "utf8"))
    .split("\n").filter(line => line.startsWith("{")).map(line => JSON.parse(line));
  evidence.push(...records);
  if (records.length < 19 || records.some(record => record.pass !== true)) {
    throw new Error(`Java ${profile} regression matrix must pass before importing assets.`);
  }
}
const assets = [
  ["JAVA_COMPILER_SHA256", "java-teavm-0.13.1.compiler.wasm", "compiler/java-compiler.wasm"],
  ["JAVA_COMPILE_CLASSLIB_SHA256", "java-teavm-0.13.1.compile-classlib.bin", "classlibs/java-teavm-0.13.1.compile-classlib.bin"],
  ["JAVA_RUNTIME_CLASSLIB_SHA256", "java-teavm-0.13.1.runtime-classlib.bin", "classlibs/java-teavm-0.13.1.runtime-classlib.bin"],
];
let contract = await readFile(path.join(root, "src/core/toolchains.ts"), "utf8");
let cli = await readFile(path.join(root, "src/cli/toolchains.ts"), "utf8");
for (const [constant, name, relative] of assets) {
  const input = path.join(source, relative);
  const bytes = await readFile(input);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const identityKey = {
    JAVA_COMPILER_SHA256: "compiler",
    JAVA_COMPILE_CLASSLIB_SHA256: "sdk",
    JAVA_RUNTIME_CLASSLIB_SHA256: "runtime",
  }[constant];
  if (evidence.some(record => record.toolchain?.[identityKey] !== sha256)) {
    throw new Error(`Java regression evidence does not describe current ${name}.`);
  }
  const declaration = new RegExp(`(export const ${constant} = ")[^"]+`);
  if (!declaration.test(contract)) throw new Error(`Missing Java contract constant ${constant}`);
  contract = contract.replace(declaration, `$1${sha256}`);
  const filename = name.replaceAll(".", "\\.");
  const descriptor = new RegExp(`(path: "/toolchains/${filename}", bytes: )\\d+(, sha256: ")[^"]+`);
  if (!descriptor.test(cli)) throw new Error(`Missing CLI Java asset ${name}`);
  cli = cli.replace(descriptor, (_, prefix, middle) => `${prefix}${bytes.length}${middle}${sha256}`);
  await copyFile(input, path.join(root, "public/toolchains", name));
  console.log(JSON.stringify({ name, bytes: bytes.length, sha256 }));
}
for (const name of ["java-compiler-runtime.mjs", "java-compiler-bindings.mjs"]) {
  await copyFile(path.join(source, "compiler", name), path.join(root, "src/compiler/vendor", name));
}
await writeFile(path.join(root, "src/core/toolchains.ts"), contract);
await writeFile(path.join(root, "src/cli/toolchains.ts"), cli);
