const TERMINAL_SUBMISSION_STATES = "'completed','compile-error','judge-error','infrastructure-error','cancelled'";

/**
 * Records the authoritative logical completion instant for `judge-terminal`
 * contests. The statements are deliberately returned as one ordered D1 batch:
 * evidence is frozen first, a close-boundary violation is then invalidated,
 * and Prompt Program provenance mirrors the final eligibility fact.
 */
export function prepareJudgeTerminalEvidenceUpdates(
  database: D1Database,
  submissionId: string,
  terminalAt: string,
): readonly D1PreparedStatement[] {
  const recordEvidence = database.prepare(`UPDATE contest_submission_records AS record
    SET evidence_logical_seconds=(SELECT CAST(MIN(rule_revision.duration_seconds,
        CASE WHEN rule_revision.clock_kind='global'
          THEN runtime.logical_anchor_seconds + CASE WHEN runtime.state='running'
            THEN CAST(MAX(0, ROUND((julianday(?) - julianday(runtime.wall_anchor_at))*86400000))/1000 AS INTEGER)
            ELSE 0 END
          ELSE entrant.individual_logical_anchor_seconds + CASE WHEN runtime.state='running'
            THEN CAST(MAX(0, ROUND((julianday(?) - julianday(entrant.individual_wall_anchor_at))*86400000))/1000 AS INTEGER)
            ELSE 0 END
        END) AS INTEGER)
      FROM contest_runtimes AS runtime
      JOIN contest_rule_epochs AS rule_epoch
        ON rule_epoch.contest_id=record.contest_id
       AND rule_epoch.rules_epoch=record.rules_epoch
      JOIN contest_rule_revisions AS rule_revision
        ON rule_revision.contest_id=rule_epoch.contest_id
       AND rule_revision.rules_commit=rule_epoch.rules_commit
       AND rule_revision.rules_sha256=rule_epoch.rules_sha256
      JOIN contest_entrants AS entrant
        ON entrant.id=record.entrant_id AND entrant.contest_id=runtime.contest_id
      WHERE runtime.contest_id=record.contest_id)
    WHERE record.submission_id=?
      AND record.evidence_at='judge-terminal' AND record.evidence_logical_seconds IS NULL
      AND record.eligibility='eligible'
      AND EXISTS (SELECT 1 FROM submissions WHERE id=record.submission_id
        AND state IN (${TERMINAL_SUBMISSION_STATES}))`)
    .bind(terminalAt, terminalAt, submissionId);
  const closeInvalidation = database.prepare(`UPDATE contest_submission_records AS record
    SET eligibility='invalid', invalidated_at=?,
        invalidation_reason='judge-terminal-after-close'
    WHERE record.submission_id=? AND record.evidence_at='judge-terminal'
      AND record.evidence_logical_seconds IS NOT NULL AND record.eligibility='eligible'
      AND EXISTS (SELECT 1
        FROM contest_rule_epochs AS rule_epoch
        JOIN contest_rule_problems AS problem
          ON problem.contest_id=rule_epoch.contest_id
         AND problem.rules_commit=rule_epoch.rules_commit
        JOIN submissions AS origin
          ON origin.id=record.submission_id AND origin.problem_id=problem.problem_id
        WHERE rule_epoch.contest_id=record.contest_id
          AND rule_epoch.rules_epoch=record.rules_epoch
          AND record.evidence_logical_seconds>=problem.submission_closes_after_seconds)`)
    .bind(terminalAt, submissionId);
  const promptProvenance = database.prepare(`UPDATE prompt_attempts AS attempt
    SET evidence_logical_seconds=record.evidence_logical_seconds,
        eligibility=record.eligibility,
        invalidated_at=CASE WHEN record.eligibility='invalid'
          THEN COALESCE(attempt.invalidated_at, record.invalidated_at) ELSE attempt.invalidated_at END,
        invalidation_reason=CASE WHEN record.eligibility='invalid'
          THEN COALESCE(attempt.invalidation_reason, record.invalidation_reason) ELSE attempt.invalidation_reason END,
        updated_at=?
    FROM contest_submission_records AS record
    WHERE attempt.submission_id=? AND record.submission_id=attempt.submission_id
      AND attempt.evidence_logical_seconds IS NULL`)
    .bind(terminalAt, submissionId);
  return [recordEvidence, closeInvalidation, promptProvenance];
}
