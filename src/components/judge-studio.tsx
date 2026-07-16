"use client";

import dynamic from "next/dynamic";
import type { OnMount } from "@monaco-editor/react";
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
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { projectCacheKey } from "@/src/core/hash";
import { LANGUAGES, type BuildArtifact, type Diagnostic, type Language, type Project, type ProjectConfig, type ProjectFile, type WorkerProgress } from "@/src/core/types";
import { extensionLanguage, languageLabel, TOOLCHAINS } from "@/src/core/toolchains";
import {
  decodeSolvedProgress,
  evaluateRun,
  JUDGE_PROGRESS_KEY,
  JudgeTimeoutError,
  submissionVerdict,
  type JudgeCaseResult,
  type JudgeSession,
  type SubmissionVerdict,
} from "@/src/judge/judge";
import { PROBLEMS, problemById, type JudgeProblem, type ProblemDifficulty } from "@/src/judge/problems";
import { createJudgeProject, judgeProjectId, problemIdFromProject } from "@/src/judge/project";
import { CompilerClient } from "@/src/runtime/compiler-client";
import { clearArtifactCache, listProjects, loadArtifact, loadLatestProject, requestPersistentStorage, saveArtifact, saveProject, storageEstimate } from "@/src/storage/database";
import { clearToolchainResponseCache, registerToolchainCache } from "@/src/storage/service-worker";

const MonacoEditor = dynamic(() => import("@monaco-editor/react"), { ssr: false });

type BottomTab = "judge" | "diagnostics" | "output" | "console";
type BusyAction = "build" | "run" | "judge" | "cache" | undefined;
type DifficultyFilter = "all" | ProblemDifficulty;

interface LogEntry {
  id: string;
  stream: "system" | "stdout" | "stderr";
  text: string;
}

const MONACO_LANGUAGE: Record<Language, string> = {
  c: "c",
  cpp: "cpp",
  rust: "rust",
  python: "python",
  javascript: "javascript",
  typescript: "typescript",
};

const VALID_PROBLEM_IDS = new Set(PROBLEMS.map((problem) => problem.id));

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
  return ({ c: "tone-c", cpp: "tone-cpp", rust: "tone-rust", python: "tone-python", javascript: "tone-js", typescript: "tone-ts" })[language];
}

function difficultyLabel(difficulty: ProblemDifficulty): string {
  return ({ easy: "入門", medium: "進階", hard: "挑戰" })[difficulty];
}

function verdictLabel(verdict: SubmissionVerdict): string {
  return ({
    running: "判題中",
    accepted: "Accepted",
    "wrong-answer": "Wrong Answer",
    "runtime-error": "Runtime Error",
    "time-limit": "Time Limit",
    "compile-error": "Compile Error",
    cancelled: "已取消",
  })[verdict];
}

async function runWithTimeLimit(
  client: CompilerClient,
  artifact: BuildArtifact,
  config: ProjectConfig,
  limitMs: number,
) {
  let timer = 0;
  try {
    return await Promise.race([
      client.run(artifact, config),
      new Promise<never>((_, reject) => {
        timer = window.setTimeout(() => reject(new JudgeTimeoutError()), limitMs);
      }),
    ]);
  } finally {
    window.clearTimeout(timer);
  }
}

