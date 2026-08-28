import { describe, expect, it, vi } from "vitest";
import { sha256Hex } from "../src/core/sha256";
import {
  PromptCompilerRegistry,
  type PromptCompilerAdapter,
  type PromptCompilerAdapterRequest,
} from "../src/online-judge/prompt-compiler";
import { ApiError } from "./http";
import {
  parsePromptAssistRequest,
  PromptAssistService,
  type PromptAssistAdmission,
  type PromptAssistHost,
  type PromptAssistRequest,
} from "./prompt-assist";
import type { HostPromptAssistPolicy } from "./prompt-compiler-registry";

const PROBLEM_ID = "11111111-1111-4111-8111-111111111111";
const COMMIT = "a".repeat(40);
const CONFIG = {
  compilerConfigId: "fake-assist-v1",
  compilerConfigDigest: "b".repeat(64),
  adapterId: "fake-assist",
} as const;
const POLICY: HostPromptAssistPolicy = {
  compilerConfigId: CONFIG.compilerConfigId,
  compilerConfigDigest: CONFIG.compilerConfigDigest,
  limits: {
    promptBytes: 16 * 1024,
    inputTokens: 2_048,
    outputTokens: 4_096,
    generatedSourceBytes: 128 * 1024,
    timeoutSeconds: 30,
  },
};

async function fixture(options: {
  readonly secondGuardCommit?: string;
  readonly contextContent?: string;
  readonly malformed?: boolean;
} = {}) {
  const content = options.contextContent ?? JSON.stringify({ problem: "sum" });
  const contextSha256 = await sha256Hex(content);
  const request: PromptAssistRequest = {
    context: {
      kind: "practice",
      problemId: PROBLEM_ID,
      catalogCommit: COMMIT,
      publicContextSha256: contextSha256,
    },
    language: "c",
    entry: "main.c",
    prompt: "Write a correct solution.",
  };
  const adapterCompile = vi.fn(async (input: PromptCompilerAdapterRequest) => {
    void input;
    return options.malformed
      ? { source: "not structured" }
      : { sourceFiles: [{ path: "main.c", encoding: "utf8", content: "int main(void) { return 0; }" }] };
  });
  const adapter: PromptCompilerAdapter = { id: CONFIG.adapterId, compile: adapterCompile };
  const registry = new PromptCompilerRegistry();
  registry.register(CONFIG, adapter);
  let reads = 0;
  const admission = (): PromptAssistAdmission => ({
    context: request.context,
    output: { language: "c", target: "wasip1", optimization: "release", entry: "main.c" },
    publicContext: { sha256: contextSha256, bytes: new TextEncoder().encode(content).byteLength, storageKey: `prompt-contexts/v1/${contextSha256}` },
    guard: {
      kind: "practice",
      catalogCommit: reads > 1 && options.secondGuardCommit ? options.secondGuardCommit : COMMIT,
      practiceBundleSha256: contextSha256,
    },
  });
  const host: PromptAssistHost = {
    loadAdmission: vi.fn(async () => { reads += 1; return admission(); }),
    loadPublicContext: vi.fn(async () => ({ content, sha256: contextSha256 })),
  };
  return { request, registry, host, adapterCompile };
}

describe("Prompt Assist service", () => {
  it("rejects an exact-shape violation before touching the provider", async () => {
    const value = {
      context: {
        kind: "practice", problemId: PROBLEM_ID, catalogCommit: COMMIT,
        publicContextSha256: "c".repeat(64), extra: true,
      },
      language: "c", entry: "main.c", prompt: "hello",
    };
    expect(() => parsePromptAssistRequest(value)).toThrow(/invalid shape/);
  });

  it("keeps production-style empty policy unavailable without admission or fallback", async () => {
    const { request, registry, host, adapterCompile } = await fixture();
    const service = new PromptAssistService(registry, null, host);

    await expect(service.generate(request)).rejects.toMatchObject({
      status: 503,
      code: "prompt-compiler-unavailable",
    });
    expect(host.loadAdmission).not.toHaveBeenCalled();
    expect(adapterCompile).not.toHaveBeenCalled();
  });

  it("uses the server-derived profile and returns only an editable non-official draft", async () => {
    const { request, registry, host, adapterCompile } = await fixture();
    const service = new PromptAssistService(registry, POLICY, host);

    const response = await service.generate(request);

    expect(adapterCompile).toHaveBeenCalledOnce();
    expect(adapterCompile.mock.calls[0]![0]).toMatchObject({
      config: CONFIG,
      output: { language: "c", target: "wasip1", optimization: "release", entry: "main.c" },
      prompt: request.prompt,
      publicContext: { sha256: request.context.publicContextSha256 },
    });
    expect(response).toMatchObject({
      schema: "wasm-oj-platform/prompt-assist-result/v1",
      context: request.context,
      output: { language: "c", target: "wasip1", optimization: "release", entry: "main.c" },
      entry: "main.c",
      sourceFiles: [{ path: "main.c", encoding: "utf8" }],
    });
    expect(response).not.toHaveProperty("compilerConfigId");
    expect(response).not.toHaveProperty("compilerConfigDigest");
    expect(response).not.toHaveProperty("attemptDisposition");
    expect(response).not.toHaveProperty("promptAttemptId");
    response.sourceFiles[0]!.content = "/* edited before ordinary code submission */";
    expect(response.sourceFiles[0]!.content).toContain("edited");
    expect(host.loadAdmission).toHaveBeenCalledTimes(2);
  });

  it("discards a valid model response when the post-generation fence changes", async () => {
    const { request, registry, host } = await fixture({ secondGuardCommit: "d".repeat(40) });
    const service = new PromptAssistService(registry, POLICY, host);

    await expect(service.generate(request)).rejects.toMatchObject({
      status: 409,
      code: "assist-context-stale",
    });
    expect(host.loadAdmission).toHaveBeenCalledTimes(2);
  });

  it("keeps strict structured response parsing and never accepts fallback source text", async () => {
    const { request, registry, host } = await fixture({ malformed: true });
    const service = new PromptAssistService(registry, POLICY, host);

    try {
      await service.generate(request);
      throw new Error("Expected malformed model output to fail.");
    } catch (error) {
      expect(error).toBeInstanceOf(ApiError);
      expect(error).toMatchObject({ status: 502, code: "prompt-response-invalid" });
    }
    expect(host.loadAdmission).toHaveBeenCalledTimes(1);
  });
});
