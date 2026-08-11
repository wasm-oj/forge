export const CANCEL_NONTERMINAL_SUBMISSION_SQL =
  "UPDATE submissions SET state='cancelled', updated_at=?, completed_at=COALESCE(completed_at, ?) WHERE id=? AND state NOT IN ('completed','compile-error','judge-error','infrastructure-error','cancelled')";

export const CANCEL_OWNED_NONTERMINAL_SUBMISSION_SQL =
  "UPDATE submissions SET state='cancelled', updated_at=?, completed_at=COALESCE(completed_at, ?) WHERE id=? AND user_id=? AND state NOT IN ('completed','compile-error','judge-error','infrastructure-error','cancelled')";

export const CANCEL_ACTIVE_SUBMISSION_ATTEMPTS_SQL =
  "UPDATE submission_attempts SET state='cancelled', finished_at=COALESCE(finished_at, ?) WHERE submission_id=? AND state IN ('created','running') AND EXISTS (SELECT 1 FROM submissions WHERE id=? AND state='cancelled')";

export const SETTLE_CANCELLED_SUBMISSION_OUTBOX_SQL =
  "UPDATE outbox SET delivered_at=COALESCE(delivered_at, ?), payload_json='{}', last_error=CASE WHEN delivered_at IS NULL THEN ? ELSE last_error END WHERE aggregate_id=? AND kind='start-submission-workflow' AND EXISTS (SELECT 1 FROM submissions WHERE id=? AND state='cancelled')";
