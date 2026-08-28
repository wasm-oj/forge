"use client";

import { Activity, AlertTriangle, ChevronDown, LockKeyhole, TrendingUp } from "lucide-react";
import Image from "next/image";
import { useEffect, useMemo, useState } from "react";
import { type BuiltinLanguage, isBuiltinLanguage } from "../../../core/types";
import { languageLabel } from "../../../core/toolchains";
import { wasmOjJson } from "../../platform/api/online-api";
import type { ProblemLocale } from "../../../judge/problem-model";
import { SubmissionPolicySummaryContent } from "../../submissions/components/submission-policy-summary";
import {
  parseProblemPerformanceResponse,
  problemPerformanceApiPath,
  readSubmissionPolicySummaryResponse,
  submissionPolicySummaryApiPath,
  type PerformanceEvolutionPoint,
  type PerformanceFrontierPoint,
  type ProblemPerformanceResponse,
  type SubmissionPolicySummaryResponse,
} from "../model/performance-contract";

const LANGUAGE_COLORS: Readonly<Record<BuiltinLanguage, string>> = {
  c: "#5e81ac",
  cpp: "#81a1c1",
  rust: "#d08770",
  python: "#ebcb8b",
  javascript: "#a3be8c",
  typescript: "#88c0d0",
  go: "#b48ead",
};

type PerformanceLoadState =
  | { readonly key: string; readonly response: ProblemPerformanceResponse }
  | { readonly key: string; readonly error: string };

type PolicyLoadState =
  | { readonly submissionId: string; readonly response: SubmissionPolicySummaryResponse }
  | { readonly submissionId: string; readonly unavailable: true }
  | { readonly submissionId: string; readonly error: string };

interface ChartPoint {
  readonly submissionId: string;
  readonly language: BuiltinLanguage;
  readonly score: number;
  readonly deterministicCost: number;
  readonly peakMemoryBytes: number;
  readonly label: string;
  readonly kind: "frontier" | "evolution";
  readonly isPareto: boolean;
}

interface PositionedPoint extends ChartPoint {
  readonly x: number;
  readonly y: number;
  readonly radius: number;
}

const CHART = Object.freeze({ width: 720, height: 360, left: 56, right: 18, top: 18, bottom: 46 });

function compactNumber(value: number, locale: ProblemLocale): string {
  return Intl.NumberFormat(locale, { notation: "compact", maximumFractionDigits: 1 }).format(value);
}

function fullNumber(value: number, locale: ProblemLocale): string {
  return Intl.NumberFormat(locale, { maximumFractionDigits: 2 }).format(value);
}

function bytes(value: number, locale: ProblemLocale): string {
  if (value < 1_024) return `${fullNumber(value, locale)} B`;
  if (value < 1_048_576) return `${fullNumber(value / 1_024, locale)} KiB`;
  return `${fullNumber(value / 1_048_576, locale)} MiB`;
}

