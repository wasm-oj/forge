import { isTerminalSubmissionState, type SubmissionState } from "../online-judge/contracts";
import type { ProductLocale } from "./app-shell";

export interface SubmissionCostPresentation {
  readonly label: string;
  readonly value: string;
}

/** Presents the persisted, deterministic Judge cost without inventing missing measurements. */
export function submissionCostPresentation(
  submission: { readonly state: SubmissionState; readonly deterministicCost: number | null },
  locale: ProductLocale,
): SubmissionCostPresentation {
  const label = locale === "zh-TW" ? "指令成本" : "Deterministic cost";
  if (submission.deterministicCost !== null) {
    return { label, value: submission.deterministicCost.toLocaleString(locale) };
  }
  return {
    label,
    value: isTerminalSubmissionState(submission.state)
      ? (locale === "zh-TW" ? "不可用" : "Unavailable")
      : (locale === "zh-TW" ? "待定" : "Pending"),
  };
}
