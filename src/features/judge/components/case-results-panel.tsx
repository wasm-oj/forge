import { Award, CheckCircle2, Target, TriangleAlert, X } from "lucide-react";
import type { JudgeUiCaseResult, JudgeUiSession } from "../../../judge/judge";
import type { JudgeProblem, ProblemLocale } from "../../../judge/problem-model";
import { verdictLabel, type JudgeUiText } from "../model/judge-ui-i18n";
import { CaseScoreDetails } from "./case-score-details";

interface CaseResultsPanelProps {
  readonly session?: JudgeUiSession;
  readonly selectedCase?: JudgeUiCaseResult;
  readonly problem: JudgeProblem;
  readonly locale: ProblemLocale;
  readonly text: JudgeUiText;
  readonly formatBytes: (bytes: number) => string;
  readonly formatDuration: (milliseconds: number) => string;
  readonly onSelectCase: (number: number) => void;
  readonly onViewDiagnostics: () => void;
}

export function CaseResultsPanel({
  session,
  selectedCase,
  problem,
  locale,
  text,
  formatBytes,
  formatDuration,
  onSelectCase,
  onViewDiagnostics,
}: CaseResultsPanelProps) {
  if (!session) {
    return <div className="empty-panel judge-empty"><Target size={18} /><strong>{text.judge.ready}</strong><span>{text.judge.readyDescription}</span></div>;
  }

  return (
    <div className="judge-results">
      <div className={`verdict-banner ${session.verdict}`}>
        <span className="verdict-icon">{session.verdict === "accepted" ? <Award size={19} /> : session.verdict === "running" ? <span className="spinner" /> : <TriangleAlert size={18} />}</span>
        <div>
          <strong>
            {session.verdict === "accepted"
              && session.score
              && session.score.points < session.score.maximumPoints
              ? text.judge.partialScore
              : verdictLabel(locale, session.verdict)}
          </strong>
          <span>
            {text.judge.casesAndPoints(
              session.completed,
              session.total,
              session.score?.points,
              session.score?.maximumPoints,
            )}
            {` · ${formatDuration(session.durationMs)}`}
          </span>
          {session.message && <span>{session.message}</span>}
        </div>
      </div>
      {session.verdict === "compile-error" && <button className="judge-link" onClick={onViewDiagnostics}>{text.judge.viewDiagnostics}</button>}
      <div className="case-list">
        {session.cases.map((test) => (
          <div
            className={`case-card ${test.verdict} ${selectedCase?.number === test.number ? "selected" : ""}`}
            key={test.number}
          >
            <button
              className="case-row"
              onClick={() => onSelectCase(test.number)}
              aria-pressed={selectedCase?.number === test.number}
              type="button"
            >
              <span className="case-status">{test.verdict === "accepted" ? <CheckCircle2 size={15} /> : <X size={15} />}</span>
              <strong>{text.judge.case(test.number)}</strong>
              <span>
                {test.verdict === "accepted" ? text.judge.correctOutput : verdictLabel(locale, test.verdict)}
                {test.points === undefined ? "" : ` · ${test.points} ${text.judge.pointsShort}`}
              </span>
              <time>{formatDuration(test.durationMs)}</time>
              {test.metrics && (
                <span className="case-metrics-summary">
                  {test.metrics.cost === null ? "—" : `${test.metrics.cost.toLocaleString()} cost`}
                  {" · "}
                  {test.metrics.memoryBytes === null ? "—" : formatBytes(test.metrics.memoryBytes)}
                </span>
              )}
            </button>
            {test.verdict !== "accepted" && (
              <div className="case-diff">
                <div><span>{text.judge.expected}</span><pre>{test.expected || "∅"}</pre></div>
                <div><span>{text.judge.actual}</span><pre>{test.actual || test.stderr || "∅"}</pre></div>
              </div>
            )}
          </div>
        ))}
      </div>
      {session.score && selectedCase?.policyEvaluations && (
        <CaseScoreDetails
          problem={problem}
          testCase={selectedCase}
          locale={locale}
        />
      )}
    </div>
  );
}
