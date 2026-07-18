import { zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { FORGE_SCHEMAS } from "../core/contract.ts";
import { sha256Hex } from "../core/hash.ts";
import {
  CargoLockDependencyResolver,
  CppLockDependencyResolver,
  GoLockDependencyResolver,
  goModuleZipHash,
  NpmLockDependencyResolver,
  PyPiLockDependencyResolver,
  type DependencyFetch,
} from "./resolvers.ts";

const encoder = new TextEncoder();

describe("native dependency adapters", () => {
  it("resolves and verifies Cargo.lock v4 crates", async () => {
    const payload = encoder.encode("crate archive");
    const digest = await sha256Hex(payload);
    const url = "https://static.crates.io/crates/serde/serde-1.0.228.crate";
    const resolver = new CargoLockDependencyResolver({ fetch: fetchMap({ [url]: payload }) });
    const graph = await resolver.resolve({
      requirements: [{ ecosystem: "cargo", name: "serde", requirement: "=1.0.228", features: ["derive"] }],
      sourceFiles: [{
        ecosystem: "cargo",
        role: "lockfile",
        path: "Cargo.lock",
        contents: `version = 4

[[package]]
name = "app"
version = "0.1.0"
dependencies = [
 "serde",
]

[[package]]
name = "serde"
version = "1.0.228"
source = "registry+https://github.com/rust-lang/crates.io-index"
checksum = "${digest}"
`,
      }],
    });
    expect(graph.roots).toEqual(["cargo:serde@1.0.228"]);
    expect(graph.packages).toEqual([expect.objectContaining({
      id: "cargo:serde@1.0.228",
      integritySha256: digest,
      features: ["derive"],
    })]);
  });

  it("resolves package-lock v3 and verifies npm SRI", async () => {
    const payload = encoder.encode("npm tarball");
    const integrity = `sha512-${await digestBase64("SHA-512", payload)}`;
    const url = "https://registry.npmjs.org/answer/-/answer-1.0.0.tgz";
    const resolver = new NpmLockDependencyResolver({ fetch: fetchMap({ [url]: payload }) });
    const graph = await resolver.resolve({
      requirements: [{ ecosystem: "npm", name: "answer", requirement: "1.0.0" }],
      sourceFiles: [{
        ecosystem: "npm",
        role: "lockfile",
        path: "package-lock.json",
        contents: JSON.stringify({
          lockfileVersion: 3,
          packages: {
            "": { dependencies: { answer: "1.0.0" } },
            "node_modules/answer": { version: "1.0.0", resolved: url, integrity },
          },
        }),
      }],
    });
    expect(graph.roots).toEqual(["npm:answer@1.0.0"]);
    expect(graph.packages[0]).toEqual(expect.objectContaining({
      id: "npm:answer@1.0.0",
      integritySha256: await sha256Hex(payload),
    }));
  });

  it("selects only a hash-approved portable PyPI artifact", async () => {
    const payload = encoder.encode("portable wheel");
    const digest = await sha256Hex(payload);
    const metadataUrl = "https://pypi.org/pypi/answer/1.0.0/json";
    const wheelUrl = "https://files.pythonhosted.org/packages/answer-1.0.0-py3-none-any.whl";
    const metadata = encoder.encode(JSON.stringify({
      urls: [{
        filename: "answer-1.0.0-py3-none-any.whl",
        packagetype: "bdist_wheel",
        url: wheelUrl,
        yanked: false,
        digests: { sha256: digest },
      }],
    }));
    const resolver = new PyPiLockDependencyResolver({
      fetch: fetchMap({ [metadataUrl]: metadata, [wheelUrl]: payload }),
    });
    const graph = await resolver.resolve({
      requirements: [{ ecosystem: "pypi", name: "Answer", requirement: "==1.0.0" }],
      sourceFiles: [{
        ecosystem: "pypi",
        role: "lockfile",
        path: "requirements.txt",
        contents: `answer==1.0.0 --hash=sha256:${digest}\n`,
      }],
    });
    expect(graph.roots).toEqual(["pypi:answer@1.0.0"]);
    expect(graph.packages[0]?.source).toBe(wheelUrl);
  });

  it("verifies Go modules with the official h1 directory hash", async () => {
    const payload = zipSync({
      "example.com/answer@v1.0.0/LICENSE": encoder.encode("MIT\n"),
      "example.com/answer@v1.0.0/go.mod": encoder.encode("module example.com/answer\n"),
    }, { level: 0 });
    const h1 = await goModuleZipHash(payload);
    const url = "https://proxy.golang.org/example.com/answer/@v/v1.0.0.zip";
    const resolver = new GoLockDependencyResolver({ fetch: fetchMap({ [url]: payload }) });
    const graph = await resolver.resolve({
      requirements: [{ ecosystem: "go", name: "example.com/answer", requirement: "v1.0.0" }],
      sourceFiles: [
        { ecosystem: "go", role: "manifest", path: "go.mod", contents: "module judge\n\nrequire example.com/answer v1.0.0\n" },
        { ecosystem: "go", role: "lockfile", path: "go.sum", contents: `example.com/answer v1.0.0 ${h1}\n` },
      ],
    });
    expect(graph.roots).toEqual(["go:example.com/answer@v1.0.0"]);
    expect(graph.packages[0]?.integritySha256).toBe(await sha256Hex(payload));
  });

  it("resolves the explicit Forge C/C++ lock without inventing a package solver", async () => {
    const payload = encoder.encode("header-only archive");
    const digest = await sha256Hex(payload);
    const url = "https://packages.wasm-oj.dev/cpp/answer-1.0.0.tar.gz";
    const resolver = new CppLockDependencyResolver({ fetch: fetchMap({ [url]: payload }) });
    const graph = await resolver.resolve({
      requirements: [{ ecosystem: "cpp", name: "answer", requirement: "1.0.0" }],
      sourceFiles: [{
        ecosystem: "cpp",
        role: "lockfile",
        path: "forge-cpp.lock.json",
        contents: JSON.stringify({
          schema: FORGE_SCHEMAS.cppDependencyLock,
          roots: ["answer@1.0.0"],
          packages: [{ name: "answer", version: "1.0.0", url, sha256: digest, dependencies: [] }],
        }),
      }],
    });
    expect(graph.roots).toEqual(["cpp:answer@1.0.0"]);
    expect(graph.packages[0]).toEqual(expect.objectContaining({ source: url, integritySha256: digest }));
  });

  it("rejects dependency URLs that are not HTTPS", async () => {
    const resolver = new NpmLockDependencyResolver({ fetch: fetchMap({}) });
    await expect(resolver.resolve({
      requirements: [{ ecosystem: "npm", name: "bad", requirement: "1.0.0" }],
      sourceFiles: [{
        ecosystem: "npm",
        role: "lockfile",
        path: "package-lock.json",
        contents: JSON.stringify({
          lockfileVersion: 3,
          packages: {
            "": { dependencies: { bad: "1.0.0" } },
            "node_modules/bad": { version: "1.0.0", resolved: "http://registry.invalid/bad.tgz", integrity: "sha512-AA==" },
          },
        }),
      }],
    })).rejects.toThrow("credential-free HTTPS");
  });
});

function fetchMap(entries: Record<string, Uint8Array>): DependencyFetch {
  return async (input) => {
    const url = String(input);
    const payload = entries[url];
    if (!payload) return new Response("not found", { status: 404 });
    return new Response(payload.slice(), {
      status: 200,
      headers: { "content-length": String(payload.byteLength) },
    });
  };
}

async function digestBase64(algorithm: AlgorithmIdentifier, bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest(algorithm, bytes.slice()));
  let binary = "";
  for (const byte of digest) binary += String.fromCharCode(byte);
  return btoa(binary);
}
