import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  OfficialSubmissionResult,
  type OfficialSubmissionStatus,
} from "./official-submission-result";

const SUBMISSION_ID = "379c9081-b935-4ed7-a5d2-5d429d4bdfc5";

describe("OfficialSubmissionResult", () => {
  it("renders a completed official verdict instead of the local Judge empty state", () => {
    const status: OfficialSubmissionStatus = {
      submissionId: SUBMISSION_ID,
      connection: "completed",
      cursor: 12,
      state: "completed",
      compilePhase: "compile",
      completedCases: 4,
      totalCases: 4,
      verdict: "accepted",
      score: 100,
      deterministicCost: 134_268,
      peakMemoryBytes: 128 * 1024,
    };

    const html = renderToStaticMarkup(createElement(OfficialSubmissionResult, {
      status,
      locale: "zh-TW",
      formatBytes: (bytes) => `${bytes / 1024} KB`,
    }));

    expect(html).toContain("data-result-source=\"official\"");
    expect(html).toContain("通過");
    expect(html).toContain("100.00 分");
    expect(html).toContain("4 / 4");
    expect(html).toContain("128 KB");
    expect(html).toContain(`/submissions/${SUBMISSION_ID}`);
    expect(html).not.toContain("準備提交");
  });

  it("renders a safe aggregate while an official submission is still running", () => {
    const html = renderToStaticMarkup(createElement(OfficialSubmissionResult, {
      status: {
        submissionId: SUBMISSION_ID,
        connection: "connected",
        cursor: 4,
        state: "running",
        completedCases: 2,
        totalCases: 4,
      },
      locale: "en",
      formatBytes: (bytes) => `${bytes} B`,
    }));

    expect(html).toContain("Official result pending");
    expect(html).toContain("Official case progress: 2 / 4");
    expect(html).not.toContain("expected");
    expect(html).not.toContain("actual");
  });
});
