import path from "node:path";
import { fileURLToPath } from "node:url";

export const SERVER_STAGE_SCRIPTS = Object.freeze([
  "server-build-stage.mjs",
  "server-runner-stage.mjs",
  "python-stage.mjs",
  "rustc-stage.mjs",
  "go-stage.mjs",
  "java-stage.mjs",
] as const);

export type ServerStageScript = typeof SERVER_STAGE_SCRIPTS[number];

const SERVER_STAGE_SCRIPT_SET = new Set<string>(SERVER_STAGE_SCRIPTS);

/** Resolve the one package-owned directory that contains every isolated server stage. */
export function resolveServerStageDirectory(moduleUrl: string = import.meta.url): string {
  const modulePath = fileURLToPath(moduleUrl);
  const moduleDirectory = path.dirname(modulePath);
  const moduleFilename = path.basename(modulePath);
  if (
    moduleFilename === "stage-scripts.ts"
    && path.basename(moduleDirectory) === "server"
    && path.basename(path.dirname(moduleDirectory)) === "src"
  ) {
    return moduleDirectory;
  }
  if (
    (moduleFilename === "index.js" || moduleFilename === "server-build-stage.mjs")
    && path.basename(moduleDirectory) === "dist"
  ) {
    return moduleDirectory;
  }
  throw new Error(`Unsupported @wasm-oj/server module layout '${modulePath}'.`);
}

/** Resolve only a declared stage below an already-established package stage root. */
export function serverStageScript(stageDirectory: string, scriptName: ServerStageScript): string {
  if (!path.isAbsolute(stageDirectory)) {
    throw new Error("The @wasm-oj/server stage directory must be absolute.");
  }
  if (!SERVER_STAGE_SCRIPT_SET.has(scriptName)) {
    throw new Error(`Unknown isolated server stage '${scriptName}'.`);
  }
  return path.join(stageDirectory, scriptName);
}
