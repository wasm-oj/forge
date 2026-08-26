"use client";

import {
  Box,
  Braces,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  CircleHelp,
  CircleStop,
  Clock3,
  Copy,
  Download,
  FileCode2,
  Gauge,
  Hammer,
  HardDrive,
  LockKeyhole,
  MessageCircle,
  Package,
  Play,
  RotateCcw,
  Search,
  Send,
  Settings2,
  ShieldCheck,
  Target,
  TriangleAlert,
  Trophy,
  Upload,
  X,
  Zap,
} from "lucide-react";
import type { CSSProperties } from "react";
import { useCallback, useEffect, useState } from "react";
import type { BuildArtifact, BuiltinLanguage, Language } from "../../../core/types";
import { languageLabel } from "../../../core/toolchains";
import { judgeProblemProgressId } from "../../../judge/judge";
import {
  DEFAULT_PROBLEM_COLLECTION_SOURCE,
  PROBLEM_COLLECTION_SOURCE_KEY,
  loadProblemCollection,
  normalizeProblemCollectionSource,
  parseGithubRepositoryUrl,
  problemCollectionSourceFromShareUrl,
  type GithubProblemCollectionSource,
  type LoadedProblemCollection,
} from "../../../judge/problem-catalog-loader";
import {
  PROBLEM_LOCALES,
  type JudgeProblem,
  type ProblemDifficulty,
  type ProblemLocale,
} from "../../../judge/problem-model";
import { isTerminalSubmissionState } from "../../../online-judge/contracts";
import type { ManagedProblemContext } from "../../../online-judge/managed-problem-collection";
import { Drawer } from "../../../components/ui/drawer";
import { IconButton } from "../../../components/ui/icon-button";
import { useProduct } from "../../platform/components/app-shell";
import { ProblemMarkdown } from "./problem-markdown";
import { ProblemLeaderboard } from "./problem-leaderboard";
import { PerformanceLab } from "./performance-lab";
import { EditorPanel } from "./editor-panel";
import { ExecutionPanel } from "./execution-panel";
import { JudgeOnboarding } from "./judge-onboarding";
import { judgeUiText, toolchainNote } from "../model/judge-ui-i18n";
import { MIN_BOTTOM_PANEL_HEIGHT } from "../model/judge-panel-layout";
import {
  formatBytes,
  formatDuration,
  useJudgeSession,
  type JudgeWorkspaceCollection,
} from "../model/use-judge-session";

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
  repositoryUrl: string;
  owner: string;
  repository: string;
  ref: string;
  indexPath: string;
}

