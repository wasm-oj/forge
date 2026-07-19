import { FORGE_CONTRACT_ID } from "../core/contract";

export const JUDGE_ONBOARDING_STORAGE_KEY = `${FORGE_CONTRACT_ID}:judge-onboarding:v1`;
const JUDGE_ONBOARDING_COMPLETED = "completed";

export function isJudgeOnboardingComplete(storage: Pick<Storage, "getItem">): boolean {
  return storage.getItem(JUDGE_ONBOARDING_STORAGE_KEY) === JUDGE_ONBOARDING_COMPLETED;
}

export function completeJudgeOnboarding(storage: Pick<Storage, "setItem">): void {
  storage.setItem(JUDGE_ONBOARDING_STORAGE_KEY, JUDGE_ONBOARDING_COMPLETED);
}
