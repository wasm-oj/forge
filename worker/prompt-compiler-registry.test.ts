import { describe, expect, it } from "vitest";
import { PromptCompilerRegistry, type PromptCompilerAdapter } from "../src/online-judge/prompt-compiler";
import { HostPromptCompilerConfiguration } from "./prompt-compiler-registry";

const CONFIG = {
  compilerConfigId: "fake-assist-v1",
  compilerConfigDigest: "a".repeat(64),
  adapterId: "fake-assist",
} as const;
const LIMITS = {
  promptBytes: 16 * 1024,
  inputTokens: 2_048,
  outputTokens: 4_096,
  generatedSourceBytes: 512 * 1024,
  timeoutSeconds: 30,
} as const;
const ADAPTER: PromptCompilerAdapter = {
  id: "fake-assist",
  async compile() { return { sourceFiles: [{ path: "main.c", encoding: "utf8", content: "int main(void){}" }] }; },
};

describe("host Prompt Assist policy", () => {
  it("never infers Assist availability from an ordinary compiler registration", () => {
    const registry = new PromptCompilerRegistry();
    registry.register(CONFIG, ADAPTER);
    const host = new HostPromptCompilerConfiguration(registry);

    expect(host.assistAvailable()).toBe(false);
    expect(host.assistPolicy()).toBeNull();
  });

  it("requires one explicit exact immutable config and freezes its bounded limits", () => {
    const registry = new PromptCompilerRegistry();
    registry.register(CONFIG, ADAPTER);
    const host = new HostPromptCompilerConfiguration(registry);

    const policy = host.configureAssist({
      compilerConfigId: CONFIG.compilerConfigId,
      compilerConfigDigest: CONFIG.compilerConfigDigest,
      limits: LIMITS,
    });

    expect(host.assistAvailable()).toBe(true);
    expect(policy).toEqual({
      compilerConfigId: CONFIG.compilerConfigId,
      compilerConfigDigest: CONFIG.compilerConfigDigest,
      limits: LIMITS,
    });
    expect(Object.isFrozen(policy)).toBe(true);
    expect(Object.isFrozen(policy.limits)).toBe(true);
    expect(() => host.configureAssist({
      compilerConfigId: CONFIG.compilerConfigId,
      compilerConfigDigest: CONFIG.compilerConfigDigest,
      limits: LIMITS,
    })).toThrow(/already configured/);
  });

  it("rejects unregistered or digest-mismatched policies without fallback", () => {
    const registry = new PromptCompilerRegistry();
    registry.register(CONFIG, ADAPTER);

    expect(() => new HostPromptCompilerConfiguration(registry).configureAssist({
      compilerConfigId: CONFIG.compilerConfigId,
      compilerConfigDigest: "b".repeat(64),
      limits: LIMITS,
    })).toThrow(/exact registered/);
    expect(() => new HostPromptCompilerConfiguration().configureAssist({
      compilerConfigId: CONFIG.compilerConfigId,
      compilerConfigDigest: CONFIG.compilerConfigDigest,
      limits: LIMITS,
    })).toThrow(/exact registered/);
  });
});
