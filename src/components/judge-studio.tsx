"use client";

import dynamic from "next/dynamic";
import type { BeforeMount, OnMount } from "@monaco-editor/react";
import {
  Award,
  Box,
  Braces,
  Bug,
  Check,
  CheckCircle2,
  ChevronDown,
  CircleHelp,
  CircleStop,
  Clock3,
  Code2,
  Download,
  FileCode2,
  Gauge,
  Hammer,
  HardDrive,
  LockKeyhole,
  MessageCircle,
  Package,
  Play,
  Plus,
  RotateCcw,
  Search,
  Send,
  Settings2,
  ShieldCheck,
  Target,
  TriangleAlert,
  X,
  Zap,
} from "lucide-react";
import type * as Monaco from "monaco-editor";
import type { CSSProperties, KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CompileCoordinator } from "@/src/compiler/coordinator";
import { projectBuildIdentity, projectCacheKey } from "@/src/core/hash";
import { isBuiltinLanguage, LANGUAGES, type BuildArtifact, type BuiltinLanguage, type Diagnostic, type Language, type Project, type ProjectFile, type RunConfig, type RunResult, type WorkerProgress } from "@/src/core/types";
import { extensionLanguage, languageLabel, TOOLCHAINS } from "@/src/core/toolchains";
import {
  decodeSolvedProgress,
  judgeProblemProgressId,
  judgeProgressKey,
  type JudgeUiCaseResult,
  type JudgeUiSession,
} from "@/src/judge/judge";
import { createJudgeExecutor, JudgeEngine, type JudgeCaseResult, type JudgeCaseVerdict } from "@/src/judge/engine";
import { FORGE_CONTRACT_VERSION } from "@/src/core/contract";
import { textMatcher } from "@/src/judge/spec";
import { normalizeOutput } from "@/src/judge/normalization";
import { createJudgeProject, judgeProjectId, latestJudgeProjectForCollection, problemIdentityFromProject } from "@/src/judge/project";
import { buildChatGptProblemUrl } from "@/src/judge/chatgpt-help";
import { BrowserForgeCompiler } from "@/src/runtime/compiler-client";
import { BrowserForgeRunner } from "@/src/runtime/runner-client";
import { clearArtifactCache, deleteArtifact, listProjects, loadArtifact, saveArtifact, saveProject } from "@/src/storage/database";
import { createDefaultBrowserStorageCoordinator, type ForgeStorageCoordinator } from "@/src/storage/coordinator";
import { registerToolchainCache } from "@/src/storage/service-worker";
import { configureForgeLanguageServices } from "@/src/editor/forge-language-services";
import { ProblemMarkdown } from "@/src/components/problem-markdown";
import { CaseScoreDetails } from "@/src/components/case-score-details";
import {
  DEFAULT_JUDGE_UI_LOCALE,
  executionTerminationLabel,
  judgeUiText,
  localizedWorkerProgress,
  readJudgeUiLocale,
  toolchainNote,
  verdictLabel,
  writeJudgeUiLocale,
} from "@/src/components/judge-ui-i18n";
import {
  completeJudgeOnboarding,
  isJudgeOnboardingComplete,
  JudgeOnboarding,
} from "@/src/components/judge-onboarding";
import {
  clampBottomPanelHeight,
  DEFAULT_BOTTOM_PANEL_HEIGHT,
  maximumBottomPanelHeight,
  MIN_BOTTOM_PANEL_HEIGHT,
  resizedBottomPanelHeight,
} from "@/src/components/judge-panel-layout";
import { assertProblemCostProfile, scoreProblemResults } from "@/src/judge/problem-scoring";
import {
  DEFAULT_PROBLEM_COLLECTION_SOURCE,
  PROBLEM_COLLECTION_SOURCE_KEY,
  clearProblemCollectionCache,
  githubRawContentUrl,
  loadProblemCollection,
  normalizeProblemCollectionSource,
  type GithubProblemCollectionSource,
  type LoadedProblemCollection,
  type ProblemCollectionEntry,
} from "@/src/judge/problem-catalog-loader";
import {
  broadestPolicy,
  PROBLEM_LOCALES,
  problemText,
  sampleCases,
  type JudgeProblem,
  type ProblemDifficulty,
  type ProblemLocale,
} from "@/src/judge/problem-model";
import { matchesProblemSearch } from "@/src/judge/problem-search";
import {
  decodeSelfTestCases,
  encodeSelfTestCases,
  MAX_SELF_TEST_CASES,
  selfTestStorageKey,
  type SelfTestCase,
} from "@/src/judge/self-tests";

const MonacoEditor = dynamic(() => import("@monaco-editor/react"), { ssr: false });
const SITES_CHUNK_MANIFEST_URL = process.env.NODE_ENV === "production"
  ? "/toolchains/forge-sites-chunks.json"
  : undefined;

type BottomTab = "judge" | "tests" | "diagnostics" | "output";
type BusyAction = "build" | "test" | "judge" | "cache" | undefined;
type DifficultyFilter = "all" | ProblemDifficulty;
type CompileAheadState = "idle" | "scheduled" | "compiling" | "ready" | "error";
type ProblemPane = "statement" | "editorial";

interface PanelResizeSession {
  pointerId: number;
  startHeight: number;
  startPointerY: number;
}

interface LogEntry {
  id: string;
  stream: "system" | "stdout" | "stderr";
  text: string;
}

interface SelfTestRunResult {
  readonly caseId: string;
  readonly run: RunResult;
}

const MONACO_LANGUAGE: Record<BuiltinLanguage, string> = {
  c: "c",
  cpp: "cpp",
  rust: "rust",
  python: "python",
  javascript: "javascript",
  typescript: "typescript",
  go: "go",
};

