import { assertLanguageIdentifier, type Language, type Project, type WorkerProgress } from "../core/types";
import type { ForgeCompiler } from "./compiler";

export interface ForgeCompilerRegistration {
  readonly languages: readonly Language[];
  readonly compiler: ForgeCompiler;
}

/**
 * Environment-neutral router for composing built-in and downstream compilers.
 *
 * Registration is frozen by the first lifecycle operation, keeping routing
 * deterministic for the lifetime of an engine and making each language owned
 * by exactly one compiler.
 */
export class ForgeCompilerRegistry implements ForgeCompiler {
  private readonly routes = new Map<Language, ForgeCompiler>();
  private readonly compilers = new Set<ForgeCompiler>();
  private readonly progressListeners = new Set<(progress: WorkerProgress) => void>();
  private readonly removeCompilerListeners = new Map<ForgeCompiler, () => void>();
  private initialization: Promise<void> | undefined;
  private sealed = false;
  private disposed = false;
  private generation = 0;

  constructor(registrations: readonly ForgeCompilerRegistration[] = []) {
    try {
      for (const registration of registrations) {
        this.register(registration.languages, registration.compiler);
      }
    } catch (error) {
      try {
        this.dispose();
      } catch (disposeError) {
        throw new AggregateError([error, disposeError], "ForgeCompilerRegistry construction and cleanup failed.");
      }
      throw error;
    }
  }

  register(languages: readonly Language[], compiler: ForgeCompiler): this {
    this.assertActive();
    if (this.sealed) throw new Error("ForgeCompilerRegistry is sealed after its first lifecycle operation.");
    if (!Array.isArray(languages) || languages.length === 0) {
      throw new Error("A compiler registration must own at least one language.");
    }
    assertCompilerContract(compiler);
    const unique = new Set<Language>();
    for (const language of languages) {
      assertLanguageIdentifier(language);
      if (unique.has(language)) throw new Error(`Language '${language}' is duplicated in one compiler registration.`);
      unique.add(language);
      if (this.routes.has(language)) throw new Error(`Language '${language}' already has a registered compiler.`);
    }
    let removeProgressListener: (() => void) | undefined;
    if (!this.compilers.has(compiler)) {
      removeProgressListener = compiler.onProgress((progress) => {
        for (const listener of this.progressListeners) listener(progress);
      });
      if (typeof removeProgressListener !== "function") {
        throw new TypeError("ForgeCompiler.onProgress() must return an unsubscribe function.");
      }
    }
    for (const language of unique) this.routes.set(language, compiler);
    if (removeProgressListener) {
      this.compilers.add(compiler);
      this.removeCompilerListeners.set(compiler, removeProgressListener);
    }
    return this;
  }

  languages(): Language[] {
    this.assertActive();
    return [...this.routes.keys()];
  }

  cacheIdentity(project: Project): string {
    this.assertActive();
    this.sealed = true;
    return this.compilerFor(project.config.language).cacheIdentity(project);
  }

  ready(): Promise<void> {
    this.assertActive();
    this.sealed = true;
    if (!this.initialization) {
      const generation = this.generation;
      const initialization = Promise.all(
        [...this.compilers].map((compiler) => compiler.ready()),
      ).then(() => {
        this.assertActive();
        if (generation !== this.generation) {
          throw new Error("ForgeCompilerRegistry initialization was superseded by a lifecycle change.");
        }
      });
      this.initialization = initialization;
      void initialization.catch(() => {
        if (this.initialization === initialization) this.initialization = undefined;
      });
    }
    return this.initialization;
  }

  async build(project: Project, cacheKey: string) {
    await this.ready();
    return this.compilerFor(project.config.language).build(project, cacheKey);
  }

  onProgress(listener: (progress: WorkerProgress) => void): () => void {
    this.assertActive();
    this.progressListeners.add(listener);
    return () => this.progressListeners.delete(listener);
  }

  async clearToolchainCache(): Promise<void> {
    await this.ready();
    await Promise.all([...this.compilers].map((compiler) => compiler.clearToolchainCache()));
  }

  cancel(): void {
    if (this.disposed) return;
    this.invalidateInitialization();
    this.invokeCompilers("cancel");
  }

  restart(): void {
    this.assertActive();
    this.invalidateInitialization();
    this.invokeCompilers("restart");
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.generation += 1;
    this.initialization = undefined;
    const errors: unknown[] = [];
    for (const remove of this.removeCompilerListeners.values()) {
      try {
        remove();
      } catch (error) {
        errors.push(error);
      }
    }
    for (const compiler of this.compilers) {
      try {
        compiler.dispose();
      } catch (error) {
        errors.push(error);
      }
    }
    this.removeCompilerListeners.clear();
    this.progressListeners.clear();
    if (errors.length > 0) throw new AggregateError(errors, "ForgeCompilerRegistry disposal failed.");
  }

  private assertActive(): void {
    if (this.disposed) throw new Error("ForgeCompilerRegistry is disposed.");
  }

  private compilerFor(language: Language): ForgeCompiler {
    this.assertActive();
    const compiler = this.routes.get(language);
    if (!compiler) throw new Error(`No ForgeCompiler is registered for language '${language}'.`);
    return compiler;
  }

  private invalidateInitialization(): void {
    this.generation += 1;
    this.initialization = undefined;
  }

  private invokeCompilers(operation: "cancel" | "restart"): void {
    const errors: unknown[] = [];
    for (const compiler of this.compilers) {
      try {
        compiler[operation]();
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length > 0) {
      throw new AggregateError(errors, `ForgeCompilerRegistry ${operation} failed.`);
    }
  }
}

function assertCompilerContract(compiler: ForgeCompiler): void {
  if (!compiler || typeof compiler !== "object") throw new TypeError("Forge compilers must be objects.");
  for (const method of [
    "cacheIdentity",
    "ready",
    "build",
    "onProgress",
    "clearToolchainCache",
    "cancel",
    "restart",
    "dispose",
  ] as const) {
    if (typeof compiler[method] !== "function") {
      throw new TypeError(`ForgeCompiler must implement ${method}().`);
    }
  }
}
