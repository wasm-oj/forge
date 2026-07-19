import type { CSSProperties } from "react";
import type { JudgeUiCaseResult } from "@/src/judge/judge";
import type {
  JudgeProblem,
  ProblemLocale,
  ProblemScoringPolicy,
} from "@/src/judge/problems";

interface ResourceThreshold {
  id: string;
  label: string;
  points: number;
  value: number;
}

function formatInteger(value: number, locale: ProblemLocale): string {
  return value.toLocaleString(locale === "zh-TW" ? "zh-TW" : "en-US");
}

function formatBytes(bytes: number, locale: ProblemLocale): string {
  const units = ["B", "KiB", "MiB", "GiB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const digits = unit === 0 || value >= 100 ? 0 : value >= 10 ? 1 : 2;
  return `${value.toLocaleString(locale === "zh-TW" ? "zh-TW" : "en-US", {
    maximumFractionDigits: digits,
  })} ${units[unit]}`;
}

function formatMilliseconds(nanoseconds: number, locale: ProblemLocale): string {
  return `${(nanoseconds / 1_000_000).toLocaleString(locale === "zh-TW" ? "zh-TW" : "en-US", {
    maximumFractionDigits: 3,
  })} ms`;
}

function axisPosition(value: number, maximum: number, logarithmic: boolean): number {
  if (maximum <= 0) return 0;
  const ratio = logarithmic
    ? Math.log1p(value) / Math.log1p(maximum)
    : value / maximum;
  return Math.max(0, Math.min(100, ratio * 100));
}

function positionStyle(position: number): CSSProperties {
  return { "--axis-position": `${position}%` } as CSSProperties;
}

function ResourceAxis({
  title,
  value,
  thresholds,
  locale,
  format,
  logarithmic = false,
}: {
  title: string;
  value: number | null;
  thresholds: readonly ResourceThreshold[];
  locale: ProblemLocale;
  format(value: number, locale: ProblemLocale): string;
  logarithmic?: boolean;
}) {
  const largestThreshold = Math.max(...thresholds.map((threshold) => threshold.value));
  const domainMaximum = Math.max(largestThreshold, value ?? 0) * 1.06;
  const markerGroups = [...thresholds.reduce((groups, threshold) => {
    const group = groups.get(threshold.value) ?? {
      ids: [] as string[],
      labels: [] as string[],
      points: [] as number[],
      value: threshold.value,
    };
    group.ids.push(threshold.id);
    group.labels.push(threshold.label);
    group.points.push(threshold.points);
    groups.set(threshold.value, group);
    return groups;
  }, new Map<number, { ids: string[]; labels: string[]; points: number[]; value: number }>()).values()];
  return (
    <div className="score-axis">
      <div className="score-axis-heading">
        <strong>{title}</strong>
        <span>
          {value === null ? (locale === "zh-TW" ? "無可用資料" : "Unavailable") : format(value, locale)}
          {logarithmic ? (locale === "zh-TW" ? " · 對數刻度" : " · log scale") : ""}
        </span>
      </div>
      <div className="score-axis-track" aria-hidden="true">
        {markerGroups.map((group) => (
          <span
            className="score-axis-threshold"
            style={positionStyle(axisPosition(group.value, domainMaximum, logarithmic))}
            title={`${group.labels.join(" + ")}: ${format(group.value, locale)}`}
            key={group.ids.join("+")}
          >
            <i />
            <b>{group.points.map((points) => `+${points}`).join("/")}</b>
          </span>
        ))}
        {value !== null && (
          <span
            className="score-axis-actual"
            style={positionStyle(axisPosition(value, domainMaximum, logarithmic))}
            title={`${locale === "zh-TW" ? "實際用量" : "Actual usage"}: ${format(value, locale)}`}
          >
            <i />
            <b>{locale === "zh-TW" ? "實際" : "actual"}</b>
          </span>
        )}
      </div>
      <div className="score-axis-limits">
        {thresholds.map((threshold) => (
          <span key={threshold.id}>
            <i />{threshold.label} ≤ {format(threshold.value, locale)}
          </span>
        ))}
      </div>
    </div>
  );
}

function policyFailure(
  policy: ProblemScoringPolicy,
  testCase: JudgeUiCaseResult,
  locale: ProblemLocale,
): string {
  const evaluation = testCase.policyEvaluations?.find((candidate) => candidate.id === policy.id);
  if (!evaluation) return locale === "zh-TW" ? "沒有計分資料" : "No scoring data";
  if (evaluation.earned) return locale === "zh-TW" ? "已取得" : "Earned";
  if (!testCase.metrics) {
    return !testCase.outputAccepted
      ? (locale === "zh-TW" ? "metrics 不可用 · 輸出未通過" : "metrics unavailable · output failed")
      : (locale === "zh-TW" ? "metrics 不可用" : "metrics unavailable");
  }
  const reasons: string[] = [];
  if (testCase.metrics.cost === null) {
    reasons.push(locale === "zh-TW" ? "cost 不可用" : "cost unavailable");
  } else if (!evaluation.costPassed) {
    reasons.push(locale === "zh-TW" ? "cost 超標" : "cost over");
  }
  if (testCase.metrics.memoryBytes === null) {
    reasons.push(locale === "zh-TW" ? "memory 不可用" : "memory unavailable");
  } else if (!evaluation.memoryPassed) {
    reasons.push(locale === "zh-TW" ? "memory 超標" : "memory over");
  }
  if (evaluation.logicalTimePassed === false) {
    reasons.push(testCase.metrics.logicalTimeNs === null
      ? (locale === "zh-TW" ? "logical time 不可用" : "logical time unavailable")
      : (locale === "zh-TW" ? "logical time 超標" : "logical time over"));
  }
  if (!testCase.outputAccepted) reasons.push(locale === "zh-TW" ? "輸出未通過" : "output failed");
  return [...new Set(reasons)].join(" · ");
}

function nextThresholdMessage(
  problem: JudgeProblem,
  testCase: JudgeUiCaseResult,
  locale: ProblemLocale,
): string {
  if (!testCase.outputAccepted) {
    return locale === "zh-TW"
      ? "輸出必須先完全正確，資源 policy 才會給分。"
      : "Output must be correct before any resource policy awards points.";
  }
  const nextPolicy = problem.scoring.policies.find((policy) => (
    !testCase.policyEvaluations?.find((evaluation) => evaluation.id === policy.id)?.earned
  ));
  if (!nextPolicy) {
    return locale === "zh-TW"
      ? "這個 case 已通過所有 policy，取得滿分。"
      : "This case passes every policy and earns full points.";
  }
  if (!testCase.metrics) {
    return locale === "zh-TW" ? "沒有足夠 metrics 計算下一個門檻。" : "Metrics are unavailable for the next threshold.";
  }
  const gaps: string[] = [];
  if (testCase.metrics.cost !== null && testCase.metrics.cost > nextPolicy.limits.instructionBudget) {
    gaps.push(`${locale === "zh-TW" ? "cost 再降低" : "reduce cost by"} ${formatInteger(
      testCase.metrics.cost - nextPolicy.limits.instructionBudget,
      locale,
    )}`);
  }
  if (
    testCase.metrics.memoryBytes !== null
    && testCase.metrics.memoryBytes > nextPolicy.limits.memoryLimitBytes
  ) {
    gaps.push(`${locale === "zh-TW" ? "memory 再降低" : "reduce memory by"} ${formatBytes(
      testCase.metrics.memoryBytes - nextPolicy.limits.memoryLimitBytes,
      locale,
    )}`);
  }
  if (
    nextPolicy.limits.logicalTimeLimitMs !== undefined
    && testCase.metrics.logicalTimeNs !== null
    && testCase.metrics.logicalTimeNs > nextPolicy.limits.logicalTimeLimitMs * 1_000_000
  ) {
    gaps.push(`${locale === "zh-TW" ? "logical time 再降低" : "reduce logical time by"} ${formatMilliseconds(
      testCase.metrics.logicalTimeNs - nextPolicy.limits.logicalTimeLimitMs * 1_000_000,
      locale,
    )}`);
  }
  const title = nextPolicy.title[locale];
  return gaps.length > 0
    ? `${locale === "zh-TW" ? `距「${title}」` : `To reach “${title}”`}: ${gaps.join(locale === "zh-TW" ? "、" : "; ")}.`
    : locale === "zh-TW"
      ? `「${title}」尚未通過；請查看下方各項狀態。`
      : `“${title}” is not yet satisfied; inspect the checks below.`;
}

export function CaseScoreDetails({
  problem,
  testCase,
  locale,
}: {
  problem: JudgeProblem;
  testCase: JudgeUiCaseResult;
  locale: ProblemLocale;
}) {
  const metrics = testCase.metrics;
  const costThresholds = problem.scoring.policies.map((policy) => ({
    id: policy.id,
    label: policy.title[locale],
    points: policy.points,
    value: policy.limits.instructionBudget,
  }));
  const memoryThresholds = problem.scoring.policies.map((policy) => ({
    id: policy.id,
    label: policy.title[locale],
    points: policy.points,
    value: policy.limits.memoryLimitBytes,
  }));
  return (
    <section className="case-score-details" aria-label={locale === "zh-TW" ? "Case 計分細節" : "Case scoring details"}>
      <header>
        <div>
          <strong>Case {String(testCase.number).padStart(2, "0")}</strong>
          <span>{locale === "zh-TW" ? "計分細節" : "scoring details"}</span>
        </div>
        <b>{testCase.points ?? 0} / {problem.scoring.maximumPoints} pts</b>
      </header>
      <p className="next-threshold-message">{nextThresholdMessage(problem, testCase, locale)}</p>
      <div className="case-metric-cards">
        <div>
          <span>{locale === "zh-TW" ? "Net instruction cost" : "Net instruction cost"}</span>
          <strong>{metrics?.cost === null || metrics?.cost === undefined ? "—" : formatInteger(metrics.cost, locale)}</strong>
          <small>
            {metrics?.rawCost === null || metrics?.rawCost === undefined
              ? (locale === "zh-TW" ? "raw cost 不可用" : "raw cost unavailable")
              : `raw ${formatInteger(metrics.rawCost, locale)} − baseline ${formatInteger(metrics.baselineCost, locale)}`}
          </small>
        </div>
        <div>
          <span>{locale === "zh-TW" ? "Peak linear memory" : "Peak linear memory"}</span>
          <strong>{metrics?.memoryBytes === null || metrics?.memoryBytes === undefined ? "—" : formatBytes(metrics.memoryBytes, locale)}</strong>
          <small>{locale === "zh-TW" ? "runtime 回報的峰值" : "runtime-reported peak"}</small>
        </div>
        {metrics?.logicalTimeNs !== null && metrics?.logicalTimeNs !== undefined && (
          <div>
            <span>Logical time</span>
            <strong>{formatMilliseconds(metrics.logicalTimeNs, locale)}</strong>
            <small>{locale === "zh-TW" ? "deterministic virtual time" : "deterministic virtual time"}</small>
          </div>
        )}
      </div>
      <div className="case-score-axes">
        <ResourceAxis
          title={locale === "zh-TW" ? "Instruction cost 門檻" : "Instruction cost thresholds"}
          value={metrics?.cost ?? null}
          thresholds={costThresholds}
          locale={locale}
          format={formatInteger}
          logarithmic
        />
        <ResourceAxis
          title={locale === "zh-TW" ? "Memory 門檻" : "Memory thresholds"}
          value={metrics?.memoryBytes ?? null}
          thresholds={memoryThresholds}
          locale={locale}
          format={formatBytes}
        />
      </div>
      <div className="case-policy-results">
        {problem.scoring.policies.map((policy) => {
          const evaluation = testCase.policyEvaluations?.find((candidate) => candidate.id === policy.id);
          return (
            <div className={evaluation?.earned ? "earned" : "missed"} key={policy.id}>
              <strong>{evaluation?.earned ? "✓" : "×"} +{policy.points} · {policy.title[locale]}</strong>
              <span>{policyFailure(policy, testCase, locale)}</span>
            </div>
          );
        })}
      </div>
    </section>
  );
}
