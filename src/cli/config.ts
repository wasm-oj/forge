import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CliError, usageError } from "./errors";

export const CONFIG_KEYS = ["server", "runtime-directory", "cache-directory"] as const;
export type ConfigKey = typeof CONFIG_KEYS[number];

export interface WojConfig {
  readonly server?: string;
  readonly "runtime-directory"?: string;
  readonly "cache-directory"?: string;
}

export interface ConfigStore {
  read(): Promise<WojConfig>;
  write(config: WojConfig): Promise<void>;
}

export function defaultConfigDirectory(
  environment: Readonly<Record<string, string | undefined>> = process.env,
  platform: string = process.platform,
): string {
  if (platform === "darwin") return path.join(os.homedir(), "Library", "Application Support", "woj");
  if (platform === "win32") {
    const appData = environment.APPDATA;
    if (!appData) throw new CliError("APPDATA is required to locate woj configuration on Windows.");
    return path.join(appData, "woj");
  }
  return path.join(environment.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "woj");
}

export function defaultConfigPath(): string {
  return path.join(defaultConfigDirectory(), "config.json");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function canonicalServer(value: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw usageError("server must be an absolute HTTPS origin."); }
  const loopback = url.hostname === "127.0.0.1" || url.hostname === "[::1]" || url.hostname === "localhost";
  if ((url.protocol !== "https:" && !(loopback && url.protocol === "http:")) || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw usageError("server must be an HTTPS origin (HTTP is accepted only for loopback development).");
  }
  return url.origin;
}

export function validateConfigValue(key: ConfigKey, value: string): string {
  if (!value || value.includes("\0")) throw usageError(`${key} cannot be empty.`);
  if (key === "server") return canonicalServer(value);
  return path.resolve(value);
}

export function parseConfig(value: unknown): WojConfig {
  if (!isRecord(value)) throw new CliError("CLI configuration must be a JSON object.", { exitCode: 4, code: "config-invalid" });
  const keys = Object.keys(value);
  if (keys.some((key) => !CONFIG_KEYS.includes(key as ConfigKey))) throw new CliError("CLI configuration contains an unknown key.", { exitCode: 4, code: "config-invalid" });
  const output: Record<string, string> = {};
  for (const key of CONFIG_KEYS) {
    const candidate = value[key];
    if (candidate !== undefined) {
      if (typeof candidate !== "string") throw new CliError(`CLI configuration '${key}' must be a string.`, { exitCode: 4, code: "config-invalid" });
      try { output[key] = validateConfigValue(key, candidate); }
      catch (error) { throw new CliError(`CLI configuration '${key}' is invalid.`, { exitCode: 4, code: "config-invalid", cause: error }); }
    }
  }
  return output;
}

export class JsonConfigStore implements ConfigStore {
  constructor(readonly file = defaultConfigPath()) {}

  async read(): Promise<WojConfig> {
    let source: string;
    try { source = await readFile(this.file, "utf8"); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
      throw error;
    }
    try { return parseConfig(JSON.parse(source) as unknown); }
    catch (error) {
      if (error instanceof SyntaxError) throw new CliError(`CLI configuration is not valid JSON: '${this.file}'.`, { cause: error });
      throw error;
    }
  }

  async write(config: WojConfig): Promise<void> {
    const validated = parseConfig(config);
    await mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const temporary = `${this.file}.${process.pid}.${crypto.randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(validated, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
    await rename(temporary, this.file);
  }
}

export class MemoryConfigStore implements ConfigStore {
  private value: WojConfig;
  constructor(initial: WojConfig = {}) { this.value = parseConfig(initial); }
  read(): Promise<WojConfig> { return Promise.resolve({ ...this.value }); }
  write(config: WojConfig): Promise<void> { this.value = parseConfig(config); return Promise.resolve(); }
}

export function isConfigKey(value: string): value is ConfigKey {
  return CONFIG_KEYS.includes(value as ConfigKey);
}
