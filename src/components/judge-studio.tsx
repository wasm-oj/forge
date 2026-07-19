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
  type SubmissionVerdict,
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
  loadProblemCollection,
  normalizeProblemCollectionSource,
  type GithubProblemCollectionSource,
  type LoadedProblemCollection,
  type ProblemCollectionEntry,
} from "@/src/judge/problem-catalog-loader";
import {
  broadestPolicy,
  DEFAULT_PROBLEM_LOCALE,
  PROBLEM_LOCALES,
  problemText,
  sampleCases,
  type JudgeProblem,
  type ProblemDifficulty,
  type ProblemLocale,
} from "@/src/judge/problem-model";
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
  const labels = locale === "zh-TW"
    ? { easy: "入門", medium: "進階", hard: "挑戰" }
    : { easy: "Easy", medium: "Medium", hard: "Hard" };
  return labels[difficulty];
}

function verdictLabel(verdict: SubmissionVerdict): string {
  return ({
    running: "判題中",
    accepted: "Accepted",
    "wrong-answer": "Wrong Answer",
    "runtime-error": "Runtime Error",
    "time-limit": "Time Limit",
    "judge-error": "Judge Error",
    "compile-error": "Compile Error",
    cancelled: "已取消",
  })[verdict];
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
  error?: string;
}

function storedProblemCollectionSource(): StoredProblemCollectionSource {
  if (typeof window === "undefined") return { source: DEFAULT_PROBLEM_COLLECTION_SOURCE };
  let raw: string | null;
  try {
    raw = localStorage.getItem(PROBLEM_COLLECTION_SOURCE_KEY);
  } catch (reason) {
    return {
      source: DEFAULT_PROBLEM_COLLECTION_SOURCE,
      error: `無法讀取題庫來源設定：${reason instanceof Error ? reason.message : String(reason)}`,
    };
  }
  if (!raw) return { source: DEFAULT_PROBLEM_COLLECTION_SOURCE };
  try {
    return { source: normalizeProblemCollectionSource(JSON.parse(raw) as unknown) };
  } catch (reason) {
    return {
      source: DEFAULT_PROBLEM_COLLECTION_SOURCE,
      error: `儲存的題庫來源設定無效：${reason instanceof Error ? reason.message : String(reason)}`,
    };
  }
}

interface ProblemSourceFormProps {
  source: GithubProblemCollectionSource;
  disabled?: boolean;
  onApply(source: GithubProblemCollectionSource): void;
}

function ProblemSourceForm({ source, disabled, onApply }: ProblemSourceFormProps) {
  const [draft, setDraft] = useState<ProblemSourceDraft>(() => sourceDraft(source));
  const [error, setError] = useState<string>();

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
        <label className="form-field"><span>GitHub owner</span><input value={draft.owner} disabled={disabled} onChange={(event) => setDraft((current) => ({ ...current, owner: event.target.value }))} /></label>
        <label className="form-field"><span>Repository</span><input value={draft.repository} disabled={disabled} onChange={(event) => setDraft((current) => ({ ...current, repository: event.target.value }))} /></label>
      </div>
      <div className="form-grid">
        <label className="form-field"><span>Branch / tag / commit</span><input value={draft.ref} disabled={disabled} onChange={(event) => setDraft((current) => ({ ...current, ref: event.target.value }))} /></label>
        <label className="form-field"><span>Collection index</span><input value={draft.indexPath} disabled={disabled} onChange={(event) => setDraft((current) => ({ ...current, indexPath: event.target.value }))} /></label>
      </div>
      {error && <p className="problem-source-error" role="alert">{error}</p>}
      <div className="problem-source-actions">
        <button type="button" disabled={disabled} onClick={() => {
          setDraft(sourceDraft(DEFAULT_PROBLEM_COLLECTION_SOURCE));
          setError(undefined);
        }}>使用預設值</button>
        <button type="button" className="problem-source-apply" disabled={disabled} onClick={apply}>載入並驗證題庫</button>
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
  const [source, setSource] = useState<GithubProblemCollectionSource>(storedSource.source);
  const [session, setSession] = useState<ProblemCollectionSession>();
  const [error, setError] = useState<string | undefined>(storedSource.error);
  const [blockedByStoredConfiguration, setBlockedByStoredConfiguration] = useState(Boolean(storedSource.error));
  const [retry, setRetry] = useState(0);

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
      setError(reason instanceof Error ? reason.message : String(reason));
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

  if (error) {
    return (
      <main className="problem-catalog-status problem-source-recovery" role="alert">
        <TriangleAlert size={22} />
        <strong>無法驗證設定的題庫</strong>
        <span>{error}</span>
        <ProblemSourceForm key={JSON.stringify(source)} source={source} onApply={changeSource} />
        <button type="button" className="problem-source-retry" onClick={retrySource}>重試目前來源</button>
      </main>
    );
  }
  if (!session) {
    return (
      <main className="problem-catalog-status" aria-live="polite">
        <ShieldCheck size={22} />
        <span>Loading and verifying problem collection…</span>
      </main>
    );
  }
  return (
    <JudgeStudio
      key={`${session.collection.sourceKey}:${session.collection.index.revision}`}
      collection={session.collection}
      initialProblem={session.initialProblem}
      onProblemCollectionSourceChange={changeSource}
    />
  );
}

