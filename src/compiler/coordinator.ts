import { projectCacheKeyForCompiler } from "../core/hash";
import { assertValidBuildArtifact } from "../core/artifact-validation";
import { assertValidProject } from "../core/project-validation";
import type { BuildArtifact, BuildResult, Project } from "../core/types";
import type { ForgeCompiler } from "./compiler";

export interface ForgeArtifactStore {
  load(cacheKey: string): Promise<BuildArtifact | undefined>;
  save(artifact: BuildArtifact): Promise<void>;
  delete(cacheKey: string): Promise<void>;
  clear(): Promise<void>;
}

export interface CoordinatorCompileOptions {
  cache?: boolean;
}

export type PrecompileStatus = "ready" | "compile-error" | "superseded" | "failed";

export interface PrecompileOutcome {
  cacheKey: string;
  status: PrecompileStatus;
  result?: BuildResult;
  error?: Error;
}

interface ActiveCompilation {
  cacheKey: string;
  priority: "background" | "foreground";
  promise: Promise<BuildResult>;
  state: { superseded: boolean };
}

/**
 * Coordinates content-addressed foreground and compile-ahead requests.
 * It never permits two compiler requests to share mutable compiler state.
 */
export class CompileCoordinator {
  private active?: ActiveCompilation;
  private backgroundIntent = 0;
  private lifecycleGeneration = 0;
  private readonly inFlightOperations = new Set<Promise<unknown>>();
  private readonly cacheMutationTails = new Map<string, Promise<void>>();

  constructor(
    private readonly compiler: ForgeCompiler,
    private readonly artifactStore?: ForgeArtifactStore,
  ) {}

  compile(project: Project, options: CoordinatorCompileOptions = {}): Promise<BuildResult> {
    return this.track(this.compileOperation(project, options));
  }

  private async compileOperation(
    project: Project,
    options: CoordinatorCompileOptions,
  ): Promise<BuildResult> {
    assertValidProject(project);
    const generation = this.lifecycleGeneration;
    const cacheKey = await this.cacheKey(project);
    this.assertCurrent(generation);
    const useCache = options.cache ?? true;
    if (this.active?.cacheKey === cacheKey) {
      this.backgroundIntent += 1;
      this.active.priority = "foreground";
      return this.active.promise;
    }
    if (useCache) {
      const cached = await this.loadCached(project, cacheKey);
      this.assertCurrent(generation);
      if (cached) return cached;
    }

    this.backgroundIntent += 1;
    if (this.active?.cacheKey === cacheKey) {
      this.active.priority = "foreground";
      return this.active.promise;
    }
    await this.cancelActiveBackground();
    this.assertCurrent(generation);
    if (this.active) {
      throw new Error("The compiler already has a different foreground build in progress.");
    }
    return this.start(project, cacheKey, "foreground", useCache);
  }

  precompile(project: Project): Promise<PrecompileOutcome> {
    return this.track(this.precompileOperation(project));
  }

  private async precompileOperation(project: Project): Promise<PrecompileOutcome> {
    assertValidProject(project);
    const intent = ++this.backgroundIntent;
    const cacheKey = await this.cacheKey(project);
    if (intent !== this.backgroundIntent) return { cacheKey, status: "superseded" };
    try {
      const cached = await this.loadCached(project, cacheKey);
      if (intent !== this.backgroundIntent) return { cacheKey, status: "superseded" };
      if (cached) return { cacheKey, status: "ready", result: cached };

      if (this.active?.cacheKey === cacheKey) {
        const result = await this.active.promise;
        return intent === this.backgroundIntent
          ? outcomeFromBuild(cacheKey, result)
          : { cacheKey, status: "superseded" };
      }
      await this.cancelActiveBackground();
      if (this.active || intent !== this.backgroundIntent) {
        return { cacheKey, status: "superseded" };
      }
      const result = await this.start(project, cacheKey, "background", true);
      return intent === this.backgroundIntent
        ? outcomeFromBuild(cacheKey, result)
        : { cacheKey, status: "superseded" };
    } catch (error) {
      if (intent !== this.backgroundIntent) return { cacheKey, status: "superseded" };
      return {
        cacheKey,
        status: "failed",
        error: error instanceof Error ? error : new Error(String(error)),
      };
    }
  }

  supersedeBackground(): void {
    this.backgroundIntent += 1;
    const active = this.active;
    if (!active || active.priority !== "background") return;
    this.supersede(active);
    this.compiler.cancel();
  }

  /** Cancel every accepted compilation and release it before returning. */
  cancel(): void {
    this.backgroundIntent += 1;
    this.lifecycleGeneration += 1;
    const active = this.active;
    if (active) this.supersede(active);
    this.compiler.cancel();
  }

