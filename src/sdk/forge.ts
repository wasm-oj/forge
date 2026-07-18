import { BrowserForgeCompiler } from "../runtime/compiler-client";
import { BrowserForgeRunner } from "../runtime/runner-client";
import { clearArtifactCache, deleteArtifact, loadArtifact, saveArtifact } from "../storage/database";
import { ForgeEngine } from "./engine";

export type { CompileOptions, ExecuteResult, RunOptions } from "./types";

export interface ForgeOptions {
  /** Content-addressed artifact persistence in IndexedDB. Defaults to true. */
  artifactCache?: boolean;
  /** URL containing all digest-pinned browser toolchain and runtime assets. Defaults to /toolchains/. */
  assetBaseUrl?: string;
  /** Calibrated cost profiles for downstream compiler registrations. */
  additionalCostBaselines?: Readonly<Record<string, number>>;
}

/** Browser host for the environment-neutral ForgeEngine library. */
export class Forge extends ForgeEngine {
  private constructor(options: ForgeOptions) {
    const compiler = new BrowserForgeCompiler({ assetBaseUrl: options.assetBaseUrl });
    const runner = new BrowserForgeRunner({
      assetBaseUrl: options.assetBaseUrl,
      additionalCostBaselines: options.additionalCostBaselines,
    });
    super({
      compiler,
      runner,
      artifactStore: options.artifactCache === false
        ? undefined
        : { load: loadArtifact, save: saveArtifact, delete: deleteArtifact, clear: clearArtifactCache },
    });
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
}
