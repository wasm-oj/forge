import type { ProblemLocale } from "../../../judge/problem-model";
import {
  OfficialSubmissionResult,
  type OfficialSubmissionStatus,
} from "../../submissions/components/official-submission-result";

interface SubmissionPanelProps {
  readonly status: OfficialSubmissionStatus;
  readonly locale: ProblemLocale;
  readonly formatBytes: (bytes: number) => string;
}

export function SubmissionPanel({ status, locale, formatBytes }: SubmissionPanelProps) {
  return (
    <OfficialSubmissionResult
      status={status}
      locale={locale}
      formatBytes={formatBytes}
    />
  );
}
