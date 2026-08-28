import { parseContestRules } from "../src/online-judge/contest-rules";
import { sha256Hex } from "./crypto";
import type { WasmOjWorkerEnv } from "./env";
import { ApiError, jsonResponse } from "./http";
import { bestContestProblemRows, type ContestResultRow } from "./leaderboards";
import { materializeContestRuntime } from "./contest-runtime";
import { submissionSourceKey } from "./submissions";

export interface PromptGallerySelectionCandidate extends ContestResultRow {
  readonly attempt_id: string;
  readonly prompt_text: string;
  readonly source_id: string;
  readonly source_sha256: string;
}

interface RuntimeDisclosureRow {
  readonly state: string;
  readonly timeline_generation: number;
  readonly rules_json: string;
  readonly official_track: string;
  readonly prompt_disclosure: string | null;
  readonly provisional: number;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} is invalid.`);
  return value as Record<string, unknown>;
}

function exact(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  if (JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...keys].sort())) throw new Error(`${label} has an invalid shape.`);
}

function publicGeneratedSource(value: unknown): Record<string, unknown> {
  const wrapper = record(value, "Stored prompt source");
  exact(wrapper, ["request", "schema", "sourceDigest"], "Stored prompt source");
  if (wrapper.schema !== "wasm-oj-platform/official-source/v1") throw new Error("Stored prompt source schema is invalid.");
  const request = record(wrapper.request, "Stored prompt source request");
  exact(request, ["entry", "language", "optimization", "sourceFiles", "target"], "Stored prompt source request");
  if (!Array.isArray(request.sourceFiles)) throw new Error("Stored prompt source files are invalid.");
  for (const [index, candidate] of request.sourceFiles.entries()) {
    const file = record(candidate, `Stored prompt source file ${index}`);
    exact(file, ["content", "encoding", "path"], `Stored prompt source file ${index}`);
    if (typeof file.path !== "string" || file.encoding !== "utf8" || typeof file.content !== "string") {
      throw new Error("Stored prompt source file is invalid.");
    }
  }
  return request;
}

async function sourceProjection(env: WasmOjWorkerEnv, row: PromptGallerySelectionCandidate): Promise<Record<string, unknown>> {
  const object = await env.JUDGE_BUCKET.get(submissionSourceKey(row.source_id));
  if (!object) throw new Error("Disclosed prompt source object is unavailable.");
  const bytes = new Uint8Array(await object.arrayBuffer());
  if (await sha256Hex(bytes) !== row.source_sha256) throw new Error("Disclosed prompt source failed its digest fence.");
  let value: unknown;
  try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown; }
  catch (error) { throw new Error("Disclosed prompt source is not canonical UTF-8 JSON.", { cause: error }); }
  return publicGeneratedSource(value);
}

export function selectPromptGalleryCandidates(
  rules: ReturnType<typeof parseContestRules>,
  candidates: readonly PromptGallerySelectionCandidate[],
): readonly PromptGallerySelectionCandidate[] {
  const grouped = new Map<string, PromptGallerySelectionCandidate[]>();
  for (const candidate of candidates) {
    const rows = grouped.get(candidate.entrant_id) ?? [];
    rows.push(candidate);
    grouped.set(candidate.entrant_id, rows);
  }
  const selected: PromptGallerySelectionCandidate[] = [];
  for (const rows of grouped.values()) {
    const best = bestContestProblemRows(rules, rows);
    for (const row of best.values()) selected.push(row as PromptGallerySelectionCandidate);
  }
  selected.sort((left, right) => left.entrant_id.localeCompare(right.entrant_id)
    || left.problem_slug.localeCompare(right.problem_slug));
  return selected;
}

export async function promptContestGallery(
  _request: Request,
  env: WasmOjWorkerEnv,
  contestId: string,
): Promise<Response> {
  await materializeContestRuntime(env, contestId);
  const runtime = await env.DB.prepare(`SELECT runtime.state, runtime.timeline_generation,
      revisions.rules_json, revisions.official_track, revisions.prompt_disclosure,
      EXISTS (SELECT 1 FROM contest_problem_epochs AS epochs
        JOIN rejudge_batches AS batches ON batches.id=epochs.rollout_batch_id
        WHERE epochs.contest_id=runtime.contest_id AND epochs.state='effective'
          AND batches.state<>'effective')
      OR EXISTS (SELECT 1 FROM contest_checkpoint_runs AS runs
        WHERE runs.contest_id=runtime.contest_id
          AND runs.timeline_generation=runtime.timeline_generation
          AND runs.state IN ('evaluating','provisional')) AS provisional
    FROM contest_runtimes AS runtime
    JOIN contest_rule_revisions AS revisions
      ON revisions.contest_id=runtime.contest_id
     AND revisions.rules_commit=runtime.active_rules_commit
     AND revisions.rules_sha256=runtime.active_rules_sha256
    WHERE runtime.contest_id=? AND revisions.status='published'`)
    .bind(contestId).first<RuntimeDisclosureRow>();
  if (!runtime || runtime.official_track !== "prompt-program"
    || runtime.prompt_disclosure !== "best-after-end") {
    throw new ApiError(404, "prompt-gallery-not-found", "This contest has no public Prompt Program gallery.");
  }
  if (runtime.state !== "ended") throw new ApiError(409, "prompt-gallery-embargoed", "Prompt Program disclosure begins after the contest ends.");
  if (runtime.provisional === 1) throw new ApiError(409, "prompt-gallery-provisional", "Final judge or checkpoint results are still settling.");
  const rules = parseContestRules(JSON.parse(runtime.rules_json) as unknown, "stored prompt gallery rules");
  const candidates = await env.DB.prepare(`SELECT records.entrant_id,
      entrants.account_user_id, origin.problem_id, problems.slug AS problem_slug,
      result.verdict, COALESCE(result.score, 0) AS score,
      result.fully_passed_cases, result.deterministic_cost, result.peak_memory_bytes,
      records.evidence_logical_seconds AS logical_seconds, result.id AS submission_id,
      origin.id AS origin_submission_id, attempts.id AS attempt_id,
      attempts.prompt_text, sources.id AS source_id,
      sources.content_sha256 AS source_sha256
    FROM prompt_attempts AS attempts
    JOIN prompt_attempt_quota AS quota ON quota.prompt_attempt_id=attempts.id
    JOIN contest_submission_records AS records ON records.submission_id=attempts.submission_id
    JOIN contest_entrants AS entrants
      ON entrants.id=attempts.entrant_id AND entrants.contest_id=attempts.contest_id
    JOIN submissions AS origin ON origin.id=attempts.submission_id
      AND origin.origin_submission_id=origin.id
    JOIN submission_sources AS sources ON sources.id=origin.source_id
    JOIN effective_submission_results AS effective ON effective.origin_submission_id=origin.id
    JOIN submissions AS result ON result.id=effective.effective_submission_id
    JOIN problem_series AS problems ON problems.id=origin.problem_id
    WHERE attempts.contest_id=?
      AND attempts.state='submitted' AND attempts.eligibility='eligible'
      AND attempts.erased_at IS NULL AND attempts.prompt_text IS NOT NULL
      AND quota.state='consumed' AND records.eligibility='eligible'
      AND records.evidence_logical_seconds IS NOT NULL
      AND sources.state='ready' AND sources.source_kind='prompt-generated'
      AND sources.content_sha256 IS NOT NULL
      AND result.state IN ('completed','compile-error','judge-error','infrastructure-error','cancelled')
      AND result.verdict IS NOT NULL
    ORDER BY records.entrant_id, problems.slug, records.evidence_logical_seconds, origin.id
    LIMIT 10001`)
    .bind(contestId).all<PromptGallerySelectionCandidate>();
  if (candidates.results.length > 10_000) throw new ApiError(503, "prompt-gallery-too-large", "Prompt gallery exceeds this release's bounded projection.");
  const entries = [];
  for (const row of selectPromptGalleryCandidates(rules, candidates.results)) {
    entries.push({
      entrantId: row.entrant_id,
      problemId: row.problem_id,
      problemSlug: row.problem_slug,
      promptAttemptId: row.attempt_id,
      submissionId: row.origin_submission_id,
      prompt: row.prompt_text,
      generatedSource: await sourceProjection(env, row),
      result: {
        verdict: row.verdict,
        score: row.score,
        fullyPassedCases: row.fully_passed_cases ?? 0,
        deterministicCost: row.deterministic_cost ?? 0,
        peakMemoryBytes: row.peak_memory_bytes ?? 0,
        achievedAtLogicalSeconds: row.logical_seconds,
      },
    });
  }
  return jsonResponse({ contestId, timelineGeneration: runtime.timeline_generation, entries }, 200, {
    "cache-control": "no-store",
  });
}