export function JudgeStudio() {
  const initialProblem = PROBLEMS[0];
  const [project, setProject] = useState<Project>(() => createJudgeProject(initialProblem, "c"));
  const [problemId, setProblemId] = useState(initialProblem.id);
  const [filter, setFilter] = useState<DifficultyFilter>("all");
  const [solved, setSolved] = useState<Set<string>>(new Set());
  const [hydrated, setHydrated] = useState(false);
  const [runtimeReady, setRuntimeReady] = useState(false);
  const [progress, setProgress] = useState<WorkerProgress>({ phase: "initializing", label: "啟動 Wasmer runtime", progress: 0 });
  const [busy, setBusy] = useState<BusyAction>();
  const [artifact, setArtifact] = useState<BuildArtifact>();
  const [diagnostics, setDiagnostics] = useState<Diagnostic[]>([]);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [judgeSession, setJudgeSession] = useState<JudgeSession>();
  const [bottomTab, setBottomTab] = useState<BottomTab>("judge");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [newFileOpen, setNewFileOpen] = useState(false);
  const [newFilePath, setNewFilePath] = useState("");
  const [storage, setStorage] = useState({ usage: 0, quota: 0 });
  const [location, setLocation] = useState({ line: 1, column: 1 });
  const clientRef = useRef<CompilerClient | undefined>(undefined);
  const editorRef = useRef<Monaco.editor.IStandaloneCodeEditor | undefined>(undefined);
  const monacoRef = useRef<typeof Monaco | undefined>(undefined);
  const revealRef = useRef<{ line: number; column: number } | undefined>(undefined);
  const judgingRef = useRef(false);
  const cancelledRef = useRef(false);

  const activeProblem = problemById(problemId) ?? initialProblem;
  const activeFile = useMemo(
    () => project.files.find((file) => file.path === project.activeFile) ?? project.files[0],
    [project],
  );
  const activeToolchain = TOOLCHAINS[project.config.language];
  const filteredProblems = useMemo(
    () => filter === "all" ? PROBLEMS : PROBLEMS.filter((problem) => problem.difficulty === filter),
    [filter],
  );

  const addLog = useCallback((stream: LogEntry["stream"], text: string) => {
    if (!text) return;
    setLogs((current) => [...current, { id: crypto.randomUUID(), stream, text }]);
  }, []);

  useEffect(() => {
    const client = new CompilerClient();
    clientRef.current = client;
    client.onProgress(setProgress);
    client.onStream((stream, chunk) => {
      if (!judgingRef.current) addLog(stream, chunk);
    });
    void (async () => {
      try {
        await registerToolchainCache();
        await requestPersistentStorage();
        try {
          setSolved(decodeSolvedProgress(localStorage.getItem(JUDGE_PROGRESS_KEY), VALID_PROBLEM_IDS));
        } catch (error) {
          localStorage.removeItem(JUDGE_PROGRESS_KEY);
          addLog("stderr", error instanceof Error ? error.message : String(error));
        }
        const restored = await loadLatestProject();
        const restoredProblemId = restored ? problemIdFromProject(restored) : undefined;
        const restoredProblem = restoredProblemId ? problemById(restoredProblemId) : undefined;
        if (restored && restoredProblem && restored.id === judgeProjectId(restoredProblem.id, restored.config.language)) {
          setProject(restored);
          setProblemId(restoredProblem.id);
        }
        setStorage(await storageEstimate());
        setHydrated(true);
        await client.ready();
        setRuntimeReady(true);
      } catch (error) {
        addLog("stderr", error instanceof Error ? error.message : String(error));
        setHydrated(true);
      }
    })();
    return () => client.dispose();
  }, [addLog]);

  useEffect(() => {
    if (!hydrated) return;
    const timer = window.setTimeout(() => void saveProject(project), 350);
    return () => window.clearTimeout(timer);
  }, [hydrated, project]);

  useEffect(() => {
    if (!hydrated) return;
    localStorage.setItem(JUDGE_PROGRESS_KEY, JSON.stringify([...solved].sort()));
  }, [hydrated, solved]);

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
      monaco.editor.setModelMarkers(model, "localwasi", markers);
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

  const onEditorMount: OnMount = useCallback((editor, monaco) => {
    editorRef.current = editor;
    monacoRef.current = monaco;
    monaco.editor.defineTheme("localwasi", {
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
    monaco.editor.setTheme("localwasi");
    editor.onDidChangeCursorPosition((event) => setLocation({ line: event.position.lineNumber, column: event.position.column }));
    applyMarkers();
  }, [applyMarkers]);

  const updateProject = useCallback((updater: (current: Project) => Project) => {
    setProject((current) => ({ ...updater(current), updatedAt: Date.now() }));
    setArtifact(undefined);
    setJudgeSession(undefined);
  }, []);

  const updateActiveFile = useCallback((content: string | undefined) => {
    if (content === undefined || !activeFile) return;
    updateProject((current) => ({
      ...current,
      files: current.files.map((file) => file.path === activeFile.path ? { ...file, content } : file),
    }));
  }, [activeFile, updateProject]);

  const openWorkspace = useCallback(async (problem: JudgeProblem, language: Language) => {
    if (busy) return;
    await saveProject(project);
    const drafts = await listProjects();
    const id = judgeProjectId(problem.id, language);
    const draft = drafts.find((candidate) => candidate.id === id);
    clientRef.current?.restart();
    setRuntimeReady(true);
    setProject(draft ?? createJudgeProject(problem, language));
    setProblemId(problem.id);
    setArtifact(undefined);
    setDiagnostics([]);
    setLogs([]);
    setJudgeSession(undefined);
    setBottomTab("judge");
  }, [busy, project]);

  const doBuild = useCallback(async (allowCache = true): Promise<BuildArtifact | undefined> => {
    const client = clientRef.current;
    if (!client) return undefined;
    setBusy("build");
    setBottomTab("output");
    setDiagnostics([]);
    setLogs([]);
    const started = performance.now();
    try {
      const cacheKey = await projectCacheKey(project);
      if (allowCache) {
        const cached = await loadArtifact(cacheKey);
        if (cached) {
          setArtifact(cached);
          addLog("system", `從本機建置快取載入 ${cached.name} · ${formatBytes(cached.size)}`);
          setProgress({ phase: "packaging", label: "命中建置快取", progress: 1 });
          return cached;
        }
      }
      addLog("system", `build ${project.name} · ${languageLabel(project.config.language)} → ${project.config.target.toUpperCase()}`);
      const result = await client.build(project, cacheKey);
      setDiagnostics(result.diagnostics);
      if (result.stdout) addLog("stdout", result.stdout);
      if (result.stderr) addLog("stderr", result.stderr);
      if (!result.success || !result.artifact) {
        addLog("system", `建置失敗 · ${Math.round(performance.now() - started)} ms`);
        setBottomTab("diagnostics");
        return undefined;
      }
      setArtifact(result.artifact);
      await saveArtifact(result.artifact);
      setStorage(await storageEstimate());
      addLog("system", `完成 ${result.artifact.name} · ${formatBytes(result.artifact.size)} · ${Math.round(result.artifact.durationMs)} ms`);
      return result.artifact;
    } catch (error) {
      addLog("stderr", error instanceof Error ? error.message : String(error));
      return undefined;
    } finally {
      setBusy(undefined);
    }
  }, [addLog, project]);

  const doRunSample = useCallback(async () => {
    const client = clientRef.current;
    if (!client) return;
    setBusy("run");
    setBottomTab("console");
    setLogs([]);
    try {
      const key = await projectCacheKey(project);
      let runnable = artifact?.cacheKey === key ? artifact : undefined;
      if (!runnable) {
        setBusy(undefined);
        runnable = await doBuild(true);
        if (!runnable) return;
        setBusy("run");
        setBottomTab("console");
        setLogs([]);
      }
      addLog("system", `執行範例輸入 · ${activeProblem.title}`);
      const result = await client.run(runnable, { ...project.config, stdin: activeProblem.examples[0].input });
      addLog("system", `process exited ${result.code} · ${Math.round(result.durationMs)} ms`);
    } catch (error) {
      addLog("stderr", error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(undefined);
    }
  }, [activeProblem, addLog, artifact, doBuild, project]);

  const doJudge = useCallback(async () => {
    const client = clientRef.current;
    if (!client) return;
    cancelledRef.current = false;
    judgingRef.current = true;
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
      const cases: JudgeCaseResult[] = [];
      for (const [index, test] of activeProblem.judgeCases.entries()) {
        if (cancelledRef.current) break;
        setProgress({
          phase: "running",
          label: `本機測資 ${index + 1} / ${activeProblem.judgeCases.length}`,
          progress: index / activeProblem.judgeCases.length,
        });
        try {
          const result = await runWithTimeLimit(
            client,
            runnable,
            { ...project.config, stdin: test.input },
            activeProblem.timeLimitMs,
          );
          const evaluated = evaluateRun(index + 1, test.output, result);
          cases.push(evaluated);
          setJudgeSession({
            problemId: activeProblem.id,
            verdict: "running",
            completed: cases.length,
            total: activeProblem.judgeCases.length,
            cases: [...cases],
            durationMs: performance.now() - started,
          });
          if (evaluated.verdict !== "accepted") break;
        } catch (error) {
          if (cancelledRef.current) break;
          if (error instanceof JudgeTimeoutError) {
            client.cancel();
            cases.push({
              number: index + 1,
              verdict: "time-limit",
              expected: test.output.trimEnd(),
              actual: "",
              stderr: error.message,
              exitCode: null,
              durationMs: activeProblem.timeLimitMs,
            });
          } else {
            cases.push({
              number: index + 1,
              verdict: "runtime-error",
              expected: test.output.trimEnd(),
              actual: "",
              stderr: error instanceof Error ? error.message : String(error),
              exitCode: null,
              durationMs: 0,
            });
          }
          break;
        }
      }
      const verdict = cancelledRef.current ? "cancelled" : submissionVerdict(cases);
      const finished: JudgeSession = {
        problemId: activeProblem.id,
        verdict,
        completed: cases.length,
        total: activeProblem.judgeCases.length,
        cases,
        durationMs: performance.now() - started,
      };
      setJudgeSession(finished);
      if (verdict === "accepted") {
        setSolved((current) => new Set([...current, activeProblem.id]));
      }
    } finally {
      judgingRef.current = false;
      setBusy(undefined);
    }
  }, [activeProblem, artifact, doBuild, project]);

  const cancel = useCallback(() => {
    cancelledRef.current = true;
    judgingRef.current = false;
    clientRef.current?.cancel();
    setBusy(undefined);
    setJudgeSession((current) => current?.verdict === "running" ? { ...current, verdict: "cancelled" } : current);
    addLog("system", "已取消操作並重啟編譯 Worker");
  }, [addLog]);

  const chooseTarget = (target: "wasi" | "wasix") => {
    if (target === project.config.target) return;
    clientRef.current?.restart();
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
      await Promise.all([clientRef.current?.clearToolchainCache(), clearToolchainResponseCache(), clearArtifactCache()]);
      setArtifact(undefined);
      setStorage(await storageEstimate());
      addLog("system", "已清除本機工具鏈回應與建置產物");
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
        <div className="brand" aria-label="LocalWASI Judge">
          <span className="brand-mark"><Target size={17} strokeWidth={2.4} /></span>
          <span className="brand-name">LocalWASI</span>
          <span className="brand-edition">judge</span>
        </div>

        <div className="problem-switcher">
          <span className="problem-switcher-number">#{String(activeProblem.number).padStart(2, "0")}</span>
          <span>{activeProblem.title}</span>
          <span className={`difficulty-pill ${activeProblem.difficulty}`}>{difficultyLabel(activeProblem.difficulty)}</span>
        </div>

        <div className="topbar-actions">
          <label className="compact-select language-select">
            <span className={`language-dot ${languageTone(project.config.language)}`} />
            <select
              value={project.config.language}
              onChange={(event) => void openWorkspace(activeProblem, event.target.value as Language)}
              aria-label="解題語言"
              disabled={Boolean(busy)}
            >
              {LANGUAGES.map((language) => <option value={language} key={language}>{languageLabel(language)}</option>)}
            </select>
            <ChevronDown size={12} />
          </label>
          <label className="compact-select">
            <select value={project.config.target} onChange={(event) => chooseTarget(event.target.value as "wasi" | "wasix")} aria-label="編譯目標" disabled={Boolean(busy)}>
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
              <button className="sample-button" onClick={() => void doRunSample()} disabled={!runtimeReady}><Play size={14} /> 跑範例</button>
              <button className="submit-button" onClick={() => void doJudge()} disabled={!runtimeReady}><Send size={14} /> 提交判題</button>
            </>
          )}
        </div>
      </header>

      <section className="judge-workspace">
        <aside className="problem-catalog">
          <div className="catalog-heading">
            <div><span>CHALLENGES</span><strong>{solved.size} / {PROBLEMS.length}</strong></div>
            <div className="catalog-progress"><span style={{ width: `${(solved.size / PROBLEMS.length) * 100}%` }} /></div>
          </div>
          <div className="difficulty-filter" aria-label="題目難度篩選">
            {(["all", "easy", "medium", "hard"] as const).map((value) => (
              <button className={filter === value ? "active" : ""} onClick={() => setFilter(value)} key={value}>
                {value === "all" ? "全部" : difficultyLabel(value)}
              </button>
            ))}
          </div>
          <div className="problem-list">
            {filteredProblems.map((problem) => (
              <button
                className={`problem-row ${problem.id === activeProblem.id ? "active" : ""}`}
                onClick={() => void openWorkspace(problem, project.config.language)}
                disabled={Boolean(busy)}
                key={problem.id}
              >
                <span className={`problem-state ${solved.has(problem.id) ? "solved" : ""}`}>
                  {solved.has(problem.id) ? <Check size={12} /> : String(problem.number).padStart(2, "0")}
                </span>
                <span className="problem-row-copy"><strong>{problem.title}</strong><small>{problem.category}</small></span>
                <span className={`difficulty-dot ${problem.difficulty}`} title={difficultyLabel(problem.difficulty)} />
              </button>
            ))}
          </div>
          <div className="privacy-card judge-privacy">
            <ShieldCheck size={16} />
            <div><strong>100% in browser</strong><span>程式碼、測資與判題結果只留在此裝置。</span></div>
          </div>
        </aside>

        <article className="problem-statement">
          <div className="statement-kicker">
            <span>PROBLEM {String(activeProblem.number).padStart(2, "0")}</span>
            <span>{activeProblem.category}</span>
          </div>
          <h1>{activeProblem.title}</h1>
          <p className="problem-summary">{activeProblem.summary}</p>
          <div className="problem-metrics">
            <span><Gauge size={13} />{difficultyLabel(activeProblem.difficulty)}</span>
            <span><Clock3 size={13} />本機上限 {activeProblem.timeLimitMs / 1000}s / case</span>
            <span><Box size={13} />{activeProblem.judgeCases.length} cases</span>
          </div>
          <section className="statement-section">
            <h2>題目敘述</h2>
            {activeProblem.description.map((paragraph) => <p key={paragraph}>{paragraph}</p>)}
          </section>
          <section className="statement-section">
            <h2>輸入</h2>
            <p>{activeProblem.input}</p>
          </section>
          <section className="statement-section">
            <h2>輸出</h2>
            <p>{activeProblem.output}</p>
          </section>
          <section className="statement-section">
            <h2>限制</h2>
            <ul>{activeProblem.constraints.map((constraint) => <li key={constraint}>{constraint}</li>)}</ul>
          </section>
          {activeProblem.examples.map((example, index) => (
            <section className="statement-section example-section" key={index}>
              <h2>範例 {index + 1}</h2>
              <div className="example-grid">
                <div><span>INPUT</span><pre>{example.input}</pre></div>
                <div><span>OUTPUT</span><pre>{example.output}</pre></div>
              </div>
              <p className="example-note">{example.explanation}</p>
            </section>
          ))}
          <div className="local-judge-note">
            <LockKeyhole size={15} />
            <p><strong>本機判題邊界</strong>完整離線判題代表測資存在瀏覽器內，適合練習與自我驗證，不宣稱能防止使用者檢視測資。</p>
          </div>
        </article>

        <section className="editor-stack judge-editor-stack">
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
                language={MONACO_LANGUAGE[activeFile.language]}
                value={activeFile.content}
                onChange={updateActiveFile}
                onMount={onEditorMount}
                theme="localwasi"
                options={{
                  automaticLayout: true,
                  fontFamily: "var(--font-mono), monospace",
                  fontSize: 13,
                  lineHeight: 21,
                  minimap: { enabled: false },
                  padding: { top: 14, bottom: 14 },
                  renderLineHighlight: "all",
                  scrollBeyondLastLine: false,
                  smoothScrolling: true,
                  tabSize: 4,
                  wordWrap: "off",
                }}
              />
            )}
          </div>

          <section className="bottom-panel">
            <div className="bottom-tabs">
              <button className={bottomTab === "judge" ? "active" : ""} onClick={() => setBottomTab("judge")}>
                判題結果 {judgeSession && <span className={`verdict-mini ${judgeSession.verdict}`}>{judgeSession.completed}/{judgeSession.total}</span>}
              </button>
              <button className={bottomTab === "diagnostics" ? "active" : ""} onClick={() => setBottomTab("diagnostics")}>
                Diagnostics {diagnostics.length > 0 && <span className="count-badge">{diagnostics.length}</span>}
              </button>
              <button className={bottomTab === "output" ? "active" : ""} onClick={() => setBottomTab("output")}>Build output</button>
              <button className={bottomTab === "console" ? "active" : ""} onClick={() => setBottomTab("console")}>Console</button>
              <div className="panel-status">
                {busy && <><span className="spinner" />{progress.label}</>}
                {!busy && artifact && <><Check size={13} />{formatBytes(artifact.size)}</>}
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
                      <div><strong>{verdictLabel(judgeSession.verdict)}</strong><span>{judgeSession.completed} / {judgeSession.total} cases · {formatDuration(judgeSession.durationMs)}</span></div>
                    </div>
                    {judgeSession.verdict === "compile-error" && <button className="judge-link" onClick={() => setBottomTab("diagnostics")}>查看編譯診斷 →</button>}
                    <div className="case-list">
                      {judgeSession.cases.map((test) => (
                        <div className={`case-row ${test.verdict}`} key={test.number}>
                          <span className="case-status">{test.verdict === "accepted" ? <CheckCircle2 size={15} /> : <X size={15} />}</span>
                          <strong>Case {String(test.number).padStart(2, "0")}</strong>
                          <span>{test.verdict === "accepted" ? "Accepted" : verdictLabel(test.verdict)}</span>
                          <time>{formatDuration(test.durationMs)}</time>
                          {test.verdict !== "accepted" && (
                            <div className="case-diff">
                              <div><span>EXPECTED</span><pre>{test.expected || "∅"}</pre></div>
                              <div><span>ACTUAL</span><pre>{test.actual || test.stderr || "∅"}</pre></div>
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                )
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
                <div className="empty-panel"><Code2 size={17} /><span>{bottomTab === "console" ? "執行範例以查看程式輸出" : "建置專案以查看編譯器輸出"}</span></div>
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
        <div>{solved.size}/{PROBLEMS.length} solved</div>
        <div>{project.config.target.toUpperCase()}</div>
        <div>Ln {location.line}, Col {location.column}</div>
      </footer>

      {settingsOpen && (
        <div className="drawer-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setSettingsOpen(false); }}>
          <aside className="settings-drawer" aria-label="本機 Judge 設定">
            <div className="drawer-heading"><div><span>LOCAL JUDGE</span><h2>編譯與執行設定</h2></div><button className="icon-button" onClick={() => setSettingsOpen(false)} aria-label="關閉設定"><X size={16} /></button></div>
            <div className="toolchain-card">
              <span className={`toolchain-mark ${languageTone(project.config.language)}`}>{languageIcon(project.config.language)}</span>
              <div><strong>{activeToolchain.label}</strong><p>{activeToolchain.note}</p></div>
            </div>
            <label className="form-field"><span>Entry file</span><select value={project.config.entry} onChange={(event) => updateProject((current) => ({ ...current, config: { ...current.config, entry: event.target.value } }))}>{project.files.map((file) => <option key={file.path}>{file.path}</option>)}</select></label>
            <div className="form-grid">
              <label className="form-field"><span>Target ABI</span><select value={project.config.target} onChange={(event) => chooseTarget(event.target.value as "wasi" | "wasix")}>{activeToolchain.targets.map((target) => <option value={target} key={target}>{target.toUpperCase()}</option>)}</select></label>
              <label className="form-field"><span>Profile</span><select value={project.config.optimization} onChange={(event) => updateProject((current) => ({ ...current, config: { ...current.config, optimization: event.target.value as "debug" | "release" } }))}><option value="debug">Debug · -O0</option><option value="release">Release · -O2</option></select></label>
            </div>
            <label className="form-field"><span>自訂 Run stdin</span><textarea value={project.config.stdin} onChange={(event) => updateProject((current) => ({ ...current, config: { ...current.config, stdin: event.target.value } }))} rows={5} /></label>
            {project.config.language === "rust" && <div className="profile-notice"><TriangleAlert size={15} /><p><strong>Rust/WASI core profile</strong> 在 Judge 中提供 <code>read_int()</code>，並支援函式、整數、bindings、loops、條件與 print macros；不包含 Cargo、crate、collection 或完整標準函式庫。</p></div>}
            <div className="local-judge-note drawer-judge-note"><LockKeyhole size={15} /><p><strong>不防作弊</strong>完全本機的測資一定能被檢視；這是刻意的隱私與教學取捨。</p></div>
            <div className="cache-section"><div><strong>本機快取</strong><span>{formatBytes(storage.usage)} / {storage.quota ? formatBytes(storage.quota) : "browser quota"}</span></div><button onClick={() => void clearCaches()} disabled={busy === "cache"}><RotateCcw size={13} /> 清除快取</button></div>
            <div className="drawer-footer"><ShieldCheck size={14} /><span>只下載工具鏈套件；提交程式碼、stdin、測資與產物不會上傳。</span></div>
          </aside>
        </div>
      )}
    </main>
  );
}