interface JudgeStudioProps {
  collection: LoadedProblemCollection;
  initialProblem: JudgeProblem;
  onProblemCollectionSourceChange(source: GithubProblemCollectionSource): void;
}

export function JudgeStudio({ collection, initialProblem, onProblemCollectionSourceChange }: JudgeStudioProps) {
  const problems = collection.index.problems;
  const initialProblemEntry = problems.find((problem) => problem.id === initialProblem.id);
  if (!initialProblemEntry) throw new Error(`Initial problem '${initialProblem.id}' is absent from its collection index.`);
  const problemDigests = useMemo(() => new Map(problems.map((problem) => [problem.id, problem.bundle.sha256])), [problems]);
  const validProgressIds = useMemo(() => new Set(problems.map((problem) => judgeProblemProgressId(problem.id, problem.bundle.sha256))), [problems]);
  const progressKey = useMemo(() => judgeProgressKey(collection.sourceKey), [collection.sourceKey]);
  const [project, setProject] = useState<Project>(() => createJudgeProject(collection.sourceKey, initialProblemEntry.bundle.sha256, initialProblem, "c"));
  const [activeProblem, setActiveProblem] = useState(initialProblem);
  const [loadingProblemId, setLoadingProblemId] = useState<string>();
  const [problemLocale, setProblemLocale] = useState<ProblemLocale>(DEFAULT_PROBLEM_LOCALE);
  const [problemPane, setProblemPane] = useState<ProblemPane>("statement");
  const [filter, setFilter] = useState<DifficultyFilter>("all");
  const [solved, setSolved] = useState<Set<string>>(new Set());
  const [hydrated, setHydrated] = useState(false);
  const [runtimeReady, setRuntimeReady] = useState(false);
  const [progress, setProgress] = useState<WorkerProgress>({ phase: "initializing", label: "啟動 Wasmer runtime", progress: 0 });
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
    () => buildChatGptProblemUrl(activeProblem, problemLocale, projectLanguage),
    [activeProblem, problemLocale, projectLanguage],
  );
  const activeToolchain = TOOLCHAINS[projectLanguage];
  const buildIdentity = useMemo(() => projectBuildIdentity(project), [project]);
  const filteredProblems = useMemo(
    () => filter === "all" ? problems : problems.filter((problem) => problem.difficulty === filter),
    [filter, problems],
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
        addLog("stderr", `無法儲存自行測試：${error instanceof Error ? error.message : String(error)}`);
      }, 0);
    }
    return () => { if (notification !== undefined) window.clearTimeout(notification); };
  }, [activeSelfTestKey, addLog, loadedSelfTestKey, selfTests]);

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
      addLog("system", `build ${project.name} · ${languageLabel(project.config.language)} → ${project.config.target.toUpperCase()}`);
      const result = await compilation.compile(project, { cache: allowCache });
      setDiagnostics(result.diagnostics);
      if (result.stdout) addLog("stdout", result.stdout);
      if (result.stderr) addLog("stderr", result.stderr);
      if (!result.success || !result.artifact) {
        setCompileAhead("error");
        addLog("system", `建置失敗 · ${Math.round(performance.now() - started)} ms`);
        setBottomTab("diagnostics");
        return undefined;
      }
      setArtifact(result.artifact);
      setCompileAhead("ready");
      const storageReport = await storageCoordinatorRef.current?.maintain();
      if (storageReport) setStorage({ usage: storageReport.after.usage, quota: storageReport.after.quota });
      if (result.cacheHit) {
        addLog("system", `從本機建置快取載入 ${result.artifact.name} · ${formatBytes(result.artifact.size)}`);
        setProgress({ phase: "packaging", label: "命中建置快取", progress: 1 });
      } else {
        addLog("system", `完成 ${result.artifact.name} · ${formatBytes(result.artifact.size)} · ${Math.round(result.artifact.durationMs)} ms`);
      }
      return result.artifact;
    } catch (error) {
      setCompileAhead("error");
      addLog("stderr", error instanceof Error ? error.message : String(error));
      return undefined;
    } finally {
      setBusy(undefined);
    }
  }, [addLog, project]);

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
      name: `${problemLocale === "zh-TW" ? "範例" : "Sample"} ${index + 1}`,
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
          label: `自行測試 ${index + 1} / ${requested.length}`,
          progress: index / requested.length,
        });
        addLog("system", `run ${testCase.name.trim() || `Case ${index + 1}`}`);
        const result = await runner.run(runnable, { ...project.config, stdin: testCase.input });
        setSelfTestResults((current) => [
          ...current.filter((candidate) => candidate.caseId !== testCase.id),
          { caseId: testCase.id, run: result },
        ]);
        const cost = result.metrics.cost === null ? "cost unavailable" : `${result.metrics.cost.toLocaleString()} cost`;
        addLog("system", `${result.termination} · exit ${result.code} · ${cost} · ${formatDuration(result.durationMs)}`);
      }
      setProgress({ phase: "running", label: "自行測試完成", progress: 1 });
    } catch (error) {
      if (!cancelledRef.current) addLog("stderr", error instanceof Error ? error.message : String(error));
    } finally {
      setRunningSelfTestId(undefined);
      setBusy(undefined);
    }
  }, [addLog, artifact, doBuild, project, selfTests]);

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
            label: `本機測資 ${completed} / ${total}`,
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
    addLog("system", "已取消操作並重啟 ForgeCompiler／ForgeRunner Workers");
  }, [addLog]);

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
    if (project.files.length === 1 || !window.confirm(`從本機專案刪除 ${path}？`)) return;
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
      addLog("system", "已清除本機題庫、工具鏈回應與建置產物快取");
    } finally {
      setBusy(undefined);
    }
  };

  if (!hydrated) {
    return <main className="boot-screen"><div className="boot-mark"><Zap size={20} /></div><p>開啟本機 Judge workspace</p></main>;
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
              onChange={(event) => setProblemLocale(event.target.value as ProblemLocale)}
              aria-label="Problem language"
              disabled={Boolean(busy || loadingProblemId)}
            >
              {PROBLEM_LOCALES.map((locale) => (
                <option value={locale} key={locale}>{locale === "zh-TW" ? "繁中" : "English"}</option>
              ))}
            </select>
            <ChevronDown size={12} />
          </label>
          <label className="compact-select language-select">
            <span className={`language-dot ${languageTone(project.config.language)}`} />
            <select
              value={project.config.language}
              onChange={(event) => void openWorkspace(activeProblemEntry, event.target.value as BuiltinLanguage)}
              aria-label="解題語言"
              disabled={Boolean(busy || loadingProblemId)}
            >
              {LANGUAGES.map((language) => <option value={language} key={language}>{languageLabel(language)}</option>)}
            </select>
            <ChevronDown size={12} />
          </label>
          <label className="compact-select">
            <select value={project.config.target} onChange={(event) => chooseTarget(event.target.value as "wasip1" | "wasix")} aria-label="編譯目標" disabled={Boolean(busy || loadingProblemId)}>
              {activeToolchain.targets.map((target) => <option value={target} key={target}>{target.toUpperCase()}</option>)}
            </select>
            <ChevronDown size={12} />
          </label>
          <button className="icon-button" onClick={() => setSettingsOpen(true)} aria-label="專案設定"><Settings2 size={16} /></button>
          {busy ? (
            <button className="stop-button" onClick={cancel}><CircleStop size={14} /> 停止</button>
          ) : (
            <>
              <button className="build-button" onClick={() => void doBuild(false)} disabled={!runtimeReady}><Hammer size={14} /> 建置</button>
              <button className="sample-button" onClick={() => setBottomTab("tests")} disabled={!runtimeReady}><Play size={14} /> 自行測試</button>
              <button className="submit-button" onClick={() => void doJudge()} disabled={!runtimeReady}><Send size={14} /> 提交判題</button>
            </>
          )}
        </div>
      </header>

      <section className="judge-workspace">
        <aside className="problem-catalog">
          <div className="catalog-heading">
            <div><span>CHALLENGES</span><strong>{solved.size} / {problems.length}</strong></div>
            <div className="catalog-progress"><span style={{ width: `${(solved.size / problems.length) * 100}%` }} /></div>
          </div>
          <div className="difficulty-filter" aria-label="題目難度篩選">
            {(["all", "easy", "medium", "hard"] as const).map((value) => (
              <button className={filter === value ? "active" : ""} onClick={() => setFilter(value)} key={value}>
                {value === "all" ? (problemLocale === "zh-TW" ? "全部" : "All") : difficultyLabel(value, problemLocale)}
              </button>
            ))}
          </div>
          <div className="problem-list">
            {filteredProblems.map((problem) => (
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
          </div>
          <div className="privacy-card judge-privacy">
            <ShieldCheck size={16} />
            <div><strong>100% in browser</strong><span>程式碼、測資與判題結果只留在此裝置。</span></div>
          </div>
          <div className="collection-source-card" title={collection.sourceKey}>
            <Package size={14} />
            <div>
              <strong>{collection.source.owner}/{collection.source.repository}</strong>
              <span>{collection.source.ref} · {collection.origin === "network" ? "verified online" : "verified cache"}</span>
            </div>
          </div>
        </aside>

        <article className="problem-statement">
          <div className="statement-kicker">
            <span>PROBLEM {String(activeProblem.number).padStart(2, "0")}</span>
            <span>{activeProblem.tags.join(" · ")}</span>
          </div>
          <h1>{activeProblemText.title}</h1>
          <div className="problem-metrics">
            <span><Gauge size={13} />{difficultyLabel(activeProblem.difficulty, problemLocale)}</span>
            <span><Zap size={13} />Baseline cost {activeBaseline.limits.instructionBudget.toLocaleString()} / case</span>
            <span><Box size={13} />{activeProblem.judgeCases.length} cases</span>
          </div>
          <div className="problem-policy-grid" aria-label="Cumulative scoring policies">
            {activeProblem.scoring.policies.map((policy) => (
              <div key={policy.id}>
                <span>{policy.title[problemLocale]}</span>
                <strong>+{policy.points} pts</strong>
                <small>{policy.limits.instructionBudget.toLocaleString()} cost · {formatBytes(policy.limits.memoryLimitBytes)}</small>
              </div>
            ))}
          </div>
          <div className="problem-document-tabs">
            <button className={problemPane === "statement" ? "active" : ""} onClick={() => setProblemPane("statement")}>
              {problemLocale === "zh-TW" ? "題目敘述" : "Statement"}
            </button>
            <button className={problemPane === "editorial" ? "active" : ""} onClick={() => setProblemPane("editorial")}>
              {problemLocale === "zh-TW" ? "題解" : "Editorial"}
            </button>
            <a
              className="ask-chatgpt-button"
              href={chatGptProblemUrl}
              target="_blank"
              rel="noopener noreferrer"
              title={problemLocale === "zh-TW" ? "帶著完整題目與目前語言模板詢問 ChatGPT" : "Ask ChatGPT with the full problem and current language template"}
            >
              <MessageCircle size={13} />
              {problemLocale === "zh-TW" ? "詢問 ChatGPT" : "Ask ChatGPT"}
            </a>
          </div>
          <ProblemMarkdown markdown={problemPane === "statement" ? activeProblemText.statement : activeProblemText.editorial} />
          <div className="local-judge-note">
            <LockKeyhole size={15} />
            {problemLocale === "zh-TW"
              ? <p><strong>本機判題邊界</strong>完整離線判題代表測資存在瀏覽器內，適合練習與自我驗證，不宣稱能防止使用者檢視測資。</p>
              : <p><strong>Local judging boundary</strong>Offline judging keeps tests in the browser. It is intended for practice and self-verification, not for hiding tests from the user.</p>}
          </div>
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
                {project.files.length > 1 && <button className="file-tab-close" onClick={() => removeFile(file.path)} aria-label={`刪除 ${file.path}`}><X size={11} /></button>}
              </div>
            ))}
            {newFileOpen ? (
              <form className="tab-new-file" onSubmit={(event) => { event.preventDefault(); addFile(); }}>
                <input autoFocus value={newFilePath} onChange={(event) => setNewFilePath(event.target.value)} placeholder="src/helper.c" aria-label="新檔案路徑" />
                <button type="submit" aria-label="建立檔案"><Check size={12} /></button>
                <button type="button" onClick={() => setNewFileOpen(false)} aria-label="取消"><X size={12} /></button>
              </form>
            ) : (
              <button className="bare-button add-file-tab" onClick={() => setNewFileOpen(true)} aria-label="新增檔案"><Plus size={14} /></button>
            )}
            <div className="editor-actions"><button className="bare-button" onClick={() => setSettingsOpen(true)} aria-label="開啟編譯設定"><Settings2 size={14} /></button></div>
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
            aria-label={problemLocale === "zh-TW" ? "調整編輯器與下方面板高度" : "Resize editor and bottom panel"}
            aria-orientation="horizontal"
            aria-valuemin={MIN_BOTTOM_PANEL_HEIGHT}
            aria-valuemax={bottomPanelMaximum}
            aria-valuenow={bottomPanelHeight}
            tabIndex={0}
            title={problemLocale === "zh-TW" ? "拖曳或使用方向鍵調整高度；雙擊重設" : "Drag or use arrow keys to resize; double-click to reset"}
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
                判題結果 {judgeSession && <span className={`verdict-mini ${judgeSession.verdict}`}>{judgeSession.completed}/{judgeSession.total}</span>}
              </button>
              <button className={bottomTab === "tests" ? "active" : ""} onClick={() => setBottomTab("tests")}>
                自行測試 <span className="test-count-badge">{selfTestResults.length}/{selfTests.length}</span>
              </button>
              <button className={bottomTab === "diagnostics" ? "active" : ""} onClick={() => setBottomTab("diagnostics")}>
                Diagnostics {diagnostics.length > 0 && <span className="count-badge">{diagnostics.length}</span>}
              </button>
              <button className={bottomTab === "output" ? "active" : ""} onClick={() => setBottomTab("output")}>Output</button>
              <div className="panel-status">
                {busy && <><span className="spinner" />{progress.label}</>}
                {!busy && compileAhead === "scheduled" && <>背景編譯已排程</>}
                {!busy && compileAhead === "compiling" && <><span className="spinner" />背景預編譯</>}
                {!busy && compileAhead === "error" && <><TriangleAlert size={13} />等待修正</>}
                {!busy && compileAhead === "ready" && artifact && <><Check size={13} />預編譯完成 · {formatBytes(artifact.size)}</>}
                {!busy && compileAhead === "idle" && artifact && <><Check size={13} />{formatBytes(artifact.size)}</>}
              </div>
              {artifact && <button className="bare-button panel-download" onClick={() => downloadArtifact(artifact)} aria-label="下載產物"><Download size={14} /></button>}
            </div>
            <div className="panel-content">
              {bottomTab === "judge" ? (
                !judgeSession ? (
                  <div className="empty-panel judge-empty"><Target size={18} /><strong>準備提交</strong><span>程式只會送進此分頁內的 Wasmer runtime。</span></div>
                ) : (
                  <div className="judge-results">
                    <div className={`verdict-banner ${judgeSession.verdict}`}>
                      <span className="verdict-icon">{judgeSession.verdict === "accepted" ? <Award size={19} /> : judgeSession.verdict === "running" ? <span className="spinner" /> : <TriangleAlert size={18} />}</span>
                      <div>
                        <strong>
                          {judgeSession.verdict === "accepted"
                            && judgeSession.score
                            && judgeSession.score.points < judgeSession.score.maximumPoints
                            ? (problemLocale === "zh-TW" ? "輸出正確 · 部分得分" : "Correct Output · Partial Score")
                            : verdictLabel(judgeSession.verdict)}
                        </strong>
                        <span>
                          {judgeSession.completed} / {judgeSession.total} cases
                          {judgeSession.score ? ` · ${judgeSession.score.points.toFixed(2)} / ${judgeSession.score.maximumPoints} points` : ""}
                          {` · ${formatDuration(judgeSession.durationMs)}`}
                        </span>
                        {judgeSession.message && <span>{judgeSession.message}</span>}
                      </div>
                    </div>
                    {judgeSession.verdict === "compile-error" && <button className="judge-link" onClick={() => setBottomTab("diagnostics")}>查看編譯診斷 →</button>}
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
                            <strong>Case {String(test.number).padStart(2, "0")}</strong>
                            <span>
                              {test.verdict === "accepted" ? (problemLocale === "zh-TW" ? "輸出正確" : "Correct output") : verdictLabel(test.verdict)}
                              {test.points === undefined ? "" : ` · ${test.points} pts`}
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
                              <div><span>EXPECTED</span><pre>{test.expected || "∅"}</pre></div>
                              <div><span>ACTUAL</span><pre>{test.actual || test.stderr || "∅"}</pre></div>
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
                  <section className="self-test-cases" aria-label="自行測試輸入">
                    <header className="self-test-toolbar">
                      <div>
                        <strong>測試案例</strong>
                        <span>每筆輸入會使用相同的最新編譯產物依序執行</span>
                      </div>
                      <div>
                        <button type="button" onClick={addSampleSelfTests} disabled={Boolean(busy) || selfTests.length >= MAX_SELF_TEST_CASES}>加入範例</button>
                        <button type="button" onClick={addSelfTest} disabled={Boolean(busy) || selfTests.length >= MAX_SELF_TEST_CASES}><Plus size={12} /> 新增</button>
                        <button className="self-test-run-all" type="button" onClick={() => void doRunSelfTests(selfTests.map((testCase) => testCase.id))} disabled={Boolean(busy) || !runtimeReady}><Play size={12} /> 全部執行</button>
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
                                aria-label={`測試案例 ${index + 1} 名稱`}
                                onFocus={() => setSelectedSelfTestId(testCase.id)}
                                onChange={(event) => updateSelfTest(testCase.id, { name: event.target.value })}
                                disabled={Boolean(busy)}
                              />
                              <button type="button" onClick={() => void doRunSelfTests([testCase.id])} disabled={Boolean(busy) || !runtimeReady} aria-label={`執行 ${testCase.name || `Case ${index + 1}`}`}><Play size={12} /></button>
                              <button type="button" onClick={() => removeSelfTest(testCase.id)} disabled={Boolean(busy) || selfTests.length === 1} aria-label={`刪除 ${testCase.name || `Case ${index + 1}`}`}><X size={12} /></button>
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
                      <div><span>RESULT</span><strong>{selectedSelfTest?.name.trim() || "Untitled case"}</strong></div>
                      {selectedSelfTestResult && (
                        <span className={selectedSelfTestResult.run.termination === "exited" && selectedSelfTestResult.run.code === 0 ? "success" : "failure"}>
                          {selectedSelfTestResult.run.termination} · exit {selectedSelfTestResult.run.code}
                        </span>
                      )}
                    </header>
                    {!selectedSelfTestResult ? (
                      <div className="empty-panel"><Play size={17} /><span>執行選取的案例後，在這裡查看輸出與資源用量</span></div>
                    ) : (
                      <div className="self-test-result-body">
                        <div className="self-test-metrics">
                          <div><span>Duration</span><strong>{formatDuration(selectedSelfTestResult.run.durationMs)}</strong></div>
                          <div><span>Instruction cost</span><strong>{selectedSelfTestResult.run.metrics.cost?.toLocaleString() ?? "—"}</strong></div>
                          <div><span>Peak memory</span><strong>{selectedSelfTestResult.run.metrics.memoryBytes === null ? "—" : formatBytes(selectedSelfTestResult.run.metrics.memoryBytes)}</strong></div>
                          <div><span>Logical time</span><strong>{selectedSelfTestResult.run.metrics.logicalTimeNs === null ? "—" : formatDuration(selectedSelfTestResult.run.metrics.logicalTimeNs / 1_000_000)}</strong></div>
                        </div>
                        <div className="self-test-stream stdout"><span>STDOUT</span><pre>{selectedSelfTestResult.run.stdout || "∅"}</pre></div>
                        {selectedSelfTestResult.run.stderr && <div className="self-test-stream stderr"><span>STDERR</span><pre>{selectedSelfTestResult.run.stderr}</pre></div>}
                      </div>
                    )}
                  </section>
                </div>
              ) : bottomTab === "diagnostics" ? (
                diagnostics.length === 0 ? (
                  <div className="empty-panel"><Check size={17} /><span>沒有編譯診斷</span></div>
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
                <div className="empty-panel"><Code2 size={17} /><span>建置或執行後，在這裡查看完整輸出紀錄</span></div>
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
        <div><LockKeyhole size={12} />Local judge</div>
        <div><Package size={12} />{activeToolchain.label} {activeToolchain.version}</div>
        <div><HardDrive size={12} />{formatBytes(storage.usage)} cached</div>
        <div className="status-spacer" />
        <div>{solved.size}/{problems.length} solved</div>
        <div>{project.config.target.toUpperCase()}</div>
        <div>Ln {location.line}, Col {location.column}</div>
      </footer>

      {settingsOpen && (
        <div className="drawer-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setSettingsOpen(false); }}>
          <aside className="settings-drawer" aria-label="本機 Judge 設定">
            <div className="drawer-heading"><div><span>LOCAL JUDGE</span><h2>工作區設定</h2><p>編譯、執行與本機資料各自獨立設定。</p></div><button className="icon-button" onClick={() => setSettingsOpen(false)} aria-label="關閉設定"><X size={16} /></button></div>
            <section className="problem-source-section" aria-labelledby="problem-source-heading">
              <div className="problem-source-heading">
                <div><span>PROBLEM COLLECTION</span><strong id="problem-source-heading">遠端題庫來源</strong></div>
                <code>{collection.index.revision.slice(0, 12)}</code>
              </div>
              <p>只先載入索引；選題時才下載並驗證該題的 SHA-256 bundle。設定會保存在此瀏覽器。</p>
              <ProblemSourceForm
                source={collection.source}
                disabled={Boolean(busy || loadingProblemId)}
                onApply={(next) => {
                  void saveProject(project).then(() => onProblemCollectionSourceChange(next)).catch((error: unknown) => {
                    addLog("stderr", error instanceof Error ? error.message : String(error));
                  });
                }}
              />
            </section>
            <section className="settings-section" aria-labelledby="compile-settings-heading">
              <header className="settings-section-heading"><span>COMPILATION</span><strong id="compile-settings-heading">編譯設定</strong><p>選擇入口檔、目標 ABI 與最佳化方式。</p></header>
              <div className="toolchain-card">
                <span className={`toolchain-mark ${languageTone(project.config.language)}`}>{languageIcon(project.config.language)}</span>
                <div><strong>{activeToolchain.label}</strong><p>{activeToolchain.note}</p></div>
              </div>
              <label className="form-field"><span>Entry file</span><select value={project.config.entry} onChange={(event) => updateProject((current) => ({ ...current, config: { ...current.config, entry: event.target.value } }))}>{project.files.map((file) => <option key={file.path}>{file.path}</option>)}</select></label>
              <div className="form-grid">
                <label className="form-field"><span>Target ABI</span><select value={project.config.target} onChange={(event) => chooseTarget(event.target.value as "wasip1" | "wasix")}>{activeToolchain.targets.map((target) => <option value={target} key={target}>{target.toUpperCase()}</option>)}</select></label>
                <label className="form-field"><span>Profile</span><select value={project.config.optimization} onChange={(event) => updateProject((current) => ({ ...current, config: { ...current.config, optimization: event.target.value as "debug" | "release" } }))}><option value="debug">Debug · -O0</option><option value="release">Release · -O2</option></select></label>
              </div>
              {project.config.language === "rust" && <div className="profile-notice"><TriangleAlert size={15} /><p><strong>Real Rust toolchain</strong> 使用來源可追溯的 <code>rustc 1.91.1-dev</code> WebC 與相符的 standard library，在 Wasmer 內直接產生 WASI P1；Cargo 可使用 Forge 統一 lock/cache API，但目前 editor 尚未把解析後的 crate 掛載進 rustc build。</p></div>}
              {project.config.language === "go" && <div className="profile-notice"><TriangleAlert size={15} /><p><strong>Standard Go / wasip1</strong> 使用標準 <code>Go 1.26.5</code> compiler、linker 與相符的 349-package standard library，全程在 Wasmer 內產生 WASI P1；Go modules 可使用 Forge 統一 lock/cache API。</p></div>}
            </section>

            <section className="settings-section" aria-labelledby="runtime-settings-heading">
              <header className="settings-section-heading"><span>EXECUTION</span><strong id="runtime-settings-heading">執行限制</strong><p>控制每次自行測試的 deterministic runtime 資源邊界。</p></header>
              <div className="form-grid">
                <label className="form-field"><span>Net weighted instruction budget</span><input type="number" min="1" max={Number.MAX_SAFE_INTEGER} step="1000000" value={project.config.resources.instructionBudget} onChange={(event) => updateRunConfig((current) => ({ ...current, resources: { ...current.resources, instructionBudget: Number(event.target.value) } }))} /></label>
                <label className="form-field"><span>Logical time budget (ms)</span><input type="number" min="1" max="9007199254" step="100" value={project.config.resources.logicalTimeLimitMs} onChange={(event) => updateRunConfig((current) => ({ ...current, resources: { ...current.resources, logicalTimeLimitMs: Number(event.target.value) } }))} /></label>
              </div>
              <div className="form-grid">
                <label className="form-field"><span>Linear memory (MiB)</span><input type="number" min="1" max="4096" step="1" value={project.config.resources.memoryLimitBytes / (1024 * 1024)} onChange={(event) => updateRunConfig((current) => ({ ...current, resources: { ...current.resources, memoryLimitBytes: Number(event.target.value) * 1024 * 1024 } }))} /></label>
                <label className="form-field"><span>Captured output (MiB)</span><input type="number" min="0.0625" max="64" step="0.0625" value={project.config.resources.outputLimitBytes / (1024 * 1024)} onChange={(event) => updateRunConfig((current) => ({ ...current, resources: { ...current.resources, outputLimitBytes: Number(event.target.value) * 1024 * 1024 } }))} /></label>
              </div>
              <div className="form-grid">
                <label className="form-field"><span>Writable VFS (MiB)</span><input type="number" min="0.0625" max="512" step="0.0625" value={project.config.resources.filesystemWriteLimitBytes / (1024 * 1024)} onChange={(event) => updateRunConfig((current) => ({ ...current, resources: { ...current.resources, filesystemWriteLimitBytes: Number(event.target.value) * 1024 * 1024 } }))} /></label>
                <label className="form-field"><span>Writable VFS entries</span><input type="number" min="1" max="65536" step="1" value={project.config.resources.filesystemEntryLimit} onChange={(event) => updateRunConfig((current) => ({ ...current, resources: { ...current.resources, filesystemEntryLimit: Number(event.target.value) } }))} /></label>
              </div>
              <label className="form-field"><span>Emergency wall deadline (ms)</span><input type="number" min="1" max="600000" step="100" value={project.config.resources.wallTimeLimitMs} onChange={(event) => updateRunConfig((current) => ({ ...current, resources: { ...current.resources, wallTimeLimitMs: Number(event.target.value) } }))} /></label>
              <div className="profile-notice"><Gauge size={15} /><p><strong>Portable limits</strong> instruction、logical time、memory、output 與 VFS 上限由 runtime 強制執行；wall deadline 只負責終止失控 Worker。</p></div>
            </section>

            <section className="settings-section" aria-labelledby="determinism-settings-heading">
              <header className="settings-section-heading"><span>DETERMINISM</span><strong id="determinism-settings-heading">可重現環境</strong><p>固定隨機來源與虛擬時鐘，讓相同輸入得到相同 transcript。</p></header>
              <div className="form-grid">
                <label className="form-field"><span>Random seed</span><input type="number" min="0" max="4294967295" step="1" value={project.config.determinism.randomSeed} onChange={(event) => updateRunConfig((current) => ({ ...current, determinism: { ...current.determinism, randomSeed: Number(event.target.value) } }))} /></label>
                <label className="form-field"><span>Clock step (ns)</span><input type="number" min="1" max="1000000000" step="1" value={project.config.determinism.clockStepNs} onChange={(event) => updateRunConfig((current) => ({ ...current, determinism: { ...current.determinism, clockStepNs: Number(event.target.value) } }))} /></label>
              </div>
              <label className="form-field"><span>Realtime epoch (Unix ms)</span><input type="number" min="0" max="18446744073000" step="1" value={project.config.determinism.realtimeEpochMs} onChange={(event) => updateRunConfig((current) => ({ ...current, determinism: { ...current.determinism, realtimeEpochMs: Number(event.target.value) } }))} /></label>
              <div className="profile-notice"><Clock3 size={15} /><p><strong>Deterministic execution</strong> sleep 與 clock poll 只會快轉虛擬時間，不等待 host；實際執行時間不屬於 deterministic transcript。</p></div>
            </section>

            <section className="settings-section settings-storage-section" aria-labelledby="storage-settings-heading">
              <header className="settings-section-heading"><span>LOCAL DATA</span><strong id="storage-settings-heading">本機資料與隱私</strong><p>管理裝置上的工具鏈、題庫與建置快取。</p></header>
              <div className="local-judge-note drawer-judge-note"><LockKeyhole size={15} /><p><strong>不防作弊</strong>完全本機的測資一定能被檢視；這是刻意的隱私與教學取捨。</p></div>
              <div className="cache-section"><div><strong>本機快取</strong><span>{formatBytes(storage.usage)} / {storage.quota ? formatBytes(storage.quota) : "browser quota"}</span></div><button onClick={() => void clearCaches()} disabled={Boolean(busy)}><RotateCcw size={13} /> 清除快取</button></div>
              <div className="drawer-footer"><ShieldCheck size={14} /><span>只下載經驗證的題庫與工具鏈；程式碼、自行測試輸入、判題結果與產物不會上傳。</span></div>
            </section>
          </aside>
        </div>
      )}
    </main>
  );
}
