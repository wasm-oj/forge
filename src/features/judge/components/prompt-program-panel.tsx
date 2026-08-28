"use client";

import { Bot, Check, Eye, FileLock2, LoaderCircle, RefreshCw, Send, TriangleAlert, X } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { wasmOjJson, wasmOjMutation } from "../../platform/api/online-api";
import type { ProblemLocale } from "../../../judge/problem-model";
import type { PromptProgramOfficialTrack } from "../../../online-judge/contest-rules";
import type { ContestWorkspaceRuntime } from "../model/contest-workspace-runtime";
import { promptProgramBlockedReason } from "../model/contest-workspace-runtime";
import {
  isPromptAttemptTerminal,
  parseGeneratedSource,
  parsePromptAttemptAccepted,
  parsePromptAttemptDetailResponse,
  parsePromptAttemptHistoryResponse,
  promptUtf8Bytes,
  type GeneratedSource,
  type PromptAttemptDetail,
  type PromptAttemptHistoryItem,
} from "../model/prompt-program-contract";

interface PromptProgramPanelProps {
  readonly runtime: ContestWorkspaceRuntime;
  readonly locale: ProblemLocale;
}

function attemptStateLabel(state: PromptAttemptHistoryItem["state"], locale: ProblemLocale): string {
  const zh = locale === "zh-TW";
  return ({
    reserved: zh ? "已保留額度" : "Reserved",
    generating: zh ? "生成中" : "Generating",
    "source-ready": zh ? "原始碼已鎖定" : "Source locked",
    submitted: zh ? "已送交判題" : "Submitted",
    failed: zh ? "失敗" : "Failed",
    cancelled: zh ? "已取消" : "Cancelled",
  } as const)[state];
}

function quotaStateLabel(state: PromptAttemptHistoryItem["quotaState"], locale: ProblemLocale): string {
  const zh = locale === "zh-TW";
  return ({
    reserved: zh ? "額度保留中" : "Quota reserved",
    consumed: zh ? "已消耗額度" : "Quota consumed",
    released: zh ? "額度已歸還" : "Quota released",
    invalid: zh ? "額度已由時間線復原" : "Quota restored by timeline",
  } as const)[state];
}

function formatAttemptTime(value: string, locale: ProblemLocale): string {
  return new Intl.DateTimeFormat(locale === "zh-TW" ? "zh-TW" : "en", {
    dateStyle: "short",
    timeStyle: "medium",
  }).format(new Date(value));
}

function attemptTone(attempt: Pick<PromptAttemptHistoryItem, "state" | "eligibility">): string {
  if (attempt.eligibility === "invalid") return "invalid";
  if (attempt.state === "failed" || attempt.state === "cancelled") return "failed";
  if (attempt.state === "submitted") return "ready";
  return "pending";
}

export function PromptProgramPanel({ runtime, locale }: PromptProgramPanelProps) {
  if (!runtime.promptCompilerAvailable || runtime.officialTrack.kind !== "prompt-program") return null;
  return <AvailablePromptProgramPanel runtime={runtime} track={runtime.officialTrack} locale={locale} />;
}

