import { startProdServer } from "vinext/server/prod-server";
import path from "node:path";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    port: { type: "string", short: "p" },
    hostname: { type: "string", short: "H" },
  },
  strict: true,
});

const port = parsePort(values.port ?? process.env.PORT ?? "3000");
const host = values.hostname ?? "0.0.0.0";

console.log(`\n  Forge production server  (port ${port})\n`);
const { server } = await startProdServer({
  port,
  host,
  outDir: path.resolve(process.cwd(), "dist"),
});
installProductionResponsePolicy(server);

function parsePort(value) {
  if (!/^\d+$/.test(value)) throw new TypeError(`Invalid production server port '${value}'.`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 65_535) {
    throw new RangeError(`Production server port must be between 1 and 65535; received '${value}'.`);
  }
  return parsed;
}

function installProductionResponsePolicy(server) {
  server.prependListener("request", (request, response) => {
    response.setHeader("Cross-Origin-Embedder-Policy", "credentialless");
    response.setHeader("Cross-Origin-Opener-Policy", "same-origin");
    response.setHeader("Cross-Origin-Resource-Policy", "same-origin");
    response.setHeader("Referrer-Policy", "no-referrer");
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
    if (!isWasmAssetRequest(request.url)) return;

    const writeHead = response.writeHead;
    response.writeHead = function forgeWriteHead(statusCode, statusMessageOrHeaders, headers) {
      if (typeof statusMessageOrHeaders === "string") {
        return writeHead.call(
          this,
          statusCode,
          statusMessageOrHeaders,
          replaceContentType(headers),
        );
      }
      return writeHead.call(this, statusCode, replaceContentType(statusMessageOrHeaders));
    };
  });
}

function isWasmAssetRequest(requestUrl) {
  if (!requestUrl) return false;
  try {
    return new URL(requestUrl, "http://forge.invalid").pathname.toLowerCase().endsWith(".wasm");
  } catch {
    return false;
  }
}

function replaceContentType(headers) {
  if (Array.isArray(headers)) {
    const filtered = [];
    for (let index = 0; index < headers.length; index += 2) {
      if (String(headers[index]).toLowerCase() === "content-type") continue;
      filtered.push(headers[index], headers[index + 1]);
    }
    filtered.push("Content-Type", "application/wasm");
    return filtered;
  }

  const corrected = {};
  for (const [key, value] of Object.entries(headers ?? {})) {
    if (key.toLowerCase() !== "content-type") corrected[key] = value;
  }
  corrected["Content-Type"] = "application/wasm";
  return corrected;
}
