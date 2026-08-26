import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { SubmissionSummary } from "../../catalog/model/education-model";
import type { SubmissionPolicySummaryResponse } from "../../judge/model/performance-contract";
import { requestSubmissionCancellation, SubmissionDetailActions } from "./student-records";
import { SubmissionPolicySummaryContent } from "./submission-policy-summary";

const SUBMISSION_ID = "11111111-1111-4111-8111-111111111111";

function submission(overrides: Partial<SubmissionSummary> = {}): SubmissionSummary {
  return {
    id: SUBMISSION_ID,
    problemId: "22222222-2222-4222-8222-222222222222",
    catalogCommit: "a".repeat(40),
    judgeDigest: "b".repeat(64),
    contestId: null,
    language: "rust",
    state: "running",
    verdict: null,
    visibility: "private",
    score: null,
    fullyPassedCases: null,
    deterministicCost: null,
    peakMemoryBytes: null,
    createdAt: "2026-08-13T00:00:00.000Z",
    updatedAt: "2026-08-13T00:00:00.000Z",
    completedAt: null,
    owner: true,
    sourceAvailable: true,
    problem: { slug: "sum", title: { en: "Sum" } },
    contest: null,
    ...overrides,
  };
}

describe("student submission journey", () => {
  it("offers the owner an explicit Official Submit cancellation only while nonterminal", () => {
    const active = renderToStaticMarkup(createElement(SubmissionDetailActions, {
      submission: submission(),
      locale: "en",
      cancelBusy: false,
      visibilityBusy: false,
      onCancel: vi.fn(),
      onChangeVisibility: vi.fn(),
    }));
    const terminal = renderToStaticMarkup(createElement(SubmissionDetailActions, {
      submission: submission({ state: "completed", verdict: "accepted", completedAt: "2026-08-13T00:00:01.000Z" }),
      locale: "en",
      cancelBusy: false,
      visibilityBusy: false,
      onCancel: vi.fn(),
      onChangeVisibility: vi.fn(),
    }));

    expect(active).toContain("Cancel Official Submission");
    expect(terminal).not.toContain("Cancel Official Submission");
  });

  it("uses the exact owner cancellation endpoint and validates its response", async () => {
    const mutation = vi.fn().mockResolvedValue({ submissionId: SUBMISSION_ID, state: "cancelled", changed: true });

    await expect(requestSubmissionCancellation(SUBMISSION_ID, mutation)).resolves.toEqual({
      submissionId: SUBMISSION_ID,
      state: "cancelled",
      changed: true,
    });
    expect(mutation).toHaveBeenCalledWith(`/api/submissions/${SUBMISSION_ID}/cancel`, {}, "POST");
  });

  it("renders the canonical policy order and resource misses on submission detail", () => {
    const response: SubmissionPolicySummaryResponse = {
      submissionId: SUBMISSION_ID,
      policySummary: {
        totalCases: 10,
        outputAcceptedCases: 9,
        policies: [
          { id: "baseline", earnedCases: 9, costExceededCases: 0, memoryExceededCases: 0, logicalTimeExceededCases: 0 },
          { id: "efficient", earnedCases: 7, costExceededCases: 2, memoryExceededCases: 1, logicalTimeExceededCases: 0 },
          { id: "optimal", earnedCases: 5, costExceededCases: 4, memoryExceededCases: 2, logicalTimeExceededCases: 1 },
        ],
      },
    };
    const html = renderToStaticMarkup(createElement(SubmissionPolicySummaryContent, { response, locale: "en" }));

    expect(html.indexOf("baseline")).toBeLessThan(html.indexOf("efficient"));
    expect(html.indexOf("efficient")).toBeLessThan(html.indexOf("optimal"));
    expect(html).toContain("9 / 10 cases produced accepted output");
    expect(html).toContain('aria-label="optimal: 5 / 10"');
  });
});