function AvailablePromptProgramPanel({
  runtime,
  track,
  locale,
}: PromptProgramPanelProps & { readonly track: PromptProgramOfficialTrack }) {
  const [open, setOpen] = useState(false);
  const [prompt, setPrompt] = useState("");
  const [idempotencyKey, setIdempotencyKey] = useState(() => `browser:${crypto.randomUUID()}`);
  const [history, setHistory] = useState<readonly PromptAttemptHistoryItem[]>([]);
  const [historyLoading, setHistoryLoading] = useState(true);
  const [selectedDetail, setSelectedDetail] = useState<PromptAttemptDetail>();
  const [detailLoading, setDetailLoading] = useState(false);
  const [pollingAttemptId, setPollingAttemptId] = useState<string>();
  const [source, setSource] = useState<GeneratedSource>();
  const [sourceSubmissionId, setSourceSubmissionId] = useState<string>();
  const [sourceLoading, setSourceLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const quotaSnapshotKey = `${runtime.timelineGeneration}:${runtime.rulesEpoch}:${runtime.problemEpoch}:${runtime.attemptsRemaining}`;
  const [acceptedSession, setAcceptedSession] = useState({ key: quotaSnapshotKey, count: 0 });
  const [error, setError] = useState<string>();
  const zh = locale === "zh-TW";
  const maxPromptBytes = track.limits.promptBytes;
  const promptBytes = promptUtf8Bytes(prompt);
  const acceptedThisSession = acceptedSession.key === quotaSnapshotKey ? acceptedSession.count : 0;
  const attemptsRemaining = Math.max(0, runtime.attemptsRemaining - acceptedThisSession);
  const blockedReason = attemptsRemaining < 1
    ? (zh ? "沒有剩餘的官方 Prompt Program attempt。" : "No official Prompt Program attempts remain.")
    : promptProgramBlockedReason(runtime);

  const loadHistory = useCallback(async (signal?: AbortSignal) => {
    const query = new URLSearchParams({ contestId: runtime.contestId, problemId: runtime.problemId });
    const value = await wasmOjJson<unknown>(`/api/prompt-attempts?${query}`, { signal });
    setHistory(parsePromptAttemptHistoryResponse(value));
  }, [runtime.contestId, runtime.problemId]);

  useEffect(() => {
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      void loadHistory(controller.signal)
        .catch((reason: unknown) => {
          if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : String(reason));
        })
        .finally(() => {
          if (!controller.signal.aborted) setHistoryLoading(false);
        });
    }, 0);
    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [loadHistory]);

  const inspectAttempt = useCallback(async (attemptId: string) => {
    setDetailLoading(true);
    setError(undefined);
    try {
      const value = await wasmOjJson<unknown>(`/api/prompt-attempts/${encodeURIComponent(attemptId)}`);
      setSelectedDetail(parsePromptAttemptDetailResponse(value));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setDetailLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!pollingAttemptId) return;
    const controller = new AbortController();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let consecutiveFailures = 0;
    const poll = async () => {
      try {
        const value = await wasmOjJson<unknown>(`/api/prompt-attempts/${encodeURIComponent(pollingAttemptId)}`, {
          signal: controller.signal,
        });
        const detail = parsePromptAttemptDetailResponse(value);
        if (controller.signal.aborted) return;
        consecutiveFailures = 0;
        setError(undefined);
        setSelectedDetail(detail);
        if (isPromptAttemptTerminal(detail.state)) {
          if (detail.quota.state === "released" || detail.quota.state === "invalid") {
            setAcceptedSession((value) => ({
              key: quotaSnapshotKey,
              count: Math.max(0, (value.key === quotaSnapshotKey ? value.count : 0) - 1),
            }));
          }
          await loadHistory(controller.signal).catch((reason: unknown) => {
            if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : String(reason));
          });
          if (!controller.signal.aborted) setPollingAttemptId(undefined);
          return;
        }
      } catch (reason) {
        if (controller.signal.aborted) return;
        consecutiveFailures += 1;
        if (consecutiveFailures >= 4) setError(reason instanceof Error ? reason.message : String(reason));
      }
      timeout = setTimeout(() => { void poll(); }, 1_250);
    };
    void poll();
    return () => {
      controller.abort();
      if (timeout) clearTimeout(timeout);
    };
  }, [loadHistory, pollingAttemptId, quotaSnapshotKey]);

  const submitPrompt = async () => {
    if (blockedReason || promptBytes < 1 || promptBytes > maxPromptBytes || runtime.promptContextSha256 === null) return;
    setSubmitting(true);
    setError(undefined);
    setSelectedDetail(undefined);
    setSource(undefined);
    setSourceSubmissionId(undefined);
    try {
      const accepted = parsePromptAttemptAccepted(await wasmOjMutation<unknown>("/api/prompt-attempts", {
        contestId: runtime.contestId,
        problemId: runtime.problemId,
        timelineGeneration: runtime.timelineGeneration,
        rulesEpoch: runtime.rulesEpoch,
        problemEpoch: runtime.problemEpoch,
        publicContextSha256: runtime.promptContextSha256,
        prompt,
        idempotencyKey,
      }));
      setPrompt("");
      setIdempotencyKey(`browser:${crypto.randomUUID()}`);
      setAcceptedSession((value) => ({
        key: quotaSnapshotKey,
        count: (value.key === quotaSnapshotKey ? value.count : 0) + 1,
      }));
      setPollingAttemptId(accepted.promptAttemptId);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setSubmitting(false);
    }
  };

  const loadSource = async (submissionId: string) => {
    setSourceLoading(true);
    setError(undefined);
    try {
      const value = await wasmOjJson<unknown>(`/api/submissions/${encodeURIComponent(submissionId)}/source`);
      setSource(parseGeneratedSource(value));
      setSourceSubmissionId(submissionId);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setSourceLoading(false);
    }
  };

  return (
    <section className={`prompt-program-panel ${open ? "is-open" : ""}`} aria-label={zh ? "Prompt Program 官方作答" : "Official Prompt Program workspace"}>
      <div className="prompt-program-heading">
        <div className="prompt-program-heading-copy">
          <Bot size={15} />
          <div>
            <strong>Prompt Program</strong>
            <span>{zh ? "模型輸出的第一份合法結構化原始碼會鎖定並成為官方提交" : "The first valid structured model output is locked and enters the official judge pipeline"}</span>
          </div>
        </div>
        <div className="prompt-program-heading-actions">
          <span>{zh ? `剩餘 ${attemptsRemaining} 次` : `${attemptsRemaining} attempts left`}</span>
          <button type="button" onClick={() => setOpen((value) => !value)}>{open ? (zh ? "收合" : "Close") : (zh ? "開啟 Prompt 模式" : "Open Prompt mode")}</button>
        </div>
      </div>

      {open && <div className="prompt-program-body">
        <div className="prompt-program-compose">
          <div className="prompt-program-mode" role="group" aria-label={zh ? "官方作答模式" : "Official submission mode"}>
            <span aria-disabled="true">Code</span>
            <span className="active" aria-current="true">Prompt Program</span>
            <small>{zh ? "模式由競賽規則固定" : "Fixed by contest rules"}</small>
          </div>
          <label>
            <span>{zh ? "你的單一 UTF-8 prompt" : "Your single UTF-8 prompt"}</span>
            <textarea
              value={prompt}
              maxLength={maxPromptBytes}
              rows={6}
              placeholder={zh ? "描述解法、限制與希望產生的程式結構…" : "Describe the solution, constraints, and desired program structure…"}
              disabled={submitting || Boolean(blockedReason)}
              onChange={(event) => {
                setPrompt(event.target.value);
                setIdempotencyKey(`browser:${crypto.randomUUID()}`);
              }}
            />
          </label>
          <div className={`prompt-program-byte-count ${promptBytes > maxPromptBytes ? "over-limit" : ""}`}>
            {promptBytes.toLocaleString()} / {maxPromptBytes.toLocaleString()} UTF-8 bytes
          </div>
          {blockedReason && <p className="prompt-program-blocked" role="status"><TriangleAlert size={13} />{blockedReason}</p>}
          <button
            type="button"
            className="prompt-program-submit"
            disabled={submitting || Boolean(pollingAttemptId) || Boolean(blockedReason) || promptBytes < 1 || promptBytes > maxPromptBytes}
            onClick={() => { void submitPrompt(); }}
          >
            {submitting || pollingAttemptId ? <LoaderCircle className="spin" size={14} /> : <Send size={14} />}
            {submitting ? (zh ? "保留額度中…" : "Reserving quota…") : (zh ? "建立官方 Prompt attempt" : "Create official prompt attempt")}
          </button>
          <p className="prompt-program-policy"><FileLock2 size={13} />{zh ? "收到模型回應後，即使輸出格式或編譯失敗也會消耗額度；平台／provider 基礎設施失敗則歸還。" : "A model response consumes quota even if malformed or uncompilable; terminal provider or platform failures release it."}</p>
        </div>

        <div className="prompt-program-history">
          <div className="prompt-program-history-heading">
            <strong>{zh ? "官方 attempt 歷史" : "Official attempt history"}</strong>
            <button type="button" disabled={historyLoading} aria-label={zh ? "重新整理 attempt 歷史" : "Refresh attempt history"} onClick={() => {
              setHistoryLoading(true);
              void loadHistory().catch((reason: unknown) => setError(reason instanceof Error ? reason.message : String(reason))).finally(() => setHistoryLoading(false));
            }}><RefreshCw className={historyLoading ? "spin" : ""} size={13} /></button>
          </div>
          {history.length === 0 && !historyLoading && <p>{zh ? "尚無 Prompt Program attempts。" : "No Prompt Program attempts yet."}</p>}
          <div className="prompt-program-attempt-list">
            {history.map((attempt) => <article className={`prompt-program-attempt tone-${attemptTone(attempt)}`} key={attempt.attemptId}>
              <div>
                <strong>{attemptStateLabel(attempt.state, locale)}</strong>
                <span>{formatAttemptTime(attempt.createdAt, locale)}</span>
              </div>
              <div>
                <span>{quotaStateLabel(attempt.quotaState, locale)}</span>
                {attempt.eligibility === "invalid" && <span className="prompt-attempt-invalid">{zh ? "非目前官方時間線" : "Outside official timeline"}</span>}
              </div>
              <div className="prompt-program-attempt-actions">
                <button type="button" disabled={detailLoading} onClick={() => { void inspectAttempt(attempt.attemptId); }}><Eye size={12} />{zh ? "詳情" : "Details"}</button>
                {attempt.submissionId && <button type="button" disabled={sourceLoading} onClick={() => { void loadSource(attempt.submissionId!); }}><FileLock2 size={12} />{zh ? "鎖定原始碼" : "Locked source"}</button>}
              </div>
            </article>)}
          </div>
        </div>

        {error && <p className="prompt-program-error" role="alert"><TriangleAlert size={13} />{error}</p>}

        {selectedDetail && <section className="prompt-attempt-detail" aria-label={zh ? "Prompt attempt 詳情" : "Prompt attempt details"}>
          <div className="prompt-attempt-detail-heading">
            <strong>{attemptStateLabel(selectedDetail.state, locale)}</strong>
            <button type="button" aria-label={zh ? "關閉詳情" : "Close details"} onClick={() => setSelectedDetail(undefined)}><X size={13} /></button>
          </div>
          <dl>
            <div><dt>{zh ? "時間線" : "Timeline"}</dt><dd>G{selectedDetail.timelineGeneration} · R{selectedDetail.rulesEpoch} · P{selectedDetail.problemEpoch} · C{selectedDetail.contentEpoch} · J{selectedDetail.judgeEpoch}</dd></div>
            <div><dt>{zh ? "額度" : "Quota"}</dt><dd>{selectedDetail.quota.slot} / {selectedDetail.quota.limit} · {quotaStateLabel(selectedDetail.quota.state, locale)}</dd></div>
            <div><dt>{zh ? "邏輯時間" : "Logical time"}</dt><dd>{selectedDetail.admittedLogicalSeconds}s{selectedDetail.evidenceLogicalSeconds === null ? "" : ` → ${selectedDetail.evidenceLogicalSeconds}s`}</dd></div>
            <div><dt>{zh ? "輸出" : "Output"}</dt><dd>{selectedDetail.output.language} · {selectedDetail.output.target} · {selectedDetail.output.optimization}</dd></div>
          </dl>
          {selectedDetail.eligibility === "invalid" && <p className="prompt-attempt-invalid"><TriangleAlert size={12} />{zh ? `已失效：${selectedDetail.invalidationReason}` : `Invalidated: ${selectedDetail.invalidationReason}`}</p>}
          {selectedDetail.failureCode && <p className="prompt-program-error">{selectedDetail.failureCode}</p>}
          {selectedDetail.prompt === null
            ? <p>{zh ? "帳號抹除後，prompt 內容已 tombstone。" : "The prompt was tombstoned after account erasure."}</p>
            : <details><summary>{zh ? "查看提交的 prompt" : "View submitted prompt"}</summary><pre>{selectedDetail.prompt}</pre></details>}
          {selectedDetail.submissionId && <button type="button" className="prompt-source-open" disabled={sourceLoading} onClick={() => { void loadSource(selectedDetail.submissionId!); }}><FileLock2 size={13} />{zh ? "查看鎖定 generated source" : "View locked generated source"}</button>}
        </section>}

        {source && sourceSubmissionId && <section className="prompt-source-viewer" aria-label={zh ? "鎖定 generated source" : "Locked generated source"}>
          <div className="prompt-source-viewer-heading">
            <div><Check size={14} /><strong>{zh ? "鎖定 generated source" : "Locked generated source"}</strong><span>{source.request.language} · {source.request.target} · {source.request.optimization}</span></div>
            <div><a href={`/api/submissions/${encodeURIComponent(sourceSubmissionId)}/source`} download>{zh ? "下載 JSON" : "Download JSON"}</a><button type="button" aria-label={zh ? "關閉原始碼" : "Close source"} onClick={() => { setSource(undefined); setSourceSubmissionId(undefined); }}><X size={13} /></button></div>
          </div>
          <p><FileLock2 size={12} />{zh ? "此版本為官方 immutable source；rejudge 只會重用這份內容，不會再次呼叫模型。" : "This is the immutable official source; rejudge reuses it without another model call."}</p>
          {source.request.sourceFiles.map((file) => <details open={source.request.sourceFiles.length === 1} key={file.path}>
            <summary>{file.path}{file.path === source.request.entry ? (zh ? " · entry" : " · entry") : ""}</summary>
            <pre><code>{file.content}</code></pre>
          </details>)}
        </section>}
      </div>}
    </section>
  );
}
