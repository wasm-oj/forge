import { createHash } from "node:crypto";

const MAX_REVISIONS_PER_CONTEST = 1_000;
const MAX_PROBLEMS_PER_REVISION = 100;
const LEGACY_ATTEMPT_LIMIT = 1_000_000;
const READ_PAGE_SIZE = 250;
const TERMINAL_SUBMISSION_STATES = new Set([
  "completed", "compile-error", "judge-error", "infrastructure-error", "cancelled",
]);
const SHA1 = /^[0-9a-f]{40}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

function canonicalJson(value) {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("Contest cutover JSON contains a non-finite number.");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object") {
    const entries = Object.keys(value).sort().map((key) => {
      if (value[key] === undefined) throw new TypeError("Contest cutover JSON contains undefined.");
      return `${JSON.stringify(key)}:${canonicalJson(value[key])}`;
    });
    return `{${entries.join(",")}}`;
  }
  throw new TypeError("Contest cutover value is not JSON.");
}

function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}

function utf8Bytes(value) {
  return new TextEncoder().encode(value).byteLength;
}

function requiredString(value, label, maximumBytes) {
  if (typeof value !== "string" || utf8Bytes(value) > maximumBytes) {
    throw new TypeError(`${label} is invalid.`);
  }
  return value;
}

function instant(value, label) {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) throw new TypeError(`${label} is invalid.`);
  return new Date(value).toISOString();
}

function sql(value) {
  if (value === null) return "NULL";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("Cannot encode a non-finite SQL number.");
    return String(value);
  }
  if (typeof value !== "string") throw new TypeError("Cannot encode a non-scalar SQL value.");
  return `'${value.replaceAll("'", "''")}'`;
}

