import { CliError } from "./errors";

const SERVICE = "wasm-oj";
export const WOJ_ACCESS_TOKEN = /^[A-Za-z0-9_-]{43}$/;

export function isWojAccessToken(value: unknown): value is string {
  return typeof value === "string" && WOJ_ACCESS_TOKEN.test(value);
}

export interface TokenStore {
  get(serverOrigin: string): Promise<string | undefined>;
  set(serverOrigin: string, token: string): Promise<void>;
  delete(serverOrigin: string): Promise<void>;
}

interface KeyringEntry {
  getPassword(): string | null;
  setPassword(password: string): void;
  deletePassword(): boolean;
}

type KeyringConstructor = new (service: string, account: string) => KeyringEntry;

export class OsKeychainTokenStore implements TokenStore {
  private constructorPromise?: Promise<KeyringConstructor>;

  private constructor_(): Promise<KeyringConstructor> {
    this.constructorPromise ??= import("@napi-rs/keyring")
      .then((module) => module.Entry as KeyringConstructor)
      .catch((error: unknown) => {
        throw new CliError("The OS keychain adapter could not be loaded; woj will not store credentials in a file.", {
          code: "keychain-unavailable",
          exitCode: 7,
          cause: error,
        });
      });
    return this.constructorPromise;
  }

  private async entry(serverOrigin: string): Promise<KeyringEntry> {
    const Entry = await this.constructor_();
    return new Entry(SERVICE, new URL(serverOrigin).origin);
  }

  async get(serverOrigin: string): Promise<string | undefined> {
    try { return (await this.entry(serverOrigin)).getPassword() ?? undefined; }
    catch (error) {
      if (error instanceof CliError) throw error;
      throw new CliError("The OS keychain could not read the woj credential.", { code: "keychain-read-failed", exitCode: 7, cause: error });
    }
  }

  async set(serverOrigin: string, token: string): Promise<void> {
    if (!isWojAccessToken(token)) {
      throw new CliError("Refusing to store a malformed woj access token.", { code: "access-token-invalid", exitCode: 7 });
    }
    try { (await this.entry(serverOrigin)).setPassword(token); }
    catch (error) {
      if (error instanceof CliError) throw error;
      throw new CliError("The OS keychain could not store the woj credential.", { code: "keychain-write-failed", exitCode: 7, cause: error });
    }
  }

  async delete(serverOrigin: string): Promise<void> {
    try { (await this.entry(serverOrigin)).deletePassword(); }
    catch (error) {
      if (error instanceof CliError) throw error;
      throw new CliError("The OS keychain could not delete the woj credential.", { code: "keychain-delete-failed", exitCode: 7, cause: error });
    }
  }
}

export class MemoryTokenStore implements TokenStore {
  private readonly tokens = new Map<string, string>();
  get(serverOrigin: string): Promise<string | undefined> { return Promise.resolve(this.tokens.get(new URL(serverOrigin).origin)); }
  set(serverOrigin: string, token: string): Promise<void> {
    if (!isWojAccessToken(token)) throw new CliError("Refusing to store a malformed woj access token.", { code: "access-token-invalid", exitCode: 7 });
    this.tokens.set(new URL(serverOrigin).origin, token);
    return Promise.resolve();
  }
  delete(serverOrigin: string): Promise<void> { this.tokens.delete(new URL(serverOrigin).origin); return Promise.resolve(); }
}
