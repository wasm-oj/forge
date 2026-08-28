import { describe, expect, it, vi } from "vitest";
import { sha256Hex } from "../core/sha256";
import {
  PROMPT_COMPILER_HARD_LIMITS,
  PromptCompilerAdapterError,
  PromptCompilerError,
  PromptCompilerRegistry,
  parsePromptCompilerConfig,
  parsePromptCompilerGeneratedSourceResponse,
  parsePromptCompilerLimits,
  promptCompilerResultToAssistDraft,
  validatePromptCompilerPrompt,
  verifyPromptCompilerPublicContext,
  type PromptCompilerAdapter,
  type PromptCompilerConfig,
} from "./prompt-compiler";

const COMPILER_CONFIG_DIGEST = "a".repeat(64);
const OTHER_COMPILER_CONFIG_DIGEST = "b".repeat(64);
const OUTPUT = {
  language: "c",
  target: "wasip1",
  optimization: "release",
  entry: "src/main.c",
} as const;
const LIMITS = {
  promptBytes: PROMPT_COMPILER_HARD_LIMITS.promptBytes,
  inputTokens: 8_192,
  outputTokens: 4_096,
  generatedSourceBytes: PROMPT_COMPILER_HARD_LIMITS.outputBytes,
  timeoutSeconds: 30,
} as const;

function configValue(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    compilerConfigId: "fixture.compiler.v1",
    compilerConfigDigest: COMPILER_CONFIG_DIGEST,
    adapterId: "fixture-adapter",
    ...overrides,
  };
}

function responseValue(content = "int main(void) { return 0; }\n"): Record<string, unknown> {
  return {
    sourceFiles: [
      { path: "src/support.h", encoding: "utf8", content: "#pragma once\n" },
      { path: "src/main.c", encoding: "utf8", content },
    ],
  };
}

async function publicContext(content = "Public problem statement\n") {
  return { content, sha256: await sha256Hex(content) };
}

function registeredRegistry(
  compile: PromptCompilerAdapter["compile"],
  overrides: Record<string, unknown> = {},
): { readonly registry: PromptCompilerRegistry; readonly config: PromptCompilerConfig } {
  const registry = new PromptCompilerRegistry();
  const config = registry.register(configValue(overrides), { id: "fixture-adapter", compile });
  return { registry, config };
}

describe("prompt compiler config", () => {
  it("parses an exact deeply immutable provider-neutral config", () => {
    const raw = configValue();
    const parsed = parsePromptCompilerConfig(raw);

    expect(parsed).toEqual(raw);
    expect(Object.isFrozen(parsed)).toBe(true);
  });

  it("rejects unknown fields and malformed immutable identities", () => {
    const invalid = [
      { ...configValue(), credentials: "secret" },
      configValue({ compilerConfigDigest: "A".repeat(64) }),
      configValue({ adapterId: "not portable" }),
    ];

    for (const candidate of invalid) {
      expect(() => parsePromptCompilerConfig(candidate)).toThrowError(expect.objectContaining({
        code: "prompt-compiler-config-invalid",
        attemptDisposition: "not-reserved",
      }));
    }
  });

  it("parses bounded per-contest invocation limits independently of the compiler pin", () => {
    expect(parsePromptCompilerLimits(LIMITS)).toEqual(LIMITS);
    for (const limits of [
      { ...LIMITS, promptBytes: 16_385 },
      { ...LIMITS, inputTokens: 0 },
      { ...LIMITS, generatedSourceBytes: 1_048_577 },
      { ...LIMITS, timeoutSeconds: 3_601 },
    ]) expect(() => parsePromptCompilerLimits(limits)).toThrow("Prompt compiler");
  });

  it("registers each immutable config ID once and binds it to the declared adapter", () => {
    const registry = new PromptCompilerRegistry();
    const adapter = { id: "fixture-adapter", compile: async () => responseValue() };
    registry.register(configValue(), adapter);

    expect(registry.isAvailable("fixture.compiler.v1", COMPILER_CONFIG_DIGEST)).toBe(true);
    expect(registry.isAvailable("fixture.compiler.v1", OTHER_COMPILER_CONFIG_DIGEST)).toBe(false);
    expect(registry.isAvailable("unknown", COMPILER_CONFIG_DIGEST)).toBe(false);
    expect(() => registry.register(configValue(), adapter)).toThrow("already registered");
    expect(() => new PromptCompilerRegistry().register(configValue(), { ...adapter, id: "other" }))
      .toThrow("does not match adapter");
  });
});

