import { execFileSync } from "node:child_process";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { quickJsBundle } from "./artifact";
import { DEFAULT_DETERMINISM } from "../core/determinism";
import { DEFAULT_RESOURCE_POLICY } from "../core/resources";
import type { RuntimeBundleArtifact } from "../core/types";

const cases = [
  { name: "readline handles CRLF crossing stream chunks and long lines", input: "a".repeat(16383) + "\r\n" + "終".repeat(65536), body: 'const rl=readline.createInterface({input:process.stdin,crlfDelay:Infinity}); rl.on("line",s=>process.stdout.write(String(Buffer.byteLength(s))+","));' },
  { name: "mature Buffer numeric and slicing APIs", input: "", body: 'const b=Buffer.alloc(8); b.writeUInt32BE(0x10203040,0); b.writeUInt32LE(0x10203040,4); process.stdout.write(b.slice(0,8).toString("hex"));' },
  { name: "default fs imports and UTF-8 stdin without a final newline", input: "20 22", body: 'process.stdout.write(String(fs.readFileSync(0,"utf8").split(/\\s+/).map(Number).reduce((a,b)=>a+b,0)));' },
  { name: "Buffer binary, NUL, and text encodings", input: "a\0終😀", body: 'const b=fs.readFileSync("/dev/stdin"); process.stdout.write(Buffer.from(b.toString("base64"),"base64")); process.stderr.write(b.toString("hex"));' },
  { name: "partial reads share a byte cursor", input: "éABC", body: 'const b=Buffer.alloc(3); const n=fs.readSync(0,b,1,2,null); process.stdout.write(JSON.stringify([n,b.toString("hex"),fs.readFileSync(0,"utf8"),fs.readFileSync(0).length]));' },
  { name: "sync byte output ranges", input: "", body: 'const b=Buffer.from([255,0,65,66]); fs.writeSync(1,b,1,2); fs.writeFileSync(2,"終\\0😀","utf8");' },
  { name: "readable stdin data/end events", input: "alpha\r\n終", body: 'let s=""; process.stdin.setEncoding("utf8"); process.stdin.on("data",c=>s+=c); process.stdin.on("end",()=>process.stdout.write(s));' },
  { name: "stream pipe", input: "a\0😀", body: 'process.stdin.pipe(process.stdout);' },
  { name: "readline CR/LF/CRLF and final line", input: "a\r\nb\rc\n\n終", body: 'const rl=readline.createInterface({input:process.stdin,crlfDelay:Infinity}); rl.on("line",s=>process.stdout.write(JSON.stringify(s)+"\\n")); rl.on("close",()=>process.stdout.write("closed"));' },
  { name: "readline async iteration", input: "a\n終", body: '(async()=>{ for await(const line of readline.createInterface({input:process.stdin})) process.stdout.write(line+"!"); })();' },
  { name: "empty readline produces no phantom line", input: "", body: 'const rl=readline.createInterface({input:process.stdin}); rl.on("line",s=>process.stdout.write("unexpected")); rl.on("close",()=>process.stdout.write("closed"));' },
];
function guest(body: string, input: string) {
  const output: Record<string, Buffer[]> = { stdout: [], stderr: [] };
  const capture = (name: string) => (data: string | ArrayBuffer) => output[name].push(typeof data === "string" ? Buffer.from(data) : Buffer.from(new Uint8Array(data)));
  const artifact = { entry: "main.js", files: { "main.js": 'const fs=require("node:fs").default; const readline=require("readline");' + body } } as unknown as RuntimeBundleArtifact;
  runInNewContext('globalThis.__wasm_oj_eval_module = (id) => __load(id);\n' + quickJsBundle(artifact, input, { args: [], env: {}, stdin: input, determinism: DEFAULT_DETERMINISM, resources: DEFAULT_RESOURCE_POLICY }), {
    __wasm_oj_determinism_seed: () => 0,
    __wasm_oj_determinism_epoch_ms: () => 0,
    __wasm_oj_determinism_step_ns: () => 1,
    __wasm_oj_write_stdout: capture("stdout"),
    __wasm_oj_write_stderr: capture("stderr"),
  }, { microtaskMode: "afterEvaluate" });
  return { stdout: Buffer.concat(output.stdout), stderr: Buffer.concat(output.stderr) };
}
describe("QuickJS Node standard I/O against native Node ESM", () => {
  it.each(cases)("$name", ({ body, input }) => {
    const source = 'import fs from "node:fs"; import readline from "node:readline";' + body;
    const stdout = execFileSync(process.execPath, ["--input-type=module", "-e", source], { input, stdio: ["pipe", "pipe", "ignore"] });
    expect(guest(body, input).stdout).toEqual(stdout);
  });
  it("preserves byte exact stderr", () => {
    expect(guest('process.stderr.write(Buffer.from([0,255,65]));', "").stderr).toEqual(Buffer.from([0,255,65]));
  });
  it("shares stdin with the existing std module", () => {
    expect(guest('fs.readSync(0,Buffer.alloc(1)); process.stdout.write(require("std").in.readAsString());', "ABC").stdout.toString()).toBe("BC");
  });
  it("fails unsupported filesystem operations explicitly", () => {
    expect(() => guest('fs.readFileSync("/etc/passwd");', "")).toThrow("Only standard input/output");
  });
});
