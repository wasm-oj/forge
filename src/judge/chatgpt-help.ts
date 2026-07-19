import type { BuiltinLanguage } from "../core/types";
import { judgeStarterSource } from "./project";
import {
  problemText,
  sampleCases,
  type JudgeProblem,
  type ProblemLocale,
} from "./problems";

const CHATGPT_URL = "https://chat.openai.com/";

const LANGUAGE_DETAILS: Record<BuiltinLanguage, { label: string; markdown: string }> = {
  c: { label: "C", markdown: "c" },
  cpp: { label: "C++", markdown: "cpp" },
  rust: { label: "Rust", markdown: "rust" },
  python: { label: "Python", markdown: "python" },
  javascript: { label: "JavaScript", markdown: "javascript" },
  typescript: { label: "TypeScript", markdown: "typescript" },
  go: { label: "Go", markdown: "go" },
};

function formatSamples(problem: JudgeProblem, locale: ProblemLocale): string {
  const inputLabel = locale === "zh-TW" ? "輸入" : "Input";
  const outputLabel = locale === "zh-TW" ? "輸出" : "Output";
  const exampleLabel = locale === "zh-TW" ? "範例" : "Example";
  return sampleCases(problem).map((sample, index) => [
    `### ${exampleLabel} ${index + 1}`,
    `${inputLabel}:`,
    "```text",
    sample.input.trimEnd(),
    "```",
    `${outputLabel}:`,
    "```text",
    sample.output.trimEnd(),
    "```",
  ].join("\n")).join("\n\n");
}

export function buildChatGptProblemPrompt(
  problem: JudgeProblem,
  locale: ProblemLocale,
  language: BuiltinLanguage,
): string {
  const text = problemText(problem, locale);
  const languageDetails = LANGUAGE_DETAILS[language];
  const starter = judgeStarterSource(problem, language).trimEnd();

  if (locale === "zh-TW") {
    return [
      "我正在學習以下 Online Judge 題目。請擔任程式設計導師，協助我理解題意、辨識關鍵限制，並以循序提示引導我找到合適的資料結構與演算法。除非我明確要求，請先不要直接給出完整解答。",
      `# 題目 ${problem.number}：${text.title}`,
      "## 完整題目描述",
      text.statement.trim(),
      "## 範例輸入輸出",
      formatSamples(problem, locale),
      `## 目前語言：${languageDetails.label}`,
      "## 程式碼模板",
      `\`\`\`${languageDetails.markdown}\n${starter}\n\`\`\``,
    ].join("\n\n");
  }

  return [
    "I am studying the following Online Judge problem. Act as a programming tutor: help me understand the task, identify the important constraints, and guide me toward suitable data structures and algorithms with progressive hints. Unless I explicitly ask, do not give me a complete solution yet.",
    `# Problem ${problem.number}: ${text.title}`,
    "## Complete Problem Statement",
    text.statement.trim(),
    "## Sample Input and Output",
    formatSamples(problem, locale),
    `## Current Language: ${languageDetails.label}`,
    "## Code Template",
    `\`\`\`${languageDetails.markdown}\n${starter}\n\`\`\``,
  ].join("\n\n");
}

export function buildChatGptProblemUrl(
  problem: JudgeProblem,
  locale: ProblemLocale,
  language: BuiltinLanguage,
): string {
  const url = new URL(CHATGPT_URL);
  url.searchParams.set("q", buildChatGptProblemPrompt(problem, locale, language));
  return url.toString();
}