describe("prompt compiler input validation", () => {
  it("enforces a single exact Unicode-scalar prompt by UTF-8 bytes", () => {
    const maximum = PROMPT_COMPILER_HARD_LIMITS.promptBytes;
    expect(validatePromptCompilerPrompt("x".repeat(maximum), maximum)).toHaveLength(maximum);
    expect(() => validatePromptCompilerPrompt("😀".repeat(maximum / 4 + 1), maximum)).toThrowError(
      expect.objectContaining({ code: "prompt-invalid", attemptDisposition: "not-reserved" }),
    );
    expect(() => validatePromptCompilerPrompt("", maximum)).toThrow("non-empty");
    expect(() => validatePromptCompilerPrompt("\ud800", maximum)).toThrow("Unicode scalar");
    expect(() => validatePromptCompilerPrompt("x", maximum + 1)).toThrowError(
      expect.objectContaining({ code: "prompt-compiler-config-invalid" }),
    );
  });

  it("verifies the digest of the exact public UTF-8 context", async () => {
    const context = await publicContext("statement\n");
    await expect(verifyPromptCompilerPublicContext(context)).resolves.toEqual(context);
    await expect(verifyPromptCompilerPublicContext({ ...context, content: "statement" })).rejects.toMatchObject({
      code: "prompt-context-integrity",
      status: 409,
      attemptDisposition: "not-reserved",
    });
    await expect(verifyPromptCompilerPublicContext({ ...context, hiddenJudgeData: "secret" })).rejects.toMatchObject({
      code: "prompt-context-integrity",
      attemptDisposition: "not-reserved",
    });
  });
});

describe("prompt compiler structured response", () => {
  it("accepts only exact UTF-8 source objects and returns canonical locked file order", () => {
    const generated = parsePromptCompilerGeneratedSourceResponse(responseValue(), OUTPUT, LIMITS);

    expect(generated).toEqual({
      output: OUTPUT,
      entry: "src/main.c",
      sourceFiles: [
        { path: "src/main.c", encoding: "utf8", content: "int main(void) { return 0; }\n" },
        { path: "src/support.h", encoding: "utf8", content: "#pragma once\n" },
      ],
    });
    expect(Object.isFrozen(generated)).toBe(true);
    expect(Object.isFrozen(generated.sourceFiles)).toBe(true);
    expect(generated.sourceFiles.every(Object.isFrozen)).toBe(true);
  });

  it("never treats JSON text, markdown, extra fields, binary, or missing entry as source", () => {
    const invalid = [
      JSON.stringify(responseValue()),
      `\`\`\`json\n${JSON.stringify(responseValue())}\n\`\`\``,
      { ...responseValue(), explanation: "trust me" },
      { sourceFiles: [{ path: "src/main.c", encoding: "base64", content: "eA==" }] },
      { sourceFiles: [{ path: "src/other.c", encoding: "utf8", content: "" }] },
      { sourceFiles: [
        { path: "src/main.c", encoding: "utf8", content: "a" },
        { path: "src/main.c", encoding: "utf8", content: "b" },
      ] },
      { sourceFiles: [{ path: "../src/main.c", encoding: "utf8", content: "" }] },
      { sourceFiles: [{ path: "src/main.c", encoding: "utf8", content: "\ud800" }] },
    ];

    for (const candidate of invalid) {
      expect(() => parsePromptCompilerGeneratedSourceResponse(candidate, OUTPUT, LIMITS))
        .toThrowError(expect.objectContaining({
          code: "prompt-response-invalid",
          status: 502,
          attemptDisposition: "consume",
        }));
    }
  });

  it("reuses official file-count, per-file, and aggregate source limits", () => {
    expect(() => parsePromptCompilerGeneratedSourceResponse({
      sourceFiles: [{ path: "src/main.c", encoding: "utf8", content: "x".repeat(256 * 1024 + 1) }],
    }, OUTPUT, LIMITS)).toThrow("exceeds 262144 bytes");

    expect(() => parsePromptCompilerGeneratedSourceResponse({
      sourceFiles: Array.from({ length: 129 }, (_, index) => ({
        path: index === 0 ? "src/main.c" : `src/${index}.c`,
        encoding: "utf8",
        content: "",
      })),
    }, OUTPUT, LIMITS)).toThrow("between 1 and 128 files");

    const threeByteLimit = parsePromptCompilerLimits({ ...LIMITS, generatedSourceBytes: 3 });
    expect(() => parsePromptCompilerGeneratedSourceResponse({
      sourceFiles: [{ path: "src/main.c", encoding: "utf8", content: "😀" }],
    }, OUTPUT, threeByteLimit)).toThrow("3-byte generated source limit");
  });
});

