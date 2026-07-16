"use client";

import dynamic from "next/dynamic";
import {
  Box,
  Braces,
  Bug,
  Check,
  ChevronDown,
  CircleStop,
  Code2,
  Download,
  FileCode2,
  FolderOpen,
  Hammer,
  HardDrive,
  LockKeyhole,
  Package,
  Play,
  Plus,
  RotateCcw,
  Settings2,
  ShieldCheck,
  TriangleAlert,
  X,
  Zap,
} from "lucide-react";
import type { OnMount } from "@monaco-editor/react";
import type * as Monaco from "monaco-editor";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { projectCacheKey } from "@/src/core/hash";
import { createProject } from "@/src/core/templates";
import { LANGUAGES, type BuildArtifact, type Diagnostic, type Language, type Project, type ProjectFile, type WorkerProgress } from "@/src/core/types";
import { extensionLanguage, languageLabel, TOOLCHAINS } from "@/src/core/toolchains";
import { CompilerClient } from "@/src/runtime/compiler-client";
import { clearArtifactCache, loadArtifact, loadLatestProject, requestPersistentStorage, saveArtifact, saveProject, storageEstimate } from "@/src/storage/database";
import { clearToolchainResponseCache, registerToolchainCache } from "@/src/storage/service-worker";

const MonacoEditor = dynamic(() => import("@monaco-editor/react"), { ssr: false });

type BottomTab = "problems" | "output" | "console";
type BusyAction = "build" | "run" | "cache" | undefined;

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

function parseArguments(value: string): string[] {
  const result: string[] = [];
  const pattern = /"([^"\\]*(?:\\.[^"\\]*)*)"|'([^'\\]*(?:\\.[^'\\]*)*)'|(\S+)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(value)) !== null) result.push(match[1] ?? match[2] ?? match[3]);
  return result;
}

function parseEnvironment(value: string): Record<string, string> {
  return Object.fromEntries(
    value
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const separator = line.indexOf("=");
        return separator < 1 ? [line, ""] : [line.slice(0, separator), line.slice(separator + 1)];
      }),
  );
}

