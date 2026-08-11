import { BrowserForgeCompiler } from "../runtime/compiler-client";
import { BrowserForgeRunner } from "../runtime/runner-client";
import { clearArtifactCache, deleteArtifact, loadArtifact, saveArtifact } from "../storage/database";
import { ForgeEngine } from "./engine";
import type { BrowserRuntimeDriverPlugin } from "../core/types";
import { IndexedDbDependencyCache } from "../dependencies/indexeddb-cache";
import { createDefaultDependencyManager } from "../dependencies/manager";
import type { DependencyNetworkAuthorizer } from "../dependencies/types";

export type { CompileOptions, ExecuteResult, RunOptions } from "./types";

export interface ForgeOptions {
  /** Content-addressed artifact persistence in IndexedDB. Defaults to true. */
  artifactCache?: boolean;
  /** URL containing all digest-pinned browser toolchain and runtime assets. Defaults to /toolchains/. */
  assetBaseUrl?: string;
  /** Calibrated cost profiles for downstream compiler registrations. */
  additionalCostBaselines?: Readonly<Record<string, number>>;
  /** Trusted same-origin, content-pinned RuntimeDriver modules loaded inside the runner Worker. */
  runtimeDriverPlugins?: readonly BrowserRuntimeDriverPlugin[];
  /** Required authorizer for any online dependency resolution. No implicit network access exists. */
  dependencyNetworkAuthorizer?: DependencyNetworkAuthorizer;
}

/** Browser host for the environment-neutral ForgeEngine library. */
export class Forge extends ForgeEngine {
  private readonly dependencyCache: IndexedDbDependencyCache;

  private constructor(options: ForgeOptions) {
    const compiler = new BrowserForgeCompiler({ assetBaseUrl: options.assetBaseUrl });
    const runner = new BrowserForgeRunner({
      assetBaseUrl: options.assetBaseUrl,
      additionalCostBaselines: options.additionalCostBaselines,
      runtimeDriverPlugins: options.runtimeDriverPlugins,
    });
    const dependencyCache = new IndexedDbDependencyCache();
    super({
      compiler,
      runner,
      artifactStore: options.artifactCache === false
        ? undefined
        : { load: loadArtifact, save: saveArtifact, delete: deleteArtifact, clear: clearArtifactCache },
      dependencyManager: createDefaultDependencyManager(dependencyCache, {
        networkAuthorizer: options.dependencyNetworkAuthorizer,
      }),
    });
    this.dependencyCache = dependencyCache;
  }

  static async create(options: ForgeOptions = {}): Promise<Forge> {
    const instance = new Forge(options);
    try {
      await instance.ready();
      return instance;
    } catch (error) {
      instance.dispose();
      throw error;
    }
  }

  override dispose(): void {
    super.dispose();
    this.dependencyCache.close();
  }
}
