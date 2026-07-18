import { assertLanguageIdentifier, type BuildResult, type Language, type Project } from "../core/types.ts";

export interface LanguageBuildContext {
  project: Project;
  cacheKey: string;
  requestId: string;
}

export interface LanguageDriver {
  readonly id: string;
  readonly languages: readonly Language[];
  build(context: LanguageBuildContext): Promise<BuildResult>;
}

/** Internal registry for Forge's built-in compiler pipelines. */
export class LanguageDriverRegistry {
  private readonly drivers = new Map<Language, LanguageDriver>();
  private readonly ids = new Set<string>();

  register(driver: LanguageDriver): void {
    if (!driver || typeof driver !== "object") throw new TypeError("Language drivers must be objects.");
    if (typeof driver.id !== "string" || !driver.id || driver.id !== driver.id.trim() || driver.id.length > 128) {
      throw new Error("Language driver IDs must be non-empty, trimmed, and at most 128 characters.");
    }
    if (this.ids.has(driver.id)) throw new Error(`Language driver '${driver.id}' is already registered.`);
    if (!Array.isArray(driver.languages) || driver.languages.length === 0) {
      throw new Error(`Language driver '${driver.id}' has no languages.`);
    }
    if (typeof driver.build !== "function") {
      throw new TypeError(`Language driver '${driver.id}' must implement build().`);
    }
    const languages = new Set<Language>();
    for (const language of driver.languages) {
      if (typeof language !== "string") throw new TypeError("Language identifiers must be strings.");
      assertLanguageIdentifier(language);
      if (languages.has(language)) {
        throw new Error(`Language '${language}' is duplicated in driver '${driver.id}'.`);
      }
      languages.add(language);
      const existing = this.drivers.get(language);
      if (existing) throw new Error(`Language '${language}' is already owned by driver '${existing.id}'.`);
    }
    for (const language of languages) {
      this.drivers.set(language, driver);
    }
    this.ids.add(driver.id);
  }

  driver(language: Language): LanguageDriver {
    const driver = this.drivers.get(language);
    if (!driver) throw new Error(`No language driver is registered for '${language}'.`);
    return driver;
  }

  languages(): Language[] {
    return [...this.drivers.keys()];
  }
}
