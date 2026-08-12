import {
  createDefaultDependencyManager,
  Engine,
  snapshotBrowserToolchainSources,
} from "@wasm-oj/core";
import type {
  BrowserRuntimeDriverPlugin,
  BrowserToolchainSource,
  DependencyNetworkAuthorizer,
} from "@wasm-oj/core";
import { IndexedDbDependencyCache } from "../dependencies/indexeddb-cache";
import { BrowserCompiler } from "../runtime/compiler-client";
import { BrowserRunner } from "../runtime/runner-client";
import { clearArtifactCache, deleteArtifact, loadArtifact, saveArtifact } from "../storage/database";

export interface BrowserEngineOptions {
  /** Explicit browser toolchain packages; no implicit asset location exists. */
  toolchains: readonly BrowserToolchainSource[];
  /** Content-addressed artifact persistence in IndexedDB. Defaults to true. */
  artifactCache?: boolean;
  /** Calibrated cost profiles for downstream compiler registrations. */
  additionalCostBaselines?: Readonly<Record<string, number>>;
  /** Trusted same-origin, content-pinned RuntimeDriver modules loaded inside the runner Worker. */
  runtimeDriverPlugins?: readonly BrowserRuntimeDriverPlugin[];
  /** Required authorizer for any online dependency resolution. No implicit network access exists. */
  dependencyNetworkAuthorizer?: DependencyNetworkAuthorizer;
}

class BrowserHostedEngine extends Engine {
  constructor(
    compiler: BrowserCompiler,
    runner: BrowserRunner,
    private readonly dependencyCache: IndexedDbDependencyCache,
    artifactCache: boolean,
    dependencyNetworkAuthorizer: DependencyNetworkAuthorizer | undefined,
  ) {
    super({
      compiler,
      runner,
      artifactStore: artifactCache
        ? { load: loadArtifact, save: saveArtifact, delete: deleteArtifact, clear: clearArtifactCache }
        : undefined,
      dependencyManager: createDefaultDependencyManager(dependencyCache, {
        networkAuthorizer: dependencyNetworkAuthorizer,
      }),
    });
  }

  override dispose(): void {
    super.dispose();
    this.dependencyCache.close();
  }
}

/** Creates a browser-hosted engine from explicit, contract-v2 toolchain sources. */
export async function createBrowserEngine(options: BrowserEngineOptions): Promise<Engine> {
  if (!options || typeof options !== "object") {
    throw new TypeError("createBrowserEngine requires explicit toolchain options.");
  }
  const toolchains = snapshotBrowserToolchainSources(options.toolchains);
  let compiler: BrowserCompiler | undefined;
  let runner: BrowserRunner | undefined;
  let dependencyCache: IndexedDbDependencyCache | undefined;
  let instance: BrowserHostedEngine | undefined;
  try {
    dependencyCache = new IndexedDbDependencyCache();
    compiler = new BrowserCompiler({ toolchains });
    runner = new BrowserRunner({
      toolchains,
      additionalCostBaselines: options.additionalCostBaselines,
      runtimeDriverPlugins: options.runtimeDriverPlugins,
    });
    instance = new BrowserHostedEngine(
      compiler,
      runner,
      dependencyCache,
      options.artifactCache !== false,
      options.dependencyNetworkAuthorizer,
    );
    await instance.ready();
    return instance;
  } catch (error) {
    if (instance) {
      instance.dispose();
    } else {
      runner?.dispose();
      compiler?.dispose();
      dependencyCache?.close();
    }
    throw error;
  }
}
