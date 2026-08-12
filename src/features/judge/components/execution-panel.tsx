import { Check, Code2, Download, Play, Plus, TriangleAlert, X, Bug, CheckCircle2 } from "lucide-react";
import type { BuildArtifact, Diagnostic, RunResult, WorkerProgress } from "../../../core/types";
import type { JudgeUiCaseResult, JudgeUiSession } from "../../../judge/judge";
import { normalizeOutput } from "../../../judge/normalization";
import type { JudgeProblem, ProblemLocale } from "../../../judge/problem-model";
import { MAX_SELF_TEST_CASES, type SelfTestCase } from "../../../judge/self-tests";
import type { OfficialSubmissionStatus } from "../../submissions/components/official-submission-result";
import { executionTerminationLabel, localizedWorkerProgress, type JudgeUiText } from "../model/judge-ui-i18n";
import { CaseResultsPanel } from "./case-results-panel";
import { SubmissionPanel } from "./submission-panel";

export type BottomTab = "judge" | "tests" | "diagnostics" | "output";
export type BusyAction = "build" | "test" | "judge" | "official" | "cache" | undefined;
export type CompileAheadState = "idle" | "scheduled" | "compiling" | "ready" | "error";

export interface LogEntry {
  readonly id: string;
  readonly stream: "system" | "stdout" | "stderr";
  readonly text: string;
}

export interface SelfTestRunResult {
  readonly caseId: string;
  readonly run: RunResult;
  readonly expectedOutput?: string;
  readonly matchesExpected?: boolean;
}

interface ExecutionPanelProps {
  readonly activeTab: BottomTab;
  readonly busy: BusyAction;
  readonly progress: WorkerProgress;
  readonly compileAhead: CompileAheadState;
  readonly artifact?: BuildArtifact;
  readonly officialSubmission?: OfficialSubmissionStatus;
  readonly judgeSession?: JudgeUiSession;
  readonly selectedCase?: JudgeUiCaseResult;
  readonly problem: JudgeProblem;
  readonly locale: ProblemLocale;
  readonly text: JudgeUiText;
  readonly selfTests: readonly SelfTestCase[];
  readonly selfTestResults: readonly SelfTestRunResult[];
  readonly selectedSelfTest?: SelfTestCase;
  readonly selectedSelfTestResult?: SelfTestRunResult;
  readonly runningSelfTestId?: string;
  readonly diagnostics: readonly Diagnostic[];
  readonly logs: readonly LogEntry[];
  readonly runtimeReady: boolean;
  readonly formatBytes: (bytes: number) => string;
  readonly formatDuration: (milliseconds: number) => string;
  readonly onTabChange: (tab: BottomTab) => void;
  readonly onDownloadArtifact: (artifact: BuildArtifact) => void;
  readonly onSelectCase: (number: number) => void;
  readonly onAddSamples: () => void;
  readonly onAddSelfTest: () => void;
  readonly onRunSelfTests: (ids: readonly string[]) => void;
  readonly onSelectSelfTest: (id: string) => void;
  readonly onUpdateSelfTest: (id: string, update: Partial<Pick<SelfTestCase, "name" | "input">>) => void;
  readonly onRemoveSelfTest: (id: string) => void;
  readonly onOpenDiagnostic: (diagnostic: Diagnostic) => void;
}