function cleanPath(path: string): string | undefined {
  const normalized = path.trim().replaceAll("\\", "/").replace(/^\.\//, "");
  if (!normalized || normalized.startsWith("/") || normalized.split("/").includes("..")) return undefined;
  if (!/^[\w@.+/-]+$/.test(normalized)) return undefined;
  return normalized;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function formatDuration(milliseconds: number): string {
  return milliseconds < 1000 ? `${Math.round(milliseconds)} ms` : `${(milliseconds / 1000).toFixed(2)} s`;
}

function submissionVerdictFromContract(verdict: JudgeCaseVerdict | "accepted"): JudgeUiCaseResult["verdict"] {
  if (verdict === "accepted" || verdict === "wrong-answer") return verdict;
  if (verdict === "judge-error") return "judge-error";
  if (verdict === "instruction-limit" || verdict === "logical-time-limit" || verdict === "wall-time-limit") return "time-limit";
  return "runtime-error";
}

function displayJudgeCase(
  result: JudgeCaseResult,
  index: number,
  expected: string,
): JudgeUiCaseResult {
  const verdict = submissionVerdictFromContract(result.verdict);
  return {
    number: index + 1,
    verdict,
    expected: normalizeOutput(expected, "lines"),
    actual: normalizeOutput(result.run?.stdout ?? "", "lines"),
    stderr: result.run?.stderr || result.message || "",
    exitCode: result.run?.code ?? null,
    durationMs: result.run?.durationMs ?? 0,
  };
}

function serializeBundle(artifact: Extract<BuildArtifact, { kind: "runtime-bundle" }>): string {
  const files = Object.fromEntries(Object.entries(artifact.files).map(([path, value]) => [
    path,
    typeof value === "string"
      ? { encoding: "utf8", data: value }
      : { encoding: "base64", data: btoa(Array.from(value, (byte) => String.fromCharCode(byte)).join("")) },
  ]));
  return JSON.stringify({ manifest: JSON.parse(artifact.manifest), files }, null, 2);
}

function downloadArtifact(artifact: BuildArtifact): void {
  const blob = artifact.kind === "wasm"
    ? new Blob([artifact.bytes.slice().buffer], { type: "application/wasm" })
    : new Blob([serializeBundle(artifact)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = artifact.name;
  anchor.click();
  URL.revokeObjectURL(url);
}

function languageIcon(language: Language) {
  if (language === "python") return <Braces size={14} />;
  if (language === "rust") return <Settings2 size={14} />;
  return <FileCode2 size={14} />;
}

function languageTone(language: Language): string {
  return ({ c: "tone-c", cpp: "tone-cpp", rust: "tone-rust", python: "tone-python", javascript: "tone-js", typescript: "tone-ts" } as Record<string, string>)[language] ?? "tone-js";
}

function difficultyLabel(difficulty: ProblemDifficulty, locale: ProblemLocale): string {
  return judgeUiText(locale).difficulty[difficulty];
}

interface ProblemSourceDraft {
  owner: string;
  repository: string;
  ref: string;
  indexPath: string;
}

function sourceDraft(source: GithubProblemCollectionSource): ProblemSourceDraft {
  return {
    owner: source.owner,
    repository: source.repository,
    ref: source.ref,
    indexPath: source.indexPath,
  };
}

interface StoredProblemCollectionSource {
  source: GithubProblemCollectionSource;
  error?: {
    kind: "read" | "invalid";
    detail: string;
  };
}

function storedProblemCollectionSource(): StoredProblemCollectionSource {
  if (typeof window === "undefined") return { source: DEFAULT_PROBLEM_COLLECTION_SOURCE };
  let raw: string | null;
  try {
    raw = localStorage.getItem(PROBLEM_COLLECTION_SOURCE_KEY);
  } catch (reason) {
    return {
      source: DEFAULT_PROBLEM_COLLECTION_SOURCE,
      error: {
        kind: "read",
        detail: reason instanceof Error ? reason.message : String(reason),
      },
    };
  }
  if (!raw) return { source: DEFAULT_PROBLEM_COLLECTION_SOURCE };
  try {
    return { source: normalizeProblemCollectionSource(JSON.parse(raw) as unknown) };
  } catch (reason) {
    return {
      source: DEFAULT_PROBLEM_COLLECTION_SOURCE,
      error: {
        kind: "invalid",
        detail: reason instanceof Error ? reason.message : String(reason),
      },
    };
  }
}

interface ProblemSourceFormProps {
  source: GithubProblemCollectionSource;
  locale: ProblemLocale;
  disabled?: boolean;
  onApply(source: GithubProblemCollectionSource): void;
}

function ProblemSourceForm({ source, locale, disabled, onApply }: ProblemSourceFormProps) {
  const [draft, setDraft] = useState<ProblemSourceDraft>(() => sourceDraft(source));
  const [error, setError] = useState<string>();
  const text = judgeUiText(locale).source;

  const apply = () => {
    try {
      const normalized = normalizeProblemCollectionSource({ provider: "github", ...draft });
      setError(undefined);
      onApply(normalized);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  };

  return (
    <div className="problem-source-form">
      <div className="form-grid">
        <label className="form-field"><span>{text.owner}</span><input value={draft.owner} disabled={disabled} onChange={(event) => setDraft((current) => ({ ...current, owner: event.target.value }))} /></label>
        <label className="form-field"><span>{text.repository}</span><input value={draft.repository} disabled={disabled} onChange={(event) => setDraft((current) => ({ ...current, repository: event.target.value }))} /></label>
      </div>
      <div className="form-grid">
        <label className="form-field"><span>{text.ref}</span><input value={draft.ref} disabled={disabled} onChange={(event) => setDraft((current) => ({ ...current, ref: event.target.value }))} /></label>
        <label className="form-field"><span>{text.index}</span><input value={draft.indexPath} disabled={disabled} onChange={(event) => setDraft((current) => ({ ...current, indexPath: event.target.value }))} /></label>
      </div>
      {error && <p className="problem-source-error" role="alert">{text.invalid(error)}</p>}
      <div className="problem-source-actions">
        <button type="button" disabled={disabled} onClick={() => {
          setDraft(sourceDraft(DEFAULT_PROBLEM_COLLECTION_SOURCE));
          setError(undefined);
        }}>{text.useDefault}</button>
        <button type="button" className="problem-source-apply" disabled={disabled} onClick={apply}>{text.apply}</button>
      </div>
    </div>
  );
}

interface ProblemCollectionSession {
  collection: LoadedProblemCollection;
  initialProblem: JudgeProblem;
}

export function JudgeStudioLoader() {
  const [storedSource] = useState<StoredProblemCollectionSource>(storedProblemCollectionSource);
  const [problemLocale, setProblemLocale] = useState<ProblemLocale>(() => {
    if (typeof window === "undefined") return DEFAULT_JUDGE_UI_LOCALE;
    try {
      return readJudgeUiLocale(localStorage);
    } catch {
      return DEFAULT_JUDGE_UI_LOCALE;
    }
  });
  const [source, setSource] = useState<GithubProblemCollectionSource>(storedSource.source);
  const [session, setSession] = useState<ProblemCollectionSession>();
  const [error, setError] = useState<{
    kind: "read" | "invalid" | "load";
    detail: string;
  } | undefined>(storedSource.error);
  const [blockedByStoredConfiguration, setBlockedByStoredConfiguration] = useState(Boolean(storedSource.error));
  const [retry, setRetry] = useState(0);
  const text = judgeUiText(problemLocale);

  useEffect(() => {
    document.documentElement.lang = problemLocale === "zh-TW" ? "zh-Hant" : "en";
  }, [problemLocale]);

  useEffect(() => {
    if (blockedByStoredConfiguration) return;
    const controller = new AbortController();
    void (async () => {
      const collection = await loadProblemCollection(source, { signal: controller.signal });
      const first = collection.index.problems[0];
      if (!first) throw new Error("The verified problem collection is empty.");
      const initialProblem = await collection.loadProblem(first.id, controller.signal);
      if (!controller.signal.aborted) setSession({ collection, initialProblem });
    })().catch((reason: unknown) => {
      if (controller.signal.aborted) return;
      if (reason instanceof DOMException && reason.name === "AbortError") return;
      setError({ kind: "load", detail: reason instanceof Error ? reason.message : String(reason) });
    });
    return () => controller.abort();
  }, [blockedByStoredConfiguration, retry, source]);

  const changeSource = useCallback((next: GithubProblemCollectionSource) => {
    localStorage.setItem(PROBLEM_COLLECTION_SOURCE_KEY, JSON.stringify(next));
    setSession(undefined);
    setError(undefined);
    setBlockedByStoredConfiguration(false);
    setSource(next);
    setRetry((value) => value + 1);
  }, []);

  const retrySource = useCallback(() => {
    setSession(undefined);
    setError(undefined);
    setBlockedByStoredConfiguration(false);
    setRetry((value) => value + 1);
  }, []);

  const changeProblemLocale = useCallback((locale: ProblemLocale) => {
    setProblemLocale(locale);
    writeJudgeUiLocale(localStorage, locale);
  }, []);

  const errorMessage = error?.kind === "read"
    ? text.loader.sourceReadFailed(error.detail)
    : error?.kind === "invalid"
      ? text.loader.sourceInvalid(error.detail)
      : error ? text.loader.loadFailed(error.detail) : undefined;

  if (error) {
    return (
      <main className="problem-catalog-status problem-source-recovery" role="alert">
        <label className="problem-source-locale">
          <span>{text.topbar.interfaceLanguage}</span>
          <select value={problemLocale} onChange={(event) => changeProblemLocale(event.target.value as ProblemLocale)}>
            {PROBLEM_LOCALES.map((locale) => (
              <option value={locale} key={locale}>{judgeUiText(locale).localeName}</option>
            ))}
          </select>
        </label>
        <TriangleAlert size={22} />
        <strong>{text.loader.failed}</strong>
        <span>{errorMessage}</span>
        <ProblemSourceForm key={JSON.stringify(source)} source={source} locale={problemLocale} onApply={changeSource} />
        <button type="button" className="problem-source-retry" onClick={retrySource}>{text.loader.retry}</button>
      </main>
    );
  }
  if (!session) {
    return (
      <main className="problem-catalog-status" aria-live="polite">
        <ShieldCheck size={22} />
        <span>{text.loader.loading}</span>
      </main>
    );
  }
  return (
    <JudgeStudio
      key={`${session.collection.sourceKey}:${session.collection.index.revision}`}
      collection={session.collection}
      initialProblem={session.initialProblem}
      problemLocale={problemLocale}
      onProblemLocaleChange={changeProblemLocale}
      onProblemCollectionSourceChange={changeSource}
    />
  );
}

interface JudgeStudioProps {
  collection: LoadedProblemCollection;
  initialProblem: JudgeProblem;
  problemLocale: ProblemLocale;
  onProblemLocaleChange(locale: ProblemLocale): void;
  onProblemCollectionSourceChange(source: GithubProblemCollectionSource): void;
}

export function JudgeStudio({
  collection,
  initialProblem,
  problemLocale,
  onProblemLocaleChange,
  onProblemCollectionSourceChange,
}: JudgeStudioProps) {
  const problems = collection.index.problems;
  const initialProblemEntry = problems.find((problem) => problem.id === initialProblem.id);
  if (!initialProblemEntry) throw new Error(`Initial problem '${initialProblem.id}' is absent from its collection index.`);
  const problemDigests = useMemo(() => new Map(problems.map((problem) => [problem.id, problem.bundle.sha256])), [problems]);
  const validProgressIds = useMemo(() => new Set(problems.map((problem) => judgeProblemProgressId(problem.id, problem.bundle.sha256))), [problems]);
  const progressKey = useMemo(() => judgeProgressKey(collection.sourceKey), [collection.sourceKey]);
  const [project, setProject] = useState<Project>(() => createJudgeProject(collection.sourceKey, initialProblemEntry.bundle.sha256, initialProblem, "c"));
  const [activeProblem, setActiveProblem] = useState(initialProblem);
  const [loadingProblemId, setLoadingProblemId] = useState<string>();
  const [problemPane, setProblemPane] = useState<ProblemPane>("statement");
  const [filter, setFilter] = useState<DifficultyFilter>("all");
  const [problemSearch, setProblemSearch] = useState("");
  const [solved, setSolved] = useState<Set<string>>(new Set());
  const [hydrated, setHydrated] = useState(false);
  const [runtimeReady, setRuntimeReady] = useState(false);
  const [progress, setProgress] = useState<WorkerProgress>({ phase: "initializing", label: "Starting Wasmer runtime", progress: 0 });
  const [busy, setBusy] = useState<BusyAction>();
  const [artifact, setArtifact] = useState<BuildArtifact>();
  const [diagnostics, setDiagnostics] = useState<Diagnostic[]>([]);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [selfTests, setSelfTests] = useState<SelfTestCase[]>(() => decodeSelfTestCases(
    null,
    sampleCases(initialProblem)[0]?.input ?? "",
  ));
  const [loadedSelfTestKey, setLoadedSelfTestKey] = useState<string>();
  const [selectedSelfTestId, setSelectedSelfTestId] = useState("case-1");
  const [runningSelfTestId, setRunningSelfTestId] = useState<string>();
  const [selfTestResults, setSelfTestResults] = useState<SelfTestRunResult[]>([]);
  const [judgeSession, setJudgeSession] = useState<JudgeUiSession>();
  const [selectedCaseNumber, setSelectedCaseNumber] = useState<number>();
  const [bottomTab, setBottomTab] = useState<BottomTab>("judge");
  const [bottomPanelHeight, setBottomPanelHeight] = useState(DEFAULT_BOTTOM_PANEL_HEIGHT);
  const [bottomPanelMaximum, setBottomPanelMaximum] = useState(DEFAULT_BOTTOM_PANEL_HEIGHT);
  const [resizingBottomPanel, setResizingBottomPanel] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [onboardingOpen, setOnboardingOpen] = useState(false);
  const [newFileOpen, setNewFileOpen] = useState(false);
  const [newFilePath, setNewFilePath] = useState("");
  const [storage, setStorage] = useState({ usage: 0, quota: 0 });
  const [location, setLocation] = useState({ line: 1, column: 1 });
  const [compileAhead, setCompileAhead] = useState<CompileAheadState>("idle");
  const compilerRef = useRef<BrowserForgeCompiler | undefined>(undefined);
  const compileCoordinatorRef = useRef<CompileCoordinator | undefined>(undefined);
  const runnerRef = useRef<BrowserForgeRunner | undefined>(undefined);
  const storageCoordinatorRef = useRef<ForgeStorageCoordinator | undefined>(undefined);
  const projectRef = useRef(project);
  const editorStackRef = useRef<HTMLElement | null>(null);
  const editorRef = useRef<Monaco.editor.IStandaloneCodeEditor | undefined>(undefined);
  const monacoRef = useRef<typeof Monaco | undefined>(undefined);
  const revealRef = useRef<{ line: number; column: number } | undefined>(undefined);
  const judgingRef = useRef(false);
  const cancelledRef = useRef(false);
  const panelResizeRef = useRef<PanelResizeSession | undefined>(undefined);
  const text = judgeUiText(problemLocale);

  const activeProblemText = problemText(activeProblem, problemLocale);
  const activeProblemEntry = useMemo(() => {
    const entry = problems.find((problem) => problem.id === activeProblem.id);
    if (!entry) throw new Error(`Active problem '${activeProblem.id}' is absent from its collection index.`);
    return entry;
  }, [activeProblem.id, problems]);
  const activeProgressId = judgeProblemProgressId(activeProblem.id, activeProblemEntry.bundle.sha256);
  const activeSelfTestKey = useMemo(
    () => selfTestStorageKey(collection.sourceKey, activeProgressId),
    [activeProgressId, collection.sourceKey],
  );
  const activeBaseline = broadestPolicy(activeProblem);
  const activeFile = useMemo(
    () => project.files.find((file) => file.path === project.activeFile) ?? project.files[0],
    [project],
  );
  const projectLanguage: BuiltinLanguage = isBuiltinLanguage(project.config.language)
    ? project.config.language
    : "c";
  const chatGptProblemUrl = useMemo(
    () => buildChatGptProblemUrl(
      activeProblem,
      problemLocale,
      projectLanguage,
      githubRawContentUrl(collection.source, activeProblemEntry.statementPaths[problemLocale]),
    ),
    [activeProblem, activeProblemEntry.statementPaths, collection.source, problemLocale, projectLanguage],
  );
  const activeToolchain = TOOLCHAINS[projectLanguage];
  const buildIdentity = useMemo(() => projectBuildIdentity(project), [project]);
  const filteredProblems = useMemo(
    () => problems.filter((problem) => (
      (filter === "all" || problem.difficulty === filter)
      && matchesProblemSearch(problem, problemSearch)
    )),
    [filter, problemSearch, problems],
  );
  const groupedProblems = useMemo(
    () => filteredProblems.reduce<Array<{ id: string; title: string; problems: ProblemCollectionEntry[] }>>((groups, problem) => {
      const id = problem.trackId;
      const current = groups.at(-1);
      if (current?.id === id) {
        current.problems.push(problem);
      } else {
        groups.push({ id, title: problem.track[problemLocale], problems: [problem] });
      }
      return groups;
    }, []),
    [filteredProblems, problemLocale],
  );
  const selectedCaseResult = judgeSession?.cases.find((testCase) => (
    testCase.number === selectedCaseNumber
  )) ?? judgeSession?.cases[0];
  const selectedSelfTest = selfTests.find((testCase) => testCase.id === selectedSelfTestId) ?? selfTests[0];
  const selectedSelfTestResult = selectedSelfTest
    ? selfTestResults.find((result) => result.caseId === selectedSelfTest.id)
    : undefined;

  const addLog = useCallback((stream: LogEntry["stream"], text: string) => {
    if (!text) return;
    setLogs((current) => [...current, { id: crypto.randomUUID(), stream, text }]);
  }, []);

  const dismissOnboarding = useCallback(() => {
    try {
      completeJudgeOnboarding(localStorage);
    } catch (error) {
      addLog("stderr", text.logs.onboardingSaveFailed(error instanceof Error ? error.message : String(error)));
    }
    setOnboardingOpen(false);
  }, [addLog, text]);

  useEffect(() => {
    if (!hydrated) return;
    try {
      setOnboardingOpen(!isJudgeOnboardingComplete(localStorage));
    } catch (error) {
      addLog("stderr", text.logs.onboardingReadFailed(error instanceof Error ? error.message : String(error)));
      setOnboardingOpen(true);
    }
  }, [addLog, hydrated, text]);

  const measureBottomPanel = useCallback(() => {
    const stack = editorStackRef.current;
    if (!stack) return;
    const stackHeight = stack.getBoundingClientRect().height;
    const maximum = maximumBottomPanelHeight(stackHeight);
    setBottomPanelMaximum(maximum);
    setBottomPanelHeight((current) => clampBottomPanelHeight(stackHeight, current));
  }, []);

  useEffect(() => {
    const stack = editorStackRef.current;
    if (!stack) return;
    const observer = new ResizeObserver(measureBottomPanel);
    observer.observe(stack);
    measureBottomPanel();
    return () => observer.disconnect();
  }, [measureBottomPanel]);

  const stopBottomPanelResize = useCallback((target?: HTMLDivElement, pointerId?: number) => {
    if (target && pointerId !== undefined && target.hasPointerCapture(pointerId)) {
      target.releasePointerCapture(pointerId);
    }
    panelResizeRef.current = undefined;
    setResizingBottomPanel(false);
    editorRef.current?.layout();
  }, []);

  const startBottomPanelResize = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    panelResizeRef.current = {
      pointerId: event.pointerId,
      startHeight: bottomPanelHeight,
      startPointerY: event.clientY,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
    setResizingBottomPanel(true);
    event.preventDefault();
  }, [bottomPanelHeight]);

  const moveBottomPanelResize = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const resize = panelResizeRef.current;
    const stack = editorStackRef.current;
    if (!resize || resize.pointerId !== event.pointerId || !stack) return;
    setBottomPanelHeight(resizedBottomPanelHeight(
      stack.getBoundingClientRect().height,
      resize.startHeight,
      resize.startPointerY,
      event.clientY,
    ));
  }, []);

  const resizeBottomPanelFromKeyboard = useCallback((event: ReactKeyboardEvent<HTMLDivElement>) => {
    const stack = editorStackRef.current;
    if (!stack) return;
    const stackHeight = stack.getBoundingClientRect().height;
    const step = event.shiftKey ? 64 : 24;
    let requestedHeight: number | undefined;
    if (event.key === "ArrowUp") requestedHeight = bottomPanelHeight + step;
    if (event.key === "ArrowDown") requestedHeight = bottomPanelHeight - step;
    if (event.key === "Home") requestedHeight = MIN_BOTTOM_PANEL_HEIGHT;
    if (event.key === "End") requestedHeight = maximumBottomPanelHeight(stackHeight);
    if (requestedHeight === undefined) return;
    event.preventDefault();
    setBottomPanelHeight(clampBottomPanelHeight(stackHeight, requestedHeight));
  }, [bottomPanelHeight]);

  const resetBottomPanelHeight = useCallback(() => {
    const stack = editorStackRef.current;
    if (!stack) return;
    setBottomPanelHeight(clampBottomPanelHeight(
      stack.getBoundingClientRect().height,
      DEFAULT_BOTTOM_PANEL_HEIGHT,
    ));
  }, []);

  useEffect(() => {
    projectRef.current = project;
  }, [project]);

  useEffect(() => {
    const storageCoordinator = createDefaultBrowserStorageCoordinator();
    storageCoordinatorRef.current = storageCoordinator;
    let compilation: CompileCoordinator | undefined;
    let runner: BrowserForgeRunner | undefined;
    let disposed = false;
    void (async () => {
      try {
        await registerToolchainCache({ chunkManifestUrl: SITES_CHUNK_MANIFEST_URL });
        if (disposed) return;
        const compiler = new BrowserForgeCompiler();
        compilation = new CompileCoordinator(compiler, {
          load: loadArtifact,
          save: saveArtifact,
          delete: deleteArtifact,
          clear: clearArtifactCache,
        });
        runner = new BrowserForgeRunner();
        compilerRef.current = compiler;
        compileCoordinatorRef.current = compilation;
        runnerRef.current = runner;
        compiler.onProgress(setProgress);
        runner.onProgress(setProgress);
        runner.onStream((stream, chunk) => {
          if (!judgingRef.current) addLog(stream, chunk);
        });
        await storageCoordinator.requestPersistence();
        if (disposed) return;
        try {
          setSolved(decodeSolvedProgress(localStorage.getItem(progressKey), validProgressIds));
        } catch (error) {
          localStorage.removeItem(progressKey);
          addLog("stderr", error instanceof Error ? error.message : String(error));
        }
        const restored = latestJudgeProjectForCollection(
          await listProjects(),
          collection.sourceKey,
          problemDigests,
        );
        if (disposed) return;
        const restoredIdentity = restored ? problemIdentityFromProject(restored, collection.sourceKey) : undefined;
        const restoredSummary = restoredIdentity
          ? problems.find((candidate) => candidate.id === restoredIdentity.problemId && candidate.bundle.sha256 === restoredIdentity.bundleSha256)
          : undefined;
        const restoredProblem = restoredSummary
          ? await collection.loadProblem(restoredSummary.id)
          : undefined;
        if (disposed) return;
        if (
          restored
          && restoredSummary
          && restoredProblem
          && isBuiltinLanguage(restored.config.language)
          && restored.id === judgeProjectId(collection.sourceKey, restoredSummary.bundle.sha256, restoredProblem.id, restored.config.language)
        ) {
          setProject(restored);
          setActiveProblem(restoredProblem);
        }
        const storageReport = await storageCoordinator.estimate();
        if (disposed) return;
        setStorage({ usage: storageReport.usage, quota: storageReport.quota });
        setHydrated(true);
        await Promise.all([compiler.ready(), runner.ready()]);
        if (disposed) return;
        setRuntimeReady(true);
      } catch (error) {
        if (disposed) return;
        addLog("stderr", error instanceof Error ? error.message : String(error));
        setHydrated(true);
      }
    })();
    return () => {
      disposed = true;
      compilation?.dispose();
      runner?.dispose();
    };
  }, [addLog, collection, problemDigests, problems, progressKey, validProgressIds]);

  useEffect(() => {
    if (!hydrated || !runtimeReady) return;
    const compilation = compileCoordinatorRef.current;
    if (!compilation) return;
    const snapshot = structuredClone(projectRef.current);
    let current = true;
    setCompileAhead("scheduled");
    const timer = window.setTimeout(() => {
      setCompileAhead("compiling");
      void compilation.precompile(snapshot).then((outcome) => {
        if (!current) return;
        if (outcome.status === "ready" && outcome.result?.artifact) {
          setArtifact(outcome.result.artifact);
          setCompileAhead("ready");
        } else if (outcome.status === "compile-error" || outcome.status === "failed") {
          setCompileAhead("error");
        }
      });
    }, 900);
    return () => {
      current = false;
      window.clearTimeout(timer);
      compilation.supersedeBackground();
      setCompileAhead("idle");
    };
  }, [buildIdentity, hydrated, runtimeReady]);

  useEffect(() => {
    if (!hydrated) return;
    const timer = window.setTimeout(() => void saveProject(project), 350);
    return () => window.clearTimeout(timer);
  }, [hydrated, project]);

  useEffect(() => {
    if (!hydrated) return;
    localStorage.setItem(progressKey, JSON.stringify([...solved].sort()));
  }, [hydrated, progressKey, solved]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      const sampleInput = sampleCases(activeProblem)[0]?.input ?? "";
      let restored: SelfTestCase[];
      try {
        restored = decodeSelfTestCases(localStorage.getItem(activeSelfTestKey), sampleInput);
      } catch (error) {
        localStorage.removeItem(activeSelfTestKey);
        restored = decodeSelfTestCases(null, sampleInput);
        addLog("stderr", error instanceof Error ? error.message : String(error));
      }
      setSelfTests(restored);
      setSelectedSelfTestId(restored[0].id);
      setSelfTestResults([]);
      setRunningSelfTestId(undefined);
      setLoadedSelfTestKey(activeSelfTestKey);
    }, 0);
    return () => window.clearTimeout(timer);
  }, [activeProblem, activeSelfTestKey, addLog]);

  useEffect(() => {
    if (loadedSelfTestKey !== activeSelfTestKey) return;
    let notification: number | undefined;
    try {
      localStorage.setItem(activeSelfTestKey, encodeSelfTestCases(selfTests));
    } catch (error) {
      notification = window.setTimeout(() => {
        addLog("stderr", text.logs.selfTestSaveFailed(error instanceof Error ? error.message : String(error)));
      }, 0);
    }
    return () => { if (notification !== undefined) window.clearTimeout(notification); };
  }, [activeSelfTestKey, addLog, loadedSelfTestKey, selfTests, text]);

  const applyMarkers = useCallback(() => {
    const monaco = monacoRef.current;
    if (!monaco) return;
    for (const model of monaco.editor.getModels()) {
      const path = decodeURIComponent(model.uri.path).replace(/^\//, "");
      const markers = diagnostics
        .filter((diagnostic) => diagnostic.file === path)
        .map((diagnostic) => ({
          startLineNumber: diagnostic.line,
          startColumn: diagnostic.column,
          endLineNumber: diagnostic.endLine ?? diagnostic.line,
          endColumn: diagnostic.endColumn ?? diagnostic.column + 1,
          message: diagnostic.message,
          code: diagnostic.code,
          source: diagnostic.source,
          severity: diagnostic.severity === "error"
            ? monaco.MarkerSeverity.Error
            : diagnostic.severity === "warning"
              ? monaco.MarkerSeverity.Warning
              : monaco.MarkerSeverity.Info,
        }));
      monaco.editor.setModelMarkers(model, "forge", markers);
    }
  }, [diagnostics]);

  useEffect(applyMarkers, [activeFile?.path, applyMarkers]);

  useEffect(() => {
    const editor = editorRef.current;
    const target = revealRef.current;
    if (!editor || !target) return;
    editor.setPosition({ lineNumber: target.line, column: target.column });
    editor.revealPositionInCenter({ lineNumber: target.line, column: target.column });
    editor.focus();
    revealRef.current = undefined;
  }, [project.activeFile]);

  const beforeEditorMount: BeforeMount = useCallback((monaco) => {
    configureForgeLanguageServices(monaco);
  }, []);

  const onEditorMount: OnMount = useCallback((editor, monaco) => {
    editorRef.current = editor;
    monacoRef.current = monaco;
    monaco.editor.defineTheme("forge", {
      base: "vs-dark",
      inherit: true,
      rules: [
        { token: "comment", foreground: "777168", fontStyle: "italic" },
        { token: "keyword", foreground: "c9f27b" },
        { token: "string", foreground: "e9bc7a" },
        { token: "number", foreground: "8dc6ff" },
        { token: "type", foreground: "9de1d1" },
      ],
      colors: {
        "editor.background": "#151411",
        "editor.foreground": "#e8e5de",
        "editorLineNumber.foreground": "#5e5a52",
        "editorLineNumber.activeForeground": "#b9b3a8",
        "editor.lineHighlightBackground": "#1e1d19",
        "editor.selectionBackground": "#39472d",
        "editorCursor.foreground": "#c9f27b",
        "editorIndentGuide.background1": "#292720",
      },
    });
    monaco.editor.setTheme("forge");
    editor.onDidChangeCursorPosition((event) => setLocation({ line: event.position.lineNumber, column: event.position.column }));
    applyMarkers();
  }, [applyMarkers]);

  const updateProject = useCallback((updater: (current: Project) => Project) => {
    setProject((current) => ({ ...updater(current), updatedAt: Date.now() }));
    setArtifact(undefined);
    setSelfTestResults([]);
    setJudgeSession(undefined);
    setSelectedCaseNumber(undefined);
  }, []);

  const updateRunConfig = useCallback((updater: (current: RunConfig) => RunConfig) => {
    setProject((current) => ({
      ...current,
      config: { ...current.config, ...updater(current.config) },
      updatedAt: Date.now(),
    }));
    setSelfTestResults([]);
    setJudgeSession(undefined);
    setSelectedCaseNumber(undefined);
  }, []);

  const updateActiveFile = useCallback((content: string | undefined) => {
    if (content === undefined || !activeFile) return;
    updateProject((current) => ({
      ...current,
      files: current.files.map((file) => file.path === activeFile.path ? { ...file, content } : file),
    }));
  }, [activeFile, updateProject]);

  const openWorkspace = useCallback(async (summary: ProblemCollectionEntry, language: BuiltinLanguage) => {
    if (busy || loadingProblemId) return;
    setLoadingProblemId(summary.id);
    try {
      await saveProject(project);
      const problem = summary.id === activeProblem.id
        ? activeProblem
        : await collection.loadProblem(summary.id);
      const drafts = await listProjects();
      const id = judgeProjectId(collection.sourceKey, summary.bundle.sha256, problem.id, language);
      const draft = drafts.find((candidate) => candidate.id === id);
      compileCoordinatorRef.current?.restart();
      runnerRef.current?.restart();
      setRuntimeReady(true);
      setProject(draft ?? createJudgeProject(collection.sourceKey, summary.bundle.sha256, problem, language));
      setActiveProblem(problem);
      setArtifact(undefined);
      setDiagnostics([]);
      setLogs([]);
      setSelfTestResults([]);
      setRunningSelfTestId(undefined);
      setJudgeSession(undefined);
      setSelectedCaseNumber(undefined);
      setBottomTab("judge");
    } catch (error) {
      addLog("stderr", error instanceof Error ? error.message : String(error));
      setBottomTab("output");
    } finally {
      setLoadingProblemId(undefined);
    }
  }, [activeProblem, addLog, busy, collection, loadingProblemId, project]);

  const doBuild = useCallback(async (allowCache = true): Promise<BuildArtifact | undefined> => {
    const compilation = compileCoordinatorRef.current;
    if (!compilation) return undefined;
    setBusy("build");
    setBottomTab("output");
    setDiagnostics([]);
    setLogs([]);
    const started = performance.now();
    try {
      addLog("system", text.logs.buildStarted(project.name, languageLabel(project.config.language), project.config.target.toUpperCase()));
      const result = await compilation.compile(project, { cache: allowCache });
      setDiagnostics(result.diagnostics);
      if (result.stdout) addLog("stdout", result.stdout);
      if (result.stderr) addLog("stderr", result.stderr);
      if (!result.success || !result.artifact) {
        setCompileAhead("error");
        addLog("system", text.logs.buildFailed(Math.round(performance.now() - started)));
        setBottomTab("diagnostics");
        return undefined;
      }
      setArtifact(result.artifact);
      setCompileAhead("ready");
      const storageReport = await storageCoordinatorRef.current?.maintain();
      if (storageReport) setStorage({ usage: storageReport.after.usage, quota: storageReport.after.quota });
      if (result.cacheHit) {
        addLog("system", text.logs.cacheLoaded(result.artifact.name, formatBytes(result.artifact.size)));
        setProgress({ phase: "packaging", label: "Build cache hit", progress: 1 });
      } else {
        addLog("system", text.logs.buildComplete(result.artifact.name, formatBytes(result.artifact.size), Math.round(result.artifact.durationMs)));
      }
      return result.artifact;
    } catch (error) {
      setCompileAhead("error");
      addLog("stderr", error instanceof Error ? error.message : String(error));
      return undefined;
    } finally {
      setBusy(undefined);
    }
  }, [addLog, project, text]);

  const updateSelfTest = (id: string, update: Partial<Pick<SelfTestCase, "name" | "input">>) => {
    setSelfTests((current) => current.map((testCase) => (
      testCase.id === id ? { ...testCase, ...update } : testCase
    )));
    setSelfTestResults((current) => current.filter((result) => result.caseId !== id));
  };

  const addSelfTest = () => {
    if (selfTests.length >= MAX_SELF_TEST_CASES) return;
    const id = `case-${crypto.randomUUID()}`;
    const names = new Set(selfTests.map((testCase) => testCase.name));
    let number = selfTests.length + 1;
    while (names.has(`Case ${number}`)) number += 1;
    setSelfTests((current) => [...current, { id, name: `Case ${number}`, input: "" }]);
    setSelectedSelfTestId(id);
  };

  const addSampleSelfTests = () => {
    const available = MAX_SELF_TEST_CASES - selfTests.length;
    if (available < 1) return;
    const additions = sampleCases(activeProblem).slice(0, available).map((sample, index) => ({
      id: `sample-${crypto.randomUUID()}`,
      name: text.selfTest.sampleName(index + 1),
      input: sample.input,
    }));
    if (additions.length === 0) return;
    setSelfTests((current) => [...current, ...additions]);
    setSelectedSelfTestId(additions[0].id);
  };

  const removeSelfTest = (id: string) => {
    if (selfTests.length === 1) return;
    const index = selfTests.findIndex((testCase) => testCase.id === id);
    const next = selfTests.filter((testCase) => testCase.id !== id);
    setSelfTests(next);
    setSelfTestResults((current) => current.filter((result) => result.caseId !== id));
    if (selectedSelfTestId === id) setSelectedSelfTestId(next[Math.min(index, next.length - 1)].id);
  };

  const doRunSelfTests = useCallback(async (caseIds: readonly string[]) => {
    const runner = runnerRef.current;
    const requested = selfTests.filter((testCase) => caseIds.includes(testCase.id));
    if (!runner || requested.length === 0) return;
    cancelledRef.current = false;
    setBusy("test");
    setBottomTab("tests");
    setSelectedSelfTestId(requested[0].id);
    setSelfTestResults((current) => current.filter((result) => !caseIds.includes(result.caseId)));
    setLogs([]);
    try {
      const key = await projectCacheKey(project);
      let runnable = artifact?.cacheKey === key ? artifact : undefined;
      if (!runnable) {
        setBusy(undefined);
        runnable = await doBuild(true);
        if (!runnable) return;
        setBottomTab("tests");
        setBusy("test");
      }
      for (const [index, testCase] of requested.entries()) {
        if (cancelledRef.current) break;
        setRunningSelfTestId(testCase.id);
        setSelectedSelfTestId(testCase.id);
        setProgress({
          phase: "running",
          label: `Self Test ${index + 1} / ${requested.length}`,
          progress: index / requested.length,
        });
        addLog("system", text.logs.runStarted(testCase.name.trim() || text.selfTest.caseName(index + 1)));
        const result = await runner.run(runnable, { ...project.config, stdin: testCase.input });
        setSelfTestResults((current) => [
          ...current.filter((candidate) => candidate.caseId !== testCase.id),
          { caseId: testCase.id, run: result },
        ]);
        const cost = result.metrics.cost === null
          ? text.logs.costUnavailable
          : text.logs.cost(result.metrics.cost.toLocaleString());
        addLog("system", `${executionTerminationLabel(problemLocale, result.termination)} · ${text.selfTest.exit} ${result.code} · ${cost} · ${formatDuration(result.durationMs)}`);
      }
      setProgress({ phase: "running", label: "Self Test complete", progress: 1 });
    } catch (error) {
      if (!cancelledRef.current) addLog("stderr", error instanceof Error ? error.message : String(error));
    } finally {
      setRunningSelfTestId(undefined);
      setBusy(undefined);
    }
  }, [addLog, artifact, doBuild, problemLocale, project, selfTests, text]);

  const doJudge = useCallback(async () => {
    const runner = runnerRef.current;
    if (!runner) return;
    cancelledRef.current = false;
    judgingRef.current = true;
    setSelectedCaseNumber(undefined);
    const started = performance.now();
    setBottomTab("judge");
    setLogs([]);
    setJudgeSession({
      problemId: activeProblem.id,
      verdict: "running",
      completed: 0,
      total: activeProblem.judgeCases.length,
      cases: [],
      durationMs: 0,
    });
    try {
      const key = await projectCacheKey(project);
      let runnable = artifact?.cacheKey === key ? artifact : undefined;
      if (!runnable) {
        runnable = await doBuild(true);
        setBottomTab("judge");
        if (!runnable) {
          setJudgeSession({
            problemId: activeProblem.id,
            verdict: "compile-error",
            completed: 0,
            total: activeProblem.judgeCases.length,
            cases: [],
            durationMs: performance.now() - started,
          });
          return;
        }
      }
      setBusy("judge");
      assertProblemCostProfile(activeProblem, projectLanguage, runnable.costProfile);
      const baseline = broadestPolicy(activeProblem);
      const cases: JudgeUiCaseResult[] = [];
      const judging = new JudgeEngine(createJudgeExecutor({
        run: (buildArtifact, run) => runner.run(buildArtifact, {
          ...run,
          args: [...run.args],
          env: { ...run.env },
        }),
        interact: (contestant, interactor, interaction) => runner.interact(
          contestant,
          interactor,
          interaction,
        ),
      }));
      const result = await judging.judge(runnable, {
        version: FORGE_CONTRACT_VERSION,
        failFast: false,
        cases: activeProblem.judgeCases.map((test) => ({
          kind: "batch" as const,
          id: test.id,
          input: { kind: "inline" as const, value: test.input },
          matcher: textMatcher(test.output, "lines"),
          args: project.config.args,
          env: project.config.env,
          determinism: project.config.determinism,
          resources: {
            ...project.config.resources,
            instructionBudget: baseline.limits.instructionBudget,
            memoryLimitBytes: baseline.limits.memoryLimitBytes,
            wallTimeLimitMs: activeProblem.scoring.safetyLimits.wallTimeLimitMs,
            ...(baseline.limits.logicalTimeLimitMs === undefined
              ? {}
              : { logicalTimeLimitMs: baseline.limits.logicalTimeLimitMs }),
          },
        })),
      }, {
        onCase(contractCase, completed, total) {
          if (cancelledRef.current) return;
          const index = completed - 1;
          const expected = activeProblem.judgeCases[index]?.output ?? "";
          cases.push(displayJudgeCase(contractCase, index, expected));
          setProgress({
            phase: "running",
            label: `Local cases ${completed} / ${total}`,
            progress: completed / total,
          });
          setJudgeSession({
            problemId: activeProblem.id,
            verdict: "running",
            completed,
            total,
            cases: [...cases],
            durationMs: performance.now() - started,
          });
        },
      });
      const score = scoreProblemResults(activeProblem, projectLanguage, result.cases);
      const scoredCases = cases.map((testCase, index) => ({
        ...testCase,
        points: score.cases[index].points,
        outputAccepted: score.cases[index].outputAccepted,
        passedPolicyIds: score.cases[index].passedPolicyIds,
        metrics: score.cases[index].metrics ?? undefined,
        policyEvaluations: score.cases[index].policyEvaluations,
      }));
      const detailCase = scoredCases.reduce((lowest, candidate) => (
        (candidate.points ?? 0) < (lowest.points ?? 0) ? candidate : lowest
      ));
      setSelectedCaseNumber(detailCase.number);
      const verdict = cancelledRef.current ? "cancelled" : submissionVerdictFromContract(result.verdict);
      const finished: JudgeUiSession = {
        problemId: activeProblem.id,
        verdict,
        completed: cases.length,
        total: activeProblem.judgeCases.length,
        cases: scoredCases,
        durationMs: performance.now() - started,
        score: {
          numerator: score.numerator,
          denominator: score.denominator,
          points: score.points,
          maximumPoints: score.maximumPoints,
        },
      };
      setJudgeSession(finished);
      if (verdict === "accepted" && score.points === score.maximumPoints) {
        setSolved((current) => new Set([...current, activeProgressId]));
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      addLog("stderr", message);
      setJudgeSession({
        problemId: activeProblem.id,
        verdict: "judge-error",
        completed: 0,
        total: activeProblem.judgeCases.length,
        cases: [],
        durationMs: performance.now() - started,
        message,
      });
    } finally {
      judgingRef.current = false;
      setBusy(undefined);
    }
  }, [activeProblem, activeProgressId, addLog, artifact, doBuild, project, projectLanguage]);

  const cancel = useCallback(() => {
    cancelledRef.current = true;
    judgingRef.current = false;
    compileCoordinatorRef.current?.cancel();
    runnerRef.current?.cancel();
    setBusy(undefined);
    setRunningSelfTestId(undefined);
    setJudgeSession((current) => current?.verdict === "running" ? { ...current, verdict: "cancelled" } : current);
    addLog("system", text.logs.cancelled);
  }, [addLog, text]);

  const chooseTarget = (target: "wasip1" | "wasix") => {
    if (target === project.config.target) return;
    compileCoordinatorRef.current?.restart();
    runnerRef.current?.restart();
    updateProject((current) => ({ ...current, config: { ...current.config, target } }));
  };

  const addFile = () => {
    const path = cleanPath(newFilePath);
    if (!path || project.files.some((file) => file.path === path)) return;
    const language = extensionLanguage(path) ?? project.config.language;
    const file: ProjectFile = { path, language, content: "" };
    updateProject((current) => ({ ...current, files: [...current.files, file], activeFile: path }));
    setNewFilePath("");
    setNewFileOpen(false);
  };

  const removeFile = (path: string) => {
    if (project.files.length === 1 || !window.confirm(text.editor.deleteFileConfirm(path))) return;
    updateProject((current) => {
      const files = current.files.filter((file) => file.path !== path);
      const active = current.activeFile === path ? files[0].path : current.activeFile;
      const entry = current.config.entry === path ? files[0].path : current.config.entry;
      return { ...current, files, activeFile: active, config: { ...current.config, entry } };
    });
  };

  const openDiagnostic = (diagnostic: Diagnostic) => {
    if (!project.files.some((file) => file.path === diagnostic.file)) return;
    revealRef.current = { line: diagnostic.line, column: diagnostic.column };
    setProject((current) => ({ ...current, activeFile: diagnostic.file }));
  };

  const clearCaches = async () => {
    setBusy("cache");
    try {
      const compilation = compileCoordinatorRef.current;
      const runner = runnerRef.current;
      await Promise.all([
        compilation?.cancelAndWait(),
        runner?.cancelAndWait(),
      ]);
      await Promise.all([
        compilerRef.current?.clearToolchainCache(),
        runner?.clearRuntimeCache(),
        clearProblemCollectionCache(),
      ]);
      await storageCoordinatorRef.current?.clear();
      setArtifact(undefined);
      const storageReport = await storageCoordinatorRef.current?.estimate();
      if (storageReport) setStorage({ usage: storageReport.usage, quota: storageReport.quota });
      addLog("system", text.logs.cachesCleared);
    } finally {
      setBusy(undefined);
    }
  };

  if (!hydrated) {
    return <main className="boot-screen"><div className="boot-mark"><Zap size={20} /></div><p>{text.boot}</p></main>;
  }

  return (
    <main className="studio-shell judge-shell">
      <header className="topbar">
        <div className="brand" aria-label="WASM OJ Forge">
          <span className="brand-mark"><Target size={17} strokeWidth={2.4} /></span>
          <span className="brand-name">FORGE</span>
          <span className="brand-edition">judge</span>
        </div>

        <div className="problem-switcher">
          <span className="problem-switcher-number">#{String(activeProblem.number).padStart(2, "0")}</span>
          <span>{activeProblemText.title}</span>
          <span className={`difficulty-pill ${activeProblem.difficulty}`}>{difficultyLabel(activeProblem.difficulty, problemLocale)}</span>
        </div>

        <div className="topbar-actions">
          <label className="compact-select">
            <select
              value={problemLocale}
              onChange={(event) => onProblemLocaleChange(event.target.value as ProblemLocale)}
              aria-label={text.topbar.interfaceLanguage}
              disabled={Boolean(busy || loadingProblemId)}
            >
              {PROBLEM_LOCALES.map((locale) => (
                <option value={locale} key={locale}>{judgeUiText(locale).localeName}</option>
              ))}
            </select>
            <ChevronDown size={12} />
          </label>
          <label className="compact-select language-select">
            <span className={`language-dot ${languageTone(project.config.language)}`} />
            <select
              value={project.config.language}
              onChange={(event) => void openWorkspace(activeProblemEntry, event.target.value as BuiltinLanguage)}
              aria-label={text.topbar.solutionLanguage}
              disabled={Boolean(busy || loadingProblemId)}
            >
              {LANGUAGES.map((language) => <option value={language} key={language}>{languageLabel(language)}</option>)}
            </select>
            <ChevronDown size={12} />
          </label>
          <label className="compact-select">
            <select value={project.config.target} onChange={(event) => chooseTarget(event.target.value as "wasip1" | "wasix")} aria-label={text.topbar.compilationTarget} disabled={Boolean(busy || loadingProblemId)}>
              {activeToolchain.targets.map((target) => <option value={target} key={target}>{target.toUpperCase()}</option>)}
            </select>
            <ChevronDown size={12} />
          </label>
          <button className="icon-button" onClick={() => setOnboardingOpen(true)} aria-label={text.topbar.openGuide} title={text.topbar.guide}><CircleHelp size={16} /></button>
          <button className="icon-button" onClick={() => setSettingsOpen(true)} aria-label={text.topbar.projectSettings}><Settings2 size={16} /></button>
          {busy ? (
            <button className="stop-button" onClick={cancel}><CircleStop size={14} /> {text.topbar.stop}</button>
          ) : (
            <>
              <button className="build-button" onClick={() => void doBuild(false)} disabled={!runtimeReady}><Hammer size={14} /> {text.topbar.build}</button>
              <button className="sample-button" onClick={() => setBottomTab("tests")} disabled={!runtimeReady}><Play size={14} /> {text.topbar.selfTest}</button>
              <button className="submit-button" onClick={() => void doJudge()} disabled={!runtimeReady}><Send size={14} /> {text.topbar.submit}</button>
            </>
          )}
        </div>
      </header>

      <section className="judge-workspace">
        <aside className="problem-catalog">
          <div className="catalog-heading">
            <div><span>{text.catalog.heading.toUpperCase()}</span><strong>{solved.size} / {problems.length}</strong></div>
            <div className="catalog-progress"><span style={{ width: `${(solved.size / problems.length) * 100}%` }} /></div>
          </div>
          <div className="difficulty-filter" aria-label={text.catalog.difficultyFilter}>
            {(["all", "easy", "medium", "hard"] as const).map((value) => (
              <button className={filter === value ? "active" : ""} onClick={() => setFilter(value)} key={value}>
                {value === "all" ? text.catalog.all : difficultyLabel(value, problemLocale)}
              </button>
            ))}
          </div>
          <label className="catalog-search">
            <Search size={13} />
            <input
              type="search"
              value={problemSearch}
              onChange={(event) => setProblemSearch(event.target.value)}
              placeholder={text.catalog.searchPlaceholder}
              aria-label={text.catalog.search}
            />
            {problemSearch && (
              <button type="button" onClick={() => setProblemSearch("")} aria-label={text.catalog.clearSearch}>
                <X size={12} />
              </button>
            )}
          </label>
          <div className="problem-list">
            {groupedProblems.map((group) => (
              <section className="problem-track" key={group.id}>
                <h2>{group.title}</h2>
                {group.problems.map((problem) => (
                  <button
                    className={`problem-row ${problem.id === activeProblem.id ? "active" : ""}`}
                    onClick={() => void openWorkspace(problem, projectLanguage)}
                    disabled={Boolean(busy || loadingProblemId)}
                    key={problem.id}
                  >
                    <span className={`problem-state ${solved.has(judgeProblemProgressId(problem.id, problem.bundle.sha256)) ? "solved" : ""}`}>
                      {solved.has(judgeProblemProgressId(problem.id, problem.bundle.sha256)) ? <Check size={12} /> : String(problem.number).padStart(2, "0")}
                    </span>
                    <span className="problem-row-copy"><strong>{problem.title[problemLocale]}</strong><small>{problem.tags.join(" · ")}</small></span>
                    <span className={`difficulty-dot ${problem.difficulty}`} title={difficultyLabel(problem.difficulty, problemLocale)} />
                  </button>
                ))}
              </section>
            ))}
            {groupedProblems.length === 0 && (
              <div className="catalog-empty">
                <Search size={16} />
                <span>{text.catalog.empty}</span>
              </div>
            )}
          </div>
          <div className="collection-source-card" title={collection.sourceKey}>
            <Package size={14} />
            <div>
              <strong>{collection.source.owner}/{collection.source.repository}</strong>
              <span>{collection.source.ref} · {collection.origin === "network" ? text.catalog.verifiedOnline : text.catalog.verifiedCache}</span>
            </div>
          </div>
        </aside>

        <article className="problem-statement">
          <div className="statement-kicker">
            <span>{text.statement.problem.toUpperCase()} {String(activeProblem.number).padStart(2, "0")}</span>
            <span>{activeProblem.track[problemLocale]} · {activeProblem.tags.join(" · ")}</span>
          </div>
          <h1>{activeProblemText.title}</h1>
          <div className="problem-metrics">
            <span><Gauge size={13} />{difficultyLabel(activeProblem.difficulty, problemLocale)}</span>
            <span><Zap size={13} />{text.statement.baselineCost} {activeBaseline.limits.instructionBudget.toLocaleString()} · {text.statement.perCase}</span>
            <span><Box size={13} />{text.statement.cases(activeProblem.judgeCases.length)}</span>
          </div>
          <div className="problem-policy-grid" aria-label={text.statement.scoringPolicies}>
            {activeProblem.scoring.policies.map((policy) => (
              <div key={policy.id}>
                <span>{policy.title[problemLocale]}</span>
                <strong>+{policy.points} {text.statement.pointsShort}</strong>
                <small>{policy.limits.instructionBudget.toLocaleString()} {text.statement.costUnit} · {formatBytes(policy.limits.memoryLimitBytes)}</small>
              </div>
            ))}
          </div>
          <div className="problem-document-tabs">
            <button className={problemPane === "statement" ? "active" : ""} onClick={() => setProblemPane("statement")}>
              {text.statement.statement}
            </button>
            <button className={problemPane === "editorial" ? "active" : ""} onClick={() => setProblemPane("editorial")}>
              {text.statement.editorial}
            </button>
            <a
              className="ask-chatgpt-button"
              href={chatGptProblemUrl}
              target="_blank"
              rel="noopener noreferrer"
              title={text.statement.askChatGptTitle}
            >
              <MessageCircle size={13} />
              {text.statement.askChatGpt}
            </a>
          </div>
          <ProblemMarkdown markdown={problemPane === "statement" ? activeProblemText.statement : activeProblemText.editorial} />
        </article>

        <section
          className={`editor-stack judge-editor-stack ${resizingBottomPanel ? "resizing-bottom-panel" : ""}`}
          ref={editorStackRef}
          style={{ "--judge-bottom-panel-height": `${bottomPanelHeight}px` } as CSSProperties}
        >
          <div className="editor-tabs file-tabs">
            {project.files.map((file) => (
              <div className={`file-tab ${file.path === project.activeFile ? "active" : ""}`} key={file.path}>
                <button className="file-tab-open" onClick={() => setProject((current) => ({ ...current, activeFile: file.path }))}>
                  <span className={`file-icon ${languageTone(file.language)}`}>{languageIcon(file.language)}</span>
                  {file.path.split("/").at(-1)}
                </button>
                {project.files.length > 1 && <button className="file-tab-close" onClick={() => removeFile(file.path)} aria-label={text.editor.deleteFile(file.path)}><X size={11} /></button>}
              </div>
            ))}
            {newFileOpen ? (
              <form className="tab-new-file" onSubmit={(event) => { event.preventDefault(); addFile(); }}>
                <input autoFocus value={newFilePath} onChange={(event) => setNewFilePath(event.target.value)} placeholder="src/helper.c" aria-label={text.editor.newFilePath} />
                <button type="submit" aria-label={text.editor.createFile}><Check size={12} /></button>
                <button type="button" onClick={() => setNewFileOpen(false)} aria-label={text.editor.cancel}><X size={12} /></button>
              </form>
            ) : (
              <button className="bare-button add-file-tab" onClick={() => setNewFileOpen(true)} aria-label={text.editor.addFile}><Plus size={14} /></button>
            )}
            <div className="editor-actions"><button className="bare-button" onClick={() => setSettingsOpen(true)} aria-label={text.editor.openCompilationSettings}><Settings2 size={14} /></button></div>
          </div>
          <div className="editor-surface">
            {activeFile && (
              <MonacoEditor
                path={`file:///${activeFile.path}`}
                language={isBuiltinLanguage(activeFile.language) ? MONACO_LANGUAGE[activeFile.language] : "plaintext"}
                value={activeFile.content}
                onChange={updateActiveFile}
                beforeMount={beforeEditorMount}
                onMount={onEditorMount}
                theme="forge"
                options={{
                  automaticLayout: true,
                  fontFamily: "var(--font-mono), monospace",
                  fontSize: 13,
                  lineHeight: 21,
                  minimap: { enabled: false },
                  padding: { top: 14, bottom: 14 },
                  renderLineHighlight: "all",
                  readOnly: Boolean(loadingProblemId),
                  scrollBeyondLastLine: false,
                  smoothScrolling: true,
                  tabSize: 4,
                  wordWrap: "off",
                }}
              />
            )}
          </div>

          <div
            className="bottom-panel-resizer"
            role="separator"
            aria-label={text.editor.resizePanel}
            aria-orientation="horizontal"
            aria-valuemin={MIN_BOTTOM_PANEL_HEIGHT}
            aria-valuemax={bottomPanelMaximum}
            aria-valuenow={bottomPanelHeight}
            tabIndex={0}
            title={text.editor.resizePanelHint}
            onDoubleClick={resetBottomPanelHeight}
            onKeyDown={resizeBottomPanelFromKeyboard}
            onPointerDown={startBottomPanelResize}
            onPointerMove={moveBottomPanelResize}
            onPointerUp={(event) => stopBottomPanelResize(event.currentTarget, event.pointerId)}
            onPointerCancel={(event) => stopBottomPanelResize(event.currentTarget, event.pointerId)}
            onLostPointerCapture={() => stopBottomPanelResize()}
          >
            <span aria-hidden="true" />
          </div>

          <section className="bottom-panel">
            <div className="bottom-tabs">
              <button className={bottomTab === "judge" ? "active" : ""} onClick={() => setBottomTab("judge")}>
                {text.panel.judgeResults} {judgeSession && <span className={`verdict-mini ${judgeSession.verdict}`}>{judgeSession.completed}/{judgeSession.total}</span>}
              </button>
              <button className={bottomTab === "tests" ? "active" : ""} onClick={() => setBottomTab("tests")}>
                {text.panel.selfTest} <span className="test-count-badge">{selfTestResults.length}/{selfTests.length}</span>
              </button>
              <button className={bottomTab === "diagnostics" ? "active" : ""} onClick={() => setBottomTab("diagnostics")}>
                {text.panel.diagnostics} {diagnostics.length > 0 && <span className="count-badge">{diagnostics.length}</span>}
              </button>
              <button className={bottomTab === "output" ? "active" : ""} onClick={() => setBottomTab("output")}>{text.panel.output}</button>
              <div className="panel-status">
                {busy && <><span className="spinner" />{localizedWorkerProgress(progress, problemLocale)}</>}
                {!busy && compileAhead === "scheduled" && <>{text.panel.compileScheduled}</>}
                {!busy && compileAhead === "compiling" && <><span className="spinner" />{text.panel.precompiling}</>}
                {!busy && compileAhead === "error" && <><TriangleAlert size={13} />{text.panel.waitingForFix}</>}
                {!busy && compileAhead === "ready" && artifact && <><Check size={13} />{text.panel.precompileReady} · {formatBytes(artifact.size)}</>}
                {!busy && compileAhead === "idle" && artifact && <><Check size={13} />{formatBytes(artifact.size)}</>}
              </div>
              {artifact && <button className="bare-button panel-download" onClick={() => downloadArtifact(artifact)} aria-label={text.panel.downloadArtifact}><Download size={14} /></button>}
            </div>
            <div className="panel-content">
              {bottomTab === "judge" ? (
                !judgeSession ? (
                  <div className="empty-panel judge-empty"><Target size={18} /><strong>{text.judge.ready}</strong><span>{text.judge.readyDescription}</span></div>
                ) : (
                  <div className="judge-results">
                    <div className={`verdict-banner ${judgeSession.verdict}`}>
                      <span className="verdict-icon">{judgeSession.verdict === "accepted" ? <Award size={19} /> : judgeSession.verdict === "running" ? <span className="spinner" /> : <TriangleAlert size={18} />}</span>
                      <div>
                        <strong>
                          {judgeSession.verdict === "accepted"
                            && judgeSession.score
                            && judgeSession.score.points < judgeSession.score.maximumPoints
                            ? text.judge.partialScore
                            : verdictLabel(problemLocale, judgeSession.verdict)}
                        </strong>
                        <span>
                          {text.judge.casesAndPoints(
                            judgeSession.completed,
                            judgeSession.total,
                            judgeSession.score?.points,
                            judgeSession.score?.maximumPoints,
                          )}
                          {` · ${formatDuration(judgeSession.durationMs)}`}
                        </span>
                        {judgeSession.message && <span>{judgeSession.message}</span>}
                      </div>
                    </div>
                    {judgeSession.verdict === "compile-error" && <button className="judge-link" onClick={() => setBottomTab("diagnostics")}>{text.judge.viewDiagnostics}</button>}
                    <div className="case-list">
                      {judgeSession.cases.map((test) => (
                        <div
                          className={`case-card ${test.verdict} ${selectedCaseResult?.number === test.number ? "selected" : ""}`}
                          key={test.number}
                        >
                          <button
                            className="case-row"
                            onClick={() => setSelectedCaseNumber(test.number)}
                            aria-pressed={selectedCaseResult?.number === test.number}
                            type="button"
                          >
                            <span className="case-status">{test.verdict === "accepted" ? <CheckCircle2 size={15} /> : <X size={15} />}</span>
                            <strong>{text.judge.case(test.number)}</strong>
                            <span>
                              {test.verdict === "accepted" ? text.judge.correctOutput : verdictLabel(problemLocale, test.verdict)}
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
                    {judgeSession.score && selectedCaseResult?.policyEvaluations && (
                      <CaseScoreDetails
                        problem={activeProblem}
                        testCase={selectedCaseResult}
                        locale={problemLocale}
                      />
                    )}
                  </div>
                )
              ) : bottomTab === "tests" ? (
                <div className="self-test-workbench">
                  <section className="self-test-cases" aria-label={text.selfTest.inputRegion}>
                    <header className="self-test-toolbar">
                      <div>
                        <strong>{text.selfTest.heading}</strong>
                        <span>{text.selfTest.description}</span>
                      </div>
                      <div>
                        <button type="button" onClick={addSampleSelfTests} disabled={Boolean(busy) || selfTests.length >= MAX_SELF_TEST_CASES}>{text.selfTest.addSamples}</button>
                        <button type="button" onClick={addSelfTest} disabled={Boolean(busy) || selfTests.length >= MAX_SELF_TEST_CASES}><Plus size={12} /> {text.selfTest.add}</button>
                        <button className="self-test-run-all" type="button" onClick={() => void doRunSelfTests(selfTests.map((testCase) => testCase.id))} disabled={Boolean(busy) || !runtimeReady}><Play size={12} /> {text.selfTest.runAll}</button>
                      </div>
                    </header>
                    <div className="self-test-list">
                      {selfTests.map((testCase, index) => {
                        const result = selfTestResults.find((candidate) => candidate.caseId === testCase.id)?.run;
                        const successful = result?.termination === "exited" && result.code === 0;
                        return (
                          <article className={`self-test-card ${selectedSelfTest?.id === testCase.id ? "selected" : ""}`} key={testCase.id}>
                            <header>
                              <button
                                className="self-test-selector"
                                type="button"
                                onClick={() => setSelectedSelfTestId(testCase.id)}
                                aria-pressed={selectedSelfTest?.id === testCase.id}
                              >
                                <span>{String(index + 1).padStart(2, "0")}</span>
                                {runningSelfTestId === testCase.id
                                  ? <span className="spinner" />
                                  : result
                                    ? successful ? <CheckCircle2 size={13} /> : <TriangleAlert size={13} />
                                    : <Code2 size={13} />}
                              </button>
                              <input
                                value={testCase.name}
                                maxLength={80}
                                aria-label={text.selfTest.nameLabel(index + 1)}
                                onFocus={() => setSelectedSelfTestId(testCase.id)}
                                onChange={(event) => updateSelfTest(testCase.id, { name: event.target.value })}
                                disabled={Boolean(busy)}
                              />
                              <button type="button" onClick={() => void doRunSelfTests([testCase.id])} disabled={Boolean(busy) || !runtimeReady} aria-label={text.selfTest.run(testCase.name || text.selfTest.caseName(index + 1))}><Play size={12} /></button>
                              <button type="button" onClick={() => removeSelfTest(testCase.id)} disabled={Boolean(busy) || selfTests.length === 1} aria-label={text.selfTest.remove(testCase.name || text.selfTest.caseName(index + 1))}><X size={12} /></button>
                            </header>
                            <label>
                              <span>STDIN</span>
                              <textarea
                                value={testCase.input}
                                rows={4}
                                spellCheck={false}
                                onFocus={() => setSelectedSelfTestId(testCase.id)}
                                onChange={(event) => updateSelfTest(testCase.id, { input: event.target.value })}
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
                        <span className={selectedSelfTestResult.run.termination === "exited" && selectedSelfTestResult.run.code === 0 ? "success" : "failure"}>
                          {executionTerminationLabel(problemLocale, selectedSelfTestResult.run.termination)} · {text.selfTest.exit} {selectedSelfTestResult.run.code}
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
                        <div className="self-test-stream stdout"><span>STDOUT</span><pre>{selectedSelfTestResult.run.stdout || "∅"}</pre></div>
                        {selectedSelfTestResult.run.stderr && <div className="self-test-stream stderr"><span>STDERR</span><pre>{selectedSelfTestResult.run.stderr}</pre></div>}
                      </div>
                    )}
                  </section>
                </div>
              ) : bottomTab === "diagnostics" ? (
                diagnostics.length === 0 ? (
                  <div className="empty-panel"><Check size={17} /><span>{text.empty.diagnostics}</span></div>
                ) : (
                  <div className="diagnostic-list">
                    {diagnostics.map((diagnostic, index) => (
                      <button className={`diagnostic-row ${diagnostic.severity}`} key={`${diagnostic.file}-${diagnostic.line}-${index}`} onClick={() => openDiagnostic(diagnostic)}>
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
        </section>
      </section>

      <footer className="statusbar">
        <div><LockKeyhole size={12} />{text.status.localJudge}</div>
        <div><Package size={12} />{activeToolchain.label} {activeToolchain.version}</div>
        <div><HardDrive size={12} />{text.status.cached(formatBytes(storage.usage))}</div>
        <div className="status-spacer" />
        <div>{text.status.solved(solved.size, problems.length)}</div>
        <div>{project.config.target.toUpperCase()}</div>
        <div>{text.status.cursor(location.line, location.column)}</div>
      </footer>

      {onboardingOpen && <JudgeOnboarding locale={problemLocale} onClose={dismissOnboarding} />}

      {settingsOpen && (
        <div className="drawer-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setSettingsOpen(false); }}>
          <aside className="settings-drawer" aria-label={text.settings.ariaLabel}>
            <div className="drawer-heading"><div><span>{text.settings.eyebrow}</span><h2>{text.settings.title}</h2><p>{text.settings.description}</p></div><button className="icon-button" onClick={() => setSettingsOpen(false)} aria-label={text.settings.close}><X size={16} /></button></div>
            <section className="problem-source-section" aria-labelledby="problem-source-heading">
              <div className="problem-source-heading">
                <div><span>{text.settings.collectionEyebrow}</span><strong id="problem-source-heading">{text.settings.collectionTitle}</strong></div>
                <code>{collection.index.revision.slice(0, 12)}</code>
              </div>
              <p>{text.settings.collectionDescription}</p>
              <ProblemSourceForm
                source={collection.source}
                locale={problemLocale}
                disabled={Boolean(busy || loadingProblemId)}
                onApply={(next) => {
                  void saveProject(project).then(() => onProblemCollectionSourceChange(next)).catch((error: unknown) => {
                    addLog("stderr", error instanceof Error ? error.message : String(error));
                  });
                }}
              />
            </section>
            <section className="settings-section" aria-labelledby="compile-settings-heading">
              <header className="settings-section-heading"><span>{text.settings.compilationEyebrow}</span><strong id="compile-settings-heading">{text.settings.compilationTitle}</strong><p>{text.settings.compilationDescription}</p></header>
              <div className="toolchain-card">
                <span className={`toolchain-mark ${languageTone(project.config.language)}`}>{languageIcon(project.config.language)}</span>
                <div><strong>{activeToolchain.label}</strong><p>{toolchainNote(problemLocale, projectLanguage)}</p></div>
              </div>
              <label className="form-field"><span>{text.settings.entryFile}</span><select value={project.config.entry} onChange={(event) => updateProject((current) => ({ ...current, config: { ...current.config, entry: event.target.value } }))}>{project.files.map((file) => <option key={file.path}>{file.path}</option>)}</select></label>
              <div className="form-grid">
                <label className="form-field"><span>{text.settings.targetAbi}</span><select value={project.config.target} onChange={(event) => chooseTarget(event.target.value as "wasip1" | "wasix")}>{activeToolchain.targets.map((target) => <option value={target} key={target}>{target.toUpperCase()}</option>)}</select></label>
                <label className="form-field"><span>{text.settings.profile}</span><select value={project.config.optimization} onChange={(event) => updateProject((current) => ({ ...current, config: { ...current.config, optimization: event.target.value as "debug" | "release" } }))}><option value="debug">Debug · -O0</option><option value="release">Release · -O2</option></select></label>
              </div>
              {project.config.language === "rust" && <div className="profile-notice"><TriangleAlert size={15} /><p><strong>{text.settings.rustToolchainTitle}</strong> {text.settings.rustToolchainNote(activeToolchain.version)}</p></div>}
              {project.config.language === "go" && <div className="profile-notice"><TriangleAlert size={15} /><p><strong>{text.settings.goToolchainTitle}</strong> {text.settings.goToolchainNote(activeToolchain.version)}</p></div>}
            </section>

            <section className="settings-section" aria-labelledby="runtime-settings-heading">
              <header className="settings-section-heading"><span>{text.settings.executionEyebrow}</span><strong id="runtime-settings-heading">{text.settings.executionTitle}</strong><p>{text.settings.executionDescription}</p></header>
              <div className="form-grid">
                <label className="form-field"><span>{text.settings.instructionBudget}</span><input type="number" min="1" max={Number.MAX_SAFE_INTEGER} step="1000000" value={project.config.resources.instructionBudget} onChange={(event) => updateRunConfig((current) => ({ ...current, resources: { ...current.resources, instructionBudget: Number(event.target.value) } }))} /></label>
                <label className="form-field"><span>{text.settings.logicalTimeBudget}</span><input type="number" min="1" max="9007199254" step="100" value={project.config.resources.logicalTimeLimitMs} onChange={(event) => updateRunConfig((current) => ({ ...current, resources: { ...current.resources, logicalTimeLimitMs: Number(event.target.value) } }))} /></label>
              </div>
              <div className="form-grid">
                <label className="form-field"><span>{text.settings.linearMemory}</span><input type="number" min="1" max="4096" step="1" value={project.config.resources.memoryLimitBytes / (1024 * 1024)} onChange={(event) => updateRunConfig((current) => ({ ...current, resources: { ...current.resources, memoryLimitBytes: Number(event.target.value) * 1024 * 1024 } }))} /></label>
                <label className="form-field"><span>{text.settings.capturedOutput}</span><input type="number" min="0.0625" max="64" step="0.0625" value={project.config.resources.outputLimitBytes / (1024 * 1024)} onChange={(event) => updateRunConfig((current) => ({ ...current, resources: { ...current.resources, outputLimitBytes: Number(event.target.value) * 1024 * 1024 } }))} /></label>
              </div>
              <div className="form-grid">
                <label className="form-field"><span>{text.settings.writableVfs}</span><input type="number" min="0.0625" max="512" step="0.0625" value={project.config.resources.filesystemWriteLimitBytes / (1024 * 1024)} onChange={(event) => updateRunConfig((current) => ({ ...current, resources: { ...current.resources, filesystemWriteLimitBytes: Number(event.target.value) * 1024 * 1024 } }))} /></label>
                <label className="form-field"><span>{text.settings.writableVfsEntries}</span><input type="number" min="1" max="65536" step="1" value={project.config.resources.filesystemEntryLimit} onChange={(event) => updateRunConfig((current) => ({ ...current, resources: { ...current.resources, filesystemEntryLimit: Number(event.target.value) } }))} /></label>
              </div>
              <label className="form-field"><span>{text.settings.wallDeadline}</span><input type="number" min="1" max="600000" step="100" value={project.config.resources.wallTimeLimitMs} onChange={(event) => updateRunConfig((current) => ({ ...current, resources: { ...current.resources, wallTimeLimitMs: Number(event.target.value) } }))} /></label>
              <div className="profile-notice"><Gauge size={15} /><p><strong>{text.settings.portableLimitsTitle}</strong> {text.settings.portableLimitsNote}</p></div>
            </section>

            <section className="settings-section" aria-labelledby="determinism-settings-heading">
              <header className="settings-section-heading"><span>{text.settings.determinismEyebrow}</span><strong id="determinism-settings-heading">{text.settings.determinismTitle}</strong><p>{text.settings.determinismDescription}</p></header>
              <div className="form-grid">
                <label className="form-field"><span>{text.settings.randomSeed}</span><input type="number" min="0" max="4294967295" step="1" value={project.config.determinism.randomSeed} onChange={(event) => updateRunConfig((current) => ({ ...current, determinism: { ...current.determinism, randomSeed: Number(event.target.value) } }))} /></label>
                <label className="form-field"><span>{text.settings.clockStep}</span><input type="number" min="1" max="1000000000" step="1" value={project.config.determinism.clockStepNs} onChange={(event) => updateRunConfig((current) => ({ ...current, determinism: { ...current.determinism, clockStepNs: Number(event.target.value) } }))} /></label>
              </div>
              <label className="form-field"><span>{text.settings.realtimeEpoch}</span><input type="number" min="0" max="18446744073000" step="1" value={project.config.determinism.realtimeEpochMs} onChange={(event) => updateRunConfig((current) => ({ ...current, determinism: { ...current.determinism, realtimeEpochMs: Number(event.target.value) } }))} /></label>
              <div className="profile-notice"><Clock3 size={15} /><p><strong>{text.settings.deterministicExecutionTitle}</strong> {text.settings.deterministicExecutionNote}</p></div>
            </section>

            <section className="settings-section settings-storage-section" aria-labelledby="storage-settings-heading">
              <header className="settings-section-heading"><span>{text.settings.localDataEyebrow}</span><strong id="storage-settings-heading">{text.settings.localDataTitle}</strong><p>{text.settings.localDataDescription}</p></header>
              <div className="local-judge-note drawer-judge-note"><LockKeyhole size={15} /><p><strong>{text.settings.noAntiCheatTitle}</strong>{text.settings.noAntiCheatNote}</p></div>
              <div className="cache-section"><div><strong>{text.settings.localCache}</strong><span>{formatBytes(storage.usage)} / {storage.quota ? formatBytes(storage.quota) : text.settings.browserQuota}</span></div><button onClick={() => void clearCaches()} disabled={Boolean(busy)}><RotateCcw size={13} /> {text.settings.clearCache}</button></div>
              <div className="drawer-footer"><ShieldCheck size={14} /><span>{text.settings.privacyNote}</span></div>
            </section>
          </aside>
        </div>
      )}
    </main>
  );
}
