"use client";

import type * as Monaco from "monaco-editor";
import type {
  KeyboardEvent as ReactKeyboardEvent,
  MouseEvent as ReactMouseEvent,
  PointerEvent as ReactPointerEvent,
} from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CompileCoordinator } from "../../../compiler/coordinator";
import { projectBuildIdentity, projectCacheKey } from "../../../core/hash";
import {
  isBuiltinLanguage,
  LANGUAGES,
  type BuildArtifact,
  type BuiltinLanguage,
  type Diagnostic,
  type Project,
  type ProjectFile,
  type RunConfig,
  type WorkerProgress,
} from "../../../core/types";
import { extensionLanguage, languageLabel, TOOLCHAINS } from "../../../core/toolchains";
import { WASM_OJ_CONTRACT_VERSION } from "../../../core/contract";
import {
  decodeSolvedProgress,
  judgeProblemProgressId,
  judgeProgressKey,
  type JudgeUiCaseResult,
  type JudgeUiSession,
} from "../../../judge/judge";
import { createJudgeExecutor, JudgeEngine, type JudgeCaseResult, type JudgeCaseVerdict } from "../../../judge/engine";
import { textMatcher } from "../../../judge/spec";
import { normalizeOutput } from "../../../judge/normalization";
import { sampleOutputMatches } from "../../../judge/sample-output";
import { recordLocalSamplesPassed } from "../../../judge/local-practice-progress";
import {
  createJudgeProject,
  judgeProjectId,
  latestJudgeProjectForCollection,
  problemIdentityFromProject,
} from "../../../judge/project";
import { buildChatGptProblemUrl } from "../../../judge/chatgpt-help";
import { assertProblemCostProfile, scoreProblemResults } from "../../../judge/problem-scoring";
import {
  clearProblemCollectionCache,
  githubRawContentUrl,
  problemCollectionShareUrl,
  type LoadedProblemCollection,
  type ProblemCollectionEntry,
} from "../../../judge/problem-catalog-loader";
import {
  broadestPolicy,
  sampleCases,
  problemText,
  type JudgeProblem,
  type ProblemDifficulty,
  type ProblemLocale,
} from "../../../judge/problem-model";
import { matchesProblemSearch } from "../../../judge/problem-search";
import {
  decodeSelfTestCases,
  encodeSelfTestCases,
  MAX_SELF_TEST_CASES,
  selfTestStorageKey,
  type SelfTestCase,
} from "../../../judge/self-tests";
import { BrowserCompiler } from "../../../runtime/compiler-client";
import { BrowserRunner } from "../../../runtime/runner-client";
import {
  clearArtifactCache,
  deleteArtifact,
  listProjects,
  loadArtifact,
  saveArtifact,
  saveProject,
} from "../../../storage/database";
import {
  createDefaultBrowserStorageCoordinator,
  type StorageCoordinator,
} from "../../../storage/coordinator";
import {
  DraftPersistenceController,
  type DraftPersistenceState,
} from "../../../storage/draft-persistence";
import { DRAFT_SOURCE_EXPORT_MAX_BYTES } from "../../../storage/draft-recovery";
import { registerToolchainCache } from "../../../storage/service-worker";
import { requestWasmOjTurnstileToken } from "../../../turnstile/client";
import { isTerminalSubmissionState, type SequencedSubmissionEvent } from "../../../online-judge/contracts";
import {
  parseOfficialSubmissionCancellation,
  parseOfficialSubmissionCreated,
  SubmissionEventPollingClient,
} from "../../../online-judge/submission-event-polling";
import {
  createOfficialSubmissionRequest,
  managedProblemMetadataApiPath,
  normalizeManagedProblemContext,
  type LoadedManagedProblemCollection,
  type ManagedProblemCollectionEntry,
  type ManagedProblemContext,
} from "../../../online-judge/managed-problem-collection";
import type { OfficialSubmissionStatus } from "../../submissions/components/official-submission-result";
import { useProduct } from "../../platform/components/app-shell";
import { PLATFORM_BROWSER_TOOLCHAINS } from "../../platform/browser-toolchains";
import { configureWasmOjLanguageServices } from "../editor/wasm-oj-language-services";
import { registerWasmOjMonacoThemes } from "../editor/wasm-oj-monaco-theme";
import type { BeforeMount, OnMount } from "../editor/self-hosted-monaco-editor";
import { completeJudgeOnboarding } from "./judge-onboarding-storage";
import {
  clampBottomPanelHeight,
  DEFAULT_BOTTOM_PANEL_HEIGHT,
  maximumBottomPanelHeight,
  MIN_BOTTOM_PANEL_HEIGHT,
  resizedBottomPanelHeight,
} from "../model/judge-panel-layout";
import {
  executionTerminationLabel,
  judgeUiText,
} from "../model/judge-ui-i18n";
import type {
  BottomTab,
  BusyAction,
  CompileAheadState,
  LogEntry,
  SelfTestRunResult,
} from "../components/execution-panel";

const SITES_CHUNK_MANIFEST_URL = process.env.NODE_ENV === "production"
  ? "/toolchains/wasm-oj-sites-chunks.json"
  : undefined;

type DifficultyFilter = "all" | ProblemDifficulty;
type ProblemPane = "statement" | "editorial" | "leaderboard" | "performance";

