"use client";

import {
  BrainCircuit,
  Clock3,
  CodeXml,
  GitCommitHorizontal,
  History,
  Pause,
  Play,
  RefreshCw,
  RotateCcw,
  ShieldAlert,
  UsersRound,
} from "lucide-react";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { formatLogicalDuration, type ContestProjection } from "../../contests/model/contest-projection";
import { wasmOjJson, wasmOjMutation } from "../../platform/api/online-api";

export interface OrganizerParticipantRow {
  readonly entrantId: string;
  readonly participant: { readonly id: string; readonly label: string };
  readonly joinedAt: string;
  readonly startedAt: string | null;
  readonly state: "joined" | "active" | "eliminated" | "completed";
  readonly logicalTimeSeconds: number | null;
  readonly nextBoundarySeconds: number | null;
  readonly phase: string;
  readonly checkpoints: readonly {
    readonly id: string;
    readonly state: string;
    readonly decision: "advanced" | "eliminated" | null;
    readonly provisional: boolean;
  }[];
  readonly elimination: {
    readonly at: string | null;
    readonly atLogicalSeconds: number;
    readonly checkpointId: string | null;
    readonly reason: string | null;
  } | null;
}

export interface PendingContestRulesPreview {
  readonly activeRulesCommit: string;
  readonly activeRulesDigest: string;
  readonly rulesCommit: string;
  readonly rulesDigest: string;
  readonly state: ContestProjection["runtimeState"];
  readonly logicalSeconds: number;
  readonly timelineGeneration: number;
  readonly ruleEpoch: number;
  readonly firstStarted: boolean;
  readonly immutableChanges: readonly string[];
  readonly rewindToZeroChanges: readonly string[];
  readonly canMonotonicRecalculate: boolean;
  readonly canRewind: boolean;
  readonly requiresRewindToZero: boolean;
}

export function rewindConfirmationPhrase(timelineGeneration: number): string {
  if (!Number.isSafeInteger(timelineGeneration) || timelineGeneration < 1) throw new TypeError("Timeline generation must be a positive integer.");
  return `REWIND TIMELINE ${timelineGeneration}`;
}

function rulesActivationConfirmationPhrase(ruleEpoch: number): string {
  return `APPLY RULE EPOCH ${ruleEpoch + 1}`;
}

function short(value: string): string {
  return value.slice(0, 12);
}