function dateTime(value: string, locale: ProblemLocale): string {
  return new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

async function loadPolicySummary(submissionId: string, signal: AbortSignal): Promise<SubmissionPolicySummaryResponse | null> {
  const response = await fetch(submissionPolicySummaryApiPath(submissionId), { credentials: "same-origin", signal });
  return readSubmissionPolicySummaryResponse(response, submissionId);
}

function chartPoints(response: ProblemPerformanceResponse): readonly ChartPoint[] {
  const frontier: ChartPoint[] = response.frontier.map((point) => ({
    submissionId: point.submissionId,
    language: point.language,
    score: point.score,
    deterministicCost: point.deterministicCost,
    peakMemoryBytes: point.peakMemoryBytes,
    label: point.participant.label,
    kind: "frontier",
    isPareto: point.isPareto,
  }));
  const evolution = (response.myEvolution ?? []).flatMap((point): ChartPoint[] => (
    !point.eligible || point.state !== "completed" || point.score === null || point.deterministicCost === null || point.peakMemoryBytes === null
      ? []
      : [{
        submissionId: point.submissionId,
        language: point.language,
        score: point.score,
        deterministicCost: point.deterministicCost,
        peakMemoryBytes: point.peakMemoryBytes,
        label: `#${point.attemptNumber}`,
        kind: "evolution",
        isPareto: false,
      }]
  ));
  return [...frontier, ...evolution];
}

function positionPoints(points: readonly ChartPoint[]): readonly PositionedPoint[] {
  const innerWidth = CHART.width - CHART.left - CHART.right;
  const innerHeight = CHART.height - CHART.top - CHART.bottom;
  const maximumLogCost = Math.max(1, ...points.map((point) => Math.log1p(point.deterministicCost)));
  const maximumScore = Math.max(1, ...points.map((point) => point.score));
  const maximumMemory = Math.max(1, ...points.map((point) => point.peakMemoryBytes));
  return points.map((point) => ({
    ...point,
    x: CHART.left + (Math.log1p(point.deterministicCost) / maximumLogCost) * innerWidth,
    y: CHART.top + (1 - point.score / maximumScore) * innerHeight,
    radius: 4 + Math.sqrt(point.peakMemoryBytes / maximumMemory) * 6,
  }));
}

function pointLabel(point: ChartPoint, locale: ProblemLocale, chinese: boolean): string {
  return `${point.label}, ${languageLabel(point.language)}, ${chinese ? "分數" : "score"} ${fullNumber(point.score, locale)}, ${chinese ? "成本" : "cost"} ${fullNumber(point.deterministicCost, locale)}, ${chinese ? "記憶體" : "memory"} ${bytes(point.peakMemoryBytes, locale)}`;
}

function PerformancePlot({
  response,
  locale,
  selectedSubmissionId,
  onSelect,
}: {
  readonly response: ProblemPerformanceResponse;
  readonly locale: ProblemLocale;
  readonly selectedSubmissionId?: string;
  onSelect(submissionId: string): void;
}) {
  const chinese = locale === "zh-TW";
  const points = useMemo(() => positionPoints(chartPoints(response)), [response]);
  const maximumLogCost = Math.max(1, ...points.map((point) => Math.log1p(point.deterministicCost)));
  const maximumScore = Math.max(1, ...points.map((point) => point.score));
  const pareto = points
    .filter((point) => point.kind === "frontier" && point.isPareto)
    .sort((left, right) => left.deterministicCost - right.deterministicCost || left.score - right.score);
  const evolution = points
    .filter((point) => point.kind === "evolution")
    .sort((left, right) => {
      const leftAttempt = Number(left.label.slice(1));
      const rightAttempt = Number(right.label.slice(1));
      return leftAttempt - rightAttempt;
    });
  const arrowId = `performance-arrow-${response.context.problemId.replaceAll("-", "")}`;
  const innerWidth = CHART.width - CHART.left - CHART.right;
  const innerHeight = CHART.height - CHART.top - CHART.bottom;
  const ticks = [0, 0.25, 0.5, 0.75, 1] as const;

  return <figure className="performance-plot">
    <svg
      viewBox={`0 0 ${CHART.width} ${CHART.height}`}
      role="img"
      aria-labelledby={`${arrowId}-title ${arrowId}-description`}
      preserveAspectRatio="xMidYMid meet"
    >
      <title id={`${arrowId}-title`}>{chinese ? "分數與確定性成本散佈圖" : "Score and deterministic-cost scatter plot"}</title>
      <desc id={`${arrowId}-description`}>{chinese
        ? "水平軸為 log1p 確定性成本，垂直軸為分數，點的大小表示尖峰記憶體；實線連接 Pareto 前緣，箭頭連接你的歷次提交。"
        : "The horizontal axis is log1p deterministic cost, the vertical axis is score, point size is peak memory; a solid line connects the Pareto frontier and arrows connect your attempts."}</desc>
      <defs>
        <marker id={arrowId} viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
          <path d="M 0 0 L 8 4 L 0 8 z" className="performance-arrow-head" />
        </marker>
      </defs>
      <g className="performance-grid" aria-hidden="true">
        {ticks.map((tick) => {
          const x = CHART.left + tick * innerWidth;
          const y = CHART.top + (1 - tick) * innerHeight;
          return <g key={tick}>
            <line x1={x} y1={CHART.top} x2={x} y2={CHART.top + innerHeight} />
            <line x1={CHART.left} y1={y} x2={CHART.left + innerWidth} y2={y} />
            <text x={x} y={CHART.height - 23} textAnchor="middle">{compactNumber(Math.expm1(maximumLogCost * tick), locale)}</text>
            <text x={CHART.left - 10} y={y + 4} textAnchor="end">{fullNumber(maximumScore * tick, locale)}</text>
          </g>;
        })}
      </g>
      <text className="performance-axis-label" x={CHART.left + innerWidth / 2} y={CHART.height - 4} textAnchor="middle">
        {chinese ? "確定性成本（log1p）" : "Deterministic cost (log1p)"}
      </text>
      <text className="performance-axis-label" transform={`translate(13 ${CHART.top + innerHeight / 2}) rotate(-90)`} textAnchor="middle">
        {chinese ? "分數" : "Score"}
      </text>
      {pareto.length > 1 && <polyline
        className="performance-pareto-line"
        points={pareto.map((point) => `${point.x},${point.y}`).join(" ")}
        aria-hidden="true"
      />}
      {evolution.slice(1).map((point, index) => <line
        className="performance-evolution-arrow"
        x1={evolution[index]!.x}
        y1={evolution[index]!.y}
        x2={point.x}
        y2={point.y}
        markerEnd={`url(#${arrowId})`}
        key={`${evolution[index]!.submissionId}-${point.submissionId}`}
        aria-hidden="true"
      />)}
      {points.map((point) => <g
        className={`performance-point ${point.kind === "evolution" ? "is-owner" : ""} ${point.isPareto ? "is-pareto" : ""} ${point.submissionId === selectedSubmissionId ? "is-selected" : ""}`}
        role="button"
        tabIndex={0}
        aria-label={pointLabel(point, locale, chinese)}
        aria-pressed={point.submissionId === selectedSubmissionId}
        onClick={() => onSelect(point.submissionId)}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            onSelect(point.submissionId);
          }
        }}
        key={`${point.kind}-${point.submissionId}`}
      >
        <circle cx={point.x} cy={point.y} r={point.radius + 5} className="performance-point-hit" />
        <circle cx={point.x} cy={point.y} r={point.radius} fill={LANGUAGE_COLORS[point.language]} />
        {point.kind === "evolution" && <circle cx={point.x} cy={point.y} r={Math.max(1.5, point.radius - 3)} className="performance-owner-core" />}
      </g>)}
    </svg>
    <figcaption>{chinese
      ? "越靠左上越好。圓點越大代表記憶體使用越高；外圈為你的提交。"
      : "Upper-left is better. Larger circles use more memory; outlined points are your submissions."}</figcaption>
  </figure>;
}

