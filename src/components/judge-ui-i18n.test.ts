import { describe, expect, it } from "vitest";
import {
  DEFAULT_JUDGE_UI_LOCALE,
  executionTerminationLabel,
  JUDGE_UI_LOCALE_STORAGE_KEY,
  judgeUiText,
  localizedWorkerProgress,
  readJudgeUiLocale,
  verdictLabel,
  writeJudgeUiLocale,
} from "./judge-ui-i18n";

function memoryStorage(initial?: string): Pick<Storage, "getItem" | "setItem"> {
  const values = new Map<string, string>();
  if (initial !== undefined) values.set(JUDGE_UI_LOCALE_STORAGE_KEY, initial);
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value); },
  };
}

describe("judge UI localization", () => {
  it("provides complete locale-specific copy for primary workspace surfaces", () => {
    const zh = judgeUiText("zh-TW");
    const en = judgeUiText("en");

    expect(zh.topbar.submit).toBe("提交判題");
    expect(en.topbar.submit).toBe("Submit");
    expect(zh.panel.diagnostics).toBe("編譯診斷");
    expect(en.panel.diagnostics).toBe("Diagnostics");
    expect(zh.settings.localDataTitle).toBe("本機資料與隱私");
    expect(en.settings.localDataTitle).toBe("Local data and privacy");
    expect(en.judge.casesAndPoints(2, 3, 4, 5)).toBe("2 / 3 cases · 4.00 / 5 points");
    expect(zh.judge.casesAndPoints(2, 3, 4, 5)).toBe("2 / 3 筆測資 · 4.00 / 5 分");
  });

  it("keeps all static English copy free of Chinese characters", () => {
    expect(JSON.stringify(judgeUiText("en"))).not.toMatch(/[\p{Script=Han}]/u);
  });

  it("persists only supported locales and defaults missing or invalid values to English", () => {
    const storage = memoryStorage();
    expect(DEFAULT_JUDGE_UI_LOCALE).toBe("en");
    expect(readJudgeUiLocale(storage)).toBe("en");

    writeJudgeUiLocale(storage, "zh-TW");
    expect(readJudgeUiLocale(storage)).toBe("zh-TW");
    expect(readJudgeUiLocale(memoryStorage("fr"))).toBe("en");
  });

  it("localizes verdicts, termination states, and worker progress", () => {
    expect(verdictLabel("zh-TW", "wrong-answer")).toBe("答案錯誤");
    expect(verdictLabel("en", "wrong-answer")).toBe("Wrong Answer");
    expect(executionTerminationLabel("zh-TW", "memory-limit")).toBe("超過記憶體限制");
    expect(executionTerminationLabel("en", "memory-limit")).toBe("memory limit");

    const progress = { phase: "running" as const, label: "Local cases 2 / 5", progress: 0.4 };
    expect(localizedWorkerProgress(progress, "zh-TW")).toBe("本機測資 2 / 5");
    expect(localizedWorkerProgress(progress, "en")).toBe("Local cases 2 / 5");
    expect(localizedWorkerProgress({ phase: "linking", label: "Linking SDK-direct Clang objects" }, "zh-TW"))
      .toBe("正在連結");
  });
});