function sourceDraft(source: GithubProblemCollectionSource): ProblemSourceDraft {
  return {
    repositoryUrl: `https://github.com/${source.owner}/${source.repository}`,
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
  try {
    const shared = problemCollectionSourceFromShareUrl(window.location.href);
    if (shared) return { source: shared };
  } catch (reason) {
    return {
      source: DEFAULT_PROBLEM_COLLECTION_SOURCE,
      error: {
        kind: "invalid",
        detail: reason instanceof Error ? reason.message : String(reason),
      },
    };
  }
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
      const repository = draft.repositoryUrl.trim()
        ? parseGithubRepositoryUrl(draft.repositoryUrl)
        : { owner: draft.owner, repository: draft.repository };
      const normalized = normalizeProblemCollectionSource({
        provider: "github",
        owner: repository.owner,
        repository: repository.repository,
        ref: draft.ref,
        indexPath: draft.indexPath,
      });
      setError(undefined);
      onApply(normalized);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  };

  return (
    <div className="problem-source-form">
      <label className="form-field problem-repository-url"><span>{text.repositoryUrl}</span><input type="url" placeholder="https://github.com/owner/repository" value={draft.repositoryUrl} disabled={disabled} onChange={(event) => setDraft((current) => ({ ...current, repositoryUrl: event.target.value }))} /></label>
      <div className="form-grid">
        <label className="form-field"><span>{text.owner}</span><input value={draft.owner} disabled={disabled || Boolean(draft.repositoryUrl.trim())} onChange={(event) => setDraft((current) => ({ ...current, owner: event.target.value }))} /></label>
        <label className="form-field"><span>{text.repository}</span><input value={draft.repository} disabled={disabled || Boolean(draft.repositoryUrl.trim())} onChange={(event) => setDraft((current) => ({ ...current, repository: event.target.value }))} /></label>
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

export function JudgeWorkspaceLoader() {
  const { locale: problemLocale, setLocale: changeProblemLocale } = useProduct();
  const [storedSource] = useState<StoredProblemCollectionSource>(storedProblemCollectionSource);
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
    <JudgeWorkspace
      key={`${session.collection.sourceKey}:${session.collection.index.revision}`}
      collection={session.collection}
      initialProblem={session.initialProblem}
      problemLocale={problemLocale}
      onProblemLocaleChange={changeProblemLocale}
      onProblemCollectionSourceChange={changeSource}
    />
  );
}

interface JudgeWorkspaceProps {
  collection: JudgeWorkspaceCollection;
  initialProblem: JudgeProblem;
  problemLocale: ProblemLocale;
  onProblemLocaleChange(locale: ProblemLocale): void;
  onProblemCollectionSourceChange?(source: GithubProblemCollectionSource): void;
  managedContext?: ManagedProblemContext;
  contestNavigation?: ContestWorkspaceNavigation;
}

export interface ContestWorkspaceNavigation {
  readonly title: string;
  readonly overviewHref: string;
  readonly previous?: { readonly href: string; readonly label: string };
  readonly next?: { readonly href: string; readonly label: string };
}

export function JudgeWorkspace({
  collection,
  initialProblem,
  problemLocale,
  onProblemLocaleChange,
  onProblemCollectionSourceChange,
  managedContext,
  contestNavigation,
}: JudgeWorkspaceProps) {
  const {
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
    managedProblemId,
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
  } = useJudgeSession({
    collection,
    initialProblem,
    problemLocale,
    managedContext,
  });
  if (!hydrated) {
    return <main className="boot-screen"><div className="boot-mark"><Zap size={20} /></div><p>{text.boot}</p></main>;
  }

  return (
    <main className={`studio-shell judge-shell ${explicitManagedContext ? "managed-judge-shell" : "custom-judge-shell"}`}>
      <header className="topbar" data-drawer-background>
        <div className="brand" aria-label="WASM-OJ">
          <span className="brand-mark"><Target size={17} strokeWidth={2.4} /></span>
          <span className="brand-name">WASM-OJ</span>
          <span className="brand-edition">judge</span>
        </div>

        <div className="problem-switcher">
          {contestNavigation && <a className="icon-button" href={contestNavigation.overviewHref} aria-label={`${contestNavigation.title} overview`} title={contestNavigation.title}><Trophy size={14} /></a>}
          {contestNavigation?.previous && <a className="icon-button" href={contestNavigation.previous.href} aria-label={`Previous problem: ${contestNavigation.previous.label}`} title={contestNavigation.previous.label}><ChevronLeft size={14} /></a>}
          <span className="problem-switcher-number">#{String(activeProblem.number).padStart(2, "0")}</span>
          <span>{activeProblemText.title}</span>
          <span className={`difficulty-pill ${activeProblem.difficulty}`}>{difficultyLabel(activeProblem.difficulty, problemLocale)}</span>
          {contestNavigation?.next && <a className="icon-button" href={contestNavigation.next.href} aria-label={`Next problem: ${contestNavigation.next.label}`} title={contestNavigation.next.label}><ChevronRight size={14} /></a>}
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
              {availableLanguages.map((language) => <option value={language} key={language}>{languageLabel(language)}</option>)}
            </select>
            <ChevronDown size={12} />
          </label>
          {busy ? (
            <button className="stop-button" onClick={cancel}><CircleStop size={14} /> {text.topbar.stop}</button>
          ) : explicitManagedContext ? (
            <>
              <button className="workspace-advanced-button" onClick={openSettings}><Settings2 size={14} />{problemLocale === "zh-TW" ? "測試 / 進階" : "Test / Advanced"}</button>
              <button className="workspace-run-button" onClick={() => void doRunSamples()} disabled={!runtimeReady}><Play size={14} />{text.topbar.runPublicSamples}</button>
              <button className="workspace-submit-button" onClick={() => void doOfficialSubmit()}><Send size={14} />{text.topbar.officialSubmit}</button>
            </>
          ) : (
            <>
              <label className="compact-select">
                <select value={project.config.target} onChange={(event) => chooseTarget(event.target.value as "wasip1" | "wasix")} aria-label={text.topbar.compilationTarget} disabled={Boolean(loadingProblemId)}>
                  {activeToolchain.targets.map((target) => <option value={target} key={target}>{target.toUpperCase()}</option>)}
                </select>
                <ChevronDown size={12} />
              </label>
              <button className="icon-button" onClick={() => setOnboardingOpen(true)} aria-label={text.topbar.openGuide} title={text.topbar.guide}><CircleHelp size={16} /></button>
              <button className="icon-button" onClick={openSettings} aria-label={text.topbar.projectSettings}><Settings2 size={16} /></button>
              <button className="build-button" onClick={() => void doBuild(false)} disabled={!runtimeReady}><Hammer size={14} /> {text.topbar.build}</button>
              <button className="sample-button" onClick={() => setBottomTab("tests")} disabled={!runtimeReady}><Play size={14} /> {text.topbar.selfTest}</button>
              {fullLocalJudgeAvailable
                ? <button className="submit-button" onClick={() => void doJudge()} disabled={!runtimeReady}><Send size={14} /> {text.topbar.judgeLocally}</button>
                : <button className="submit-button" disabled title={text.official.contestSamplesOnly}><LockKeyhole size={14} /> {text.topbar.samplesOnly}</button>}
              {managedProblemId && <button className="official-submit-button" onClick={() => void doOfficialSubmit()}><ShieldCheck size={14} /> {text.topbar.officialSubmit}</button>}
            </>
          )}
        </div>
      </header>

      <section className={`judge-workspace ${explicitManagedContext ? "managed-workspace" : "custom-judge-workspace"}`} data-drawer-background>
        {explicitManagedContext && <nav className="mobile-workspace-tabs" aria-label="Workspace"><button className={mobileWorkspaceTab === "problem" ? "active" : ""} onClick={() => setMobileWorkspaceTab("problem")}>Problem</button><button className={mobileWorkspaceTab === "code" ? "active" : ""} onClick={() => setMobileWorkspaceTab("code")}>Code</button><button className={mobileWorkspaceTab === "result" ? "active" : ""} onClick={() => setMobileWorkspaceTab("result")}>Result</button></nav>}
        {explicitManagedContext && <div className="managed-capability" role="status"><ShieldCheck size={14} /> {explicitManagedContext.contestId ? (problemLocale === "zh-TW" ? "競賽題目 · 本機執行公開範例，提交後由 Server 正式判題" : "Contest problem · run public samples locally, then submit for the official verdict") : (problemLocale === "zh-TW" ? "官方練習 · 程式碼保存在瀏覽器，提交後取得驗證結果" : "Official practice · code stays in your browser until you submit")}</div>}
        {runtimeInitializationError && (
          <div className="official-submission-status connection-error" role="alert">
            <TriangleAlert size={14} />
            <strong>{problemLocale === "zh-TW" ? "本機執行環境無法啟動" : "Local runtime failed to start"}</strong>
            <span>{runtimeInitializationError}</span>
            <button type="button" onClick={() => setRuntimeGeneration((current) => current + 1)}>
              <RotateCcw size={12} /> {problemLocale === "zh-TW" ? "重試" : "Retry"}
            </button>
          </div>
        )}
        {officialSubmissionStatus && (
          <div className={`official-submission-status connection-${officialSubmissionStatus.connection}`} role="status" aria-live="polite">
            <ShieldCheck size={14} />
            <strong>{problemLocale === "zh-TW" ? "正式提交" : "Official submission"}</strong>
            <span>{text.official.connection(officialSubmissionStatus.connection)}</span>
            {officialSubmissionStatus.state && <span>{text.official.state(officialSubmissionStatus.state)}</span>}
            {officialSubmissionStatus.compilePhase && <span>{text.official.compiling(officialSubmissionStatus.compilePhase)}</span>}
            {officialSubmissionStatus.completedCases !== undefined && officialSubmissionStatus.totalCases !== undefined && <span>{text.official.cases(officialSubmissionStatus.completedCases, officialSubmissionStatus.totalCases)}</span>}
            {officialSubmissionStatus.verdict && officialSubmissionStatus.score !== undefined && <span>{text.official.verdict(officialSubmissionStatus.verdict, officialSubmissionStatus.score)}</span>}
            {officialSubmissionStatus.state && !isTerminalSubmissionState(officialSubmissionStatus.state) && <button type="button" onClick={() => void cancelOfficialSubmission()}><CircleStop size={12} /> {text.topbar.stop}</button>}
            {officialSubmissionStatus.eventError && <span className="official-status-detail">{officialSubmissionStatus.eventError}</span>}
            {officialSubmissionStatus.connectionDetail && <span className="official-status-detail">{officialSubmissionStatus.connectionDetail}</span>}
          </div>
        )}
        {!explicitManagedContext && <aside className="problem-catalog">
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
            {collection.source.provider === "github"
              ? <div>
                <strong>{collection.source.owner}/{collection.source.repository}</strong>
                <span>{collection.source.ref} · {collection.index.revision.slice(0, 12)} · {collection.origin === "network" ? text.catalog.verifiedOnline : text.catalog.verifiedCache}</span>
              </div>
              : <div>
                <strong>{collection.source.mode === "contest" ? text.catalog.managedContest : text.catalog.managedPractice}</strong>
                <span>{collection.source.problemId} · {collection.source.catalogCommit.slice(0, 12)} · {text.catalog.verifiedManaged}</span>
              </div>}
          </div>
        </aside>}

        <article className={`problem-statement ${mobileWorkspaceTab === "problem" ? "mobile-active" : ""}`}>
          <div className="statement-kicker">
            <span>{text.statement.problem.toUpperCase()} {String(activeProblem.number).padStart(2, "0")}</span>
            <span>{activeProblem.track[problemLocale]} · {activeProblem.tags.join(" · ")}</span>
          </div>
          <h1>{activeProblemText.title}</h1>
          <div className="problem-metrics">
            <span><Gauge size={13} />{difficultyLabel(activeProblem.difficulty, problemLocale)}</span>
            {!explicitManagedContext && <span><Zap size={13} />{text.statement.baselineCost} {activeBaseline.limits.instructionBudget.toLocaleString()} · {text.statement.perCase}</span>}
            {!explicitManagedContext && <span><Box size={13} />{text.statement.cases(activeProblem.judgeCases.length)}</span>}
          </div>
          {!explicitManagedContext && <div className="problem-policy-grid" aria-label={text.statement.scoringPolicies}>
            {activeProblem.scoring.policies.map((policy) => (
              <div key={policy.id}>
                <span>{policy.title[problemLocale]}</span>
                <strong>+{policy.points} {text.statement.pointsShort}</strong>
                <small>{policy.limits.instructionBudget.toLocaleString()} {text.statement.costUnit} · {formatBytes(policy.limits.memoryLimitBytes)}</small>
              </div>
            ))}
          </div>}
          <div className="problem-document-tabs">
            <button className={problemPane === "statement" ? "active" : ""} onClick={() => setProblemPane("statement")}>
              {text.statement.statement}
            </button>
            {editorialAvailable && <button className={problemPane === "editorial" ? "active" : ""} onClick={() => setProblemPane("editorial")}>
              {text.statement.editorial}
            </button>}
            {explicitManagedContext && !explicitManagedContext.contestId && <button className={problemPane === "leaderboard" ? "active" : ""} onClick={() => setProblemPane("leaderboard")}>
              {problemLocale === "zh-TW" ? "排名" : "Ranking"}
            </button>}
            {explicitManagedContext && <button className={problemPane === "performance" ? "active" : ""} onClick={() => setProblemPane("performance")}>
              {problemLocale === "zh-TW" ? "效能" : "Performance"}
            </button>}
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
          {problemPane === "leaderboard" && explicitManagedContext && !explicitManagedContext.contestId
            ? <ProblemLeaderboard
              problemId={explicitManagedContext.problemId}
              locale={problemLocale}
              refreshKey={officialSubmissionStatus?.state && isTerminalSubmissionState(officialSubmissionStatus.state) ? officialSubmissionStatus.submissionId : undefined}
            />
            : problemPane === "performance" && explicitManagedContext
              ? <PerformanceLab
                problemId={explicitManagedContext.problemId}
                contestId={explicitManagedContext.contestId}
                locale={problemLocale}
                refreshKey={officialSubmissionStatus?.state && isTerminalSubmissionState(officialSubmissionStatus.state) ? officialSubmissionStatus.submissionId : undefined}
              />
            : <ProblemMarkdown markdown={problemPane === "statement" || !editorialAvailable ? activeProblemText.statement : activeProblemText.editorial} />}
        </article>

        <section
          className={`editor-stack judge-editor-stack ${resizingBottomPanel ? "resizing-bottom-panel" : ""} mobile-${mobileWorkspaceTab}`}
          ref={editorStackRef}
          style={{ "--judge-bottom-panel-height": `${bottomPanelHeight}px` } as CSSProperties}
        >
          <EditorPanel
            project={project}
            activeFile={activeFile}
            productTheme={productTheme}
            loading={Boolean(loadingProblemId)}
            newFileOpen={newFileOpen}
            newFilePath={newFilePath}
            text={text}
            beforeMount={beforeEditorMount}
            onMount={onEditorMount}
            languageTone={languageTone}
            languageIcon={languageIcon}
            onOpenFile={(path) => setProject((current) => ({ ...current, activeFile: path }))}
            onRequestFileRemoval={requestFileRemoval}
            onNewFileOpenChange={setNewFileOpen}
            onNewFilePathChange={setNewFilePath}
            onAddFile={addFile}
            onOpenSettings={openSettings}
            onChange={updateActiveFile}
          />
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

          <ExecutionPanel
            activeTab={bottomTab}
            busy={busy}
            progress={progress}
            compileAhead={compileAhead}
            artifact={artifact}
            officialSubmission={officialSubmissionStatus}
            judgeSession={judgeSession}
            selectedCase={selectedCaseResult}
            problem={activeProblem}
            locale={problemLocale}
            text={text}
            selfTests={selfTests}
            selfTestResults={selfTestResults}
            selectedSelfTest={selectedSelfTest}
            selectedSelfTestResult={selectedSelfTestResult}
            runningSelfTestId={runningSelfTestId}
            diagnostics={diagnostics}
            logs={logs}
            runtimeReady={runtimeReady}
            formatBytes={formatBytes}
            formatDuration={formatDuration}
            onTabChange={setBottomTab}
            onDownloadArtifact={downloadArtifact}
            onSelectCase={setSelectedCaseNumber}
            onAddSamples={addSampleSelfTests}
            onAddSelfTest={addSelfTest}
            onRunSelfTests={(ids) => { void doRunSelfTests(ids); }}
            onSelectSelfTest={setSelectedSelfTestId}
            onUpdateSelfTest={updateSelfTest}
            onRemoveSelfTest={removeSelfTest}
            onOpenDiagnostic={openDiagnostic}
          />
        </section>
      </section>

      <footer className="statusbar" data-drawer-background>
        <div><LockKeyhole size={12} />{text.status.localJudge}</div>
        <div><Package size={12} />{activeToolchain.label} {activeToolchain.version}</div>
        <div><HardDrive size={12} />{text.status.cached(formatBytes(storage.usage))}</div>
        <div title={draftStatusDescription}><HardDrive size={12} />{draftStatusLabel}</div>
        <div className="status-spacer" />
        <div>{text.status.solved(solved.size, problems.length)}</div>
        <div>{project.config.target.toUpperCase()}</div>
        <div>{text.status.cursor(location.line, location.column)}</div>
      </footer>

      {onboardingOpen && <JudgeOnboarding locale={problemLocale} onClose={dismissOnboarding} />}

      <Drawer open={settingsOpen} label={text.settings.ariaLabel} onClose={() => setSettingsOpen(false)} returnFocusRef={settingsReturnFocusRef} portalTarget={drawerPortalTarget} className="settings-drawer">
            <div className="drawer-heading"><div><span>{text.settings.eyebrow}</span><h2>{text.settings.title}</h2><p>{text.settings.description}</p></div><IconButton icon={X} label={text.settings.close} onClick={() => setSettingsOpen(false)} /></div>
            {collection.source.provider === "github" && onProblemCollectionSourceChange && <section className="problem-source-section" aria-labelledby="problem-source-heading">
              <div className="problem-source-heading">
                <div><span>{text.settings.collectionEyebrow}</span><strong id="problem-source-heading">{text.settings.collectionTitle}</strong></div>
                <code>{collection.index.revision.slice(0, 12)}</code>
              </div>
              <p>{text.settings.collectionDescription}</p>
              <div className="collection-disclosure-warning"><TriangleAlert size={14} /><span>{text.settings.collectionDisclosureWarning}</span></div>
              <div className="collection-share-row">
                <a href={`https://github.com/${collection.source.owner}/${collection.source.repository}`} target="_blank" rel="noreferrer"><Package size={13} />{text.settings.openRepository}</a>
                <button type="button" onClick={() => void copyCollectionShareUrl()}><Copy size={13} />{shareState === "copied" ? text.settings.shareCopied : shareState === "failed" ? text.settings.shareFailed : text.settings.copyShareLink}</button>
              </div>
              <ProblemSourceForm
                source={collection.source}
                locale={problemLocale}
                disabled={Boolean(busy || loadingProblemId)}
                onApply={(next) => {
                  draftPersistenceController.update(project);
                  void draftPersistenceController.flush()
                    .then(() => onProblemCollectionSourceChange(next))
                    .catch((error: unknown) => {
                      addLog("stderr", error instanceof Error ? error.message : String(error));
                    });
                }}
              />
            </section>}
            {collection.source.provider === "managed" && <section className="problem-source-section" aria-labelledby="problem-source-heading">
              <div className="problem-source-heading">
                <div><span>{text.settings.collectionEyebrow}</span><strong id="problem-source-heading">{collection.source.mode === "contest" ? text.catalog.managedContest : text.catalog.managedPractice}</strong></div>
                <code>{collection.index.revision.slice(0, 12)}</code>
              </div>
              <p>{text.settings.managedContentDescription}</p>
              {collection.source.mode === "contest" && <div className="collection-disclosure-warning"><LockKeyhole size={14} /><span>{text.official.contestSamplesOnly}</span></div>}
            </section>}
            <section className="settings-section" aria-labelledby="compile-settings-heading">
              <header className="settings-section-heading"><span>{text.settings.compilationEyebrow}</span><strong id="compile-settings-heading">{text.settings.compilationTitle}</strong><p>{text.settings.compilationDescription}</p></header>
              <div className="toolchain-card">
                <span className={`toolchain-mark ${languageTone(project.config.language)}`}>{languageIcon(project.config.language)}</span>
                <div><strong>{activeToolchain.label}</strong><p>{toolchainNote(problemLocale, projectLanguage)}</p></div>
              </div>
              <label className="form-field"><span>{text.settings.entryFile}</span><select value={project.config.entry} onChange={(event) => updateProject((current) => ({ ...current, config: { ...current.config, entry: event.target.value } }))}>{project.files.map((file) => <option key={file.path}>{file.path}</option>)}</select></label>
              <div className="form-grid">
                <label className="form-field"><span>{text.settings.targetAbi}</span><select value={project.config.target} disabled={Boolean(publishedCompileProfile)} onChange={(event) => chooseTarget(event.target.value as "wasip1" | "wasix")}>{(publishedCompileProfile ? [publishedCompileProfile.target] : activeToolchain.targets).map((target) => <option value={target} key={target}>{target.toUpperCase()}</option>)}</select></label>
                <label className="form-field"><span>{text.settings.profile}</span><select value={project.config.optimization} disabled={Boolean(publishedCompileProfile)} onChange={(event) => updateProject((current) => ({ ...current, config: { ...current.config, optimization: event.target.value as "debug" | "release" } }))}>{publishedCompileProfile ? <option value={publishedCompileProfile.optimization}>{publishedCompileProfile.optimization === "debug" ? "Debug · -O0" : "Release · -O2"}</option> : <><option value="debug">Debug · -O0</option><option value="release">Release · -O2</option></>}</select></label>
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
              <div className="cache-section"><div><strong>{text.settings.draftPersistence}</strong><span>{draftStatusDescription}</span></div>{draftPersistence.phase === "error" && <button type="button" onClick={() => void draftPersistenceController.retry().catch(() => undefined)}><RotateCcw size={13} /> {text.settings.retryDraftSave}</button>}</div>
              <div className="cache-section">
                <div><strong>{text.settings.draftRecovery}</strong><span>{text.settings.draftRecoveryDescription}</span></div>
                <div>
                  <button type="button" onClick={exportDraftSources} disabled={!hydrated}><Download size={13} /> {text.settings.exportDraft}</button>
                  <button type="button" onClick={() => draftRecoveryInputRef.current?.click()} disabled={!hydrated}><Upload size={13} /> {text.settings.importDraft}</button>
                  <input
                    ref={draftRecoveryInputRef}
                    type="file"
                    accept="application/json,.json"
                    hidden
                    onChange={(event) => {
                      const file = event.currentTarget.files?.[0];
                      event.currentTarget.value = "";
                      if (file) void importDraftSources(file);
                    }}
                  />
                </div>
              </div>
              {draftRecoveryMessage && <div className="profile-notice" role={draftRecoveryMessage.tone === "error" ? "alert" : "status"}><FileCode2 size={15} /><p>{draftRecoveryMessage.text}</p></div>}
              <div className="cache-section"><div><strong>{text.settings.persistentStorage}</strong><span>{persistentStorageDescription}</span></div></div>
              <div className="cache-section"><div><strong>{text.settings.localCache}</strong><span>{formatBytes(storage.usage)} / {storage.quota ? formatBytes(storage.quota) : text.settings.browserQuota}</span></div><button onClick={() => void clearCaches()} disabled={Boolean(busy)}><RotateCcw size={13} /> {text.settings.clearCache}</button></div>
              <div className="drawer-footer"><ShieldCheck size={14} /><span>{text.settings.privacyNote}</span></div>
            </section>
      </Drawer>
      <Drawer open={Boolean(pendingFileRemoval)} label={pendingFileRemoval ? text.editor.deleteFileConfirm(pendingFileRemoval) : text.editor.deleteFile("")} onClose={() => setPendingFileRemoval(undefined)} returnFocusRef={fileRemovalReturnFocusRef} portalTarget={drawerPortalTarget}>
        <div className="account-delete-drawer">
          <header><div><span className="product-eyebrow"><TriangleAlert aria-hidden="true" size={14} /> {problemLocale === "zh-TW" ? "刪除檔案" : "Delete file"}</span><h2>{pendingFileRemoval ? text.editor.deleteFileConfirm(pendingFileRemoval) : ""}</h2></div><IconButton icon={X} label={text.settings.close} onClick={() => setPendingFileRemoval(undefined)} /></header>
          <p>{problemLocale === "zh-TW" ? "這只會刪除目前瀏覽器草稿中的檔案。" : "This removes the file only from the draft stored in this browser."}</p>
          <footer><button className="secondary-action" type="button" onClick={() => setPendingFileRemoval(undefined)}>{problemLocale === "zh-TW" ? "取消" : "Cancel"}</button><button className="danger-action" type="button" onClick={removeFile}><X aria-hidden="true" size={15} />{problemLocale === "zh-TW" ? "刪除" : "Delete"}</button></footer>
        </div>
      </Drawer>
    </main>
  );
}