export function OrganizerContestOperations({
  contest,
  participants,
  onRefresh,
}: {
  readonly contest: ContestProjection;
  readonly participants: readonly OrganizerParticipantRow[];
  onRefresh(): Promise<void>;
}) {
  const [pauseReason, setPauseReason] = useState("");
  const [rewindReason, setRewindReason] = useState("");
  const [rewindTarget, setRewindTarget] = useState(() => Math.max(0, Math.floor(contest.logicalTimeSeconds ?? 0)));
  const [rewindConfirmation, setRewindConfirmation] = useState("");
  const [pending, setPending] = useState<PendingContestRulesPreview | null>();
  const [activationMode, setActivationMode] = useState<"monotonic-recalculate" | "rewind">("monotonic-recalculate");
  const [activationReason, setActivationReason] = useState("");
  const [activationTarget, setActivationTarget] = useState(0);
  const [activationConfirmation, setActivationConfirmation] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  const loadPending = useCallback(async () => {
    const value = await wasmOjJson<{ readonly pending: PendingContestRulesPreview | null }>(`/api/organizer/contests/${encodeURIComponent(contest.id)}/pending-rules`);
    setPending(value.pending);
    if (value.pending?.requiresRewindToZero) {
      setActivationMode("rewind");
      setActivationTarget(0);
    }
  }, [contest.id]);

  useEffect(() => {
    const timer = window.setTimeout(() => void loadPending().catch((reason: unknown) => {
      setMessage(reason instanceof Error ? reason.message : String(reason));
    }), 0);
    return () => window.clearTimeout(timer);
  }, [loadPending]);

  const mutate = async (path: string, body: unknown, success: string) => {
    setBusy(true);
    setMessage("");
    try {
      await wasmOjMutation(`/api/organizer/contests/${encodeURIComponent(contest.id)}/${path}`, body);
      await Promise.all([onRefresh(), loadPending()]);
      setMessage(success);
    } catch (reason) {
      setMessage(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  const pause = (event: FormEvent) => {
    event.preventDefault();
    void mutate("pause", { reason: pauseReason }, "Contest paused at one frozen logical timestamp.");
  };

  const rewind = (event: FormEvent) => {
    event.preventDefault();
    void mutate("rewind", { reason: rewindReason, targetLogicalSeconds: rewindTarget }, `Timeline rewound to ${formatLogicalDuration(rewindTarget)}. Resume explicitly when ready.`);
  };

  const activateRules = (event: FormEvent) => {
    event.preventDefault();
    const body = activationMode === "rewind"
      ? { mode: activationMode, reason: activationReason, rewindTargetLogicalSeconds: activationTarget }
      : { mode: activationMode, reason: activationReason };
    void mutate("pending-rules/apply", body, "Pending repository rules activated. Review the new epoch before resuming.");
  };

  const rewindPhrase = rewindConfirmationPhrase(contest.epochs.timelineGeneration);
  const activationPhrase = rulesActivationConfirmationPhrase(contest.epochs.ruleEpoch);
  const participantStates = participants.reduce<Record<string, number>>((counts, participant) => {
    counts[participant.state] = (counts[participant.state] ?? 0) + 1;
    return counts;
  }, {});

  return <div className="organizer-contest-operations">
    <section className="contest-runtime-inspect" aria-labelledby="contest-runtime-inspect-heading">
      <header><div><h3 id="contest-runtime-inspect-heading">Runtime and rule identity</h3><p>Read-only projection of the repository rules and current official timeline.</p></div><button type="button" disabled={busy} onClick={() => void Promise.all([onRefresh(), loadPending()])} aria-label="Refresh runtime"><RefreshCw size={15} /></button></header>
      <dl>
        <div><dt><GitCommitHorizontal size={13} /> Rules commit</dt><dd title={contest.rulesCommit}><code>{short(contest.rulesCommit)}</code></dd></div>
        <div><dt><History size={13} /> Timeline</dt><dd>generation <strong>{contest.epochs.timelineGeneration}</strong></dd></div>
        <div><dt><RotateCcw size={13} /> Rule epoch</dt><dd>epoch <strong>{contest.epochs.ruleEpoch}</strong></dd></div>
        <div><dt><Clock3 size={13} /> Logical time</dt><dd>{contest.logicalTimeSeconds === null ? "not started" : formatLogicalDuration(contest.logicalTimeSeconds)}</dd></div>
        <div><dt>{contest.officialTrack.kind === "prompt-program" ? <BrainCircuit size={13} /> : <CodeXml size={13} />} Official track</dt><dd>{contest.officialTrack.kind}</dd></div>
        <div><dt><ShieldAlert size={13} /> Evidence</dt><dd>{contest.evidenceAt}</dd></div>
      </dl>
      <p className="contest-runtime-digest">rules digest <code>{contest.rulesDigest}</code></p>
    </section>

    <section className="contest-operation-controls" aria-labelledby="contest-operation-heading">
      <header><h3 id="contest-operation-heading">Timeline operations</h3><p>These controls never edit repository rules. Every mutation is fenced to the current generation and epoch.</p></header>
      {contest.runtimeState === "paused" ? <div className="contest-operation-primary">
        <div><Pause size={17} /><p><strong>Paused</strong><span>{contest.pauseReason ?? "No pause reason was projected."}</span></p></div>
        <button className="primary-action" type="button" disabled={busy} onClick={() => void mutate("resume", {}, "Contest resumed from the frozen logical timestamp.")}><Play size={14} /> Resume contest</button>
      </div> : contest.runtimeState === "ended" ? <p className="product-empty">This contest has ended. Its official timeline is read only.</p> : <form className="organizer-product-form contest-operation-form" onSubmit={pause}>
        <label>Pause reason<textarea required minLength={1} maxLength={500} value={pauseReason} onChange={(event) => setPauseReason(event.target.value)} /></label>
        <button className="secondary-action" disabled={busy || pauseReason.trim().length === 0}><Pause size={14} /> Pause contest</button>
      </form>}

      {contest.runtimeState === "paused" && <form className="contest-danger-operation" onSubmit={rewind}>
        <header><ShieldAlert size={17} /><div><strong>Rewind the whole contest timeline</strong><p>Rewind creates a new generation, invalidates post-target official evidence, restores affected quotas, and relocks future content. Data is retained as invalid history; participants may already know revealed content.</p></div></header>
        <div className="organizer-date-grid">
          <label>Target logical second<input type="number" min={0} max={Math.floor(contest.logicalTimeSeconds ?? 0)} step={1} required value={rewindTarget} onChange={(event) => setRewindTarget(Number(event.target.value))} /></label>
          <label>Reason<input required minLength={1} maxLength={500} value={rewindReason} onChange={(event) => setRewindReason(event.target.value)} /></label>
        </div>
        <label>Type <strong>{rewindPhrase}</strong><input autoComplete="off" required value={rewindConfirmation} onChange={(event) => setRewindConfirmation(event.target.value)} /></label>
        <button className="danger-action" disabled={busy || rewindConfirmation !== rewindPhrase || rewindReason.trim().length === 0}><RotateCcw size={14} /> Create new timeline generation</button>
      </form>}
    </section>

    <section className="contest-pending-rules" aria-labelledby="pending-rules-heading">
      <header><div><h3 id="pending-rules-heading">Pending repository rules</h3><p>{pending === undefined ? "Inspecting the synced repository projection…" : pending === null ? "No pending rule digest." : `${short(pending.activeRulesCommit)} → ${short(pending.rulesCommit)}`}</p></div>{pending && <span>{pending.requiresRewindToZero ? "rewind 0 required" : "activation pending"}</span>}</header>
      {pending && <>
        <dl><div><dt>Pending commit</dt><dd><code>{pending.rulesCommit}</code></dd></div><div><dt>Pending digest</dt><dd><code>{pending.rulesDigest}</code></dd></div></dl>
        {pending.immutableChanges.length > 0 && <div className="contest-rule-blocker" role="alert"><strong>Immutable after first Start</strong><p>{pending.immutableChanges.join(", ")}</p></div>}
        {pending.rewindToZeroChanges.length > 0 && <div className="contest-rule-blocker" role="note"><strong>Requires rewind to logical time 0</strong><p>{pending.rewindToZeroChanges.join(", ")}</p></div>}
        <form className="organizer-product-form contest-rule-activation" onSubmit={activateRules}>
          <label>Activation mode<select value={activationMode} onChange={(event) => setActivationMode(event.target.value as typeof activationMode)}><option value="monotonic-recalculate" disabled={!pending.canMonotonicRecalculate}>Monotonic recalculation</option><option value="rewind" disabled={!pending.canRewind}>Rewind and activate</option></select></label>
          {activationMode === "rewind" && <label>Rewind target<input type="number" min={0} max={Math.floor(contest.logicalTimeSeconds ?? 0)} step={1} required value={activationTarget} onChange={(event) => setActivationTarget(Number(event.target.value))} /></label>}
          <label>Activation reason<textarea required minLength={1} maxLength={500} value={activationReason} onChange={(event) => setActivationReason(event.target.value)} /></label>
          <p className="contest-operation-warning"><ShieldAlert size={14} /> Monotonic recalculation never revives eliminated entrants, but may eliminate more entrants and invalidate later submissions. Rewind supersedes the whole timeline generation.</p>
          <label>Type <strong>{activationPhrase}</strong><input autoComplete="off" required value={activationConfirmation} onChange={(event) => setActivationConfirmation(event.target.value)} /></label>
          <button className="danger-action" disabled={busy || contest.runtimeState !== "paused" || activationConfirmation !== activationPhrase || activationReason.trim().length === 0 || (activationMode === "monotonic-recalculate" ? !pending.canMonotonicRecalculate : !pending.canRewind)}>Activate pending rules</button>
        </form>
      </>}
    </section>

    <section className="contest-entrant-inspect" aria-labelledby="entrant-inspect-heading">
      <header><div><h3 id="entrant-inspect-heading"><UsersRound size={15} /> Entrants</h3><p>{participants.length} account entrants · {participantStates.active ?? 0} active · {participantStates.eliminated ?? 0} eliminated</p></div></header>
      <div className="performance-table-wrap"><table className="performance-table"><caption>Current entrant state in timeline generation {contest.epochs.timelineGeneration}</caption><thead><tr><th>Entrant</th><th>State</th><th>Started</th><th>Logical time</th><th>Checkpoint</th></tr></thead><tbody>{participants.map((row) => <tr className={row.state === "eliminated" ? "is-invalid" : ""} key={row.entrantId}><td>{row.participant.label}</td><td><strong>{row.state}</strong></td><td>{row.startedAt ? new Date(row.startedAt).toLocaleString() : "—"}</td><td>{row.logicalTimeSeconds === null ? "—" : formatLogicalDuration(row.logicalTimeSeconds)}</td><td>{row.elimination?.checkpointId ?? row.checkpoints.findLast((checkpoint) => checkpoint.decision === "advanced")?.id ?? "—"}</td></tr>)}</tbody></table></div>
      {participants.length === 0 && <p className="product-empty">No entrants have joined.</p>}
    </section>
    {message && <output className="product-message" role="status">{message}</output>}
  </div>;
}
