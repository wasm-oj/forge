import { zipSync } from "fflate";
import { describe, expect, it, vi } from "vitest";
import { FORGE_SCHEMAS } from "../core/contract.ts";
import { sha256Hex } from "../core/hash.ts";
import { createDependencyDownloadBudget, DEPENDENCY_RESOLUTION_LIMITS } from "./limits.ts";
import {
  CargoLockDependencyResolver,
  CppLockDependencyResolver,
  DependencyNetworkError,
  GoLockDependencyResolver,
  goModuleZipHash,
  NpmLockDependencyResolver,
  PyPiLockDependencyResolver,
  type DependencyFetch,
} from "./resolvers.ts";
import type { DependencyNetworkAccess, DependencyNetworkAuthorizer } from "./types.ts";

const encoder = new TextEncoder();
const bundleDigest = "a".repeat(64);
const allowNetwork: DependencyNetworkAuthorizer = { authorize: async () => undefined };

describe("native dependency adapters", () => {
  it("resolves and verifies Cargo.lock v4 crates", async () => {
    const payload = encoder.encode("crate archive");
    const digest = await sha256Hex(payload);
    const url = "https://static.crates.io/crates/serde/serde-1.0.228.crate";
    const resolver = new CargoLockDependencyResolver({
      fetch: fetchMap({ [url]: payload }),
      networkAuthorizer: allowNetwork,
    });
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
    }, networkContext("static.crates.io"));
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
    const resolver = new NpmLockDependencyResolver({
      fetch: fetchMap({ [url]: payload }),
      networkAuthorizer: allowNetwork,
    });
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
    }, networkContext("registry.npmjs.org"));
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
      networkAuthorizer: allowNetwork,
    });
    const graph = await resolver.resolve({
      requirements: [{ ecosystem: "pypi", name: "Answer", requirement: "==1.0.0" }],
      sourceFiles: [{
        ecosystem: "pypi",
        role: "lockfile",
        path: "requirements.txt",
        contents: `answer==1.0.0 --hash=sha256:${digest}\n`,
      }],
    }, networkContext("files.pythonhosted.org", "pypi.org"));
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
    const resolver = new GoLockDependencyResolver({
      fetch: fetchMap({ [url]: payload }),
      networkAuthorizer: allowNetwork,
    });
    const graph = await resolver.resolve({
      requirements: [{ ecosystem: "go", name: "example.com/answer", requirement: "v1.0.0" }],
      sourceFiles: [
        { ecosystem: "go", role: "manifest", path: "go.mod", contents: "module judge\n\nrequire example.com/answer v1.0.0\n" },
        { ecosystem: "go", role: "lockfile", path: "go.sum", contents: `example.com/answer v1.0.0 ${h1}\n` },
      ],
    }, networkContext("proxy.golang.org"));
    expect(graph.roots).toEqual(["go:example.com/answer@v1.0.0"]);
    expect(graph.packages[0]?.integritySha256).toBe(await sha256Hex(payload));
  });

  it("resolves the explicit Forge C/C++ lock without inventing a package solver", async () => {
    const payload = encoder.encode("header-only archive");
    const digest = await sha256Hex(payload);
    const url = "https://packages.wasm-oj.dev/cpp/answer-1.0.0.tar.gz";
    const resolver = new CppLockDependencyResolver({
      fetch: fetchMap({ [url]: payload }),
      networkAuthorizer: allowNetwork,
    });
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
    }, networkContext("packages.wasm-oj.dev"));
    expect(graph.roots).toEqual(["cpp:answer@1.0.0"]);
    expect(graph.packages[0]).toEqual(expect.objectContaining({ source: url, integritySha256: digest }));
  });

  it("rejects dependency URLs that are not HTTPS", async () => {
    const resolver = new NpmLockDependencyResolver({
      fetch: fetchMap({}),
      networkAuthorizer: allowNetwork,
    });
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
    }, networkContext("registry.invalid"))).rejects.toThrow("credential-free HTTPS");
  });

  it("never performs network I/O without an explicit authorizer", async () => {
    const fetcher = vi.fn<DependencyFetch>();
    const resolver = new NpmLockDependencyResolver({ fetch: fetcher });
    await expect(resolver.resolve(npmManifest("https://registry.npmjs.org/bad/-/bad-1.0.0.tgz"),
      networkContext("registry.npmjs.org"))).rejects.toThrow("explicit authorizer");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("fails before fetch when a resolved URL is outside the complete approved host set", async () => {
    const fetcher = vi.fn<DependencyFetch>();
    const resolver = new NpmLockDependencyResolver({ fetch: fetcher, networkAuthorizer: allowNetwork });
    await expect(resolver.resolve(npmManifest("https://registry.npmjs.org/bad/-/bad-1.0.0.tgz"),
      networkContext("packages.example.com"))).rejects.toThrow("outside the explicitly authorized host set");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("classifies only a rejected fetch as a dependency network failure", async () => {
    const platformFetch = vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(new TypeError("network disconnected"));
    try {
      const resolver = new NpmLockDependencyResolver({ networkAuthorizer: allowNetwork });
      await expect(resolver.resolve(npmManifest("https://registry.npmjs.org/bad/-/bad-1.0.0.tgz"),
        networkContext("registry.npmjs.org"))).rejects.toBeInstanceOf(DependencyNetworkError);
    } finally {
      platformFetch.mockRestore();
    }

    const unclassifiedFailure = new NpmLockDependencyResolver({
      fetch: async () => { throw new TypeError("custom transport implementation failed"); },
      networkAuthorizer: allowNetwork,
    });
    const customError = await unclassifiedFailure.resolve(
      npmManifest("https://registry.npmjs.org/bad/-/bad-1.0.0.tgz"),
      networkContext("registry.npmjs.org"),
    ).then(() => undefined, (error: unknown) => error);
    expect(customError).toBeInstanceOf(TypeError);
    expect(customError).not.toBeInstanceOf(DependencyNetworkError);

    const interruptedBody = new NpmLockDependencyResolver({
      fetch: async () => new Response(new ReadableStream({
        start(controller) { controller.error(new DependencyNetworkError("registry.npmjs.org")); },
      })),
      networkAuthorizer: allowNetwork,
    });
    await expect(interruptedBody.resolve(
      npmManifest("https://registry.npmjs.org/bad/-/bad-1.0.0.tgz"),
      networkContext("registry.npmjs.org"),
    )).rejects.toBeInstanceOf(DependencyNetworkError);

    const httpResolver = new NpmLockDependencyResolver({
      fetch: async () => new Response("unavailable", { status: 503 }),
      networkAuthorizer: allowNetwork,
    });
    const httpError = await httpResolver.resolve(
      npmManifest("https://registry.npmjs.org/bad/-/bad-1.0.0.tgz"),
      networkContext("registry.npmjs.org"),
    ).then(() => undefined, (error: unknown) => error);
    expect(httpError).toBeInstanceOf(Error);
    expect(httpError).not.toBeInstanceOf(DependencyNetworkError);
    expect((httpError as Error).message).toContain("HTTP 503");
  });

  it("rejects query-bearing dependency URLs before fetch", async () => {
    const fetcher = vi.fn<DependencyFetch>();
    const resolver = new NpmLockDependencyResolver({ fetch: fetcher, networkAuthorizer: allowNetwork });
    await expect(resolver.resolve(
      npmManifest("https://registry.npmjs.org/bad/-/bad-1.0.0.tgz?token=secret"),
      networkContext("registry.npmjs.org"),
    )).rejects.toThrow("without a query or fragment");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("omits credentials and rejects every observable redirect without classifying it as a network failure", async () => {
    const url = "https://registry.npmjs.org/bad/-/bad-1.0.0.tgz";
    const followed = new Response("redirected archive", { status: 200 });
    Object.defineProperty(followed, "redirected", { value: true });
    const opaque = new Response(null, { status: 200 });
    Object.defineProperty(opaque, "type", { value: "opaqueredirect" });
    const responses = [
      new Response(null, { status: 302, headers: { location: "https://packages.example.com/archive.tgz" } }),
      followed,
      opaque,
    ];

    for (const response of responses) {
      const fetcher = vi.fn<DependencyFetch>(async () => response);
      const resolver = new NpmLockDependencyResolver({ fetch: fetcher, networkAuthorizer: allowNetwork });
      const redirectError = await resolver.resolve(
        npmManifest(url),
        networkContext("registry.npmjs.org"),
      ).then(() => undefined, (error: unknown) => error);

      expect(fetcher).toHaveBeenCalledWith(url, {
        method: "GET",
        cache: "no-store",
        credentials: "omit",
        redirect: "manual",
      });
      expect(redirectError).toBeInstanceOf(Error);
      expect(redirectError).not.toBeInstanceOf(DependencyNetworkError);
      expect((redirectError as Error).message).toContain("redirected unexpectedly");
    }
  });

  it("rejects an oversized package lock before authorization or network I/O", async () => {
    const fetcher = vi.fn<DependencyFetch>();
    const authorizer = { authorize: vi.fn(async () => undefined) };
    const packages: Record<string, unknown> = { "": { dependencies: { root: "1.0.0" } } };
    for (let index = 0; index <= DEPENDENCY_RESOLUTION_LIMITS.packages; index += 1) {
      packages[`node_modules/package-${index}`] = {
        name: `package-${index}`,
        version: "1.0.0",
        resolved: `https://registry.npmjs.org/package-${index}/-/package-${index}-1.0.0.tgz`,
        integrity: "sha512-AA==",
      };
    }
    const resolver = new NpmLockDependencyResolver({ fetch: fetcher, networkAuthorizer: authorizer });
    await expect(resolver.resolve({
      requirements: [{ ecosystem: "npm", name: "root", requirement: "1.0.0" }],
      sourceFiles: [{
        ecosystem: "npm",
        role: "lockfile",
        path: "package-lock.json",
        contents: JSON.stringify({ lockfileVersion: 3, packages }),
      }],
    }, networkContext("registry.npmjs.org"))).rejects.toThrow(
      `${DEPENDENCY_RESOLUTION_LIMITS.packages}-item limit`,
    );
    expect(authorizer.authorize).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("rejects oversized per-package lock references before authorization or network I/O", async () => {
    const fetcher = vi.fn<DependencyFetch>();
    const authorizer = { authorize: vi.fn(async () => undefined) };
    const dependencies = Object.fromEntries(Array.from(
      { length: DEPENDENCY_RESOLUTION_LIMITS.referencesPerPackage + 1 },
      (_, index) => [`dependency-${index}`, "1.0.0"],
    ));
    const resolver = new NpmLockDependencyResolver({ fetch: fetcher, networkAuthorizer: authorizer });

    await expect(resolver.resolve({
      requirements: [{ ecosystem: "npm", name: "root", requirement: "1.0.0" }],
      sourceFiles: [{
        ecosystem: "npm",
        role: "lockfile",
        path: "package-lock.json",
        contents: JSON.stringify({
          lockfileVersion: 3,
          packages: {
            "": { dependencies: { root: "1.0.0" } },
            "node_modules/root": {
              version: "1.0.0",
              resolved: "https://registry.npmjs.org/root/-/root-1.0.0.tgz",
              integrity: "sha512-AA==",
              dependencies,
            },
          },
        }),
      }],
    }, networkContext("registry.npmjs.org"))).rejects.toThrow(
      `${DEPENDENCY_RESOLUTION_LIMITS.referencesPerPackage}-item limit`,
    );
    expect(authorizer.authorize).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("enforces one concurrency-safe aggregate budget across parallel downloads", async () => {
    const payload = encoder.encode("123456");
    const integrity = `sha512-${await digestBase64("SHA-512", payload)}`;
    const firstUrl = "https://registry.npmjs.org/first/-/first-1.0.0.tgz";
    const secondUrl = "https://registry.npmjs.org/second/-/second-1.0.0.tgz";
    const fetcher = vi.fn<DependencyFetch>(async () => new Response(payload.slice(), {
      status: 200,
      headers: { "content-length": String(payload.byteLength) },
    }));
    const resolver = new NpmLockDependencyResolver({ fetch: fetcher, networkAuthorizer: allowNetwork, concurrency: 2 });
    await expect(resolver.resolve({
      requirements: [{ ecosystem: "npm", name: "first", requirement: "1.0.0" }],
      sourceFiles: [{
        ecosystem: "npm",
        role: "lockfile",
        path: "package-lock.json",
        contents: JSON.stringify({
          lockfileVersion: 3,
          packages: {
            "": { dependencies: { first: "1.0.0" } },
            "node_modules/first": {
              version: "1.0.0",
              resolved: firstUrl,
              integrity,
              dependencies: { second: "1.0.0" },
            },
            "node_modules/second": { version: "1.0.0", resolved: secondUrl, integrity },
          },
        }),
      }],
    }, {
      ...networkContext("registry.npmjs.org"),
      downloadBudget: createDependencyDownloadBudget(10),
    })).rejects.toThrow("10-byte aggregate limit");
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("rejects a caller-forged aggregate budget before fetching", async () => {
    const fetcher = vi.fn<DependencyFetch>();
    const resolver = new NpmLockDependencyResolver({ fetch: fetcher, networkAuthorizer: allowNetwork });
    await expect(resolver.resolve(
      npmManifest("https://registry.npmjs.org/bad/-/bad-1.0.0.tgz"),
      {
        ...networkContext("registry.npmjs.org"),
        downloadBudget: {
          limitBytes: DEPENDENCY_RESOLUTION_LIMITS.totalDownloadBytes,
          usedBytes: 0,
          reserve() {},
          consume() {},
          release() {},
        },
      },
    )).rejects.toThrow("must be issued by Forge");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("preflights Go ZIP entry count and unpacked bytes before accepting extraction", async () => {
    const exact = zipSync({ "module@v1.0.0/file.txt": new Uint8Array(1_024) }, { level: 9 });
    await expect(goModuleZipHash(exact, 1_024, 1)).resolves.toMatch(/^h1:/);
    await expect(goModuleZipHash(exact, 1_023, 1)).rejects.toThrow("unpacked byte limit");

    const twoFiles = zipSync({
      "module@v1.0.0/a.txt": new Uint8Array([1]),
      "module@v1.0.0/b.txt": new Uint8Array([2]),
    }, { level: 9 });
    await expect(goModuleZipHash(twoFiles, 1_024, 1)).rejects.toThrow("1-file limit");

    const bomb = zipSync({ "module@v1.0.0/bomb.bin": new Uint8Array(1024 * 1024) }, { level: 9 });
    expect(bomb.byteLength).toBeLessThan(10_000);
    await expect(goModuleZipHash(bomb, 1_024, 1)).rejects.toThrow("unpacked byte limit");
  });

  it("does not allow callers to raise hard resolver resource limits", async () => {
    expect(() => new NpmLockDependencyResolver({
      maxPackageBytes: DEPENDENCY_RESOLUTION_LIMITS.packageBytes + 1,
    })).toThrow("hard limit");
    expect(() => new NpmLockDependencyResolver({
      concurrency: DEPENDENCY_RESOLUTION_LIMITS.concurrency + 1,
    })).toThrow("hard limit");
    await expect(goModuleZipHash(new Uint8Array(), DEPENDENCY_RESOLUTION_LIMITS.unpackedBytes + 1))
      .rejects.toThrow("hard limit");
  });
});

function npmManifest(url: string) {
  return {
    requirements: [{ ecosystem: "npm" as const, name: "bad", requirement: "1.0.0" }],
    sourceFiles: [{
      ecosystem: "npm" as const,
      role: "lockfile" as const,
      path: "package-lock.json",
      contents: JSON.stringify({
        lockfileVersion: 3,
        packages: {
          "": { dependencies: { bad: "1.0.0" } },
          "node_modules/bad": { version: "1.0.0", resolved: url, integrity: "sha512-AA==" },
        },
      }),
    }],
  };
}

function networkContext(...hosts: string[]): { networkAccess: DependencyNetworkAccess } {
  return {
    networkAccess: {
      sourceKey: "github:wasm-oj/fixture@main:collection/index.json",
      bundleDigest,
      hosts,
    },
  };
}

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
