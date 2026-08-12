"use client";

import dynamic from "next/dynamic";
import { Check, Plus, Settings2, X } from "lucide-react";
import type { MouseEvent as ReactMouseEvent, ReactNode } from "react";
import type { Language, Project, ProjectFile } from "../../../core/types";
import type { BeforeMount, OnMount } from "../editor/self-hosted-monaco-editor";
import { wasmOjMonacoTheme } from "../editor/wasm-oj-monaco-theme";
import type { JudgeUiText } from "../model/judge-ui-i18n";

const MonacoEditor = dynamic(() => import("../editor/self-hosted-monaco-editor"), { ssr: false });

const MONACO_LANGUAGE: Readonly<Record<string, string>> = {
  c: "c",
  cpp: "cpp",
  rust: "rust",
  python: "python",
  javascript: "javascript",
  typescript: "typescript",
  go: "go",
};

interface EditorPanelProps {
  readonly project: Project;
  readonly activeFile?: ProjectFile;
  readonly productTheme: "light" | "dark";
  readonly loading: boolean;
  readonly newFileOpen: boolean;
  readonly newFilePath: string;
  readonly text: JudgeUiText;
  readonly beforeMount: BeforeMount;
  readonly onMount: OnMount;
  readonly languageTone: (language: Language) => string;
  readonly languageIcon: (language: Language) => ReactNode;
  readonly onOpenFile: (path: string) => void;
  readonly onRequestFileRemoval: (path: string, trigger: HTMLElement) => void;
  readonly onNewFileOpenChange: (open: boolean) => void;
  readonly onNewFilePathChange: (path: string) => void;
  readonly onAddFile: () => void;
  readonly onOpenSettings: (event: ReactMouseEvent<HTMLElement>) => void;
  readonly onChange: (content: string | undefined) => void;
}

export function EditorPanel({
  project,
  activeFile,
  productTheme,
  loading,
  newFileOpen,
  newFilePath,
  text,
  beforeMount,
  onMount,
  languageTone,
  languageIcon,
  onOpenFile,
  onRequestFileRemoval,
  onNewFileOpenChange,
  onNewFilePathChange,
  onAddFile,
  onOpenSettings,
  onChange,
}: EditorPanelProps) {
  return (
    <>
      <div className="editor-tabs file-tabs">
        {project.files.map((file) => (
          <div className={`file-tab ${file.path === project.activeFile ? "active" : ""}`} key={file.path}>
            <button className="file-tab-open" onClick={() => onOpenFile(file.path)}>
              <span className={`file-icon ${languageTone(file.language)}`}>{languageIcon(file.language)}</span>
              {file.path.split("/").at(-1)}
            </button>
            {project.files.length > 1 && <button className="file-tab-close" onClick={(event) => onRequestFileRemoval(file.path, event.currentTarget)} aria-label={text.editor.deleteFile(file.path)}><X size={11} /></button>}
          </div>
        ))}
        {newFileOpen ? (
          <form className="tab-new-file" onSubmit={(event) => { event.preventDefault(); onAddFile(); }}>
            <input autoFocus value={newFilePath} onChange={(event) => onNewFilePathChange(event.target.value)} placeholder="src/helper.c" aria-label={text.editor.newFilePath} />
            <button type="submit" aria-label={text.editor.createFile}><Check size={12} /></button>
            <button type="button" onClick={() => onNewFileOpenChange(false)} aria-label={text.editor.cancel}><X size={12} /></button>
          </form>
        ) : (
          <button className="bare-button add-file-tab" onClick={() => onNewFileOpenChange(true)} aria-label={text.editor.addFile}><Plus size={14} /></button>
        )}
        <div className="editor-actions"><button className="bare-button" onClick={onOpenSettings} aria-label={text.editor.openCompilationSettings}><Settings2 size={14} /></button></div>
      </div>
      <div className="editor-surface">
        {activeFile && (
          <MonacoEditor
            path={`file:///${activeFile.path}`}
            language={MONACO_LANGUAGE[activeFile.language] ?? "plaintext"}
            value={activeFile.content}
            onChange={onChange}
            beforeMount={beforeMount}
            onMount={onMount}
            theme={wasmOjMonacoTheme(productTheme)}
            options={{
              automaticLayout: true,
              fontFamily: "var(--font-mono), monospace",
              fontSize: 13,
              lineHeight: 21,
              minimap: { enabled: false },
              padding: { top: 14, bottom: 14 },
              renderLineHighlight: "all",
              readOnly: loading,
              scrollBeyondLastLine: false,
              smoothScrolling: true,
              tabSize: 4,
              wordWrap: "off",
            }}
          />
        )}
      </div>
    </>
  );
}
