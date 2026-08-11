"use client";

import "./monaco-environment";
import * as Monaco from "monaco-editor";
import { useEffect, useRef, type CSSProperties } from "react";

export type BeforeMount = (monaco: typeof Monaco) => void;
export type OnMount = (editor: Monaco.editor.IStandaloneCodeEditor, monaco: typeof Monaco) => void;

export interface SelfHostedMonacoEditorProps {
  path: string;
  language: string;
  value: string;
  onChange?: (value: string | undefined) => void;
  beforeMount?: BeforeMount;
  onMount?: OnMount;
  theme?: string;
  options?: Monaco.editor.IStandaloneEditorConstructionOptions;
}

export default function SelfHostedMonacoEditor({
  path,
  language,
  value,
  onChange,
  beforeMount,
  onMount,
  theme,
  options,
}: SelfHostedMonacoEditorProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<Monaco.editor.IStandaloneCodeEditor | undefined>(undefined);
  const createdModelsRef = useRef(new Set<Monaco.editor.ITextModel>());
  const onChangeRef = useRef(onChange);
  const lifecycleRef = useRef({ beforeMount, onMount });
  const initialOptionsRef = useRef(options);
  const initialThemeRef = useRef(theme);

  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const createdModels = createdModelsRef.current;
    lifecycleRef.current.beforeMount?.(Monaco);
    const editor = Monaco.editor.create(container, {
      ...initialOptionsRef.current,
      ...(initialThemeRef.current === undefined ? {} : { theme: initialThemeRef.current }),
      model: null,
    });
    editorRef.current = editor;
    const subscription = editor.onDidChangeModelContent(() => {
      onChangeRef.current?.(editor.getValue());
    });
    lifecycleRef.current.onMount?.(editor, Monaco);
    return () => {
      subscription.dispose();
      editor.dispose();
      editorRef.current = undefined;
      for (const model of createdModels) model.dispose();
      createdModels.clear();
    };
  }, []);

  useEffect(() => {
    const editor = editorRef.current;
    if (!editor) return;
    const uri = Monaco.Uri.parse(path);
    let model = Monaco.editor.getModel(uri);
    if (!model) {
      model = Monaco.editor.createModel(value, language, uri);
      createdModelsRef.current.add(model);
    } else {
      Monaco.editor.setModelLanguage(model, language);
      if (model.getValue() !== value) model.setValue(value);
    }
    editor.setModel(model);
  }, [language, path, value]);

  useEffect(() => {
    if (theme) Monaco.editor.setTheme(theme);
  }, [theme]);

  useEffect(() => {
    if (options) editorRef.current?.updateOptions(options);
  }, [options]);

  return <div ref={containerRef} style={CONTAINER_STYLE} />;
}

const CONTAINER_STYLE: CSSProperties = Object.freeze({ height: "100%", width: "100%" });
