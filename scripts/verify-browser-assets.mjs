import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const EXECUTABLE_EXTENSIONS = new Set([".cjs", ".html", ".js", ".mjs", ".xhtml"]);
const EXECUTION_CDNS = [
  "cdn.jsdelivr.net",
  "cdnjs.cloudflare.com",
  "esm.sh",
  "unpkg.com",
];

export async function verifyBrowserAssets(directory) {
  const failures = [];
  const files = await recursiveFiles(directory);
  for (const relative of files) {
    if (!EXECUTABLE_EXTENSIONS.has(path.extname(relative))) continue;
    const source = await readFile(path.join(directory, relative), "utf8");
    failures.push(...externalExecutableUrls(source).map((url) => `${relative}: ${url}`));
  }
  if (failures.length) {
    throw new Error(`Browser output contains external executable URLs:\n${failures.join("\n")}`);
  }
  const headers = files.find((relative) => relative === "_headers");
  if (!headers) throw new Error("Browser output is missing its Cloudflare security headers.");
  verifyBrowserSecurityHeaders(await readFile(path.join(directory, headers), "utf8"));
}

export function externalExecutableUrls(source) {
  if (typeof source !== "string") throw new TypeError("Browser asset source must be text.");
  const urls = new Set();
  for (const match of source.matchAll(/<script\b[^>]*\bsrc\s*=\s*["'](https?:\/\/[^"']+)["']/giu)) {
    urls.add(match[1]);
  }
  for (const match of source.matchAll(/\b(?:import\s*\(|import\s+[^;]*?from\s*|export\s+[^;]*?from\s*)["'](https?:\/\/[^"']+)["']/gu)) {
    urls.add(match[1]);
  }
  for (const match of source.matchAll(/https?:\/\/[^\s"'`<>\\)]+/gu)) {
    let url;
    try { url = new URL(match[0]); } catch { continue; }
    if (EXECUTION_CDNS.includes(url.hostname)
      || /(?:\.m?js|\.cjs)$/iu.test(url.pathname)
      || /\/min\/vs\/?$/u.test(url.pathname)) {
      urls.add(url.href);
    }
  }
  return [...urls].sort();
}

export function verifyBrowserSecurityHeaders(source) {
  const match = /^\s*Content-Security-Policy:\s*(.+)$/imu.exec(source);
  if (!match) throw new Error("Browser security headers are missing Content-Security-Policy.");
  const directives = new Map(match[1].split(";").map((value) => {
    const tokens = value.trim().split(/\s+/u);
    return [tokens[0], tokens.slice(1)];
  }));
  requireDirective(directives, "script-src", ["'self'", "'wasm-unsafe-eval'"]);
  requireDirective(directives, "worker-src", ["'self'", "blob:"]);
  requireDirective(directives, "connect-src", ["'self'", "https:"]);
  requireDirective(directives, "object-src", ["'none'"]);
  requireDirective(directives, "base-uri", ["'none'"]);
}

function requireDirective(directives, name, expected) {
  const actual = directives.get(name);
  if (!actual || JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`Browser CSP '${name}' must be exactly ${expected.join(" ")}.`);
  }
}

async function recursiveFiles(directory, prefix = "") {
  const result = [];
  for (const entry of await readdir(path.join(directory, prefix), { withFileTypes: true })) {
    const relative = path.posix.join(prefix, entry.name);
    if (entry.isDirectory()) result.push(...await recursiveFiles(directory, relative));
    else if (entry.isFile()) result.push(relative);
    else throw new Error(`Browser output contains unsupported entry '${relative}'.`);
  }
  return result;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const directory = process.argv[2];
  if (!directory || process.argv.length !== 3) throw new Error("Usage: verify-browser-assets.mjs <browser-output-directory>");
  await verifyBrowserAssets(path.resolve(directory));
  process.stdout.write("Verified browser output contains no external executable URLs.\n");
}
