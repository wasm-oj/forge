import { Award, CircleStop, TriangleAlert } from "lucide-react";
import {
  executionTerminationLabel,
  judgeUiText,
  verdictLabel,
} from "../../judge/model/judge-ui-i18n";
import type { ProblemLocale } from "../../../judge/problem-model";
import {
  isTerminalSubmissionState,
  type SubmissionState,
  type SubmissionVerdict,
} from "../../../online-judge/contracts";
import type { SubmissionPollingConnectionState } from "../../../online-judge/submission-event-polling";

export interface OfficialSubmissionStatus {
  readonly submissionId: string;
  readonly connection: SubmissionPollingConnectionState;
  readonly cursor: number;
  readonly state?: SubmissionState;
  readonly compilePhase?: string;
  readonly completedCases?: number;
  readonly totalCases?: number;
  readonly verdict?: SubmissionVerdict;
  readonly score?: number;
  readonly deterministicCost?: number;
  readonly peakMemoryBytes?: number;
  readonly eventError?: string;
  readonly connectionDetail?: string;
}

interface OfficialSubmissionResultProps {
  readonly status: OfficialSubmissionStatus;
  readonly locale: ProblemLocale;
  readonly formatBytes: (bytes: number) => string;
}

function officialVerdictLabel(locale: ProblemLocale, verdict: SubmissionVerdict): string {
  switch (verdict) {
    case "instruction-limit":
    case "logical-time-limit":
    case "memory-limit":
    case "output-limit":
    case "filesystem-limit":
    case "wall-time-limit":
      return executionTerminationLabel(locale, verdict);
    case "accepted":
    case "wrong-answer":
    case "runtime-error":
    case "compile-error":
    case "judge-error":
    case "cancelled":
      return verdictLabel(locale, verdict);
  }
}

function resultTone(status: OfficialSubmissionStatus): string {
  if (status.verdict === "accepted") return "accepted";
  if (status.verdict === "cancelled" || status.state === "cancelled") return "cancelled";
  if (status.verdict === "compile-error" || status.state === "compile-error") return "compile-error";
  if (status.verdict === "wrong-answer") return "wrong-answer";
  if (status.verdict || (status.state && isTerminalSubmissionState(status.state))) return "judge-error";
  return "running";
}

export function OfficialSubmissionResult({ status, locale, formatBytes }: OfficialSubmissionResultProps) {
  const text = judgeUiText(locale);
  const terminal = status.state ? isTerminalSubmissionState(status.state) : false;
  const tone = resultTone(status);
  const heading = status.verdict
    ? officialVerdictLabel(locale, status.verdict)
    : status.eventError ?? text.official.resultPending;

  return (
    <div className="judge-results official-judge-results" data-result-source="official">
      <div className={`verdict-banner ${tone}`}>
        <span className="verdict-icon">
          {status.verdict === "accepted"
            ? <Award size={19} />
            : !terminal
              ? <span className="spinner" />
              : status.state === "cancelled"
                ? <CircleStop size={18} />
                : <TriangleAlert size={18} />}
        </span>
        <div>
          <strong>{heading}</strong>
          {status.score !== undefined && <span>{text.official.resultScore(status.score)}</span>}
          {status.state && <span>{text.official.state(status.state)}</span>}
        </div>
      </div>

      <div className="official-result-summary">
        {status.completedCases !== undefined && status.totalCases !== undefined && (
          <span>{text.official.cases(status.completedCases, status.totalCases)}</span>
        )}
        {status.compilePhase && <span>{text.official.compiling(status.compilePhase)}</span>}
        {status.deterministicCost !== undefined && status.peakMemoryBytes !== undefined && (
          <span>{text.official.resources(status.deterministicCost, formatBytes(status.peakMemoryBytes))}</span>
        )}
        <span>{text.official.submission(status.submissionId)}</span>
        {status.eventError && status.eventError !== heading && <span className="official-result-error">{status.eventError}</span>}
      </div>

      <a className="judge-link" href={`/submissions/${status.submissionId}`}>{text.official.viewSubmission}</a>
    </div>
  );
}