export function ExecutionPanel({
  activeTab,
  busy,
  progress,
  compileAhead,
  artifact,
  officialSubmission,
  judgeSession,
  selectedCase,
  problem,
  locale,
  text,
  selfTests,
  selfTestResults,
  selectedSelfTest,
  selectedSelfTestResult,
  runningSelfTestId,
  diagnostics,
  logs,
  runtimeReady,
  formatBytes,
  formatDuration,
  onTabChange,
  onDownloadArtifact,
  onSelectCase,
  onAddSamples,
  onAddSelfTest,
  onRunSelfTests,
  onSelectSelfTest,
  onUpdateSelfTest,
  onRemoveSelfTest,
  onOpenDiagnostic,
}: ExecutionPanelProps) {
  return (
    <section className="bottom-panel">
      <div className="bottom-tabs">
        <button className={activeTab === "judge" ? "active" : ""} onClick={() => onTabChange("judge")}>
          {text.panel.judgeResults} {officialSubmission
            ? <span className={`verdict-mini ${officialSubmission.verdict ?? officialSubmission.state ?? "running"}`}>
              {officialSubmission.completedCases !== undefined && officialSubmission.totalCases !== undefined
                ? `${officialSubmission.completedCases}/${officialSubmission.totalCases}`
                : officialSubmission.state ?? "…"}
            </span>
            : judgeSession && <span className={`verdict-mini ${judgeSession.verdict}`}>{judgeSession.completed}/{judgeSession.total}</span>}
        </button>
        <button className={activeTab === "tests" ? "active" : ""} onClick={() => onTabChange("tests")}>
          {text.panel.selfTest} <span className="test-count-badge">{selfTestResults.length}/{selfTests.length}</span>
        </button>
        <button className={activeTab === "diagnostics" ? "active" : ""} onClick={() => onTabChange("diagnostics")}>
          {text.panel.diagnostics} {diagnostics.length > 0 && <span className="count-badge">{diagnostics.length}</span>}
        </button>
        <button className={activeTab === "output" ? "active" : ""} onClick={() => onTabChange("output")}>{text.panel.output}</button>
        <div className="panel-status">
          {busy && <><span className="spinner" />{localizedWorkerProgress(progress, locale)}</>}
          {!busy && compileAhead === "scheduled" && <>{text.panel.compileScheduled}</>}
          {!busy && compileAhead === "compiling" && <><span className="spinner" />{text.panel.precompiling}</>}
          {!busy && compileAhead === "error" && <><TriangleAlert size={13} />{text.panel.waitingForFix}</>}
          {!busy && compileAhead === "ready" && artifact && <><Check size={13} />{text.panel.precompileReady} · {formatBytes(artifact.size)}</>}
          {!busy && compileAhead === "idle" && artifact && <><Check size={13} />{formatBytes(artifact.size)}</>}
        </div>
        {artifact && <button className="bare-button panel-download" onClick={() => onDownloadArtifact(artifact)} aria-label={text.panel.downloadArtifact}><Download size={14} /></button>}
      </div>
      <div className="panel-content">
        {activeTab === "judge" ? (
          officialSubmission ? (
            <SubmissionPanel status={officialSubmission} locale={locale} formatBytes={formatBytes} />
          ) : (
            <CaseResultsPanel
              session={judgeSession}
              selectedCase={selectedCase}
              problem={problem}
              locale={locale}
              text={text}
              formatBytes={formatBytes}
              formatDuration={formatDuration}
              onSelectCase={onSelectCase}
              onViewDiagnostics={() => onTabChange("diagnostics")}
            />
          )
        ) : activeTab === "tests" ? (
          <div className="self-test-workbench">
            <section className="self-test-cases" aria-label={text.selfTest.inputRegion}>
              <header className="self-test-toolbar">
                <div><strong>{text.selfTest.heading}</strong><span>{text.selfTest.description}</span></div>
                <div>
                  <button type="button" onClick={onAddSamples} disabled={Boolean(busy) || selfTests.length >= MAX_SELF_TEST_CASES}>{text.selfTest.addSamples}</button>
                  <button type="button" onClick={onAddSelfTest} disabled={Boolean(busy) || selfTests.length >= MAX_SELF_TEST_CASES}><Plus size={12} /> {text.selfTest.add}</button>
                  <button className="self-test-run-all" type="button" onClick={() => onRunSelfTests(selfTests.map((testCase) => testCase.id))} disabled={Boolean(busy) || !runtimeReady}><Play size={12} /> {text.selfTest.runAll}</button>
                </div>
              </header>
              <div className="self-test-list">
                {selfTests.map((testCase, index) => {
                  const runResult = selfTestResults.find((candidate) => candidate.caseId === testCase.id);
                  const result = runResult?.run;
                  const successful = result?.termination === "exited" && result.code === 0 && runResult?.matchesExpected !== false;
                  return (
                    <article className={`self-test-card ${selectedSelfTest?.id === testCase.id ? "selected" : ""}`} key={testCase.id}>
                      <header>
                        <button className="self-test-selector" type="button" onClick={() => onSelectSelfTest(testCase.id)} aria-pressed={selectedSelfTest?.id === testCase.id}>
                          <span>{String(index + 1).padStart(2, "0")}</span>
                          {runningSelfTestId === testCase.id ? <span className="spinner" /> : result ? successful ? <CheckCircle2 size={13} /> : <TriangleAlert size={13} /> : <Code2 size={13} />}
                        </button>
                        <input
                          value={testCase.name}
                          maxLength={80}
                          aria-label={text.selfTest.nameLabel(index + 1)}
                          onFocus={() => onSelectSelfTest(testCase.id)}
                          onChange={(event) => onUpdateSelfTest(testCase.id, { name: event.target.value })}
                          disabled={Boolean(busy)}
                        />
                        <button type="button" onClick={() => onRunSelfTests([testCase.id])} disabled={Boolean(busy) || !runtimeReady} aria-label={text.selfTest.run(testCase.name || text.selfTest.caseName(index + 1))}><Play size={12} /></button>
                        <button type="button" onClick={() => onRemoveSelfTest(testCase.id)} disabled={Boolean(busy) || selfTests.length === 1} aria-label={text.selfTest.remove(testCase.name || text.selfTest.caseName(index + 1))}><X size={12} /></button>
                      </header>
                      <label>
                        <span>STDIN</span>
                        <textarea
                          value={testCase.input}
                          rows={4}
                          spellCheck={false}
                          onFocus={() => onSelectSelfTest(testCase.id)}
                          onChange={(event) => onUpdateSelfTest(testCase.id, { input: event.target.value })}
                          disabled={Boolean(busy)}
                        />
                      </label>
                    </article>
                  );
                })}
              </div>
            </section>
            <section className="self-test-result" aria-live="polite">
              <header>
                <div><span>{text.selfTest.result}</span><strong>{selectedSelfTest?.name.trim() || text.selfTest.untitled}</strong></div>
                {selectedSelfTestResult && (
                  <span className={selectedSelfTestResult.run.termination === "exited" && selectedSelfTestResult.run.code === 0 && selectedSelfTestResult.matchesExpected !== false ? "success" : "failure"}>
                    {selectedSelfTestResult.matchesExpected === true
                      ? (locale === "zh-TW" ? "範例通過" : "Sample passed")
                      : selectedSelfTestResult.matchesExpected === false
                        ? (locale === "zh-TW" ? "輸出不符" : "Output differs")
                        : `${executionTerminationLabel(locale, selectedSelfTestResult.run.termination)} · ${text.selfTest.exit} ${selectedSelfTestResult.run.code}`}
                  </span>
                )}
              </header>
              {!selectedSelfTestResult ? (
                <div className="empty-panel"><Play size={17} /><span>{text.selfTest.empty}</span></div>
              ) : (
                <div className="self-test-result-body">
                  <div className="self-test-metrics">
                    <div><span>{text.selfTest.duration}</span><strong>{formatDuration(selectedSelfTestResult.run.durationMs)}</strong></div>
                    <div><span>{text.selfTest.instructionCost}</span><strong>{selectedSelfTestResult.run.metrics.cost?.toLocaleString() ?? "—"}</strong></div>
                    <div><span>{text.selfTest.peakMemory}</span><strong>{selectedSelfTestResult.run.metrics.memoryBytes === null ? "—" : formatBytes(selectedSelfTestResult.run.metrics.memoryBytes)}</strong></div>
                    <div><span>{text.selfTest.logicalTime}</span><strong>{selectedSelfTestResult.run.metrics.logicalTimeNs === null ? "—" : formatDuration(selectedSelfTestResult.run.metrics.logicalTimeNs / 1_000_000)}</strong></div>
                  </div>
                  {selectedSelfTestResult.expectedOutput !== undefined && <div className="self-test-stream stdout"><span>{text.judge.expected}</span><pre>{normalizeOutput(selectedSelfTestResult.expectedOutput, "lines") || "∅"}</pre></div>}
                  <div className="self-test-stream stdout"><span>{selectedSelfTestResult.expectedOutput === undefined ? "STDOUT" : text.judge.actual}</span><pre>{normalizeOutput(selectedSelfTestResult.run.stdout, "lines") || "∅"}</pre></div>
                  {selectedSelfTestResult.run.stderr && <div className="self-test-stream stderr"><span>STDERR</span><pre>{selectedSelfTestResult.run.stderr}</pre></div>}
                </div>
              )}
            </section>
          </div>
        ) : activeTab === "diagnostics" ? (
          diagnostics.length === 0 ? (
            <div className="empty-panel"><Check size={17} /><span>{text.empty.diagnostics}</span></div>
          ) : (
            <div className="diagnostic-list">
              {diagnostics.map((diagnostic, index) => (
                <button className={`diagnostic-row ${diagnostic.severity}`} key={`${diagnostic.file}-${diagnostic.line}-${index}`} onClick={() => onOpenDiagnostic(diagnostic)}>
                  {diagnostic.severity === "error" ? <Bug size={14} /> : <TriangleAlert size={14} />}
                  <span className="diagnostic-message">{diagnostic.message}</span>
                  <span className="diagnostic-location">{diagnostic.file}:{diagnostic.line}:{diagnostic.column}</span>
                  {diagnostic.code && <span className="diagnostic-code">{diagnostic.code}</span>}
                </button>
              ))}
            </div>
          )
        ) : logs.length === 0 ? (
          <div className="empty-panel"><Code2 size={17} /><span>{text.empty.output}</span></div>
        ) : (
          <div className="terminal-output">
            {logs.map((entry) => <pre className={entry.stream} key={entry.id}>{entry.stream === "system" ? <span className="prompt">› </span> : null}{entry.text}</pre>)}
          </div>
        )}
      </div>
    </section>
  );
}
