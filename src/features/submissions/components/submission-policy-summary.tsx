import type { ProblemLocale } from "../../../judge/problem-model";
import type { SubmissionPolicySummaryResponse } from "../../judge/model/performance-contract";

export function SubmissionPolicySummaryContent({ response, locale }: {
  readonly response: SubmissionPolicySummaryResponse;
  readonly locale: ProblemLocale;
}) {
  const chinese = locale === "zh-TW";
  const { policySummary } = response;
  return <>
    <p>{chinese
      ? `輸出正確 ${policySummary.outputAcceptedCases} / ${policySummary.totalCases} 筆測資；逐層顯示未通過的資源門檻。`
      : `${policySummary.outputAcceptedCases} / ${policySummary.totalCases} cases produced accepted output; each level shows resource-gate misses.`}</p>
    <div className="performance-policy-grid">
      {policySummary.policies.map((policy, index) => <article key={policy.id} className={index === 2 ? "is-optimal" : ""}>
        <span>0{index + 1}</span>
        <h4>{policy.id}</h4>
        <strong>{policy.earnedCases} / {policySummary.totalCases}</strong>
        <progress value={policy.earnedCases} max={Math.max(1, policySummary.totalCases)} aria-label={`${policy.id}: ${policy.earnedCases} / ${policySummary.totalCases}`} />
        <dl>
          <div><dt>{chinese ? "成本" : "Cost"}</dt><dd>{policy.costExceededCases}</dd></div>
          <div><dt>{chinese ? "記憶體" : "Memory"}</dt><dd>{policy.memoryExceededCases}</dd></div>
          <div><dt>{chinese ? "邏輯時間" : "Logical time"}</dt><dd>{policy.logicalTimeExceededCases}</dd></div>
        </dl>
      </article>)}
    </div>
  </>;
}
