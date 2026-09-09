import { createServer } from "node:http";
import { createReadStream } from "node:fs";
import { mkdir, readFile, writeFile, stat } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, firefox, webkit } from "playwright";

const root = fileURLToPath(new URL("../", import.meta.url));
const output = path.resolve(root, process.env.CSP_OUTPUT_DIRECTORY ?? "output/playwright/csp-reliability");
await mkdir(output, { recursive: true });
const sources = [];
for (const name of ["clang", "go", "java", "javascript", "python", "rust"]) {
  const { browserSource } = await import(`../packages/toolchain-${name}/dist/index.js`);
  sources.push(browserSource("/toolchains/"));
}
const policy = "default-src 'self'; script-src 'self' 'nonce-csp-test' 'wasm-unsafe-eval'; worker-src 'self' blob:; connect-src 'self'; style-src 'self'";
const importMap = { imports: {
  "@wasm-oj/browser": "/packages/browser/dist/index.js",
  "@wasm-oj/core": "/packages/core/dist/index.js",
  "@wasm-oj/contracts": "/packages/contracts/dist/index.js",
  "es-module-lexer": "/node_modules/es-module-lexer/dist/lexer.js",
  "fflate": "/node_modules/fflate/esm/browser.js",
} };
const html = `<html><head><script type="importmap" nonce="csp-test">${JSON.stringify(importMap)}</script><script type="module" src="/bootstrap.js"></script></head><body>Strict CSP runtime verification</body></html>`;
const bootstrap = `import { createBrowserEngine, WASM_OJ_LIBCXX_PCH_HEADER } from '@wasm-oj/browser';
window.cspViolations = []; addEventListener('securitypolicyviolation', e => window.cspViolations.push({directive:e.effectiveDirective, blockedURI:e.blockedURI, source:e.sourceFile}));
try { new Function('return 1')(); window.evalBlocked = false; } catch { window.evalBlocked = true; }
window.header = WASM_OJ_LIBCXX_PCH_HEADER;
window.engine = await createBrowserEngine({ artifactCache:false, toolchains: ${JSON.stringify(sources)} });
window.ready = true;`;
const server = createServer(async (req, res) => {
  res.setHeader("Content-Security-Policy", policy);
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  res.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
  res.setHeader("Cache-Control", "no-store");
  const pathname = decodeURIComponent(new URL(req.url, "http://localhost").pathname);
  if (pathname === "/" || pathname === "/bootstrap.js") {
    res.setHeader("Content-Type", pathname === "/" ? "text/html" : "text/javascript");
    res.end(pathname === "/" ? html : bootstrap); return;
  }
  const relative = pathname.startsWith("/toolchains/") ? `public${pathname}` : pathname.slice(1);
  const local = path.resolve(root, relative);
  if (!local.startsWith(root)) { res.writeHead(403).end(); return; }
  try {
    const info = await stat(local);
    res.setHeader("Content-Type", /\.(?:js|mjs)$/.test(local) ? "text/javascript" : local.endsWith(".wasm") ? "application/wasm" : local.endsWith(".json") ? "application/json" : "application/octet-stream");
    res.setHeader("Content-Length", info.size);
    createReadStream(local).pipe(res);
  } catch { res.writeHead(404).end(); }
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const extraCppHeaders = "any atomic bit cfenv codecvt cuchar format cinttypes clocale complex cstdarg ctime cwchar cwctype filesystem forward_list fstream initializer_list istream list locale memory_resource new numbers ostream ratio regex scoped_allocator source_location stdexcept streambuf system_error typeindex typeinfo valarray version".split(" ").sort();
const fixtures = [
  { language:"javascript", label:"js-syntax-runtime", source:'const = ;', input:"", runtimeError:"SyntaxError" },
  { language:"javascript", label:"js-dynamic-types", source:'let x=1;x="42";console.log(x);', input:"", expected:"42\n" },
  { language:"typescript", label:"ts-require", source:'const fs=require("node:fs");console.log(Number(fs.readFileSync(0,"utf8"))+1);', input:"41", expected:"42\n" },
  { language:"typescript", label:"ts-top-level-await-ce", compileError:true, source:'import {createInterface} from "node:readline"; const lines=createInterface({input:process.stdin}); for await (const line of lines) {console.log(Number(line)+1)}', input:"41", expected:"42\n" },
  { language:"javascript", label:"esm-await", source:'const fs=await import("node:fs"); const n=Number(fs.readFileSync(0,"utf8")); console.log(await Promise.resolve(n+1));', input:"41", expected:"42\n" },
  { language:"javascript", label:"esm-rejection", source:'await Promise.reject(new Error("top-level-failure"));', input:"", runtimeError:"top-level-failure" },
  { language:"javascript", label:"esm-pending", source:'await new Promise(()=>{});', input:"", runtimeError:"Unsettled top-level await" },
  { language:"javascript", label:"node-stdio", source:'import fs from "fs"; const b=fs.readFileSync(0); process.stdout.write(b); process.stdout.write(Buffer.from("QQBC","base64"));', input:"終\0😀", expected:"終\0😀A\0B" },
  { language:"typescript", label:"node-stdio", source:'import fs from "node:fs"; const b=Buffer.alloc(3); fs.readSync(0,b,1,2,null); process.stdout.write(JSON.stringify([b.toString("hex"),fs.readFileSync(0,"utf8")]));', input:"éABC", expected:'["00c3a9","ABC"]' },
  { language:"javascript", label:"node-readline", source:'import readline from "node:readline"; const rl=readline.createInterface({input:process.stdin,crlfDelay:Infinity}); rl.on("line",line=>process.stdout.write(JSON.stringify(line))); rl.on("close",()=>process.stdout.write("closed"));', input:"a\r\nb\rc\n\n終", expected:'"a""b""c""""終"closed' },
  { language:"typescript", label:"node-readline", source:'import {createInterface} from "readline"; (async()=>{for await (const line of createInterface({input:process.stdin})) process.stdout.write(line+"!");})();', input:"a\n終", expected:"a!終!" },
  { language:"javascript", label:"node-pipe", source:'process.stdin.pipe(process.stdout);', input:"終\0😀", expected:"終\0😀" },
  { language:"javascript", label:"node-async-error", source:'process.stdin.on("data",()=>{throw new Error("async-stdio-failure")});', input:"x", runtimeError:"async-stdio-failure" },
  { language:"typescript", label:"node-async-error", source:'Promise.reject(new Error("unhandled-test-failure"));', input:"", runtimeError:"unhandled-test-failure" },
  { language:"javascript", label:"node-handled-error", source:'const p=Promise.reject(new Error("handled")); Promise.resolve().then(()=>p.catch(()=>process.stdout.write("caught")));', input:"", expected:"caught" },
  { language:"javascript", label:"std-nul", source:'import std from "std"; std.out.puts("a\\0終");', input:"", expected:"a\0終" },
  { language:"typescript", label:"node-unsupported", source:'import { unlinkSync } from "node:fs"; unlinkSync("x");', input:"", compileError:true },
  { language:"c", label:"stdio", source:'#include <stdio.h>\nint main(){int a,b;scanf("%d%d",&a,&b);printf("%d\\n",a+b);}', input:"20 22\n", expected:"42\n" },
  { language:"cpp", label:"bits-whitespace-and-raw-string", source:'# include<bits/stdc++.h>\nint main(){int a,b;std::cin>>a>>b;std::cout<<a+b<<"\\n"<<R"raw(#include <bits/stdc++.h>)raw"<<"\\n";}', input:"20 22\n", expected:"42\n#include <bits/stdc++.h>\n" },
  { language:"cpp", label:"bits-list", source:'# include<bits/stdc++.h>\nint main(){std::list<int> x{20,22};std::cout<<x.front()+x.back()<<"\\n";}', input:"", expected:"42\n" },
  { language:"python", label:"input-no-newline", source:'a,b=map(int,input().split())\nprint(a+b)', input:"20 22", expected:"42\n" },
  { language:"javascript", label:"quickjs-stdin", source:'import * as std from "std"; const [a,b]=std.in.readAsString().trim().split(/\\s+/).map(Number); std.out.puts(String(a+b)+"\\n");', input:"20 22\n", expected:"42\n" },
  { language:"typescript", label:"quickjs-stdin", source:'import * as std from "std"; const values: number[]=std.in.readAsString().trim().split(/\\s+/).map(Number); std.out.puts(String(values[0]+values[1])+"\\n");', input:"20 22\n", expected:"42\n" },
  { language:"javascript", label:"node-fs", source:'import * as fs from "node:fs"; const [a,b]=fs.readFileSync(0,"utf8").trim().split(/\\s+/).map(Number); console.log(a+b);', input:"20 22\n", expected:"42\n" },
  { language:"typescript", label:"node-fs", source:'import * as fs from "node:fs"; const values: number[]=fs.readFileSync(0,"utf8").trim().split(/\\s+/).map(Number); console.log(values[0]+values[1]);', input:"20 22\n", expected:"42\n" },
  { language:"go", label:"fmt", source:'package main\nimport "fmt"\nfunc main(){var a,b int;fmt.Scan(&a,&b);fmt.Println(a+b)}', input:"20 22\n", expected:"42\n" },
  { language:"rust", label:"stdin", source:'use std::io::{self,Read};fn main(){let mut s=String::new();io::stdin().read_to_string(&mut s).unwrap();let mut it=s.split_whitespace().map(|x|x.parse::<i64>().unwrap());println!("{}",it.next().unwrap()+it.next().unwrap());}', input:"20 22\n", expected:"42\n" },
  { language:"java", label:"system-in", source:'public class Main { public static void main(String[] args) throws Exception { int a=System.in.read()-48; System.in.read(); int b=System.in.read()-48; System.out.println(a+b); } }', input:"2 4\n", expected:"6\n" },
  { language:"java", label:"scanner", source:'import java.util.Scanner; public class Main {public static void main(String[] args){Scanner s=new Scanner(System.in);System.out.println(s.nextInt()+s.nextInt());}}', input:"20 22\n", expected:"42\n" },
  { language:"java", label:"syntax-error", source:'public class Main {public static void main(String[] args){ int x = ; }}', input:"", compileError:true },
];
fixtures.push(...JSON.parse(await readFile(path.join(root, "scripts/fixtures/java-client.json"), "utf8")));
fixtures.push(...JSON.parse(await readFile(path.join(root, "scripts/fixtures/python-memory.json"), "utf8")));
fixtures.push(
  { language:"c", label:"logical-clock-limit", source:'#include <stdio.h>\n#include <time.h>\nint main(){for(int i=0;i<10000;i++) clock();puts("42");}', input:"", termination:"logical-time-limit", resources:{logicalTimeLimitMs:1} },
  { language:"c", label:"cpu-work", source:'#include <stdio.h>\nint main(){volatile unsigned long long s=0;for(unsigned i=0;i<10000000;i++)s+=i;printf("%llu\\n",s);}', input:"", expected:"49999995000000\n" },
  { language:"python", label:"memory-16mb", source:'print(42)', input:"", expected:"42\n", resources:{memoryLimitBytes:16*1024*1024} },
);
const record = { policy, results:[], pageErrors:[], consoleErrors:[] };
let browser;
try {
  const browserType = {chromium, firefox, webkit}[process.env.WASM_OJ_BROWSER ?? "chromium"];
  if (!browserType) throw new Error("Unknown verification browser");
  browser = await browserType.launch({ headless:true });
  const context = await browser.newContext({ serviceWorkers:"block" });
  const page = await context.newPage();
  page.on("pageerror", e => record.pageErrors.push(e.message));
  page.on("console", message => { if(message.type()==="error") record.consoleErrors.push(message.text()); });
  await page.goto(base);
  await page.waitForFunction(() => window.ready, undefined, {timeout:120000});
  record.environment = await page.evaluate(() => ({evalBlocked:window.evalBlocked,crossOriginIsolated,userAgent:navigator.userAgent}));
  if (!record.environment.evalBlocked) throw new Error("CSP does not block dynamic JavaScript");
  console.log(JSON.stringify({ready:record.environment}));
  const selected = process.argv.slice(2);
  for (const fixture of fixtures.filter(fixture => selected.length === 0 || selected.includes(fixture.label))) {
    console.log(`START ${fixture.language}/${fixture.label}`);
    const result = await page.evaluate(async fixture => {
      const start = performance.now();
      const entry = fixture.entry ?? {c:"main.c",cpp:"main.cpp",python:"main.py",javascript:"main.js",typescript:"main.ts",go:"main.go",rust:"main.rs",java:"Main.java"}[fixture.language];
      const files = {[entry]:fixture.source, ...fixture.files};
      if (fixture.language === "cpp") files["src/bits/stdc++.h"] = window.header + (fixture.extraHeaders ?? []).map(name => `#include <${name}>\n`).join("");
      const timer = setTimeout(() => window.engine.cancel(), 180000);
      try {
        const build = await window.engine.compile({language:fixture.language,target:"wasip1",optimization:fixture.optimization??"release",entry,files,projectId:`csp-${fixture.language}-${fixture.label}`},{cache:false});
        const compilation = {success:build.success,stderr:build.stderr,stdout:build.stdout,diagnostics:build.diagnostics};
        if (!build.success || !build.artifact) return {language:fixture.language,label:fixture.label,compilation,pass:!!fixture.compileError,elapsedMs:Math.round(performance.now()-start)};
        const runs = [];
        for (let attempt = 0; attempt < (fixture.repeat ?? 1); attempt++) {
          const result = await window.engine.run(build.artifact,{stdin:fixture.input,determinism:fixture.determinism,resources:{logicalTimeLimitMs:5000,memoryLimitBytes:512*1024*1024,outputLimitBytes:16*1024*1024,wallTimeLimitMs:30000,...fixture.resources}});
          runs.push(result);
          if (result.termination !== "exited") break;
        }
        const run = runs.at(-1);
        return {language:fixture.language,label:fixture.label,compilation,run,runs,pass:!fixture.compileError&&runs.every(result => fixture.termination ? result.termination===fixture.termination : fixture.runtimeError ? result.code!==0&&result.stderr.includes(fixture.runtimeError) : result.termination==="exited"&&result.code===0&&result.stdout===fixture.expected),elapsedMs:Math.round(performance.now()-start)};
      } catch(error) { return {language:fixture.language,label:fixture.label,error:String(error),pass:false,elapsedMs:Math.round(performance.now()-start)}; }
      finally {clearTimeout(timer);}
    }, {...fixture, extraHeaders:extraCppHeaders});
    record.results.push(result);
    await writeFile(path.join(output,"results.json"),JSON.stringify(record,null,2)+"\n");
    console.log(JSON.stringify({language:result.language,label:result.label,pass:result.pass,error:result.error,compiled:result.compilation?.success,code:result.run?.code,stdout:result.run?.stdout,stderr:result.compilation?.stderr||result.run?.stderr,elapsedMs:result.elapsedMs}));
  }
  if (selected.includes("execution-timing")) {
    const wasmPath = path.join(output, "slow-preparation.wasm");
    execFileSync("wat2wasm", ["-", "-o", wasmPath], {input:`(module (memory (export "memory") 1) (func (export "_start")) ${`(func ${"nop ".repeat(64)})`.repeat(3000)})`});
    record.executionTiming = await page.evaluate(async bytes => {
      const build = await window.engine.compile({language:"c",target:"wasip1",optimization:"release",entry:"main.c",files:{"main.c":"int main(){return 0;}"},projectId:"timing-seed"},{cache:false});
      if (!build.success || !build.artifact) throw new Error("Timing seed did not compile");
      const run = await window.engine.run({...build.artifact,bytes:new Uint8Array(bytes),size:bytes.length}, {resources:{wallTimeLimitMs:25}});
      return {run,pass:run.termination==="exited"&&run.code===0&&run.durationMs>25&&run.executionDurationMs<25};
    }, [...await readFile(wasmPath)]);
    console.log(JSON.stringify({executionTiming:record.executionTiming}));
  }
  record.capabilities = [];
  for (const invoke of [false, true]) {
    const wasmPath = path.join(output, `capability-${invoke}.wasm`);
    const source = `(module
      (import "wasix_64v1" "sock_open" (func $denied (param i32 i64 f32 f64) (result i64 i32)))
      (memory (export "memory") 1)
      (func (export "_start") ${invoke ? "i32.const 1 i64.const 2 f32.const 3 f64.const 4 call $denied drop drop" : ""}))`;
    execFileSync("wat2wasm", ["-", "-o", wasmPath], {input:source});
    const bytes = [...await readFile(wasmPath)];
    const response = await page.evaluate(async bytes => {
      const runtime = await import('/src/runner/generated/runtime-core.js');
      await runtime.default();
      return runtime.run_wasm_oj({
        wasm:new Uint8Array(bytes), args:[], env:{}, stdin:new Uint8Array(), files:{}, outputPaths:[], cwd:null, startupEntropyBytes:0,
        determinism:{randomSeed:7,realtimeEpochMs:946684800000,clockStepNs:1000000},
        resources:{instructionBudget:1000000,logicalTimeLimitMs:5000,memoryLimitBytes:131072,outputLimitBytes:1024,filesystemWriteLimitBytes:67108864,filesystemEntryLimit:4096},
      }, () => {});
    }, bytes);
    const pass = response.ok && (invoke
      ? response.result.termination === "trap" && response.result.trapMessage?.includes("wasix_64v1.sock_open")
      : response.result.code === 0 && response.result.termination === "exited");
    record.capabilities.push({invoke,pass,response});
    console.log(JSON.stringify({capabilityInvoke:invoke,pass,response}));
  }
  record.cspViolations = await page.evaluate(() => window.cspViolations);
  await page.evaluate(() => window.engine.dispose());
} catch(error) {record.failure=String(error);throw error;}
finally {
  await writeFile(path.join(output,"results.json"),JSON.stringify(record,null,2)+"\n");
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
}
if(record.results.some(result=>!result.pass)||record.capabilities?.some(result=>!result.pass)||record.executionTiming?.pass===false)process.exitCode=1;
console.log(`EVIDENCE ${path.join(output,"results.json")}`);
