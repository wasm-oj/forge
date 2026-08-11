import type { ForgeWorkerEnv } from "./env";

const AUDIT_KEY = /^audits\/([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\/([1-9][0-9]*)\.([0-9a-f]{64})\.json$/;

export async function deleteMirroredAttemptAudit(
  env: Pick<ForgeWorkerEnv, "JUDGE_BUCKET" | "JUDGE_MIRROR_BUCKET">,
  input: { readonly submissionId: string; readonly attempt: number; readonly auditR2Key: string },
): Promise<void> {
  const match = AUDIT_KEY.exec(input.auditR2Key);
  if (
    match?.[1] !== input.submissionId
    || Number(match[2]) !== input.attempt
    || !Number.isSafeInteger(input.attempt)
    || input.attempt < 1
  ) throw new Error("Submission audit key is not bound to its durable attempt.");
  const deleted = await Promise.allSettled([
    env.JUDGE_BUCKET.delete(input.auditR2Key),
    env.JUDGE_MIRROR_BUCKET.delete(input.auditR2Key),
  ]);
  const failures = deleted.filter((result): result is PromiseRejectedResult => result.status === "rejected");
  if (failures.length > 0) throw new AggregateError(
    failures.map((failure) => failure.reason),
    "Submission audit deletion was only partially applied.",
  );
  const [primary, mirror] = await Promise.all([
    env.JUDGE_BUCKET.head(input.auditR2Key),
    env.JUDGE_MIRROR_BUCKET.head(input.auditR2Key),
  ]);
  if (primary || mirror) throw new Error("Submission audit deletion postcondition failed.");
}
