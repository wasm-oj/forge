import { describe, expect, it } from "vitest";
import { LANGUAGES } from "../core/types";
import { buildChatGptProblemPrompt, buildChatGptProblemUrl } from "./chatgpt-help";
import { judgeStarterSource } from "./project";
import { PROBLEM_LOCALES, PROBLEMS, sampleCases } from "./problems";

describe("ChatGPT problem help", () => {
  it("references the complete statement instead of embedding it and includes the selected language template", () => {
    const problem = PROBLEMS[39];
    const statementUrl = "https://raw.githubusercontent.com/wasm-oj/problems/main/problems/034-capability-cut/statement.zh-TW.md";
    const prompt = buildChatGptProblemPrompt(problem, "zh-TW", "rust", statementUrl);

    expect(prompt).toContain(problem.title["zh-TW"]);
    expect(prompt).toContain(statementUrl);
    expect(prompt).not.toContain(problem.statement["zh-TW"].trim());
    for (const sample of sampleCases(problem)) {
      expect(prompt).not.toContain(sample.input.trimEnd());
    }
    expect(prompt).toContain("## 目前語言：Rust");
    expect(prompt).toContain(judgeStarterSource(problem, "rust").trimEnd());
  });

  it("places the compact prompt directly in the one-click ChatGPT URL", () => {
    const problem = PROBLEMS[0];
    const statementUrl = "https://raw.githubusercontent.com/wasm-oj/problems/main/problems/041-progressive-cost-budget/statement.en.md";
    const prompt = buildChatGptProblemPrompt(problem, "en", "cpp", statementUrl);
    const url = new URL(buildChatGptProblemUrl(problem, "en", "cpp", statementUrl));

    expect(url.origin).toBe("https://chatgpt.com");
    expect(url.pathname).toBe("/");
    expect(url.searchParams.get("q")).toBe(prompt);
    expect(prompt).toContain(statementUrl);
    expect(prompt).toContain("## Current Language: C++");
  });

  it("keeps every problem, locale, and language URL safely below a common request-line limit", () => {
    for (const problem of PROBLEMS) {
      for (const locale of PROBLEM_LOCALES) {
        for (const language of LANGUAGES) {
          const statementUrl = `https://raw.githubusercontent.com/wasm-oj/problems/main/problems/${problem.id}/statement.${locale}.md`;
          const prompt = buildChatGptProblemPrompt(problem, locale, language, statementUrl);
          const url = buildChatGptProblemUrl(problem, locale, language, statementUrl);
          expect(prompt).not.toContain(problem.statement[locale].trim());
          expect(prompt).toContain(judgeStarterSource(problem, language).trimEnd());
          expect(url.length).toBeLessThan(2_048);
        }
      }
    }
  });
});
