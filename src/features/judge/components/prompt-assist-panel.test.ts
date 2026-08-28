import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { PromptAssistPanel } from "./prompt-assist-panel";

describe("PromptAssistPanel", () => {
  it("labels Assist as an editable ordinary-code draft, never an official Prompt Program attempt", () => {
    const html = renderToStaticMarkup(createElement(PromptAssistPanel, {
      context: {
        kind: "practice",
        problemId: "11111111-1111-4111-8111-111111111111",
        catalogCommit: "a".repeat(40),
        publicContextSha256: "b".repeat(64),
      },
      language: "c",
      entry: "main.c",
      locale: "en",
      hasNonTemplateEdits: true,
      onReplace: vi.fn(),
    }));

    expect(html).toContain("AI Assist");
    expect(html).toContain("editable draft");
    expect(html).toContain("ordinary code submission");
    expect(html).not.toContain("quota");
    expect(html).not.toContain("official Prompt Program");
  });
});