function deterministicEntrantId(contestId, userId) {
  if (!UUID.test(contestId) || !UUID.test(userId)) throw new TypeError("Legacy contest identity is invalid.");
  const value = digest(`wasm-oj-contest-v1-entrant\0${contestId}\0${userId}`).slice(0, 32).split("");
  value[12] = "8";
  value[16] = "a";
  const hex = value.join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function classicRules(revision, problems) {
  const startsAt = instant(revision.starts_at, "legacy contest starts_at");
  const endsAt = instant(revision.ends_at, "legacy contest ends_at");
  const durationMilliseconds = Date.parse(endsAt) - Date.parse(startsAt);
  if (durationMilliseconds <= 0 || durationMilliseconds % 1_000 !== 0) {
    throw new TypeError("Legacy contest duration is not representable as whole logical seconds.");
  }
  const durationSeconds = durationMilliseconds / 1_000;
  if (durationSeconds > 31_622_400) throw new TypeError("Legacy contest duration exceeds the v2 limit.");
  const createdAt = instant(revision.created_at, "legacy contest created_at");
  const registrationOpensAt = new Date(Math.min(Date.parse(createdAt), Date.parse(startsAt))).toISOString();
  const freezeAt = revision.freeze_at === null ? null : instant(revision.freeze_at, "legacy contest freeze_at");
  let leaderboard = { kind: "live" };
  if (freezeAt !== null) {
    const offsetMilliseconds = Date.parse(freezeAt) - Date.parse(startsAt);
    if (offsetMilliseconds % 1_000 !== 0) throw new TypeError("Legacy freeze is not representable as whole logical seconds.");
    const atSeconds = offsetMilliseconds / 1_000;
    if (!Number.isSafeInteger(atSeconds) || atSeconds < 1 || atSeconds >= durationSeconds) {
      throw new TypeError("Legacy freeze is outside the contest logical duration.");
    }
    leaderboard = { kind: "freeze", atSeconds };
  }
  if (problems.length < 1 || problems.length > MAX_PROBLEMS_PER_REVISION) {
    throw new TypeError("Legacy contest problem count is outside the v2 limit.");
  }
  return {
    clock: {
      kind: "global",
      registrationOpensAt,
      registrationClosesAt: endsAt,
      startsAt,
      durationSeconds,
    },
    officialTrack: { kind: "code", aiAssist: "allowed" },
    evidenceAt: "judge-terminal",
    problems: problems.map((problem, index) => ({
      slug: requiredString(problem.slug, "legacy problem slug", 128),
      batch: Math.floor(index / 8) + 1,
      releaseAfterSeconds: 0,
      submissionClosesAfterSeconds: durationSeconds,
      points: 100,
      attemptLimit: LEGACY_ATTEMPT_LIMIT,
    })),
    scoring: {
      kind: "score",
      tieBreaks: [
        "fully-passed-cases",
        "deterministic-cost",
        "peak-memory",
        "final-best-achieved-at",
      ],
    },
    checkpoints: [],
    leaderboard,
  };
}

function revisionProjection(revision, problems) {
  if (!SHA1.test(revision.commit_sha)) throw new TypeError("Legacy contest commit is invalid.");
  if (!["draft", "published", "archived"].includes(revision.status)) throw new TypeError("Legacy contest status is invalid.");
  if (!["public", "invite"].includes(revision.access_mode)) throw new TypeError("Legacy contest access mode is invalid.");
  const rules = classicRules(revision, problems);
  const rulesJson = canonicalJson(rules);
  return {
    ...revision,
    title: requiredString(revision.title, "legacy contest title", 4_096),
    description: requiredString(revision.description, "legacy contest description", 65_536),
    rules,
    rulesJson,
    rulesSha256: digest(rulesJson),
    activationSha256: digest(canonicalJson({
      accessMode: revision.access_mode,
      rules,
      status: revision.status,
    })),
    durationSeconds: rules.clock.durationSeconds,
    registrationOpensAt: rules.clock.registrationOpensAt,
    registrationClosesAt: rules.clock.registrationClosesAt,
    startsAt: rules.clock.startsAt,
    leaderboardKind: rules.leaderboard.kind,
    freezeAfterSeconds: rules.leaderboard.kind === "freeze" ? rules.leaderboard.atSeconds : null,
  };
}

async function boundedRows(adapter, query, maximum, label) {
  const rows = await adapter.query(`${query}\nLIMIT ${maximum + 1}`);
  if (!Array.isArray(rows) || rows.length > maximum) throw new TypeError(`${label} exceeds its cutover bound.`);
  return rows;
}

async function keysetRows(adapter, queryPage, key, maximum, label) {
  const collected = [];
  let cursor = null;
  for (;;) {
    const page = await adapter.query(queryPage(cursor, READ_PAGE_SIZE));
    if (!Array.isArray(page) || page.length > READ_PAGE_SIZE) throw new TypeError(`${label} page is invalid.`);
    for (const row of page) {
      const value = row?.[key];
      if (typeof value !== "string" || (cursor !== null && value <= cursor)) {
        throw new TypeError(`${label} keyset order is invalid.`);
      }
      cursor = value;
      collected.push(row);
      if (collected.length > maximum) throw new TypeError(`${label} exceeds its cutover bound.`);
    }
    if (page.length < READ_PAGE_SIZE) return collected;
  }
}

function insertRuleRevision(contestId, revision) {
  return `INSERT INTO contest_rule_revisions (
    contest_id, rules_commit, status, title, description, access_mode,
    rules_json, rules_sha256, activation_sha256,
    clock_kind, registration_opens_at, registration_closes_at, global_starts_at,
    duration_seconds, official_track, evidence_at, ai_assist,
    prompt_compiler_config_id, prompt_compiler_config_sha256,
    prompt_max_bytes, prompt_input_tokens, prompt_output_tokens,
    prompt_generated_source_bytes, prompt_timeout_seconds, prompt_disclosure,
    scoring_kind, leaderboard_kind, leaderboard_freeze_after_seconds, created_at
  ) VALUES (
    ${sql(contestId)}, ${sql(revision.commit_sha)}, ${sql(revision.status)},
    ${sql(revision.title)}, ${sql(revision.description)}, ${sql(revision.access_mode)},
    ${sql(revision.rulesJson)}, ${sql(revision.rulesSha256)}, ${sql(revision.activationSha256)},
    'global', ${sql(revision.registrationOpensAt)}, ${sql(revision.registrationClosesAt)},
    ${sql(revision.startsAt)}, ${revision.durationSeconds}, 'code', 'judge-terminal', 'allowed',
    NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
    'score', ${sql(revision.leaderboardKind)}, ${sql(revision.freezeAfterSeconds)}, ${sql(revision.created_at)}
  ) ON CONFLICT(contest_id, rules_commit) DO NOTHING`;
}

function insertRuleProblem(contestId, revision, problem, index) {
  const rule = revision.rules.problems[index];
  return `INSERT INTO contest_rule_problems (
    contest_id, rules_commit, problem_id, ordinal, batch,
    release_after_seconds, submission_closes_after_seconds, points, attempt_limit,
    output_language, output_target, output_optimization, output_entry_path, problem_rules_json
  ) VALUES (
    ${sql(contestId)}, ${sql(revision.commit_sha)}, ${sql(problem.problem_id)}, ${index + 1},
    ${rule.batch}, 0, ${revision.durationSeconds}, 100, ${LEGACY_ATTEMPT_LIMIT},
    NULL, NULL, NULL, NULL, ${sql(canonicalJson(rule))}
  ) ON CONFLICT(contest_id, rules_commit, problem_id) DO NOTHING`;
}

function runtimeState(active, now) {
  const endedByTime = Date.parse(active.rules.clock.startsAt) + active.durationSeconds * 1_000 <= Date.parse(now);
  if (active.status !== "archived" && !endedByTime) {
    return { state: "scheduled", logicalSeconds: 0, firstStartedAt: null, endedAt: null };
  }
  const archivedBeforeStart = active.status === "archived" && Date.parse(now) < Date.parse(active.rules.clock.startsAt);
  return {
    state: "ended",
    logicalSeconds: archivedBeforeStart ? 0 : active.durationSeconds,
    firstStartedAt: archivedBeforeStart ? null : active.rules.clock.startsAt,
    endedAt: endedByTime ? active.rules.clock.registrationClosesAt : now,
  };
}

function clampLogical(timestamp, startsAt, durationSeconds, label) {
  const value = instant(timestamp, label);
  return Math.max(0, Math.min(durationSeconds, Math.floor((Date.parse(value) - Date.parse(startsAt)) / 1_000)));
}

async function translateContest(adapter, contestId, now) {
  if (!UUID.test(contestId)) throw new TypeError("Legacy contest id is invalid.");
  const authorityRows = await adapter.query(`SELECT series.id AS contest_id,
      catalogs.organizer_user_id, catalogs.active_commit_sha
    FROM contest_series AS series
    JOIN catalogs ON catalogs.id=series.catalog_id
    WHERE series.id=${sql(contestId)}`);
  if (authorityRows.length !== 1 || !UUID.test(authorityRows[0].organizer_user_id)
    || !SHA1.test(authorityRows[0].active_commit_sha)) {
    throw new TypeError("Legacy contest has no exact active catalog authority.");
  }
  const revisions = await keysetRows(adapter, (cursor, limit) => `SELECT contest_id, commit_sha,
      status, title, description, access_mode, starts_at, ends_at, freeze_at, created_at
    FROM contest_revisions WHERE contest_id=${sql(contestId)}
      ${cursor === null ? "" : `AND commit_sha>${sql(cursor)}`}
    ORDER BY commit_sha LIMIT ${limit}`, "commit_sha", MAX_REVISIONS_PER_CONTEST, "Legacy contest revisions");
  if (revisions.length < 1) throw new TypeError("Legacy contest has no revision.");
  const projections = [];
  const statements = [];
  for (const revision of revisions) {
    const problems = await boundedRows(adapter, `SELECT selected.problem_id, selected.ordinal,
        problems.slug, revisions.judge_digest
      FROM contest_revision_problems AS selected
      JOIN problem_series AS problems ON problems.id=selected.problem_id
      JOIN problem_revisions AS revisions
        ON revisions.problem_id=selected.problem_id AND revisions.commit_sha=selected.commit_sha
      WHERE selected.contest_id=${sql(contestId)} AND selected.commit_sha=${sql(revision.commit_sha)}
      ORDER BY selected.ordinal`, MAX_PROBLEMS_PER_REVISION, "Legacy contest problems");
    problems.forEach((problem, index) => {
      if (problem.ordinal !== index + 1) throw new TypeError("Legacy contest problem ordinals are not contiguous.");
    });
    const projection = revisionProjection(revision, problems);
    projections.push({ projection, problems });
    statements.push(insertRuleRevision(contestId, projection));
    problems.forEach((problem, index) => statements.push(insertRuleProblem(contestId, projection, problem, index)));
  }
  const activeEntry = projections.find(({ projection }) => projection.commit_sha === authorityRows[0].active_commit_sha);
  if (!activeEntry) throw new TypeError("Legacy contest active revision is missing.");
  const active = activeEntry.projection;
  const operational = runtimeState(active, now);
  statements.push(`INSERT INTO contest_runtimes (
      contest_id, active_rules_commit, active_rules_sha256, active_activation_sha256,
      pending_rules_commit, pending_rules_sha256, pending_activation_sha256,
      rules_epoch, timeline_generation, state, wall_anchor_at, logical_anchor_seconds,
      pause_reason, paused_at, paused_from_state, schedule_shift_seconds,
      first_started_at, ended_at, created_at, updated_at
    ) VALUES (
      ${sql(contestId)}, ${sql(active.commit_sha)}, ${sql(active.rulesSha256)},
      ${sql(active.activationSha256)}, NULL, NULL, NULL, 1, 1, ${sql(operational.state)},
      NULL, ${operational.logicalSeconds}, NULL, NULL, NULL, 0,
      ${sql(operational.firstStartedAt)}, ${sql(operational.endedAt)},
      ${sql(active.created_at)}, ${sql(now)}
    ) ON CONFLICT(contest_id) DO NOTHING`);
  statements.push(`INSERT INTO contest_rule_epochs (
      contest_id, rules_epoch, rules_commit, rules_sha256, timeline_generation,
      activation_kind, activated_logical_seconds, activated_at, activated_by
    ) VALUES (
      ${sql(contestId)}, 1, ${sql(active.commit_sha)}, ${sql(active.rulesSha256)}, 1,
      'initial', 0, ${sql(active.created_at)}, ${sql(authorityRows[0].organizer_user_id)}
    ) ON CONFLICT(contest_id, rules_epoch) DO NOTHING`);
  activeEntry.problems.forEach((problem) => {
    statements.push(`INSERT INTO contest_problem_epochs (
        contest_id, problem_id, problem_epoch, rules_epoch, content_epoch, judge_epoch,
        content_commit, judge_commit, judge_digest, state, rollout_batch_id,
        created_at, effective_at, failure_code
      ) VALUES (
        ${sql(contestId)}, ${sql(problem.problem_id)}, 1, 1, 1, 1,
        ${sql(active.commit_sha)}, ${sql(active.commit_sha)}, ${sql(problem.judge_digest)},
        'effective', NULL, ${sql(now)}, ${sql(now)}, NULL
      ) ON CONFLICT(contest_id, problem_id, problem_epoch) DO NOTHING`);
  });
  await adapter.execute(statements);

  const entrants = await keysetRows(adapter, (cursor, limit) => `WITH entrant_facts(user_id, joined_at) AS (
      SELECT user_id, joined_at FROM contest_participants WHERE contest_id=${sql(contestId)}
      UNION ALL
      SELECT user_id, admitted_at FROM submissions
      WHERE contest_id=${sql(contestId)} AND origin_submission_id=id
    )
    SELECT user_id, MIN(joined_at) AS joined_at FROM entrant_facts
    GROUP BY user_id ${cursor === null ? "" : `HAVING user_id>${sql(cursor)}`}
    ORDER BY user_id LIMIT ${limit}`, "user_id", 100_000, "Legacy contest entrants");
  const entrantByUser = new Map();
  const entrantStatements = [];
  for (const entrant of entrants) {
    if (!UUID.test(entrant.user_id)) throw new TypeError("Legacy contest entrant user id is invalid.");
    const entrantId = deterministicEntrantId(contestId, entrant.user_id);
    entrantByUser.set(entrant.user_id, entrantId);
    const startedAt = operational.state === "ended" ? operational.firstStartedAt : null;
    entrantStatements.push(`INSERT INTO contest_entrants (
        id, contest_id, kind, subject_key, account_user_id, owner_user_id,
        joined_at, started_at, start_timeline_generation,
        individual_wall_anchor_at, individual_logical_anchor_seconds,
        state, state_timeline_generation, eliminated_at, eliminated_logical_seconds,
        eliminated_checkpoint_id, elimination_reason, created_at, updated_at
      ) VALUES (
        ${sql(entrantId)}, ${sql(contestId)}, 'account', ${sql(entrant.user_id)},
        ${sql(entrant.user_id)}, ${sql(entrant.user_id)}, ${sql(instant(entrant.joined_at, "legacy entrant joined_at"))},
        ${sql(startedAt)}, ${startedAt === null ? "NULL" : "1"}, NULL, 0,
        ${operational.state === "ended" ? "'completed'" : "'joined'"}, 1,
        NULL, NULL, NULL, NULL, ${sql(now)}, ${sql(now)}
      ) ON CONFLICT(contest_id, kind, subject_key) DO NOTHING`);
  }
  await adapter.execute(entrantStatements);

  const submissions = await keysetRows(adapter, (cursor, limit) => `SELECT origin.id, origin.user_id,
      origin.problem_id, origin.catalog_commit, origin.state,
      origin.admitted_at, origin.completed_at,
      COALESCE(result.completed_at, origin.completed_at) AS evidence_at
    FROM submissions AS origin
    LEFT JOIN effective_submission_results AS effective
      ON effective.origin_submission_id=origin.id
    LEFT JOIN submissions AS result ON result.id=effective.effective_submission_id
    WHERE origin.contest_id=${sql(contestId)} AND origin.origin_submission_id=origin.id
      ${cursor === null ? "" : `AND origin.id>${sql(cursor)}`}
    ORDER BY origin.id LIMIT ${limit}`, "id", 1_000_000, "Legacy contest submissions");
  const submissionStatements = [];
  const submissionFacts = [];
  for (const submission of submissions) {
    if (!TERMINAL_SUBMISSION_STATES.has(submission.state) || submission.evidence_at === null) {
      throw new TypeError("Legacy contest submission is not terminal.");
    }
    const entrantId = entrantByUser.get(submission.user_id);
    if (!entrantId) throw new TypeError("Legacy contest submission has no deterministic entrant.");
    const sourceProjection = projections.find(({ projection }) => projection.commit_sha === submission.catalog_commit);
    if (!sourceProjection?.problems.some((problem) => problem.problem_id === submission.problem_id)) {
      throw new TypeError("Legacy contest submission has no exact source rule problem.");
    }
    const admittedLogical = clampLogical(submission.admitted_at, active.startsAt, active.durationSeconds, "legacy submission admitted_at");
    const evidenceLogical = clampLogical(submission.evidence_at, active.startsAt, active.durationSeconds, "legacy submission evidence_at");
    submissionFacts.push({
      id: submission.id,
      entrantId,
      admittedLogical,
      evidenceLogical,
    });
    submissionStatements.push(`INSERT INTO contest_submission_records (
        submission_id, contest_id, entrant_id, timeline_generation, rules_epoch,
        content_epoch, judge_epoch, admitted_logical_seconds, evidence_at,
        evidence_logical_seconds, eligibility, invalidated_at, invalidation_reason, created_at
      ) VALUES (
        ${sql(submission.id)}, ${sql(contestId)}, ${sql(entrantId)}, 1, 1, 1, 1,
        ${admittedLogical}, 'judge-terminal', ${evidenceLogical}, 'eligible', NULL, NULL,
        ${sql(instant(submission.admitted_at, "legacy submission admitted_at"))}
      ) ON CONFLICT(submission_id) DO NOTHING`);
  }
  await adapter.execute(submissionStatements);

  const persistedRevisions = await keysetRows(adapter, (cursor, limit) => `SELECT rules_commit,
      rules_sha256, activation_sha256
    FROM contest_rule_revisions WHERE contest_id=${sql(contestId)}
      ${cursor === null ? "" : `AND rules_commit>${sql(cursor)}`}
    ORDER BY rules_commit LIMIT ${limit}`, "rules_commit", MAX_REVISIONS_PER_CONTEST,
  "Translated contest revisions");
  if (persistedRevisions.length !== projections.length || projections.some(({ projection }, index) => {
    const row = persistedRevisions[index];
    return row?.rules_commit !== projection.commit_sha || row.rules_sha256 !== projection.rulesSha256
      || row.activation_sha256 !== projection.activationSha256;
  })) throw new Error("Contest v1 cutover revision verification failed.");
  for (const { projection, problems } of projections) {
    const persistedProblems = await boundedRows(adapter, `SELECT problem_id, ordinal, problem_rules_json
      FROM contest_rule_problems
      WHERE contest_id=${sql(contestId)} AND rules_commit=${sql(projection.commit_sha)}
      ORDER BY ordinal`, MAX_PROBLEMS_PER_REVISION, "Translated contest problems");
    if (persistedProblems.length !== problems.length || persistedProblems.some((row, index) => (
      row.problem_id !== problems[index]?.problem_id
      || row.ordinal !== index + 1
      || row.problem_rules_json !== canonicalJson(projection.rules.problems[index])
    ))) throw new Error("Contest v1 cutover problem-rule verification failed.");
  }
  const persistedEntrants = await keysetRows(adapter, (cursor, limit) => `SELECT id, account_user_id
    FROM contest_entrants WHERE contest_id=${sql(contestId)}
      ${cursor === null ? "" : `AND account_user_id>${sql(cursor)}`}
    ORDER BY account_user_id LIMIT ${limit}`, "account_user_id", 100_000,
  "Translated contest entrants");
  if (persistedEntrants.length !== entrants.length || persistedEntrants.some((row, index) => (
    row.account_user_id !== entrants[index]?.user_id
    || row.id !== entrantByUser.get(row.account_user_id)
  ))) throw new Error("Contest v1 cutover entrant verification failed.");
  const persistedSubmissions = await keysetRows(adapter, (cursor, limit) => `SELECT submission_id,
      entrant_id, admitted_logical_seconds, evidence_logical_seconds, evidence_at, eligibility
    FROM contest_submission_records WHERE contest_id=${sql(contestId)}
      ${cursor === null ? "" : `AND submission_id>${sql(cursor)}`}
    ORDER BY submission_id LIMIT ${limit}`, "submission_id", 1_000_000,
  "Translated contest submissions");
  if (persistedSubmissions.length !== submissionFacts.length || persistedSubmissions.some((row, index) => {
    const fact = submissionFacts[index];
    return row.submission_id !== fact?.id || row.entrant_id !== fact.entrantId
      || row.admitted_logical_seconds !== fact.admittedLogical
      || row.evidence_logical_seconds !== fact.evidenceLogical
      || row.evidence_at !== "judge-terminal" || row.eligibility !== "eligible";
  })) throw new Error("Contest v1 cutover submission verification failed.");
  const runtime = await adapter.query(`SELECT active_rules_commit, active_rules_sha256,
      active_activation_sha256, rules_epoch, timeline_generation
    FROM contest_runtimes WHERE contest_id=${sql(contestId)}`);
  if (runtime.length !== 1 || runtime[0].active_rules_commit !== active.commit_sha
    || runtime[0].active_rules_sha256 !== active.rulesSha256
    || runtime[0].active_activation_sha256 !== active.activationSha256
    || runtime[0].rules_epoch !== 1 || runtime[0].timeline_generation !== 1) {
    throw new Error("Contest v1 cutover runtime verification failed.");
  }
  const persistedEpochs = await boundedRows(adapter, `SELECT problem_id, content_commit,
      judge_commit, judge_digest, problem_epoch, content_epoch, judge_epoch
    FROM contest_problem_epochs WHERE contest_id=${sql(contestId)} AND state='effective'
    ORDER BY problem_id`, MAX_PROBLEMS_PER_REVISION, "Translated contest problem epochs");
  const expectedEpochs = [...activeEntry.problems].sort((left, right) => left.problem_id.localeCompare(right.problem_id));
  if (persistedEpochs.length !== expectedEpochs.length || persistedEpochs.some((row, index) => {
    const expected = expectedEpochs[index];
    return row.problem_id !== expected?.problem_id || row.content_commit !== active.commit_sha
      || row.judge_commit !== active.commit_sha || row.judge_digest !== expected.judge_digest
      || row.problem_epoch !== 1 || row.content_epoch !== 1 || row.judge_epoch !== 1;
  })) throw new Error("Contest v1 cutover problem-epoch verification failed.");
  const verification = await adapter.query(`SELECT
      (SELECT COUNT(*) FROM contest_rule_problems WHERE contest_id=${sql(contestId)}) AS revisions_problems,
      (SELECT COUNT(*) FROM contest_entrants WHERE contest_id=${sql(contestId)}) AS entrants,
      (SELECT COUNT(*) FROM contest_submission_records WHERE contest_id=${sql(contestId)}) AS submissions,
      (SELECT COUNT(*) FROM contest_problem_epochs WHERE contest_id=${sql(contestId)} AND state='effective') AS active_problems`);
  const expectedProblems = projections.reduce((sum, value) => sum + value.problems.length, 0);
  if (verification.length !== 1
    || verification[0].revisions_problems !== expectedProblems
    || verification[0].entrants !== entrants.length
    || verification[0].submissions !== submissions.length
    || verification[0].active_problems !== activeEntry.problems.length) {
    throw new Error("Contest v1 cutover materialization verification failed.");
  }
  const completed = await adapter.query(`UPDATE contest_v2_cutover_items SET
      state='completed', translated_revision_count=${projections.length},
      translated_entrant_count=${entrants.length}, translated_submission_count=${submissions.length},
      completed_at=${sql(now)}
    WHERE contest_id=${sql(contestId)} AND state='pending'
      AND source_revision_count=${projections.length}
      AND source_submission_count=${submissions.length}
    RETURNING contest_id`);
  if (completed.length !== 1) {
    const existing = await adapter.query(`SELECT state FROM contest_v2_cutover_items WHERE contest_id=${sql(contestId)}`);
    if (existing.length !== 1 || existing[0].state !== "completed") {
      throw new Error("Contest v1 cutover item completion fence failed.");
    }
  }
}

export async function runContestV1Cutover(adapter, options = {}) {
  if (!adapter || typeof adapter.query !== "function" || typeof adapter.execute !== "function") {
    throw new TypeError("Contest cutover adapter is invalid.");
  }
  const now = instant(options.now ?? new Date().toISOString(), "contest cutover time");
  const states = await adapter.query("SELECT * FROM contest_v2_cutover_state WHERE singleton=1");
  if (states.length !== 1) throw new Error("Contest v2 cutover state is unavailable.");
  if (states[0].state === "completed") {
    return { state: "completed", translatedContests: states[0].completed_contest_count, replayed: true };
  }
  const blockers = await adapter.query("SELECT blocker_kind, blocker_key FROM contest_v2_cutover_input_blockers ORDER BY blocker_kind, blocker_key");
  if (blockers.length !== 0) throw new Error(`Contest v2 cutover is blocked: ${canonicalJson(blockers)}.`);
  await adapter.execute([`UPDATE contest_v2_cutover_state SET
      state='applying', started_at=COALESCE(started_at, ${sql(now)}),
      failure_code=NULL, updated_at=${sql(now)}
    WHERE singleton=1 AND state IN ('pending','applying','failed')`]);
  try {
    const items = await keysetRows(adapter, (cursor, limit) => `SELECT contest_id
      FROM contest_v2_cutover_items WHERE state='pending'
        ${cursor === null ? "" : `AND contest_id>${sql(cursor)}`}
      ORDER BY contest_id LIMIT ${limit}`, "contest_id", 10_000, "Legacy contests");
    for (const item of items) await translateContest(adapter, item.contest_id, now);
    const completed = await adapter.query(`UPDATE contest_v2_cutover_state SET
        state='completed', completed_contest_count=legacy_contest_count,
        completed_at=${sql(now)}, updated_at=${sql(now)}
      WHERE singleton=1 AND state='applying'
        AND NOT EXISTS (SELECT 1 FROM contest_v2_cutover_items WHERE state<>'completed')
      RETURNING legacy_contest_count`);
    if (completed.length !== 1) throw new Error("Contest v2 cutover final completion fence failed.");
    return { state: "completed", translatedContests: completed[0].legacy_contest_count, replayed: false };
  } catch (error) {
    const code = error instanceof TypeError ? "legacy-contest-unrepresentable" : "contest-v2-cutover-failed";
    await adapter.execute([`UPDATE contest_v2_cutover_state SET state='failed',
      failure_code=${sql(code)}, updated_at=${sql(now)}
      WHERE singleton=1 AND state='applying'`]);
    throw error;
  }
}

export const contestV1CutoverInternals = Object.freeze({
  canonicalJson,
  classicRules,
  deterministicEntrantId,
  revisionProjection,
});
