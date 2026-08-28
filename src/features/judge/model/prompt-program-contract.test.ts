import { describe, expect, it } from "vitest";
import {
  parseGeneratedSource,
  parsePromptAttemptAccepted,
  parsePromptAttemptDetailResponse,
  parsePromptAttemptHistoryResponse,
  promptUtf8Bytes,
} from "./prompt-program-contract";

const ATTEMPT_ID = "11111111-1111-4111-8111-111111111111";
const CONTEST_ID = "22222222-2222-4222-8222-222222222222";
const ENTRANT_ID = "33333333-3333-4333-8333-333333333333";
const PROBLEM_ID = "44444444-4444-4444-8444-444444444444";
const SUBMISSION_ID = "55555555-5555-4555-8555-555555555555";
const SHA = "a".repeat(64);
const TIMESTAMP = "2026-08-27T00:00:00.000Z";

describe("Prompt Program frontend contracts", () => {
  it("accepts exact history and rejects added fields", () => {
    const item = {
      attemptId: ATTEMPT_ID,
      contestId: CONTEST_ID,
      problemId: PROBLEM_ID,
      state: "submitted",
      quotaState: "consumed",
      submissionId: SUBMISSION_ID,
      failureCode: null,
      eligibility: "eligible",
      createdAt: TIMESTAMP,
      updatedAt: TIMESTAMP,
    };
    expect(parsePromptAttemptHistoryResponse({ promptAttempts: [item] })).toHaveLength(1);
    expect(() => parsePromptAttemptHistoryResponse({ promptAttempts: [{ ...item, legacyLanguage: "prompt" }] })).toThrow(/invalid shape/);
  });

  it("binds accepted URLs to the returned attempt identity", () => {
    expect(parsePromptAttemptAccepted({
      promptAttemptId: ATTEMPT_ID,
      state: "reserved",
      replayed: false,
      detailUrl: `https://judge.example/api/prompt-attempts/${ATTEMPT_ID}`,
      eventsUrl: `https://judge.example/api/prompt-attempts/${ATTEMPT_ID}/events`,
    }).promptAttemptId).toBe(ATTEMPT_ID);
    expect(() => parsePromptAttemptAccepted({
      promptAttemptId: ATTEMPT_ID,
      state: "reserved",
      replayed: true,
      detailUrl: `/api/prompt-attempts/${CONTEST_ID}`,
      eventsUrl: `/api/prompt-attempts/${ATTEMPT_ID}/events`,
    })).toThrow(/identity/);
  });

  it("parses invalid attempt provenance without treating it as official", () => {
    const detail = parsePromptAttemptDetailResponse({ promptAttempt: {
      attemptId: ATTEMPT_ID,
      contestId: CONTEST_ID,
      entrantId: ENTRANT_ID,
      problemId: PROBLEM_ID,
      timelineGeneration: 2,
      rulesEpoch: 3,
      problemEpoch: 7,
      contentEpoch: 4,
      judgeEpoch: 5,
      compilerConfigId: "fixture-v1",
      compilerConfigDigest: SHA,
      publicContextSha256: SHA,
      prompt: "Solve it.",
      promptBytes: 9,
      promptSha256: SHA,
      output: { language: "rust", target: "wasip1", optimization: "release", entry: "src/main.rs" },
      state: "submitted",
      quota: { slot: 1, limit: 3, state: "invalid", settlementReason: "timeline-rewind" },
      generatedSourceId: SUBMISSION_ID,
      generatedSourceSha256: SHA,
      submissionId: SUBMISSION_ID,
      admittedLogicalSeconds: 70,
      evidenceLogicalSeconds: 72,
      responseReceivedAt: TIMESTAMP,
      sourceReadyAt: TIMESTAMP,
      terminalAt: TIMESTAMP,
      providerDurationMs: 2_000,
      failureCode: null,
      eligibility: "invalid",
      invalidationReason: "timeline-rewind",
      erasedAt: null,
      createdAt: TIMESTAMP,
      updatedAt: TIMESTAMP,
    } });
    expect(detail.eligibility).toBe("invalid");
    expect(detail.problemEpoch).toBe(7);
    expect(detail.invalidationReason).toBe("timeline-rewind");
  });

  it("parses only locked structured generated sources", () => {
    const source = parseGeneratedSource({
      schema: "wasm-oj-platform/official-source/v1",
      sourceDigest: SHA,
      request: {
        language: "rust",
        target: "wasip1",
        optimization: "release",
        entry: "src/main.rs",
        sourceFiles: [{ path: "src/main.rs", encoding: "utf8", content: "fn main() {}" }],
      },
    });
    expect(source.request.sourceFiles[0]?.path).toBe("src/main.rs");
    expect(() => parseGeneratedSource({
      schema: "wasm-oj-platform/official-source/v1",
      sourceDigest: SHA,
      request: {
        language: "rust",
        target: "wasip1",
        optimization: "release",
        entry: "src/main.rs",
        sourceFiles: [{ path: "src/main.rs", encoding: "utf8", content: "fn main() {}", editable: true }],
      },
    })).toThrow(/invalid shape/);
  });

  it("counts the actual UTF-8 quota", () => {
    expect(promptUtf8Bytes("城市")).toBe(6);
  });
});