interface PanelResizeSession {
  pointerId: number;
  startHeight: number;
  startPointerY: number;
}

interface ManagedCollectionMatch {
  readonly publicationId: string;
  readonly problems: Readonly<Record<string, string>>;
}

export type JudgeWorkspaceCollection = LoadedProblemCollection | LoadedManagedProblemCollection;
export type JudgeWorkspaceCollectionEntry = ProblemCollectionEntry | ManagedProblemCollectionEntry;

export interface JudgeSessionOptions {
  readonly collection: JudgeWorkspaceCollection;
  readonly initialProblem: JudgeProblem;
  readonly problemLocale: ProblemLocale;
  readonly managedContext?: ManagedProblemContext;
}

function createCollectionJudgeProject(
  collection: JudgeWorkspaceCollection,
  bundleSha256: string,
  problem: JudgeProblem,
  language: BuiltinLanguage,
): Project {
  const project = createJudgeProject(collection.sourceKey, bundleSha256, problem, language);
  return bindPublishedCompileProfile(collection, project);
}

function bindPublishedCompileProfile(collection: JudgeWorkspaceCollection, project: Project): Project {
  if (collection.source.provider !== "managed") return project;
  if (!isBuiltinLanguage(project.config.language)) throw new Error("Managed problem draft uses an unsupported language.");
  const language = project.config.language;
  const profile = collection.source.allowedProfiles[language];
  if (!profile) throw new Error(`Published problem does not allow ${language}.`);
  return {
    ...project,
    config: {
      ...project.config,
      target: profile.target,
      optimization: profile.optimization,
    },
  };
}

