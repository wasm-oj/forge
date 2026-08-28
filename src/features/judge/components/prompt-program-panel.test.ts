import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { ContestWorkspaceRuntime } from "../model/contest-workspace-runtime";
import { PromptProgramPanel } from "./prompt-program-panel";

const runtime: ContestWorkspaceRuntime = {
  contestId: "11111111-1111-4111-8111-111111111111",
  problemId: "22222222-2222-4222-8222-222222222222",
  timelineGeneration: 1,
  rulesEpoch: 2,
  problemEpoch: 3,
  officialTrack: {
    kind: "prompt-program",
    compiler: { configId: "fixture-v1", configDigest: "a".repeat(64) },
    limits: { promptBytes: 16_384, inputTokens: 4_096, outputTokens: 4_096, generatedSourceBytes: 1_000_000, timeoutSeconds: 60 },
    attemptPolicy: { consumeOn: "model-response-received", terminalInfrastructureFailure: "release-reservation" },
    disclosure: "private",
  },
  promptCompilerAvailable: true,
  aiAssistAvailable: false,
  promptContextSha256: "b".repeat(64),
  availability: "open",
  attemptsRemaining: 3,
  paused: false,
  phase: "running",
  runtimeState: "running",
  clock: {
    kind: "global",
    registrationOpensAt: "2026-08-27T00:00:00.000Z",
    registrationClosesAt: "2026-08-27T00:30:00.000Z",
    startsAt: "2026-08-27T01:00:00.000Z",
    durationSeconds: 1_800,
  },
  scheduleShiftSeconds: 0,
  logicalTimeSeconds: 120,
  nextBoundarySeconds: 180,
  fetchedAtMs: 0,
  judgeProvisional: false,
  entrantState: "active",
  publicRepositoryWarning: null,
};

describe("PromptProgramPanel", () => {
  it("does not render a Prompt Program action when the pinned compiler is unavailable", () => {
    const html = renderToStaticMarkup(createElement(PromptProgramPanel, {
      runtime: { ...runtime, promptCompilerAvailable: false },
      locale: "en",
    }));
    expect(html).toBe("");
  });

  it("exposes the official Prompt Program entry point only when the compiler is available", () => {
    const html = renderToStaticMarkup(createElement(PromptProgramPanel, { runtime, locale: "en" }));
    expect(html).toContain("Prompt Program");
    expect(html).toContain("Open Prompt mode");
    expect(html).toContain("3 attempts left");
    expect(html).not.toContain("Official Submit");
  });
});