describe("prompt compiler registry invocation semantics", () => {
  it("passes only validated public input and classifies a resolved response as consumed", async () => {
    const compile = vi.fn<PromptCompilerAdapter["compile"]>(async () => responseValue());
    const { registry, config } = registeredRegistry(compile);
    const context = await publicContext();

    const result = await registry.compile({
      compilerConfigId: config.compilerConfigId,
      compilerConfigDigest: config.compilerConfigDigest,
      output: OUTPUT,
      limits: LIMITS,
      publicContext: context,
      prompt: "Write a correct C program.",
    });

    expect(result).toMatchObject({
      compilerConfigId: config.compilerConfigId,
      compilerConfigDigest: config.compilerConfigDigest,
      publicContextSha256: context.sha256,
      attemptDisposition: "consume",
      output: OUTPUT,
      entry: "src/main.c",
    });
    expect(compile).toHaveBeenCalledOnce();
    expect(compile.mock.calls[0]?.[0]).toEqual({
      config,
      output: OUTPUT,
      limits: LIMITS,
      publicContext: context,
      prompt: "Write a correct C program.",
      signal: expect.anything(),
    });
    expect(Object.isFrozen(compile.mock.calls[0]?.[0])).toBe(true);
  });

  it("keeps one compiler pin while accepting a distinct trusted output profile per problem", async () => {
    const { registry, config } = registeredRegistry(async ({ output }) => ({
      sourceFiles: [{ path: output.entry, encoding: "utf8", content: "source" }],
    }));
    const context = await publicContext();
    const rustOutput = {
      language: "rust",
      target: "wasip1",
      optimization: "release",
      entry: "src/main.rs",
    } as const;
    const common = {
      compilerConfigId: config.compilerConfigId,
      compilerConfigDigest: config.compilerConfigDigest,
      publicContext: context,
      prompt: "solve",
      limits: LIMITS,
    };
    const [c, rust] = await Promise.all([
      registry.compile({ ...common, output: OUTPUT }),
      registry.compile({ ...common, output: rustOutput }),
    ]);
    expect(c.output).toEqual(OUTPUT);
    expect(rust.output).toEqual(rustOutput);
    expect(rust.sourceFiles[0]?.path).toBe("src/main.rs");
  });

  it("reports an unregistered compiler as typed 503 before reservation", async () => {
    await expect(new PromptCompilerRegistry().compile({
      compilerConfigId: "missing.compiler",
      compilerConfigDigest: COMPILER_CONFIG_DIGEST,
      output: OUTPUT,
      limits: LIMITS,
      publicContext: await publicContext(),
      prompt: "code",
    })).rejects.toMatchObject({
      name: "PromptCompilerError",
      code: "prompt-compiler-unavailable",
      status: 503,
      retryable: true,
      attemptDisposition: "not-reserved",
    });
  });

  it("rejects a digest that does not identify the registered immutable config", async () => {
    const compile = vi.fn<PromptCompilerAdapter["compile"]>(async () => responseValue());
    const { registry, config } = registeredRegistry(compile);
    await expect(registry.compile({
      compilerConfigId: config.compilerConfigId,
      compilerConfigDigest: OTHER_COMPILER_CONFIG_DIGEST,
      output: OUTPUT,
      limits: LIMITS,
      publicContext: await publicContext(),
      prompt: "code",
    })).rejects.toMatchObject({
      code: "prompt-compiler-config-mismatch",
      status: 409,
      attemptDisposition: "not-reserved",
    });
    expect(compile).not.toHaveBeenCalled();
  });

  it("releases quota for declared or unexpected failures before a response", async () => {
    const declared = registeredRegistry(async () => {
      throw new PromptCompilerAdapterError("Provider is temporarily unavailable.", true);
    });
    await expect(declared.registry.compile({
      compilerConfigId: declared.config.compilerConfigId,
      compilerConfigDigest: declared.config.compilerConfigDigest,
      output: OUTPUT,
      limits: LIMITS,
      publicContext: await publicContext(),
      prompt: "code",
    })).rejects.toMatchObject({
      code: "prompt-provider-failure",
      status: 502,
      retryable: true,
      attemptDisposition: "release",
    });

    const unexpected = registeredRegistry(async () => {
      throw new Error("credential-bearing internal error");
    });
    await expect(unexpected.registry.compile({
      compilerConfigId: unexpected.config.compilerConfigId,
      compilerConfigDigest: unexpected.config.compilerConfigDigest,
      output: OUTPUT,
      limits: LIMITS,
      publicContext: await publicContext(),
      prompt: "code",
    })).rejects.toMatchObject({
      message: "Prompt compiler provider failed before returning a response.",
      code: "prompt-provider-failure",
      retryable: true,
      attemptDisposition: "release",
    });
  });

  it("enforces the host boundary timeout even when an adapter ignores cancellation", async () => {
    vi.useFakeTimers();
    try {
      let receivedSignal: AbortSignal | undefined;
      const { registry, config } = registeredRegistry(async (request) => {
        receivedSignal = request.signal;
        return new Promise<never>(() => undefined);
      });
      const compilation = registry.compile({
        compilerConfigId: config.compilerConfigId,
        compilerConfigDigest: config.compilerConfigDigest,
        output: OUTPUT,
        limits: { ...LIMITS, timeoutSeconds: 1 },
        publicContext: await publicContext(),
        prompt: "code",
      });
      const expectation = expect(compilation).rejects.toMatchObject({
        code: "prompt-provider-failure",
        retryable: true,
        attemptDisposition: "release",
      });
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(1_000);
      await expectation;
      expect(receivedSignal?.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("consumes quota when a provider resolves with a malformed response", async () => {
    const { registry, config } = registeredRegistry(async () => "```c\nint main(){}\n```");
    await expect(registry.compile({
      compilerConfigId: config.compilerConfigId,
      compilerConfigDigest: config.compilerConfigDigest,
      output: OUTPUT,
      limits: LIMITS,
      publicContext: await publicContext(),
      prompt: "code",
    })).rejects.toMatchObject({
      code: "prompt-response-invalid",
      status: 502,
      retryable: false,
      attemptDisposition: "consume",
    });
  });

  it("does not call the adapter when prompt or context admission fails", async () => {
    const compile = vi.fn<PromptCompilerAdapter["compile"]>(async () => responseValue());
    const { registry, config } = registeredRegistry(compile);
    const context = await publicContext();

    await expect(registry.compile({
      compilerConfigId: config.compilerConfigId,
      compilerConfigDigest: config.compilerConfigDigest,
      output: OUTPUT,
      limits: LIMITS,
      publicContext: context,
      prompt: "",
    })).rejects.toBeInstanceOf(PromptCompilerError);
    await expect(registry.compile({
      compilerConfigId: config.compilerConfigId,
      compilerConfigDigest: config.compilerConfigDigest,
      output: OUTPUT,
      limits: LIMITS,
      publicContext: { ...context, content: "changed" },
      prompt: "code",
    })).rejects.toMatchObject({ code: "prompt-context-integrity" });
    expect(compile).not.toHaveBeenCalled();
  });

  it("copies fake-adapter output into an editable Assist draft without official Prompt identity", async () => {
    const { registry, config } = registeredRegistry(async () => responseValue());
    const generated = await registry.compile({
      compilerConfigId: config.compilerConfigId,
      compilerConfigDigest: config.compilerConfigDigest,
      output: OUTPUT,
      limits: LIMITS,
      publicContext: await publicContext(),
      prompt: "draft a solution",
    });
    const draft = promptCompilerResultToAssistDraft(generated);
    draft.sourceFiles[0]!.content = "int main(void) { return 7; }\n";
    expect(draft.sourceFiles[0]!.content).not.toBe(generated.sourceFiles[0]!.content);
    expect(Object.hasOwn(draft, "compilerConfigId")).toBe(false);
    expect(Object.hasOwn(draft, "attemptDisposition")).toBe(false);
  });
});