function Participant({ point }: { readonly point: PerformanceFrontierPoint }) {
  return <span className="performance-participant">
    {point.participant.avatarUrl && <Image src={point.participant.avatarUrl} width={20} height={20} alt="" unoptimized />}
    <span>{point.participant.label}</span>
  </span>;
}

function statusLabel(point: PerformanceEvolutionPoint): string {
  if (!point.eligible) return `invalid · ${point.invalidationReason ?? "superseded timeline"} · ${point.verdict ?? point.state}`;
  return point.verdict ?? point.state;
}

export function PerformanceLabView({
  locale,
  language,
  response,
  loading,
  error,
  selectedSubmissionId,
  policySummary,
  policyLoading,
  policyUnavailable,
  policyError,
  onLanguageChange,
  onSelect,
}: {
  readonly locale: ProblemLocale;
  readonly language: BuiltinLanguage | "all";
  readonly response?: ProblemPerformanceResponse;
  readonly loading: boolean;
  readonly error?: string;
  readonly selectedSubmissionId?: string;
  readonly policySummary?: SubmissionPolicySummaryResponse;
  readonly policyLoading: boolean;
  readonly policyUnavailable?: boolean;
  readonly policyError?: string;
  onLanguageChange(language: BuiltinLanguage | "all"): void;
  onSelect(submissionId: string): void;
}) {
  const chinese = locale === "zh-TW";
  const selectedEvolution = response?.myEvolution?.find((point) => point.submissionId === selectedSubmissionId);
  const errorAttempts = response?.myEvolution?.filter((point) => !point.eligible || (point.state !== "completed" && point.state !== "admitting" && point.state !== "queued" && point.state !== "preparing" && point.state !== "compiling" && point.state !== "running" && point.state !== "finalizing")) ?? [];

  return <section className="performance-lab" aria-label={chinese ? "效能實驗室" : "Performance Lab"}>
    <div className="online-section-heading performance-heading">
      <div>
        <h2><Activity size={14} /> {chinese ? "效能實驗室" : "Performance Lab"}</h2>
        <p>{chinese
          ? "比較分數、確定性成本與尖峰記憶體，沿著 Pareto 前緣找到下一個最佳化方向。"
          : "Compare score, deterministic cost, and peak memory; use the Pareto frontier to choose the next optimization."}</p>
      </div>
      <label className="compact-select">
        <select
          value={language}
          aria-label={chinese ? "依程式語言篩選效能" : "Filter performance by language"}
          onChange={(event) => {
            const value = event.target.value;
            if (value === "all" || isBuiltinLanguage(value)) onLanguageChange(value);
          }}
        >
          <option value="all">{chinese ? "所有語言" : "All languages"}</option>
          {(response?.context.availableLanguages ?? []).map((value) => <option value={value} key={value}>{languageLabel(value)}</option>)}
        </select>
        <ChevronDown size={12} />
      </label>
    </div>

    {loading && <div className="online-empty" role="status">{chinese ? "載入效能資料中…" : "Loading performance data…"}</div>}
    {error && <div className="online-error" role="alert">{error}</div>}
    {!loading && !error && response && <>
      {response.context.frozen && <div className="performance-freeze-note" role="status">
        <LockKeyhole size={14} />
        <span>{chinese
          ? "競賽封榜中：全域前緣只顯示 freeze 時點前的結果；你的演進紀錄仍保持完整。"
          : "Contest freeze is active: the global frontier stops at the freeze timestamp, while your own evolution remains complete."}</span>
      </div>}
      {response.context.hidden && <div className="performance-freeze-note" role="status">
        <LockKeyhole size={14} />
        <span>{chinese
          ? "排行榜在競賽結束前隱藏；你的完整演進與被 rewind 失效的歷史仍可查看。"
          : "The leaderboard is hidden until contest end; your own evolution and rewind-invalidated history remain visible."}</span>
      </div>}

      <div className="performance-legend" aria-label={chinese ? "語言圖例" : "Language legend"}>
        {response.context.availableLanguages.map((item) => <span key={item}><i style={{ backgroundColor: LANGUAGE_COLORS[item] }} />{languageLabel(item)}</span>)}
        <span className="performance-pareto-key"><i />{chinese ? "Pareto 前緣" : "Pareto frontier"}</span>
        <span className="performance-owner-key"><i />{chinese ? "你的演進" : "Your evolution"}</span>
      </div>

      {response.frontier.length > 0 || (response.myEvolution?.some((point) => point.score !== null && point.deterministicCost !== null && point.peakMemoryBytes !== null) ?? false)
        ? <PerformancePlot response={response} locale={locale} selectedSubmissionId={selectedSubmissionId} onSelect={onSelect} />
        : <div className="online-empty">{chinese ? "目前還沒有可繪製的完成結果。" : "There are no completed results to plot yet."}</div>}

      {errorAttempts.length > 0 && <div className="performance-errors" aria-labelledby="performance-error-title">
        <h3 id="performance-error-title"><AlertTriangle size={13} /> {chinese ? "未產生效能座標的事件" : "Events without performance coordinates"}</h3>
        <ol>
          {errorAttempts.map((point) => <li className="performance-event-error" key={point.submissionId}>
            <button type="button" onClick={() => onSelect(point.submissionId)} aria-pressed={point.submissionId === selectedSubmissionId}>#{point.attemptNumber}</button>
            <span>{languageLabel(point.language)}</span>
            <strong>{statusLabel(point)}</strong>
            <time dateTime={point.createdAt}>{dateTime(point.createdAt, locale)}</time>
          </li>)}
        </ol>
      </div>}

      <div className="performance-table-wrap">
        <table className="performance-table">
          <caption>{chinese ? "全域效能前緣的可存取表格" : "Accessible global performance frontier"}</caption>
          <thead><tr>
            <th>{chinese ? "參與者" : "Participant"}</th><th>{chinese ? "語言" : "Language"}</th><th>{chinese ? "分數" : "Score"}</th>
            <th>{chinese ? "成本" : "Cost"}</th><th>{chinese ? "記憶體" : "Memory"}</th><th>{chinese ? "達成時間" : "Achieved"}</th><th>Pareto</th>
          </tr></thead>
          <tbody>{response.frontier.map((point) => <tr className={point.submissionId === selectedSubmissionId ? "is-selected" : ""} key={point.submissionId}>
            <td><button type="button" onClick={() => onSelect(point.submissionId)} aria-pressed={point.submissionId === selectedSubmissionId}><Participant point={point} /></button></td>
            <td>{languageLabel(point.language)}</td><td>{fullNumber(point.score, locale)}</td><td>{fullNumber(point.deterministicCost, locale)}</td>
            <td>{bytes(point.peakMemoryBytes, locale)}</td><td><time dateTime={point.achievedAt}>{dateTime(point.achievedAt, locale)}</time></td><td>{point.isPareto ? "●" : "—"}</td>
          </tr>)}</tbody>
        </table>
      </div>

      <section className="performance-evolution" aria-labelledby="performance-evolution-title">
        <header><TrendingUp size={14} /><div><h3 id="performance-evolution-title">{chinese ? "我的演進" : "My evolution"}</h3><p>{chinese ? "依提交時間排序；錯誤仍保留為事件列。" : "Chronological by submission time; failed attempts remain visible as event rows."}</p></div></header>
        {response.context.myEvolutionTruncated && <div className="performance-history-note" role="status">{chinese
          ? "演進圖顯示最近 200 次提交；編號保留完整歷史序號。"
          : "Evolution shows the most recent 200 submissions; attempt numbers retain their full-history identity."}</div>}
        {response.myEvolution === null
          ? <div className="online-empty">{chinese ? "登入後即可查看自己的演進路徑與 policy ladder。" : "Sign in to see your evolution path and policy ladder."}</div>
          : response.myEvolution.length === 0
            ? <div className="online-empty">{chinese ? "你尚未對這題正式提交。" : "You have not officially submitted this problem yet."}</div>
            : <div className="performance-table-wrap"><table className="performance-table evolution-table">
              <caption>{chinese ? "我的提交時間序列" : "My submission timeline"}</caption>
              <thead><tr><th>#</th><th>{chinese ? "狀態" : "State"}</th><th>{chinese ? "語言" : "Language"}</th><th>{chinese ? "分數" : "Score"}</th><th>{chinese ? "成本" : "Cost"}</th><th>{chinese ? "記憶體" : "Memory"}</th><th>{chinese ? "時間" : "Time"}</th></tr></thead>
              <tbody>{response.myEvolution.map((point) => <tr className={`${point.state !== "completed" || !point.eligible ? "performance-event-error" : ""} ${!point.eligible ? "is-invalid" : ""} ${point.submissionId === selectedSubmissionId ? "is-selected" : ""}`} key={point.submissionId}>
                <td><button type="button" onClick={() => onSelect(point.submissionId)} aria-pressed={point.submissionId === selectedSubmissionId}>#{point.attemptNumber}</button></td>
                <td><strong>{statusLabel(point)}</strong></td><td>{languageLabel(point.language)}</td><td>{point.score === null ? "—" : fullNumber(point.score, locale)}</td>
                <td>{point.deterministicCost === null ? "—" : fullNumber(point.deterministicCost, locale)}</td><td>{point.peakMemoryBytes === null ? "—" : bytes(point.peakMemoryBytes, locale)}</td>
                <td><time dateTime={point.completedAt ?? point.createdAt}>{dateTime(point.completedAt ?? point.createdAt, locale)}</time></td>
              </tr>)}</tbody>
            </table></div>}
      </section>

      <section className="performance-policy-ladder" aria-labelledby="policy-ladder-title">
        <header><span>SELECTED RUN</span><h3 id="policy-ladder-title">{chinese ? "Baseline → Efficient → Optimal" : "Baseline → Efficient → Optimal"}</h3></header>
        {!selectedSubmissionId && <div className="online-empty">{chinese ? "選取圖上的一個提交來查看策略階梯。" : "Select a submission on the chart to inspect its policy ladder."}</div>}
        {selectedEvolution && !selectedEvolution.policySummaryAvailable && <div className="online-empty">{chinese ? "這個提交沒有可用的完成策略摘要。" : "This submission has no completed policy summary."}</div>}
        {policyUnavailable && <div className="online-empty">{chinese ? "你沒有權限讀取這個提交的策略摘要，或該摘要尚不可用。" : "This submission policy summary is not readable or is not available yet."}</div>}
        {policyLoading && <div className="online-empty" role="status">{chinese ? "載入策略摘要中…" : "Loading policy summary…"}</div>}
        {policyError && <div className="online-error" role="alert">{policyError}</div>}
        {policySummary && <SubmissionPolicySummaryContent response={policySummary} locale={locale} />}
      </section>
    </>}
  </section>;
}

