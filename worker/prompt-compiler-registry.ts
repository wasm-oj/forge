import {
  parsePromptCompilerLimits,
  PromptCompilerRegistry,
  type PromptCompilerLimits,
} from "../src/online-judge/prompt-compiler";

const SHA256 = /^[0-9a-f]{64}$/;
const CONFIG_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export interface HostPromptAssistPolicy {
  readonly compilerConfigId: string;
  readonly compilerConfigDigest: string;
  readonly limits: PromptCompilerLimits;
}

function parseAssistPolicy(value: unknown): HostPromptAssistPolicy {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Prompt Assist host policy must be an object.");
  }
  const policy = value as Record<string, unknown>;
  const actual = Object.keys(policy).sort();
  const expected = ["compilerConfigDigest", "compilerConfigId", "limits"];
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new TypeError("Prompt Assist host policy has an invalid shape.");
  }
  if (typeof policy.compilerConfigId !== "string" || !CONFIG_IDENTIFIER.test(policy.compilerConfigId)) {
    throw new TypeError("Prompt Assist compilerConfigId is invalid.");
  }
  if (typeof policy.compilerConfigDigest !== "string" || !SHA256.test(policy.compilerConfigDigest)) {
    throw new TypeError("Prompt Assist compilerConfigDigest must be a lowercase SHA-256 digest.");
  }
  return Object.freeze({
    compilerConfigId: policy.compilerConfigId,
    compilerConfigDigest: policy.compilerConfigDigest,
    limits: parsePromptCompilerLimits(policy.limits),
  });
}

/**
 * Host-owned compiler configuration. Registering an official compiler never
 * opts it into editable Assist implicitly; the host must select one immutable
 * config explicitly.
 */
export class HostPromptCompilerConfiguration {
  readonly registry: PromptCompilerRegistry;
  #assistPolicy: HostPromptAssistPolicy | null = null;

  constructor(registry = new PromptCompilerRegistry()) {
    this.registry = registry;
  }

  configureAssist(value: unknown): HostPromptAssistPolicy {
    if (this.#assistPolicy !== null) throw new TypeError("Prompt Assist host policy is already configured.");
    const policy = parseAssistPolicy(value);
    if (!this.registry.isAvailable(policy.compilerConfigId, policy.compilerConfigDigest)) {
      throw new TypeError("Prompt Assist host policy must reference an exact registered compiler config.");
    }
    this.#assistPolicy = policy;
    return policy;
  }

  assistPolicy(): HostPromptAssistPolicy | null {
    return this.#assistPolicy;
  }

  assistAvailable(): boolean {
    const policy = this.#assistPolicy;
    return policy !== null
      && this.registry.isAvailable(policy.compilerConfigId, policy.compilerConfigDigest);
  }
}

/**
 * Deliberately empty in this release. A deployment host may register pinned
 * adapters during module initialization; this repository never guesses a
 * provider or falls back to a different model/configuration.
 */
const HOST_CONFIGURATION = new HostPromptCompilerConfiguration();

export function hostPromptCompilerRegistry(): PromptCompilerRegistry {
  return HOST_CONFIGURATION.registry;
}

export function configureHostPromptAssist(value: unknown): HostPromptAssistPolicy {
  return HOST_CONFIGURATION.configureAssist(value);
}

export function hostPromptAssistPolicy(): HostPromptAssistPolicy | null {
  return HOST_CONFIGURATION.assistPolicy();
}

export function hostPromptAssistAvailable(): boolean {
  return HOST_CONFIGURATION.assistAvailable();
}