function environmentText(env: Record<string, string>): string {
  return Object.entries(env).map(([key, value]) => `${key}=${value}`).join("\n");
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

export function Studio() {
  const [project, setProject] = useState<Project>(() => createProject("c"));
  const [hydrated, setHydrated] = useState(false);
  const [runtimeReady, setRuntimeReady] = useState(false);
  const [progress, setProgress] = useState<WorkerProgress>({ phase: "initializing", label: "Starting Wasmer runtime", progress: 0 });
  const [busy, setBusy] = useState<BusyAction>();
  const [artifact, setArtifact] = useState<BuildArtifact>();
  const [diagnostics, setDiagnostics] = useState<Diagnostic[]>([]);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [bottomTab, setBottomTab] = useState<BottomTab>("output");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [newFileOpen, setNewFileOpen] = useState(false);
  const [newFilePath, setNewFilePath] = useState("");
  const [storage, setStorage] = useState({ usage: 0, quota: 0 });
  const [location, setLocation] = useState({ line: 1, column: 1 });
  const clientRef = useRef<CompilerClient | undefined>(undefined);
  const editorRef = useRef<Monaco.editor.IStandaloneCodeEditor | undefined>(undefined);
  const monacoRef = useRef<typeof Monaco | undefined>(undefined);
  const revealRef = useRef<{ line: number; column: number } | undefined>(undefined);

  const activeFile = useMemo(
    () => project.files.find((file) => file.path === project.activeFile) ?? project.files[0],
    [project],
  );
  const activeToolchain = TOOLCHAINS[project.config.language];

  const addLog = useCallback((stream: LogEntry["stream"], text: string) => {
    if (!text) return;
    setLogs((current) => [...current, { id: crypto.randomUUID(), stream, text }]);
  }, []);

  useEffect(() => {
    const client = new CompilerClient();
    clientRef.current = client;
    client.onProgress(setProgress);
    client.onStream((stream, chunk) => addLog(stream, chunk));
    void (async () => {
      try {
        await registerToolchainCache();
        await requestPersistentStorage();
        const restored = await loadLatestProject();
        if (restored) setProject(restored);
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
  }, []);

  const updateActiveFile = useCallback((content: string | undefined) => {
    if (content === undefined || !activeFile) return;
    updateProject((current) => ({
      ...current,
      files: current.files.map((file) => file.path === activeFile.path ? { ...file, content } : file),
    }));
  }, [activeFile, updateProject]);

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
          addLog("system", `restored ${cached.name} from local build cache · ${formatBytes(cached.size)}`);
          setProgress({ phase: "packaging", label: "Build cache hit", progress: 1 });
          return cached;
        }
      }
      addLog("system", `build ${project.name} · ${languageLabel(project.config.language)} → ${project.config.target.toUpperCase()}`);
      const result = await client.build(project, cacheKey);
      setDiagnostics(result.diagnostics);
      if (result.stdout) addLog("stdout", result.stdout);
      if (result.stderr) addLog("stderr", result.stderr);
      if (!result.success || !result.artifact) {
        addLog("system", `build failed · ${Math.round(performance.now() - started)} ms`);
        setBottomTab("problems");
        return undefined;
      }
      setArtifact(result.artifact);
      await saveArtifact(result.artifact);
      setStorage(await storageEstimate());
      addLog("system", `finished ${result.artifact.name} · ${formatBytes(result.artifact.size)} · ${Math.round(result.artifact.durationMs)} ms`);
      return result.artifact;
    } catch (error) {
      addLog("stderr", error instanceof Error ? error.message : String(error));
      return undefined;
    } finally {
      setBusy(undefined);
    }
  }, [addLog, project]);

  const doRun = useCallback(async () => {
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
      addLog("system", `$ wasmer run ${runnable.name}${project.config.args.length ? ` -- ${project.config.args.join(" ")}` : ""}`);
      const result = await client.run(runnable, project.config);
      addLog("system", `process exited ${result.code} · ${Math.round(result.durationMs)} ms`);
    } catch (error) {
      addLog("stderr", error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(undefined);
    }
  }, [addLog, artifact, doBuild, project]);

  const cancel = useCallback(() => {
    clientRef.current?.cancel();
    setBusy(undefined);
    addLog("system", "operation cancelled; compiler worker restarted");
  }, [addLog]);

  const chooseLanguage = (language: Language) => {
    if (language === project.config.language) return;
    if (!window.confirm(`Create a new ${languageLabel(language)} project? Unsaved editor state for this project will remain in local storage.`)) return;
    clientRef.current?.restart();
    setProject(createProject(language, project.name));
    setArtifact(undefined);
    setDiagnostics([]);
    setLogs([]);
  };

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
    if (project.files.length === 1 || !window.confirm(`Delete ${path} from this local project?`)) return;
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
      addLog("system", "local toolchain responses and build artifacts cleared");
    } finally {
      setBusy(undefined);
    }
  };

  if (!hydrated) return <main className="boot-screen"><div className="boot-mark"><Zap size={20} /></div><p>Opening your local workspace</p></main>;

  return (
    <main className="studio-shell">
      <header className="topbar">
        <div className="brand" aria-label="LocalWASI Studio">
          <span className="brand-mark"><Box size={17} strokeWidth={2.4} /></span>
          <span className="brand-name">LocalWASI</span>
          <span className="brand-edition">studio</span>
        </div>

        <div className="project-switcher">
          <FolderOpen size={14} />
          <span>{project.name}</span>
          <ChevronDown size={13} />
        </div>

        <div className="topbar-actions">
          <label className="compact-select language-select">
            <span className={`language-dot ${languageTone(project.config.language)}`} />
            <select value={project.config.language} onChange={(event) => chooseLanguage(event.target.value as Language)} aria-label="Project language">
              {LANGUAGES.map((language) => <option value={language} key={language}>{languageLabel(language)}</option>)}
            </select>
            <ChevronDown size={12} />
          </label>
          <label className="compact-select">
            <select
              value={project.config.target}
              onChange={(event) => chooseTarget(event.target.value as "wasi" | "wasix")}
              aria-label="Compilation target"
            >
              {activeToolchain.targets.map((target) => (
                <option value={target} key={target}>{target.toUpperCase()}</option>
              ))}
            </select>
            <ChevronDown size={12} />
          </label>
          <button className="icon-button" onClick={() => setSettingsOpen(true)} aria-label="Project settings"><Settings2 size={16} /></button>
          {busy ? (
            <button className="stop-button" onClick={cancel}><CircleStop size={14} /> Stop</button>
          ) : (
            <>
              <button className="build-button" onClick={() => void doBuild(false)} disabled={!runtimeReady}><Hammer size={14} /> Build</button>
              <button className="run-button" onClick={() => void doRun()} disabled={!runtimeReady}><Play size={14} fill="currentColor" /> Run</button>
            </>
          )}
        </div>
      </header>

      <section className="workspace">
        <aside className="explorer">
          <div className="pane-heading">
            <span>PROJECT</span>
            <button className="bare-button" onClick={() => setNewFileOpen((open) => !open)} aria-label="Add file"><Plus size={15} /></button>
          </div>
          <div className="project-root"><ChevronDown size={13} /><FolderOpen size={14} /><span>{project.name}</span></div>
          <div className="file-list">
            {project.files.map((file) => (
              <div className={`file-row ${file.path === project.activeFile ? "active" : ""}`} key={file.path}>
                <button className="file-open" onClick={() => setProject((current) => ({ ...current, activeFile: file.path }))}>
                  <span className={`file-icon ${languageTone(file.language)}`}>{languageIcon(file.language)}</span>
                  <span title={file.path}>{file.path}</span>
                </button>
                <button className="file-delete" onClick={() => removeFile(file.path)} aria-label={`Delete ${file.path}`}><X size={12} /></button>
              </div>
            ))}
          </div>
          {newFileOpen && (
            <form className="new-file-form" onSubmit={(event) => { event.preventDefault(); addFile(); }}>
              <input autoFocus value={newFilePath} onChange={(event) => setNewFilePath(event.target.value)} placeholder="src/module.c" aria-label="New file path" />
              <button type="submit" aria-label="Create file"><Check size={13} /></button>
            </form>
          )}

          <div className="explorer-spacer" />
          <div className="privacy-card">
            <ShieldCheck size={16} />
            <div><strong>Private by design</strong><span>Source never leaves this browser.</span></div>
          </div>
        </aside>

        <section className="editor-stack">
          <div className="editor-tabs">
            {activeFile && (
              <button className="editor-tab active">
                <span className={`file-icon ${languageTone(activeFile.language)}`}>{languageIcon(activeFile.language)}</span>
                {activeFile.path.split("/").at(-1)}
                <span className="dirty-dot" />
              </button>
            )}
            <div className="editor-actions"><button className="bare-button" onClick={() => setSettingsOpen(true)} aria-label="Open compiler configuration"><Settings2 size={14} /></button></div>
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
                  fontSize: 14,
                  lineHeight: 22,
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
              <button className={bottomTab === "problems" ? "active" : ""} onClick={() => setBottomTab("problems")}>
                Problems {diagnostics.length > 0 && <span className="count-badge">{diagnostics.length}</span>}
              </button>
              <button className={bottomTab === "output" ? "active" : ""} onClick={() => setBottomTab("output")}>Build output</button>
              <button className={bottomTab === "console" ? "active" : ""} onClick={() => setBottomTab("console")}>Program console</button>
              <div className="panel-status">
                {busy && <><span className="spinner" />{progress.label}</>}
                {!busy && artifact && <><Check size={13} />{artifact.name} · {formatBytes(artifact.size)}</>}
              </div>
              {artifact && <button className="bare-button panel-download" onClick={() => downloadArtifact(artifact)} aria-label="Download artifact"><Download size={14} /></button>}
            </div>
            <div className="panel-content">
              {bottomTab === "problems" ? (
                diagnostics.length === 0 ? (
                  <div className="empty-panel"><Check size={17} /><span>No diagnostics</span></div>
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
                <div className="empty-panel"><Code2 size={17} /><span>{bottomTab === "console" ? "Run the project to see program output" : "Build the project to see compiler output"}</span></div>
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
        <div><LockKeyhole size={12} />Local only</div>
        <div><Package size={12} />{activeToolchain.label} {activeToolchain.version}</div>
        <div><HardDrive size={12} />{formatBytes(storage.usage)} cached</div>
        <div className="status-spacer" />
        <div>{project.config.target.toUpperCase()}</div>
        <div>Ln {location.line}, Col {location.column}</div>
      </footer>

      {settingsOpen && (
        <div className="drawer-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setSettingsOpen(false); }}>
          <aside className="settings-drawer" aria-label="Project configuration">
            <div className="drawer-heading"><div><span>PROJECT CONFIG</span><h2>Build settings</h2></div><button className="icon-button" onClick={() => setSettingsOpen(false)} aria-label="Close settings"><X size={16} /></button></div>
            <div className="toolchain-card">
              <span className={`toolchain-mark ${languageTone(project.config.language)}`}>{languageIcon(project.config.language)}</span>
              <div><strong>{activeToolchain.label}</strong><p>{activeToolchain.note}</p></div>
            </div>
            <label className="form-field"><span>Project name</span><input value={project.name} onChange={(event) => updateProject((current) => ({ ...current, name: event.target.value }))} /></label>
            <label className="form-field"><span>Entry file</span><select value={project.config.entry} onChange={(event) => updateProject((current) => ({ ...current, config: { ...current.config, entry: event.target.value } }))}>{project.files.map((file) => <option key={file.path}>{file.path}</option>)}</select></label>
            <div className="form-grid">
              <label className="form-field"><span>Target ABI</span><select value={project.config.target} onChange={(event) => updateProject((current) => ({ ...current, config: { ...current.config, target: event.target.value as "wasi" | "wasix" } }))}><option value="wasi">WASI Preview 1</option><option value="wasix">WASIX</option></select></label>
              <label className="form-field"><span>Profile</span><select value={project.config.optimization} onChange={(event) => updateProject((current) => ({ ...current, config: { ...current.config, optimization: event.target.value as "debug" | "release" } }))}><option value="debug">Debug · -O0</option><option value="release">Release · -O2</option></select></label>
            </div>
            <label className="form-field"><span>Program arguments</span><input value={project.config.args.join(" ")} onChange={(event) => updateProject((current) => ({ ...current, config: { ...current.config, args: parseArguments(event.target.value) } }))} placeholder='--name "WASI user"' /></label>
            <label className="form-field"><span>Environment</span><textarea value={environmentText(project.config.env)} onChange={(event) => updateProject((current) => ({ ...current, config: { ...current.config, env: parseEnvironment(event.target.value) } }))} rows={4} placeholder="KEY=value" /></label>
            <label className="form-field"><span>Standard input</span><textarea value={project.config.stdin} onChange={(event) => updateProject((current) => ({ ...current, config: { ...current.config, stdin: event.target.value } }))} rows={4} placeholder="Text passed to stdin at startup" /></label>
            {project.config.language === "rust" && <div className="profile-notice"><TriangleAlert size={15} /><p><strong>Rust/WASI core profile</strong> supports functions, primitive types, bindings, ranges, control flow, and print macros. Cargo, crates, traits, structs, enums, async, and unsafe are intentionally rejected with source diagnostics.</p></div>}
            <div className="cache-section"><div><strong>Local cache</strong><span>{formatBytes(storage.usage)} of {storage.quota ? formatBytes(storage.quota) : "browser quota"}</span></div><button onClick={() => void clearCaches()} disabled={busy === "cache"}><RotateCcw size={13} /> Clear caches</button></div>
            <div className="drawer-footer"><ShieldCheck size={14} /><span>Only registry package binaries are downloaded. Source and artifacts are never uploaded.</span></div>
          </aside>
        </div>
      )}
    </main>
  );
}