function cleanPath(path: string): string | undefined {
  const normalized = path.trim().replaceAll("\\", "/").replace(/^\.\//, "");
  if (!normalized || normalized.startsWith("/") || normalized.split("/").includes("..")) return undefined;
  if (!/^[\w@.+/-]+$/.test(normalized)) return undefined;
  return normalized;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function formatDuration(milliseconds: number): string {
  return milliseconds < 1000 ? `${Math.round(milliseconds)} ms` : `${(milliseconds / 1000).toFixed(2)} s`;
}

function wasmOjCsrfCookie(): string | undefined {
  for (const part of document.cookie.split(";")) {
    const [name, ...value] = part.trim().split("=");
    if (name === "wasm_oj_csrf") return value.join("=");
  }
  return undefined;
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

export function useJudgeSession({
  collection,
  initialProblem,
  problemLocale,
  managedContext,
}: JudgeSessionOptions) {
  const { theme: productTheme } = useProduct();
  const explicitManagedContext = useMemo(
    () => managedContext ? normalizeManagedProblemContext(managedContext) : undefined,
    [managedContext],
  );
  if (collection.source.provider === "managed") {
    if (
      !explicitManagedContext
      || collection.source.problemVersionId !== explicitManagedContext.problemVersionId
      || collection.source.contestId !== explicitManagedContext.contestId
      || collection.source.mode !== (explicitManagedContext.contestId ? "contest" : "official-practice")
      || collection.source.metadataUrl !== managedProblemMetadataApiPath(explicitManagedContext)
    ) {
      throw new Error("Managed JudgeWorkspace collection and managedContext must identify the same v2 content pointer.");
    }
  } else if (explicitManagedContext) {
    throw new Error("managedContext requires a managed problem collection; GitHub collection identity cannot be substituted.");
  }
  const problems = collection.index.problems;
  const initialProblemEntry = problems.find((problem) => problem.id === initialProblem.id);
  if (!initialProblemEntry) throw new Error(`Initial problem '${initialProblem.id}' is absent from its collection index.`);
  const managedSource = collection.source.provider === "managed" ? collection.source : undefined;
  const availableLanguages = managedSource
    ? LANGUAGES.filter((language) => managedSource.allowedProfiles[language] !== undefined)
    : LANGUAGES;
  const initialLanguage = availableLanguages.includes("c") ? "c" : availableLanguages[0];
  if (!initialLanguage) throw new Error("Published managed problem has no allowed compile profile.");
  const problemDigests = useMemo(() => new Map(problems.map((problem) => [problem.id, problem.bundle.sha256])), [problems]);
  const validProgressIds = useMemo(() => new Set(problems.map((problem) => judgeProblemProgressId(problem.id, problem.bundle.sha256))), [problems]);
  const progressKey = useMemo(() => judgeProgressKey(collection.sourceKey), [collection.sourceKey]);
  const [project, setProject] = useState<Project>(() => createCollectionJudgeProject(collection, initialProblemEntry.bundle.sha256, initialProblem, initialLanguage));
  const [activeProblem, setActiveProblem] = useState(initialProblem);
  const [loadingProblemId, setLoadingProblemId] = useState<string>();
  const [problemPane, setProblemPane] = useState<ProblemPane>("statement");
  const [filter, setFilter] = useState<DifficultyFilter>("all");
  const [problemSearch, setProblemSearch] = useState("");
  const [solved, setSolved] = useState<Set<string>>(new Set());
  const [hydrated, setHydrated] = useState(false);
  const [runtimeReady, setRuntimeReady] = useState(false);
  const [runtimeInitializationError, setRuntimeInitializationError] = useState("");
  const [runtimeGeneration, setRuntimeGeneration] = useState(0);
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
  const [pendingFileRemoval, setPendingFileRemoval] = useState<string>();
  const [drawerPortalTarget, setDrawerPortalTarget] = useState<HTMLElement>();
  const [onboardingOpen, setOnboardingOpen] = useState(false);
  const [mobileWorkspaceTab, setMobileWorkspaceTab] = useState<"problem" | "code" | "result">("problem");
  const [newFileOpen, setNewFileOpen] = useState(false);
  const [newFilePath, setNewFilePath] = useState("");
  const [storage, setStorage] = useState({ usage: 0, quota: 0 });
  const [storagePersistence, setStoragePersistence] = useState<"checking" | "granted" | "best-effort" | "error">("checking");
  const [draftRecoveryMessage, setDraftRecoveryMessage] = useState<{ tone: "success" | "error"; text: string }>();
  const [location, setLocation] = useState({ line: 1, column: 1 });
  const [compileAhead, setCompileAhead] = useState<CompileAheadState>("idle");
  const [shareState, setShareState] = useState<"idle" | "copied" | "failed">("idle");
  const [managedMatch, setManagedMatch] = useState<ManagedCollectionMatch>();
  const [managedMatchChecked, setManagedMatchChecked] = useState(Boolean(explicitManagedContext));
  const [officialSubmissionId, setOfficialSubmissionId] = useState<string>();
  const [officialSubmissionStatus, setOfficialSubmissionStatus] = useState<OfficialSubmissionStatus>();
  const compilerRef = useRef<BrowserCompiler | undefined>(undefined);
  const compileCoordinatorRef = useRef<CompileCoordinator | undefined>(undefined);
  const runnerRef = useRef<BrowserRunner | undefined>(undefined);
  const storageCoordinatorRef = useRef<StorageCoordinator | undefined>(undefined);
  const draftPersistenceControllerRef = useRef<DraftPersistenceController | undefined>(undefined);
  draftPersistenceControllerRef.current ??= new DraftPersistenceController(saveProject);
  const draftPersistenceController = draftPersistenceControllerRef.current;
  const [draftPersistence, setDraftPersistence] = useState<DraftPersistenceState>(
    () => draftPersistenceController.snapshot(),
  );
  const projectRef = useRef(project);
  const importedProjectRef = useRef<Project | undefined>(undefined);
  const draftRecoveryInputRef = useRef<HTMLInputElement>(null);
  const editorStackRef = useRef<HTMLElement | null>(null);
  const editorRef = useRef<Monaco.editor.IStandaloneCodeEditor | undefined>(undefined);
  const monacoRef = useRef<typeof Monaco | undefined>(undefined);
  const revealRef = useRef<{ line: number; column: number } | undefined>(undefined);
  const judgingRef = useRef(false);
  const cancelledRef = useRef(false);
  const officialPollingRef = useRef<SubmissionEventPollingClient | undefined>(undefined);
  const officialCancelPendingRef = useRef(false);
  const officialRunRef = useRef(0);
  const panelResizeRef = useRef<PanelResizeSession | undefined>(undefined);
  const settingsReturnFocusRef = useRef<HTMLElement>(null);
  const fileRemovalReturnFocusRef = useRef<HTMLElement>(null);
  const text = judgeUiText(problemLocale);

  const activeProblemText = problemText(activeProblem, problemLocale);
  const activeProblemEntry = useMemo(() => {
    const entry = problems.find((problem) => problem.id === activeProblem.id);
    if (!entry) throw new Error(`Active problem '${activeProblem.id}' is absent from its collection index.`);
    return entry;
  }, [activeProblem.id, problems]);
  const activeProgressId = judgeProblemProgressId(activeProblem.id, activeProblemEntry.bundle.sha256);
  const matchedProblemVersionId = managedMatch?.problems[activeProblem.id];
  const officialContext = explicitManagedContext
    ?? (matchedProblemVersionId ? { problemVersionId: matchedProblemVersionId } : undefined);
  const managedProblemVersionId = officialContext?.problemVersionId;
  const officialContestId = officialContext?.contestId;
  // Managed GitHub content is public-only; complete judge data exists only in the immutable R2 package.
  const fullLocalJudgeAvailable = explicitManagedContext === undefined;
  const editorialAvailable = explicitManagedContext?.contestId === undefined;
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
  const publishedCompileProfile = managedSource?.allowedProfiles[projectLanguage];
  const chatGptProblemUrl = useMemo(() => {
    let statementUrl: string;
    if (collection.source.provider === "github") {
      if (!("statementPaths" in activeProblemEntry)) throw new Error("GitHub collection entry is missing statement paths.");
      statementUrl = githubRawContentUrl(collection.source, activeProblemEntry.statementPaths[problemLocale]);
    } else {
      if ("statementPaths" in activeProblemEntry) throw new Error("Managed collection entry cannot masquerade as a GitHub entry.");
      statementUrl = typeof window === "undefined"
        ? collection.source.contentUrl
        : new URL(collection.source.contentUrl, window.location.origin).toString();
    }
    return buildChatGptProblemUrl(activeProblem, problemLocale, projectLanguage, statementUrl);
  }, [activeProblem, activeProblemEntry, collection.source, problemLocale, projectLanguage]);
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
    () => filteredProblems.reduce<Array<{ id: string; title: string; problems: JudgeWorkspaceCollectionEntry[] }>>((groups, problem) => {
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
  const draftStatusLabel = draftPersistence.phase === "error"
    ? text.status.draftError
    : draftPersistence.phase === "saving"
      ? text.status.draftSaving
      : draftPersistence.phase === "dirty"
        ? text.status.draftPending
        : text.status.draftSaved;
  const draftStatusDescription = draftPersistence.phase === "error"
    ? text.settings.draftError(draftPersistence.error ?? "")
    : draftPersistence.phase === "saving"
      ? text.settings.draftSaving
      : draftPersistence.phase === "dirty"
        ? text.settings.draftPending
        : text.settings.draftSaved;
  const persistentStorageDescription = storagePersistence === "granted"
    ? text.settings.persistentStorageGranted
    : storagePersistence === "error"
      ? text.settings.persistentStorageError
      : text.settings.persistentStorageBestEffort;

  const addLog = useCallback((stream: LogEntry["stream"], text: string) => {
    if (!text) return;
    setLogs((current) => [...current, { id: crypto.randomUUID(), stream, text }]);
  }, []);

  const exportDraftSources = useCallback(() => {
    try {
      const encoded = draftPersistenceController.exportSources(projectRef.current);
      const url = URL.createObjectURL(new Blob([encoded], { type: "application/json;charset=utf-8" }));
      const link = document.createElement("a");
      link.href = url;
      link.download = "wasm-oj-source-draft.json";
      link.click();
      URL.revokeObjectURL(url);
      setDraftRecoveryMessage({ tone: "success", text: text.settings.draftExported });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      setDraftRecoveryMessage({ tone: "error", text: text.settings.draftRecoveryError(detail) });
      addLog("stderr", detail);
    }
  }, [addLog, draftPersistenceController, text.settings]);

  const importDraftSources = useCallback(async (file: File) => {
    try {
      if (file.size > DRAFT_SOURCE_EXPORT_MAX_BYTES) {
        throw new Error(`Draft source export exceeds the ${DRAFT_SOURCE_EXPORT_MAX_BYTES} byte limit.`);
      }
      const restored = draftPersistenceController.importSources(
        new Uint8Array(await file.arrayBuffer()),
        projectRef.current,
      );
      importedProjectRef.current = restored;
      setProject(restored);
      setArtifact(undefined);
      setDiagnostics([]);
      setSelfTestResults([]);
      setJudgeSession(undefined);
      setSelectedCaseNumber(undefined);
      await draftPersistenceController.flush();
      setDraftRecoveryMessage({ tone: "success", text: text.settings.draftImported });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      setDraftRecoveryMessage({ tone: "error", text: text.settings.draftRecoveryError(detail) });
      addLog("stderr", detail);
    }
  }, [addLog, draftPersistenceController, text.settings]);

  useEffect(
    () => draftPersistenceController.subscribe(setDraftPersistence),
    [draftPersistenceController],
  );

  useEffect(() => {
    const flush = () => {
      void draftPersistenceController.flush().catch(() => undefined);
    };
    const onVisibilityChange = () => {
      if (document.visibilityState === "hidden") flush();
    };
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      if (!draftPersistenceController.hasPendingDraft()) return;
      flush();
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("pagehide", flush);
    window.addEventListener("beforeunload", onBeforeUnload);
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      window.removeEventListener("pagehide", flush);
      window.removeEventListener("beforeunload", onBeforeUnload);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      flush();
    };
  }, [draftPersistenceController]);

  useEffect(() => {
    const controller = new AbortController();
    setManagedMatch(undefined);
    if (explicitManagedContext) {
      setManagedMatchChecked(true);
      return () => controller.abort();
    }
    if (collection.source.provider !== "github") {
      setManagedMatchChecked(true);
      return () => controller.abort();
    }
    setManagedMatchChecked(false);
    const parameters = new URLSearchParams({
      repository: `${collection.source.owner}/${collection.source.repository}`,
      revision: collection.index.revision,
    });
    void fetch(`/api/collections/managed-match?${parameters}`, {
      signal: controller.signal,
      credentials: "same-origin",
      headers: { accept: "application/json" },
    }).then(async (response) => {
      if (!response.ok) return;
      const result = await response.json() as { matched?: unknown; publicationId?: unknown; problems?: unknown };
      if (result.matched === true && typeof result.publicationId === "string" && result.problems && typeof result.problems === "object" && !Array.isArray(result.problems)) {
        setManagedMatch({ publicationId: result.publicationId, problems: result.problems as Record<string, string> });
      }
    }).catch(() => undefined).finally(() => {
      if (!controller.signal.aborted) setManagedMatchChecked(true);
    });
    return () => controller.abort();
  }, [collection.index.revision, collection.source, explicitManagedContext]);

  useEffect(() => () => {
    officialRunRef.current += 1;
    officialPollingRef.current?.stop("workspace closed");
  }, []);

  const dismissOnboarding = useCallback(() => {
    try {
      completeJudgeOnboarding(localStorage);
    } catch (error) {
      addLog("stderr", text.logs.onboardingSaveFailed(error instanceof Error ? error.message : String(error)));
    }
    setOnboardingOpen(false);
  }, [addLog, text]);

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
    let disposed = false;
    void (async () => {
      try {
        try {
          const persistent = await storageCoordinator.requestPersistence();
          if (disposed) return;
          setStoragePersistence(persistent ? "granted" : "best-effort");
        } catch (error) {
          if (disposed) return;
          setStoragePersistence("error");
          addLog("stderr", error instanceof Error ? error.message : String(error));
        }
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
          && (collection.source.provider !== "managed" || collection.source.allowedProfiles[restored.config.language] !== undefined)
          && restored.id === judgeProjectId(collection.sourceKey, restoredSummary.bundle.sha256, restoredProblem.id, restored.config.language)
        ) {
          setProject(bindPublishedCompileProfile(collection, restored));
          setActiveProblem(restoredProblem);
        }
        const storageReport = await storageCoordinator.estimate();
        if (disposed) return;
        setStorage({ usage: storageReport.usage, quota: storageReport.quota });
        setHydrated(true);
      } catch (error) {
        if (disposed) return;
        addLog("stderr", error instanceof Error ? error.message : String(error));
        setHydrated(true);
      }
    })();
    return () => {
      disposed = true;
    };
  }, [addLog, collection, problemDigests, problems, progressKey, validProgressIds]);

  useEffect(() => {
    if (!hydrated) return;
    let compilation: CompileCoordinator | undefined;
    let runner: BrowserRunner | undefined;
    let disposed = false;
    setRuntimeReady(false);
    setRuntimeInitializationError("");
    setProgress({ phase: "initializing", label: "Starting Wasmer runtime", progress: 0 });
    void (async () => {
      try {
        await registerToolchainCache({ chunkManifestUrl: SITES_CHUNK_MANIFEST_URL });
        if (disposed) return;
        const compiler = new BrowserCompiler({ toolchains: PLATFORM_BROWSER_TOOLCHAINS });
        compilation = new CompileCoordinator(compiler, {
          load: loadArtifact,
          save: saveArtifact,
          delete: deleteArtifact,
          clear: clearArtifactCache,
        });
        runner = new BrowserRunner({ toolchains: PLATFORM_BROWSER_TOOLCHAINS });
        compilerRef.current = compiler;
        compileCoordinatorRef.current = compilation;
        runnerRef.current = runner;
        compiler.onProgress(setProgress);
        runner.onProgress(setProgress);
        runner.onStream((stream, chunk) => {
          if (!judgingRef.current) addLog(stream, chunk);
        });
        await Promise.all([compiler.ready(), runner.ready()]);
        if (disposed) return;
        setRuntimeReady(true);
      } catch (error) {
        if (disposed) return;
        const message = error instanceof Error ? error.message : String(error);
        addLog("stderr", message);
        setRuntimeInitializationError(message);
        if (compileCoordinatorRef.current === compilation) compileCoordinatorRef.current = undefined;
        if (runnerRef.current === runner) runnerRef.current = undefined;
        compilation?.dispose();
        runner?.dispose();
        compilation = undefined;
        runner = undefined;
      }
    })();
    return () => {
      disposed = true;
      if (compileCoordinatorRef.current === compilation) compileCoordinatorRef.current = undefined;
      if (runnerRef.current === runner) runnerRef.current = undefined;
      compilation?.dispose();
      runner?.dispose();
    };
  }, [addLog, hydrated, runtimeGeneration]);

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
    if (importedProjectRef.current === project) {
      importedProjectRef.current = undefined;
      return;
    }
    draftPersistenceController.update(project);
  }, [draftPersistenceController, hydrated, project]);

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
      monaco.editor.setModelMarkers(model, "wasm-oj", markers);
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
    configureWasmOjLanguageServices(monaco);
    registerWasmOjMonacoThemes(monaco);
  }, []);

  const onEditorMount: OnMount = useCallback((editor, monaco) => {
    editorRef.current = editor;
    monacoRef.current = monaco;
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

  const openWorkspace = useCallback(async (summary: JudgeWorkspaceCollectionEntry, language: BuiltinLanguage) => {
    if (busy || loadingProblemId) return;
    setLoadingProblemId(summary.id);
    try {
      draftPersistenceController.update(project);
      await draftPersistenceController.flush();
      const problem = summary.id === activeProblem.id
        ? activeProblem
        : await collection.loadProblem(summary.id);
      const drafts = await listProjects();
      const id = judgeProjectId(collection.sourceKey, summary.bundle.sha256, problem.id, language);
      const draft = drafts.find((candidate) => candidate.id === id);
      compileCoordinatorRef.current?.restart();
      runnerRef.current?.restart();
      setRuntimeReady(true);
      setProject(draft
        ? bindPublishedCompileProfile(collection, draft)
        : createCollectionJudgeProject(collection, summary.bundle.sha256, problem, language));
      setActiveProblem(problem);
      setArtifact(undefined);
      setDiagnostics([]);
      setLogs([]);
      setSelfTestResults([]);
      setRunningSelfTestId(undefined);
      setJudgeSession(undefined);
      setSelectedCaseNumber(undefined);
      setOfficialSubmissionId(undefined);
      setOfficialSubmissionStatus(undefined);
      setProblemPane("statement");
      setBottomTab("judge");
    } catch (error) {
      addLog("stderr", error instanceof Error ? error.message : String(error));
      setBottomTab("output");
    } finally {
      setLoadingProblemId(undefined);
    }
  }, [activeProblem, addLog, busy, collection, draftPersistenceController, loadingProblemId, project]);

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

  const doRunSelfTests = useCallback(async (
    caseIds: readonly string[],
    availableCases: readonly SelfTestCase[] = selfTests,
    expectedOutputs?: ReadonlyMap<string, string>,
  ) => {
    const runner = runnerRef.current;
    const requested = availableCases.filter((testCase) => caseIds.includes(testCase.id));
    if (!runner || requested.length === 0) return;
    const completedResults: SelfTestRunResult[] = [];
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
        const expectedOutput = expectedOutputs?.get(testCase.id);
        const matchesExpected = expectedOutput === undefined
          ? undefined
          : sampleOutputMatches(result, expectedOutput);
        const completed = { caseId: testCase.id, run: result, expectedOutput, matchesExpected } satisfies SelfTestRunResult;
        completedResults.push(completed);
        setSelfTestResults((current) => [
          ...current.filter((candidate) => candidate.caseId !== testCase.id),
          completed,
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
    return completedResults;
  }, [addLog, artifact, doBuild, problemLocale, project, selfTests, text]);

  const doRunSamples = useCallback(async () => {
    const samples = sampleCases(activeProblem).map((sample, index) => ({
      id: `sample-${index + 1}`,
      name: text.selfTest.sampleName(index + 1),
      input: sample.input,
      expectedOutput: sample.output,
    }));
    if (samples.length === 0) return;
    setSelfTests(samples);
    setSelectedSelfTestId(samples[0].id);
    setMobileWorkspaceTab("result");
    const expectedOutputs = new Map(samples.map((sample) => [sample.id, sample.expectedOutput] as const));
    const results = await doRunSelfTests(samples.map((sample) => sample.id), samples, expectedOutputs);
    if (
      managedProblemVersionId
      && results?.length === samples.length
      && results.every((result) => result.matchesExpected === true)
    ) {
      recordLocalSamplesPassed(localStorage, managedProblemVersionId, activeProblemEntry.bundle.sha256);
    }
  }, [activeProblem, activeProblemEntry.bundle.sha256, doRunSelfTests, managedProblemVersionId, text]);

  const doJudge = useCallback(async () => {
    if (!fullLocalJudgeAvailable) {
      setBottomTab("tests");
      addLog("system", text.official.contestSamplesOnly);
      return;
    }
    const runner = runnerRef.current;
    if (!runner) return;
    cancelledRef.current = false;
    judgingRef.current = true;
    setSelectedCaseNumber(undefined);
    setOfficialSubmissionId(undefined);
    setOfficialSubmissionStatus(undefined);
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
        version: WASM_OJ_CONTRACT_VERSION,
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
  }, [activeProblem, activeProgressId, addLog, artifact, doBuild, fullLocalJudgeAvailable, project, projectLanguage, text.official.contestSamplesOnly]);

  const doOfficialSubmit = useCallback(async () => {
    if (!managedProblemVersionId) return;
    setMobileWorkspaceTab("result");
    const runIdentity = officialRunRef.current + 1;
    officialRunRef.current = runIdentity;
    setBusy("official");
    setBottomTab("output");
    setLogs([]);
    setJudgeSession(undefined);
    setOfficialSubmissionId(undefined);
    setOfficialSubmissionStatus(undefined);
    officialPollingRef.current?.stop("superseded");
    officialCancelPendingRef.current = false;
    let polling: SubmissionEventPollingClient | undefined;
    try {
      const session = await fetch("/api/auth/session", { credentials: "same-origin", headers: { accept: "application/json" } });
      const sessionValue = await session.json() as { authenticated?: unknown };
      if (!session.ok || sessionValue.authenticated !== true) {
        const returnPath = `${window.location.pathname}${window.location.search}${window.location.hash}`;
        const loginUrl = new URL("/api/auth/github", window.location.origin);
        loginUrl.searchParams.set("return", returnPath);
        window.location.assign(loginUrl);
        return;
      }
      const csrf = wasmOjCsrfCookie();
      if (!csrf) throw new Error(text.official.csrfMissing);
      addLog("system", text.official.admitting);
      const requestBody = JSON.stringify(createOfficialSubmissionRequest({
        problemVersionId: managedProblemVersionId,
        ...(officialContestId ? { contestId: officialContestId } : {}),
      }, {
        language: projectLanguage,
        target: project.config.target,
        optimization: project.config.optimization,
        entry: project.config.entry,
        sourceFiles: project.files.map((file) => ({ path: file.path, encoding: "utf8" as const, content: file.content })),
        idempotencyKey: `browser:${crypto.randomUUID()}`,
      }));
      type SubmissionResponse = {
        submissionId?: unknown;
        eventCursor?: unknown;
        eventsUrl?: unknown;
        state?: unknown;
        replayed?: unknown;
        error?: { code?: unknown; message?: unknown };
      };
      const submit = async (turnstileToken?: string): Promise<{ response: Response; value: SubmissionResponse }> => {
        const response = await fetch("/api/submissions", {
          method: "POST",
          credentials: "same-origin",
          headers: {
            "content-type": "application/json",
            accept: "application/json",
            "x-wasm-oj-csrf": csrf,
            ...(turnstileToken ? { "x-wasm-oj-turnstile-token": turnstileToken } : {}),
          },
          body: requestBody,
        });
        return { response, value: await response.json() as SubmissionResponse };
      };
      let { response, value } = await submit();
      if (response.status === 403 && value.error?.code === "turnstile-required") {
        const turnstileToken = await requestWasmOjTurnstileToken("official-submit");
        ({ response, value } = await submit(turnstileToken));
      }
      if (!response.ok) throw new Error(typeof value.error?.message === "string" ? value.error.message : text.official.rejected);
      const created = parseOfficialSubmissionCreated(value, window.location.origin);
      setOfficialSubmissionId(created.submissionId);
      setOfficialSubmissionStatus({
        submissionId: created.submissionId,
        state: created.state,
        connection: "replaying",
        cursor: created.eventCursor,
      });
      addLog("system", text.official.created(created.submissionId));
      polling = new SubmissionEventPollingClient({
        eventsUrl: created.eventsUrl,
        initialCursor: created.eventCursor,
        onEvent: (event: SequencedSubmissionEvent) => {
          setOfficialSubmissionStatus((current) => {
            if (!current || current.submissionId !== created.submissionId) return current;
            const next: OfficialSubmissionStatus = { ...current, cursor: event.sequence };
            if (event.kind === "state" && event.state) return { ...next, state: event.state };
            if (event.kind === "compile-progress" && event.phase) return { ...next, compilePhase: event.phase };
            if (event.kind === "case-progress" && event.completedCases !== undefined && event.totalCases !== undefined) return { ...next, completedCases: event.completedCases, totalCases: event.totalCases };
            if (event.kind === "verdict" && event.verdict && event.score !== undefined) return { ...next, verdict: event.verdict, score: event.score };
            if (event.kind === "resource-summary" && event.deterministicCost !== undefined && event.peakMemoryBytes !== undefined) return { ...next, deterministicCost: event.deterministicCost, peakMemoryBytes: event.peakMemoryBytes };
            if (event.kind === "error" && event.message) return { ...next, eventError: event.message };
            return next;
          });
          if (event.kind === "state" && event.state) addLog("system", text.official.state(event.state));
          if (event.kind === "compile-progress" && event.phase) addLog("system", text.official.compiling(event.phase));
          if (event.kind === "case-progress" && event.completedCases !== undefined && event.totalCases !== undefined) addLog("system", text.official.cases(event.completedCases, event.totalCases));
          if (event.kind === "verdict" && event.verdict && event.score !== undefined) addLog("system", text.official.verdict(event.verdict, event.score));
          if (event.kind === "resource-summary" && event.deterministicCost !== undefined && event.peakMemoryBytes !== undefined) addLog("system", text.official.resources(event.deterministicCost, formatBytes(event.peakMemoryBytes)));
          if (event.kind === "error" && event.message) addLog("stderr", event.message);
          if (
            event.kind === "verdict"
            || (event.kind === "state" && event.state && isTerminalSubmissionState(event.state))
          ) setBottomTab("judge");
        },
        onStatus: (status) => {
          setOfficialSubmissionStatus((current) => {
            if (!current || current.submissionId !== created.submissionId) return current;
            return {
              ...current,
              connection: status.state,
              cursor: status.cursor,
              connectionDetail: status.reason,
            };
          });
          if (status.state === "disconnected") addLog("system", text.official.disconnected(status.cursor));
          if (status.state === "reconnecting") addLog("system", text.official.reconnecting(status.reconnectAttempt, status.cursor));
          if (status.state === "error") addLog("stderr", text.official.pollingError(status.cursor));
          if (status.state === "completed") setBottomTab("judge");
        },
      });
      officialPollingRef.current = polling;
      const result = await polling.run();
      if (result.kind === "disconnected" && result.reason !== "superseded" && result.reason !== "workspace closed") throw new Error(text.official.pollingStopped);
    } catch (error) {
      addLog("stderr", error instanceof Error ? error.message : String(error));
    } finally {
      if (officialRunRef.current === runIdentity && (!polling || officialPollingRef.current === polling)) {
        officialPollingRef.current = undefined;
        officialCancelPendingRef.current = false;
        setBusy(undefined);
      }
    }
  }, [addLog, managedProblemVersionId, officialContestId, project, projectLanguage, text]);

  const cancelOfficialSubmission = useCallback(async () => {
    if (officialCancelPendingRef.current) return;
    if (!officialSubmissionId) {
      addLog("stderr", text.official.cancelUnavailable);
      return;
    }
    const csrf = wasmOjCsrfCookie();
    if (!csrf) {
      addLog("stderr", text.official.csrfMissing);
      return;
    }
    officialCancelPendingRef.current = true;
    addLog("system", text.official.cancelRequested);
    try {
      const response = await fetch(`/api/submissions/${officialSubmissionId}/cancel`, {
        method: "POST",
        credentials: "same-origin",
        headers: { accept: "application/json", "x-wasm-oj-csrf": csrf },
      });
      const value = await response.json() as unknown;
      if (!response.ok) {
        const message = value && typeof value === "object" && !Array.isArray(value)
          && typeof (value as { error?: { message?: unknown } }).error?.message === "string"
          ? (value as { error: { message: string } }).error.message
          : text.official.pollingFailed;
        throw new Error(message);
      }
      const cancellation = parseOfficialSubmissionCancellation(value, officialSubmissionId);
      setOfficialSubmissionStatus((current) => current?.submissionId === officialSubmissionId
        ? { ...current, state: cancellation.state }
        : current);
      addLog("system", text.official.cancelReconciled(cancellation.state));
    } catch (error) {
      addLog("stderr", error instanceof Error ? error.message : String(error));
    } finally {
      officialCancelPendingRef.current = false;
    }
  }, [addLog, officialSubmissionId, text]);

  const cancel = useCallback(() => {
    if (busy === "official") {
      void cancelOfficialSubmission();
      return;
    }
    cancelledRef.current = true;
    judgingRef.current = false;
    compileCoordinatorRef.current?.cancel();
    runnerRef.current?.cancel();
    setBusy(undefined);
    setRunningSelfTestId(undefined);
    setJudgeSession((current) => current?.verdict === "running" ? { ...current, verdict: "cancelled" } : current);
    addLog("system", text.logs.cancelled);
  }, [addLog, busy, cancelOfficialSubmission, text]);

  const openSettings = (event: ReactMouseEvent<HTMLElement>) => {
    settingsReturnFocusRef.current = event.currentTarget;
    setDrawerPortalTarget(event.currentTarget.closest<HTMLElement>(".studio-shell") ?? undefined);
    setSettingsOpen(true);
  };

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

  const requestFileRemoval = (path: string, trigger: HTMLElement) => {
    if (project.files.length === 1) return;
    fileRemovalReturnFocusRef.current = trigger;
    setDrawerPortalTarget(trigger.closest<HTMLElement>(".studio-shell") ?? undefined);
    setPendingFileRemoval(path);
  };

  const removeFile = () => {
    const path = pendingFileRemoval;
    if (!path || project.files.length === 1) return;
    updateProject((current) => {
      const files = current.files.filter((file) => file.path !== path);
      const active = current.activeFile === path ? files[0].path : current.activeFile;
      const entry = current.config.entry === path ? files[0].path : current.config.entry;
      return { ...current, files, activeFile: active, config: { ...current.config, entry } };
    });
    setPendingFileRemoval(undefined);
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

  const copyCollectionShareUrl = useCallback(async () => {
    try {
      if (collection.source.provider !== "github") throw new Error("Managed problem routes have stable platform URLs and no repository share contract.");
      const shareUrl = problemCollectionShareUrl(collection.source, window.location.href);
      await navigator.clipboard.writeText(shareUrl);
      setShareState("copied");
      window.setTimeout(() => setShareState("idle"), 2_000);
    } catch (error) {
      setShareState("failed");
      addLog("stderr", error instanceof Error ? error.message : String(error));
    }
  }, [addLog, collection.source]);


  return {
    productTheme,
    explicitManagedContext,
    problems,
    availableLanguages,
    project,
    setProject,
    activeProblem,
    loadingProblemId,
    problemPane,
    setProblemPane,
    filter,
    setFilter,
    problemSearch,
    setProblemSearch,
    solved,
    hydrated,
    runtimeReady,
    runtimeInitializationError,
    setRuntimeGeneration,
    progress,
    busy,
    artifact,
    diagnostics,
    logs,
    selfTests,
    setSelectedSelfTestId,
    runningSelfTestId,
    selfTestResults,
    judgeSession,
    setSelectedCaseNumber,
    bottomTab,
    setBottomTab,
    bottomPanelHeight,
    bottomPanelMaximum,
    resizingBottomPanel,
    settingsOpen,
    setSettingsOpen,
    pendingFileRemoval,
    setPendingFileRemoval,
    drawerPortalTarget,
    onboardingOpen,
    setOnboardingOpen,
    mobileWorkspaceTab,
    setMobileWorkspaceTab,
    newFileOpen,
    setNewFileOpen,
    newFilePath,
    setNewFilePath,
    storage,
    draftRecoveryMessage,
    location,
    compileAhead,
    shareState,
    managedMatch,
    managedMatchChecked,
    officialSubmissionStatus,
    draftPersistenceController,
    draftPersistence,
    draftRecoveryInputRef,
    editorStackRef,
    settingsReturnFocusRef,
    fileRemovalReturnFocusRef,
    text,
    activeProblemText,
    activeProblemEntry,
    managedProblemVersionId,
    fullLocalJudgeAvailable,
    editorialAvailable,
    activeBaseline,
    activeFile,
    projectLanguage,
    publishedCompileProfile,
    chatGptProblemUrl,
    activeToolchain,
    groupedProblems,
    selectedCaseResult,
    selectedSelfTest,
    selectedSelfTestResult,
    draftStatusLabel,
    draftStatusDescription,
    persistentStorageDescription,
    addLog,
    exportDraftSources,
    importDraftSources,
    dismissOnboarding,
    stopBottomPanelResize,
    startBottomPanelResize,
    moveBottomPanelResize,
    resizeBottomPanelFromKeyboard,
    resetBottomPanelHeight,
    beforeEditorMount,
    onEditorMount,
    updateProject,
    updateRunConfig,
    updateActiveFile,
    openWorkspace,
    doBuild,
    updateSelfTest,
    addSelfTest,
    addSampleSelfTests,
    removeSelfTest,
    doRunSelfTests,
    doRunSamples,
    doJudge,
    doOfficialSubmit,
    cancelOfficialSubmission,
    cancel,
    openSettings,
    chooseTarget,
    addFile,
    requestFileRemoval,
    removeFile,
    openDiagnostic,
    clearCaches,
    copyCollectionShareUrl,
  };
}
