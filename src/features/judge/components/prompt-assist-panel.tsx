"use client";

import { Bot, FileCode2, LoaderCircle, Send, Sparkles, TriangleAlert, X } from "lucide-react";
import { useState } from "react";
import type { BuiltinLanguage } from "../../../core/types";
import type { ProblemLocale } from "../../../judge/problem-model";
import type { PromptAssistDraft } from "../../../online-judge/prompt-compiler";
import { wasmOjMutation } from "../../platform/api/online-api";
import {
  createPromptAssistRequest,
  parsePromptAssistResponse,
  PROMPT_ASSIST_MAX_PROMPT_BYTES,
  promptAssistUtf8Bytes,
  type PromptAssistWorkspaceContext,
} from "../model/prompt-assist-contract";

export interface PromptAssistPanelProps {
  readonly context: PromptAssistWorkspaceContext;
  readonly language: BuiltinLanguage;
  readonly entry: string;
  readonly locale: ProblemLocale;
  readonly hasNonTemplateEdits: boolean;
  readonly onReplace: (draft: PromptAssistDraft) => void;
}

export function PromptAssistPanel({
  context,
  language,
  entry,
  locale,
  hasNonTemplateEdits,
  onReplace,
}: PromptAssistPanelProps) {
  const [open, setOpen] = useState(false);
  const [prompt, setPrompt] = useState("");
  const [generating, setGenerating] = useState(false);
  const [draft, setDraft] = useState<PromptAssistDraft>();
  const [error, setError] = useState<string>();
  const zh = locale === "zh-TW";
  const promptBytes = promptAssistUtf8Bytes(prompt);

  const generate = async () => {
    if (generating || promptBytes < 1 || promptBytes > PROMPT_ASSIST_MAX_PROMPT_BYTES) return;
    setGenerating(true);
    setError(undefined);
    setDraft(undefined);
    try {
      const request = createPromptAssistRequest(context, language, entry, prompt);
      const value = await wasmOjMutation<unknown>("/api/prompt-assist", request);
      setDraft(parsePromptAssistResponse(value, request));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setGenerating(false);
    }
  };

  const replace = () => {
    if (!draft) return;
    if (hasNonTemplateEdits && !window.confirm(zh
      ? "目前編輯器含有你的修改。要以 AI Assist 產生的檔案取代全部編輯器內容嗎？"
      : "The editor contains your changes. Replace every editor file with the AI Assist draft?")) return;
    onReplace(draft);
    setDraft(undefined);
    setPrompt("");
    setOpen(false);
  };

  return (
    <section className={`prompt-assist-panel ${open ? "is-open" : ""}`} aria-label={zh ? "AI 輔助程式草稿" : "AI-assisted code draft"}>
      <div className="prompt-assist-heading">
        <div><Sparkles size={15} /><strong>AI Assist</strong><span>{zh ? "產生可編輯草稿；正式提交仍是普通 Code submission" : "Generate an editable draft; Official Submit remains an ordinary code submission"}</span></div>
        <button type="button" onClick={() => setOpen((value) => !value)}>{open ? (zh ? "收合" : "Close") : (zh ? "開啟輔助" : "Open Assist")}</button>
      </div>
      {open && <div className="prompt-assist-body">
        <div className="prompt-assist-compose">
          <label>
            <span>{zh ? "描述你希望產生的解法" : "Describe the solution you want generated"}</span>
            <textarea
              rows={5}
              value={prompt}
              disabled={generating}
              placeholder={zh ? "包含演算法、限制與檔案結構…" : "Include the algorithm, constraints, and desired file structure…"}
              onChange={(event) => setPrompt(event.target.value)}
            />
          </label>
          <div className={`prompt-assist-byte-count ${promptBytes > PROMPT_ASSIST_MAX_PROMPT_BYTES ? "over-limit" : ""}`}>
            {promptBytes.toLocaleString()} / {PROMPT_ASSIST_MAX_PROMPT_BYTES.toLocaleString()} UTF-8 bytes
          </div>
          <button className="prompt-assist-generate" type="button" disabled={generating || promptBytes < 1 || promptBytes > PROMPT_ASSIST_MAX_PROMPT_BYTES} onClick={() => { void generate(); }}>
            {generating ? <LoaderCircle className="spin" size={14} /> : <Send size={14} />}
            {generating ? (zh ? "生成中…" : "Generating…") : (zh ? "產生草稿" : "Generate draft")}
          </button>
          <p><Bot size={13} />{zh ? "模型只會收到此題公開內容；沒有 tools、瀏覽、憑證或隱藏 judge data。" : "The model receives only this problem's public context—no tools, browsing, credentials, or hidden judge data."}</p>
        </div>
        <div className="prompt-assist-preview">
          <header><div><FileCode2 size={14} /><strong>{zh ? "待套用草稿" : "Draft awaiting replacement"}</strong></div>{draft && <button type="button" aria-label={zh ? "捨棄草稿" : "Discard draft"} onClick={() => setDraft(undefined)}><X size={13} /></button>}</header>
          {!draft && !error && <p>{zh ? "生成後先檢視檔案，再明確選擇是否取代編輯器。" : "Review generated files, then explicitly choose whether to replace the editor."}</p>}
          {error && <p className="prompt-assist-error" role="alert"><TriangleAlert size={13} />{error}</p>}
          {draft && <>
            <p>{draft.output.language} · {draft.output.target} · {draft.output.optimization} · {draft.sourceFiles.length} {zh ? "個檔案" : "files"}</p>
            <div className="prompt-assist-files">
              {draft.sourceFiles.map((file) => <details open={draft.sourceFiles.length === 1} key={file.path}>
                <summary>{file.path}{file.path === draft.entry ? " · entry" : ""}</summary>
                <pre><code>{file.content}</code></pre>
              </details>)}
            </div>
            {hasNonTemplateEdits && <p className="prompt-assist-warning"><TriangleAlert size={12} />{zh ? "取代前會再次確認，避免覆蓋你的修改。" : "You will be asked again before your current edits are replaced."}</p>}
            <button className="prompt-assist-replace" type="button" onClick={replace}><FileCode2 size={14} />{zh ? "取代編輯器" : "Replace editor"}</button>
          </>}
        </div>
      </div>}
    </section>
  );
}