  /** Cancel accepted work and wait for hashing, cache I/O, builds, and persistence to settle. */
  async cancelAndWait(): Promise<void> {
    this.cancel();
    while (this.inFlightOperations.size > 0) {
      await Promise.allSettled([...this.inFlightOperations]);
    }
  }

  /** Restart the compiler without allowing a retry to join stale work. */
  restart(): void {
    this.backgroundIntent += 1;
    this.lifecycleGeneration += 1;
    const active = this.active;
    if (active) this.supersede(active);
    this.compiler.restart();
  }

  dispose(): void {
    this.backgroundIntent += 1;
    this.lifecycleGeneration += 1;
    const active = this.active;
    if (active) this.supersede(active);
    this.compiler.dispose();
  }

  private cacheKey(project: Project): Promise<string> {
    return projectCacheKeyForCompiler(project, this.compiler.cacheIdentity(project));
  }

  private async loadCached(project: Project, cacheKey: string): Promise<BuildResult | undefined> {
    await this.cacheMutationTails.get(cacheKey);
    const artifact = await this.artifactStore?.load(cacheKey);
    if (!artifact) return undefined;
    try {
      assertValidBuildArtifact(artifact, { project, cacheKey });
    } catch (error) {
      console.warn(`Ignoring cached artifact '${cacheKey}' because its build identity is invalid.`, error);
      try {
        await this.artifactStore?.delete(cacheKey);
      } catch (deleteError) {
        console.warn(`Unable to evict invalid cached artifact '${cacheKey}'.`, deleteError);
      }
      return undefined;
    }
    return {
      success: true,
      diagnostics: [],
      artifact,
      stdout: "",
      stderr: "",
      cacheHit: true,
    };
  }

  private start(
    project: Project,
    cacheKey: string,
    priority: ActiveCompilation["priority"],
    persist: boolean,
  ): Promise<BuildResult> {
    const state = { superseded: false };
    const promise = this.compiler.build(project, cacheKey).then(async (result) => {
      if (state.superseded) throw new Error("Compilation was superseded.");
      if (result.success) {
        if (!result.artifact) throw new Error("ForgeCompiler returned success without an artifact.");
        assertValidBuildArtifact(result.artifact, { project, cacheKey });
        const artifact = result.artifact;
        const artifactStore = this.artifactStore;
        if (persist && artifactStore) {
          await this.queueCacheMutation(cacheKey, async () => {
            try {
              await artifactStore.save(artifact);
            } catch (error) {
              console.warn(`Unable to persist compiled artifact '${cacheKey}'.`, error);
            }
            if (state.superseded) {
              try {
                await artifactStore.delete(cacheKey);
              } catch (error) {
                console.warn(`Unable to remove superseded artifact '${cacheKey}'.`, error);
              }
            }
          });
        }
      } else if (result.artifact) {
        throw new Error("ForgeCompiler returned an artifact for a failed build.");
      }
      if (state.superseded) throw new Error("Compilation was superseded.");
      return result;
    });
    const active: ActiveCompilation = { cacheKey, priority, promise, state };
    this.active = active;
    void promise.then(
      () => this.clearActive(active),
      () => this.clearActive(active),
    );
    return promise;
  }

  private async cancelActiveBackground(): Promise<void> {
    const active = this.active;
    if (!active || active.priority !== "background") return;
    this.supersede(active);
    this.compiler.cancel();
    try {
      await active.promise;
    } catch {
      // Cancellation is represented by rejection from the replaced Worker.
    }
  }

  private supersede(active: ActiveCompilation): void {
    active.state.superseded = true;
    this.clearActive(active);
  }

  private assertCurrent(generation: number): void {
    if (generation !== this.lifecycleGeneration) throw new Error("Compilation was superseded.");
  }

  private clearActive(active: ActiveCompilation): void {
    if (this.active === active) this.active = undefined;
  }

  private track<Result>(operation: Promise<Result>): Promise<Result> {
    this.inFlightOperations.add(operation);
    void operation.then(
      () => this.inFlightOperations.delete(operation),
      () => this.inFlightOperations.delete(operation),
    );
    return operation;
  }

  private queueCacheMutation(cacheKey: string, mutation: () => Promise<void>): Promise<void> {
    const preceding = this.cacheMutationTails.get(cacheKey) ?? Promise.resolve();
    const current = preceding.then(mutation, mutation);
    this.cacheMutationTails.set(cacheKey, current);
    void current.then(
      () => {
        if (this.cacheMutationTails.get(cacheKey) === current) this.cacheMutationTails.delete(cacheKey);
      },
      () => {
        if (this.cacheMutationTails.get(cacheKey) === current) this.cacheMutationTails.delete(cacheKey);
      },
    );
    return current;
  }
}

function outcomeFromBuild(cacheKey: string, result: BuildResult): PrecompileOutcome {
  return {
    cacheKey,
    status: result.success && result.artifact ? "ready" : "compile-error",
    result,
  };
}
