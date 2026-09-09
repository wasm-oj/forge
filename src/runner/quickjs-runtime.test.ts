import { closeSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WASI } from "node:wasi";
import { gunzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { quickJsBundle } from "./artifact";
import { DEFAULT_DETERMINISM } from "../core/determinism";
import { DEFAULT_RESOURCE_POLICY } from "../core/resources";
import type { RuntimeBundleArtifact } from "../core/types";

const wasm = new WebAssembly.Module(gunzipSync(readFileSync(new URL("../../public/toolchains/quickjs-0.15.1.wasm.gz.bin", import.meta.url))));
function run(files: Record<string, string>, input = "") {
  const directory = mkdtempSync(join(tmpdir(), "quickjs-modules-"));
  const descriptors: number[] = [];
  try {
    const artifact = { entry: "main.js", files } as unknown as RuntimeBundleArtifact;
    writeFileSync(join(directory, "stdin"), quickJsBundle(artifact, input, { stdin: input, args: [], env: {}, determinism: DEFAULT_DETERMINISM, resources: DEFAULT_RESOURCE_POLICY }));
    for (const name of ["stdin", "stdout", "stderr"]) descriptors.push(openSync(join(directory, name), name === "stdin" ? "r" : "w"));
    const wasi = new WASI({ version: "preview1", args: ["qjs"], env: {}, stdin: descriptors[0], stdout: descriptors[1], stderr: descriptors[2], returnOnExit: true });
    const instance = new WebAssembly.Instance(wasm, wasi.getImportObject() as WebAssembly.Imports);
    const code = wasi.start(instance);
    return { code, stdout: readFileSync(join(directory, "stdout"), "utf8"), stderr: readFileSync(join(directory, "stderr"), "utf8") };
  } finally {
    for (const descriptor of descriptors) closeSync(descriptor);
    rmSync(directory, { recursive: true, force: true });
  }
}
describe("pinned QuickJS native ECMAScript module execution", () => {
  it("supports top-level await, dynamic imports, and shared module identity", () => {
    const result = run({
      "main.js": 'import {value} from "./value.js"; const imported=await import("./value.js"); console.log(value+imported.value);',
      "value.js": 'export const value = await Promise.resolve(21);',
    });
    expect(result).toEqual({ code: 0, stdout: "42\n", stderr: "" });
  });
  it("preserves live bindings through module cycles", () => {
    const result = run({
      "main.js": 'import {value,increment} from "./value.js"; import {read} from "./cycle.js"; increment(); console.log(value,read());',
      "value.js": 'import {read} from "./cycle.js"; export let value=1; export function increment(){value++};',
      "cycle.js": 'import {value} from "./value.js"; export function read(){return value};',
    });
    expect(result).toEqual({ code: 0, stdout: "2 2\n", stderr: "" });
  });
  it("supports top-level readline async iteration and NUL output", () => {
    const result = run({ "main.js": 'import {createInterface} from "node:readline"; for await(const line of createInterface({input:process.stdin})) process.stdout.write(line+"\\0");' }, "a\n終");
    expect(result).toEqual({ code: 0, stdout: "a\0終\0", stderr: "" });
  });
  it("fails rejected and unsettled top-level await", () => {
    expect(run({ "main.js": 'await Promise.reject(new Error("failed"));' })).toMatchObject({ code: 1, stderr: expect.stringContaining("failed") });
    expect(run({ "main.js": 'await new Promise(()=>{});' })).toMatchObject({ code: 13, stderr: expect.stringContaining("Unsettled top-level await") });
  });
  it("fails unavailable named exports before executing the user module", () => {
    const result = run({ "main.js": 'import {unlinkSync} from "node:fs"; console.log("must not run");' });
    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("unlinkSync");
  });
  it("imports existing CommonJS dependency packages with explicit ESM exports", () => {
    const result = run({
      "main.js": 'import math, {answer} from "math-package"; console.log(math.answer+answer);',
      "node_modules/math-package/package.json": '{"name":"math-package","main":"index.cjs"}',
      "node_modules/math-package/index.cjs": 'module.exports={answer:21};',
    });
    expect(result).toEqual({ code: 0, stdout: "42\n", stderr: "" });
  });
});
