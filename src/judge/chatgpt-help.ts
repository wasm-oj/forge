import type { BuiltinLanguage } from "../core/types";
import { judgeStarterSource } from "./project";
import {
  problemText,
  type JudgeProblem,
  type ProblemLocale,
} from "./problem-model";

const CHATGPT_URL = "https://chatgpt.com/";

const LANGUAGE_DETAILS: Record<BuiltinLanguage, { label: string; markdown: string }> = {
  c: { label: "C", markdown: "c" },
  cpp: { label: "C++", markdown: "cpp" },
  rust: { label: "Rust", markdown: "rust" },
  python: { label: "Python", markdown: "python" },
  javascript: { label: "JavaScript", markdown: "javascript" },
  typescript: { label: "TypeScript", markdown: "typescript" },
  go: { label: "Go", markdown: "go" },
};

export function buildChatGptProblemPrompt(
  problem: JudgeProblem,
  locale: ProblemLocale,
  language: BuiltinLanguage,
  statementUrl: string,
): string {
  const text = problemText(problem, locale);
  const languageDetails = LANGUAGE_DETAILS[language];
  const starter = judgeStarterSource(problem, language).trimEnd();

  if (locale === "zh-TW") {
    return [
      "請先開啟題目連結，讀取完整敘述與所有範例，再擔任程式設計導師，以循序提示協助我理解限制並選擇資料結構與演算法。除非我明確要求，不要直接提供完整解答；若無法存取連結，請明說，不要猜測。",
      `# 題目 ${problem.number}：${text.title}`,
      `題目連結：${statementUrl}`,
      `## 目前語言：${languageDetails.label}`,
      "## 程式碼模板",
      `\`\`\`${languageDetails.markdown}\n${starter}\n\`\`\``,
    ].join("\n\n");
  }

  return [
    "I am studying the following Online Judge problem. Act as a programming tutor: help me understand the task, identify the important constraints, and guide me toward suitable data structures and algorithms with progressive hints. Unless I explicitly ask, do not give me a complete solution yet.",
    `# Problem ${problem.number}: ${text.title}`,
    "First open the public link below and read the complete problem statement and every sample input and output before answering my question. If you cannot access the link, tell me instead of guessing the problem contents.",
    `Problem link: ${statementUrl}`,
    `## Current Language: ${languageDetails.label}`,
    "## Code Template",
    `\`\`\`${languageDetails.markdown}\n${starter}\n\`\`\``,
  ].join("\n\n");
}

export function buildChatGptProblemUrl(
  problem: JudgeProblem,
  locale: ProblemLocale,
  language: BuiltinLanguage,
  statementUrl: string,
): string {
  const url = new URL(CHATGPT_URL);
  url.searchParams.set("q", buildChatGptProblemPrompt(problem, locale, language, statementUrl));
  return url.toString();
}
