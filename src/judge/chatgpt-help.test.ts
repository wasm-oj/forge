import { describe, expect, it } from "vitest";
import { LANGUAGES } from "../core/types";
import { CHATGPT_HOME_URL, buildChatGptProblemPrompt } from "./chatgpt-help";
import { judgeStarterSource } from "./project";
import { PROBLEM_LOCALES, PROBLEMS, sampleCases } from "./problems";

describe("ChatGPT problem help", () => {
  it("includes the complete localized statement, every sample, and the selected language template", () => {
    const problem = PROBLEMS[39];
    const prompt = buildChatGptProblemPrompt(problem, "zh-TW", "rust");

    expect(prompt).toContain(problem.title["zh-TW"]);
    expect(prompt).toContain(problem.statement["zh-TW"].trim());
    for (const sample of sampleCases(problem)) {
      expect(prompt).toContain(sample.input.trimEnd());
      expect(prompt).toContain(sample.output.trimEnd());
    }
    expect(prompt).toContain("## 目前語言：Rust");
    expect(prompt).toContain(judgeStarterSource(problem, "rust").trimEnd());
  });

  it("keeps the ChatGPT destination separate from the full prompt", () => {
    const problem = PROBLEMS[0];
    const prompt = buildChatGptProblemPrompt(problem, "en", "cpp");
    const url = new URL(CHATGPT_HOME_URL);

    expect(url.origin).toBe("https://chatgpt.com");
    expect(url.pathname).toBe("/");
    expect(url.search).toBe("");
    expect(prompt).toContain(problem.statement.en.trim());
    expect(prompt).toContain("## Current Language: C++");
  });

  it("can construct complete prompts for every problem, locale, and built-in language", () => {
    for (const problem of PROBLEMS) {
      for (const locale of PROBLEM_LOCALES) {
        for (const language of LANGUAGES) {
          const prompt = buildChatGptProblemPrompt(problem, locale, language);
          expect(prompt).toContain(problem.statement[locale].trim());
          expect(prompt).toContain(judgeStarterSource(problem, language).trimEnd());
        }
      }
    }
  });
});
