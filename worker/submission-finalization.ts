export const FINALIZE_SUBMISSION_SQL = "UPDATE submissions SET state=?, verdict=?, score=?, fully_passed_cases=?, deterministic_cost=?, peak_memory_bytes=?, policy_summary_json=?, effective_attempt=?, updated_at=?, completed_at=? WHERE id=? AND state NOT IN ('completed','compile-error','judge-error','infrastructure-error','cancelled') AND ?=(SELECT MAX(attempt) FROM submission_attempts WHERE submission_id=?) AND EXISTS (SELECT 1 FROM submission_attempts WHERE submission_id=? AND attempt=? AND state='running' AND token_hash=?)";

export const FINALIZE_SUBMISSION_ATTEMPT_SQL = "UPDATE submission_attempts SET state='succeeded', finished_at=? WHERE submission_id=? AND attempt=? AND state='running' AND token_hash=? AND EXISTS (SELECT 1 FROM submissions WHERE id=? AND effective_attempt=? AND state=?)";

export interface FinalizedSubmissionAttemptRecord {
  readonly state: string;
  readonly verdict: string | null;
  readonly score: number | null;
  readonly fully_passed_cases: number | null;
  readonly deterministic_cost: number | null;
  readonly peak_memory_bytes: number | null;
  readonly policy_summary_json: string | null;
  readonly effective_attempt: number | null;
  readonly attempt_state: string;
  readonly token_hash: string;
}

export function finalizedSubmissionAttemptMatches(
  record: FinalizedSubmissionAttemptRecord | null,
  expected: {
    readonly state: string;
    readonly verdict: string;
    readonly score: number;
    readonly fullyPassedCases: number;
    readonly deterministicCost: number | null;
    readonly peakMemoryBytes: number | null;
    readonly policySummaryJson: string | null;
    readonly attempt: number;
    readonly tokenHash: string;
  },
): boolean {
  return record?.state === expected.state
    && record.verdict === expected.verdict
    && record.score === expected.score
    && record.fully_passed_cases === expected.fullyPassedCases
    && record.deterministic_cost === expected.deterministicCost
    && record.peak_memory_bytes === expected.peakMemoryBytes
    && record.policy_summary_json === expected.policySummaryJson
    && record.effective_attempt === expected.attempt
    && record.attempt_state === "succeeded"
    && record.token_hash === expected.tokenHash;
}
