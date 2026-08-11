export const FORMAL_RISK_ALLOWANCE_MS = 15 * 60 * 1_000;
export const FORMAL_RISK_VELOCITY_THRESHOLD = 5;
export const FORMAL_RISK_FAILURE_THRESHOLD = 3;
export const FORMAL_RISK_COST_THRESHOLD = 20_000_000_000;

export interface FormalRiskSignals {
  readonly priorSubmissionCount: number;
  readonly recentSubmissionCount: number;
  readonly recentFailureCount: number;
  readonly recentDeterministicCost: number;
}

function safeCount(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`${label} must be a non-negative safe integer.`);
  return value;
}

export function formalRiskRequiresTurnstile(signals: FormalRiskSignals): boolean {
  const priorSubmissionCount = safeCount(signals.priorSubmissionCount, "priorSubmissionCount");
  const recentSubmissionCount = safeCount(signals.recentSubmissionCount, "recentSubmissionCount");
  const recentFailureCount = safeCount(signals.recentFailureCount, "recentFailureCount");
  const recentDeterministicCost = safeCount(signals.recentDeterministicCost, "recentDeterministicCost");
  return priorSubmissionCount === 0
    || recentSubmissionCount >= FORMAL_RISK_VELOCITY_THRESHOLD
    || recentFailureCount >= FORMAL_RISK_FAILURE_THRESHOLD
    || recentDeterministicCost >= FORMAL_RISK_COST_THRESHOLD;
}
