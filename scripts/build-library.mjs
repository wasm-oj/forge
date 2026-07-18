import { execFile } from "node:child_process";
import { mkdtemp, readFile, readdir, rename, rm } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { rollup } from "rollup";
import { dts } from "rollup-plugin-dts";
import { build } from "vite";

const run = promisify(execFile);
const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const outDir = path.join(root, "lib");
const stagingDir = await mkdtemp(path.join(root, ".forge-library-build-"));
const declarationDir = path.join(stagingDir, ".declarations");
const alias = { "@": root };

try {
  await buildJavaScript();
  await emitDeclarations();
  await verifyEmittedDeclarationInputs();
  await rollupDeclarations();
  await rm(declarationDir, { recursive: true, force: true });
  await verifyDeclarationBoundary();

  await rm(outDir, { recursive: true, force: true });
  await rename(stagingDir, outDir);
} catch (error) {
  await rm(stagingDir, { recursive: true, force: true });
  throw error;
}

process.stdout.write("Built Forge library with three rolled public declarations.\n");

async function buildJavaScript() {
  await build({
    configFile: false,
    publicDir: false,
    resolve: { alias },
    build: {
      outDir: stagingDir,
      emptyOutDir: false,
      target: "es2022",
      sourcemap: false,
      lib: {
        entry: path.join(root, "src/sdk/core.ts"),
        formats: ["es"],
        fileName: () => "core.js",
      },
    },
  });

  await build({
    configFile: false,
    base: "./",
    publicDir: false,
    resolve: { alias },
    worker: { format: "es" },
    build: {
      outDir: stagingDir,
      emptyOutDir: false,
      target: "es2022",
      sourcemap: false,
      // Vite library mode always inlines assets. That duplicates Wasmer's
      // multi-megabyte Wasm binary into every nested Worker and makes the
      // packed browser runtime materially different from the application.
      // A normal Rollup entry preserves the same ESM API while emitting the
      // Wasmer and runtime-core Wasm modules as shared, content-hashed files.
      assetsInlineLimit: 0,
      rollupOptions: {
        input: { browser: path.join(root, "src/sdk/browser.ts") },
        preserveEntrySignatures: "strict",
        output: {
          entryFileNames: "browser.js",
          chunkFileNames: "assets/[name]-[hash].mjs",
          assetFileNames: "assets/[name]-[hash][extname]",
        },
      },
    },
  });

  await build({
    configFile: false,
    publicDir: false,
    resolve: { alias },
    build: {
      outDir: stagingDir,
      emptyOutDir: false,
      target: "es2022",
      sourcemap: false,
      ssr: true,
      rollupOptions: {
        input: {
          server: path.join(root, "src/server/index.ts"),
          "server-build-stage": path.join(root, "src/server/server-build-stage.mjs"),
          "server-runner-stage": path.join(root, "src/server/server-runner-stage.mjs"),
          "python-stage": path.join(root, "src/server/python-stage.mjs"),
          "rustc-stage": path.join(root, "src/server/rustc-stage.mjs"),
          "go-stage": path.join(root, "src/server/go-stage.mjs"),
        },
        output: {
          entryFileNames: ({ name }) => name === "server" ? "server.js" : `${name}.mjs`,
          chunkFileNames: ({ name }) => name === "server-compiler"
            ? "chunks/server-compiler.js"
            : "chunks/[name]-[hash].js",
        },
      },
    },
  });
}

async function emitDeclarations() {
  const typescript = path.join(root, "node_modules/typescript/lib/tsc.js");
  try {
    await run(process.execPath, [
      typescript,
      "--project",
      path.join(root, "tsconfig.lib.json"),
      "--noEmit",
      "false",
      "--declaration",
      "--emitDeclarationOnly",
      "--outDir",
      declarationDir,
      "--pretty",
      "false",
    ], {
      cwd: root,
      env: { ...process.env, NO_COLOR: "1" },
      maxBuffer: 10 * 1024 * 1024,
    });
  } catch (error) {
    const stdout = typeof error?.stdout === "string" ? error.stdout.trim() : "";
    const stderr = typeof error?.stderr === "string" ? error.stderr.trim() : "";
    throw new Error(
      `Forge declaration emit failed.${stdout ? `\n${stdout}` : ""}${stderr ? `\n${stderr}` : ""}`,
      { cause: error },
    );
  }
}

async function rollupDeclarations() {
  const entries = [
    ["src/sdk/core.d.ts", "core.d.ts"],
    ["src/sdk/browser.d.ts", "browser.d.ts"],
    ["src/server/index.d.ts", "server.d.ts"],
  ];

  for (const [input, output] of entries) {
    const bundle = await rollup({
      input: path.join(declarationDir, input),
      plugins: [dts({ tsconfig: path.join(root, "tsconfig.lib.json") })],
      onwarn(warning) {
        throw new Error(`Declaration rollup warning (${warning.code}): ${warning.message}`);
      },
    });
    try {
      await bundle.write({
        file: path.join(stagingDir, output),
        format: "es",
      });
    } finally {
      await bundle.close();
    }
  }
}

async function verifyEmittedDeclarationInputs() {
  const declarations = await collectDeclarations(declarationDir);
  for (const relative of declarations) {
    const source = await readFile(path.join(declarationDir, relative), "utf8");
    if (source.includes("@/")) {
      throw new Error(
        `Declaration input '${relative}' contains a source alias; use a canonical relative import in library code.`,
      );
    }
  }
}

async function verifyDeclarationBoundary() {
  const declarations = await collectDeclarations(stagingDir);
  const expected = ["browser.d.ts", "core.d.ts", "server.d.ts"];
  if (JSON.stringify(declarations) !== JSON.stringify(expected)) {
    throw new Error(
      `Forge must emit exactly three public declarations. Expected ${expected.join(", ")}; `
      + `received ${declarations.join(", ") || "none"}.`,
    );
  }

  for (const relative of declarations) {
    const source = await readFile(path.join(stagingDir, relative), "utf8");
    if (source.includes("@/") || /\b(?:from|import)\s*\(?\s*["']\.\.?\//.test(source)) {
      throw new Error(`Rolled declaration '${relative}' leaks an internal module specifier.`);
    }
  }
}

async function collectDeclarations(directory, prefix = "") {
  const declarations = [];
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      declarations.push(...await collectDeclarations(path.join(directory, entry.name), relative));
    } else if (entry.isFile() && /\.d\.(?:c|m)?ts$/.test(entry.name)) {
      declarations.push(relative);
    }
  }
  return declarations;
}
