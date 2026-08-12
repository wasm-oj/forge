import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { PerformanceLabView, performanceLabIdentity, readPolicySummaryResponse } from "./performance-lab";
import type { ProblemPerformanceResponse, SubmissionPolicySummaryResponse } from "../model/performance-contract";

const SELECTED_ID = "11111111-1111-4111-8111-111111111111";

const response: ProblemPerformanceResponse = {
  context: {
    problemVersionId: "22222222-2222-4222-8222-222222222222",
    contestId: "33333333-3333-4333-8333-333333333333",
    frozen: true,
    availableLanguages: ["rust", "python"],
    selectedLanguage: null,
    myEvolutionTruncated: true,
  },
  frontier: [{
    submissionId: "44444444-4444-4444-8444-444444444444",
    participant: { id: "participant-0123456789abcdef01234567", kind: "anonymous", label: "Private participant 234567" },
    language: "rust",
    score: 100,
    fullyPassedCases: 10,
    deterministicCost: 8_000,
    peakMemoryBytes: 1_048_576,
    achievedAt: "2026-08-12T00:00:00.000Z",
    isPareto: true,
  }],
  myEvolution: [{
    submissionId: "66666666-6666-4666-8666-666666666666",
    attemptNumber: 40,
    language: "python",
    state: "completed",
    verdict: "accepted",
    score: 80,
    fullyPassedCases: 8,
    deterministicCost: 16_000,
    peakMemoryBytes: 3_145_728,
    createdAt: "2026-08-12T00:30:00.000Z",
    completedAt: "2026-08-12T00:30:04.000Z",
    policySummaryAvailable: true,
  }, {
    submissionId: "55555555-5555-4555-8555-555555555555",
    attemptNumber: 41,
    language: "python",
    state: "compile-error",
    verdict: "compile-error",
    score: 0,
    fullyPassedCases: 0,
    deterministicCost: 12_000,
    peakMemoryBytes: 1_572_864,
    createdAt: "2026-08-12T01:00:00.000Z",
    completedAt: "2026-08-12T01:00:02.000Z",
    policySummaryAvailable: false,
  }, {
    submissionId: SELECTED_ID,
    attemptNumber: 42,
    language: "rust",
    state: "completed",
    verdict: "accepted",
    score: 98,
    fullyPassedCases: 10,
    deterministicCost: 9_000,
    peakMemoryBytes: 2_097_152,
    createdAt: "2026-08-12T02:00:00.000Z",
    completedAt: "2026-08-12T02:00:03.000Z",
    policySummaryAvailable: true,
  }],
};

const policySummary: SubmissionPolicySummaryResponse = {
  submissionId: SELECTED_ID,
  policySummary: {
    totalCases: 10,
    outputAcceptedCases: 10,
    policies: [
      { id: "baseline", earnedCases: 10, costExceededCases: 0, memoryExceededCases: 0, logicalTimeExceededCases: 0 },
      { id: "efficient", earnedCases: 8, costExceededCases: 2, memoryExceededCases: 1, logicalTimeExceededCases: 0 },
      { id: "optimal", earnedCases: 6, costExceededCases: 4, memoryExceededCases: 2, logicalTimeExceededCases: 1 },
    ],
  },
};

describe("Performance Lab", () => {
  it("server-renders an accessible chart, frozen context, evolution errors, and synchronized policy ladder", () => {
    const html = renderToStaticMarkup(createElement(PerformanceLabView, {
      locale: "zh-TW",
      language: "all",
      response,
      loading: false,
      selectedSubmissionId: SELECTED_ID,
      policySummary,
      policyLoading: false,
      onLanguageChange: vi.fn(),
      onSelect: vi.fn(),
    }));

    expect(html).toContain("效能實驗室");
    expect(html).toContain("競賽封榜中");
    expect(html).toContain("最近 200 次提交");
    expect(html).toContain("role=\"img\"");
    expect(html).toContain("role=\"button\"");
    expect(html).toContain("tabindex=\"0\"");
    expect(html).toContain("marker-end=\"url(#performance-arrow-");
    expect(html).toContain("全域效能前緣的可存取表格");
    expect(html).toContain("未產生效能座標的事件");
    expect(html).toContain("compile-error");
    expect(html).not.toContain('aria-label="#41, Python');

    const baseline = html.indexOf("baseline");
    const efficient = html.indexOf("efficient");
    const optimal = html.indexOf("optimal");
    expect(baseline).toBeGreaterThan(-1);
    expect(efficient).toBeGreaterThan(baseline);
    expect(optimal).toBeGreaterThan(efficient);
    expect(html).toContain("aria-label=\"optimal: 6 / 10\"");
  });

  it("keeps anonymous evolution unavailable without attempting a policy projection", () => {
    const html = renderToStaticMarkup(createElement(PerformanceLabView, {
      locale: "en",
      language: "all",
      response: { ...response, context: { ...response.context, frozen: false, myEvolutionTruncated: false }, myEvolution: null },
      loading: false,
      policyLoading: false,
      onLanguageChange: vi.fn(),
      onSelect: vi.fn(),
    }));

    expect(html).toContain("Sign in to see your evolution path and policy ladder.");
    expect(html).not.toContain("Contest freeze is active");
  });

  it("renders a readable public frontier summary and resets controller identity across problems or contests", () => {
    const frontierId = response.frontier[0]!.submissionId;
    const html = renderToStaticMarkup(createElement(PerformanceLabView, {
      locale: "en",
      language: "all",
      response,
      loading: false,
      selectedSubmissionId: frontierId,
      policySummary: { ...policySummary, submissionId: frontierId },
      policyLoading: false,
      onLanguageChange: vi.fn(),
      onSelect: vi.fn(),
    }));

    expect(html).toContain("10 / 10 cases produced accepted output");
    expect(html).not.toContain("only available for your own");
    expect(performanceLabIdentity("problem-a")).not.toBe(performanceLabIdentity("problem-b"));
    expect(performanceLabIdentity("problem-a", "contest-a")).not.toBe(performanceLabIdentity("problem-a", "contest-b"));
  });

  it("presents unreadable or missing policy summaries as an unavailable selection", () => {
    const html = renderToStaticMarkup(createElement(PerformanceLabView, {
      locale: "en",
      language: "all",
      response,
      loading: false,
      selectedSubmissionId: response.frontier[0]!.submissionId,
      policyLoading: false,
      policyUnavailable: true,
      onLanguageChange: vi.fn(),
      onSelect: vi.fn(),
    }));

    expect(html).toContain("policy summary is not readable or is not available yet");
    expect(html).not.toContain("role=\"alert\"");
  });

  it("classifies policy 404/409 as unavailable while keeping unexpected failures visible", async () => {
    await expect(readPolicySummaryResponse(new Response(JSON.stringify({ error: { message: "Not found" } }), {
      status: 404,
      headers: { "content-type": "application/json" },
    }), SELECTED_ID)).resolves.toBeNull();
    await expect(readPolicySummaryResponse(new Response(JSON.stringify({ error: { message: "Not ready" } }), {
      status: 409,
      headers: { "content-type": "application/json" },
    }), SELECTED_ID)).resolves.toBeNull();
    await expect(readPolicySummaryResponse(new Response(JSON.stringify({ error: { message: "Database unavailable" } }), {
      status: 503,
      headers: { "content-type": "application/json" },
    }), SELECTED_ID)).rejects.toThrow("Database unavailable");
  });
});