function PerformanceLabController({
  problemId,
  contestId,
  locale,
  refreshKey,
}: {
  readonly problemId: string;
  readonly contestId?: string;
  readonly locale: ProblemLocale;
  readonly refreshKey?: string;
}) {
  const [language, setLanguage] = useState<BuiltinLanguage | "all">("all");
  const [loadState, setLoadState] = useState<PerformanceLoadState>();
  const [selectedSubmissionId, setSelectedSubmissionId] = useState<string>();
  const [policyState, setPolicyState] = useState<PolicyLoadState>();
  const requestKey = `${problemId}:${contestId ?? "practice"}:${language}:${refreshKey ?? "initial"}`;

  useEffect(() => {
    const controller = new AbortController();
    void wasmOjJson<unknown>(problemPerformanceApiPath(problemId, language, contestId), { signal: controller.signal })
      .then((value) => parseProblemPerformanceResponse(value, { problemId, contestId, language }))
      .then((response) => {
        if (controller.signal.aborted) return;
        setLoadState({ key: requestKey, response });
        const identifiers = new Set([
          ...response.frontier.map((point) => point.submissionId),
          ...(response.myEvolution ?? []).map((point) => point.submissionId),
        ]);
        setSelectedSubmissionId((current) => {
          if (current && identifiers.has(current)) return current;
          const evolution = response.myEvolution?.findLast((point) => point.policySummaryAvailable)
            ?? response.myEvolution?.findLast((point) => point.score !== null);
          return evolution?.submissionId ?? response.frontier[0]?.submissionId;
        });
      })
      .catch((reason: unknown) => {
        if (controller.signal.aborted) return;
        setLoadState({ key: requestKey, error: reason instanceof Error ? reason.message : String(reason) });
      });
    return () => controller.abort();
  }, [contestId, language, problemId, refreshKey, requestKey]);

  const current = loadState?.key === requestKey ? loadState : undefined;
  const response = current && "response" in current ? current.response : undefined;
  const selectedEvolution = response?.myEvolution?.find((point) => point.submissionId === selectedSubmissionId);
  const selectedEvolutionId = selectedEvolution?.submissionId;
  const selectedPolicyAvailable = selectedEvolution?.policySummaryAvailable;

  useEffect(() => {
    if (!selectedSubmissionId || (selectedEvolutionId && !selectedPolicyAvailable)) return;
    const controller = new AbortController();
    void loadPolicySummary(selectedSubmissionId, controller.signal)
      .then((policyResponse) => {
        if (controller.signal.aborted) return;
        setPolicyState(policyResponse
          ? { submissionId: selectedSubmissionId, response: policyResponse }
          : { submissionId: selectedSubmissionId, unavailable: true });
      })
      .catch((reason: unknown) => {
        if (!controller.signal.aborted) setPolicyState({ submissionId: selectedSubmissionId, error: reason instanceof Error ? reason.message : String(reason) });
      });
    return () => controller.abort();
  }, [selectedEvolutionId, selectedPolicyAvailable, selectedSubmissionId]);

  const policyExpected = Boolean(selectedSubmissionId && (!selectedEvolutionId || selectedPolicyAvailable));
  const currentPolicy = policyExpected && policyState?.submissionId === selectedSubmissionId ? policyState : undefined;

  return <PerformanceLabView
    locale={locale}
    language={language}
    response={response}
    loading={!current}
    error={current && "error" in current ? current.error : undefined}
    selectedSubmissionId={selectedSubmissionId}
    policySummary={currentPolicy && "response" in currentPolicy ? currentPolicy.response : undefined}
    policyLoading={policyExpected && !currentPolicy}
    policyUnavailable={Boolean(currentPolicy && "unavailable" in currentPolicy)}
    policyError={currentPolicy && "error" in currentPolicy ? currentPolicy.error : undefined}
    onLanguageChange={setLanguage}
    onSelect={setSelectedSubmissionId}
  />;
}

export function PerformanceLab(props: {
  readonly problemId: string;
  readonly contestId?: string;
  readonly locale: ProblemLocale;
  readonly refreshKey?: string;
}) {
  const identity = performanceLabIdentity(props.problemId, props.contestId);
  return <PerformanceLabController key={identity} {...props} />;
}

export function performanceLabIdentity(problemId: string, contestId?: string): string {
  return `${problemId}:${contestId ?? "practice"}`;
}
