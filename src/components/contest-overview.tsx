"use client";

import Link from "next/link";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { LeaderboardTable, type PublicLeaderboardEntry } from "./leaderboard-table";
import { forgeJson, forgeMutation } from "./online-api";
import { managedProblemWorkspacePath } from "../online-judge/managed-problem-collection";

interface ContestDetail {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly accessMode: "public" | "invite";
  readonly startsAt: string;
  readonly endsAt: string;
  readonly freezeAt: string | null;
  readonly status: string;
  readonly joined: boolean;
  readonly organizer: boolean;
}

interface ContestProblem {
  readonly ordinal: number;
  readonly problemVersionId: string;
  readonly problemSlug: string;
  readonly title: Record<string, string>;
}

export function ContestOverview({ contestId }: { readonly contestId: string }) {
  const [contest, setContest] = useState<ContestDetail>();
  const [problems, setProblems] = useState<ContestProblem[]>([]);
  const [entries, setEntries] = useState<PublicLeaderboardEntry[]>([]);
  const [frozen, setFrozen] = useState(false);
  const [inviteCode, setInviteCode] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const [detail, board] = await Promise.all([
      forgeJson<{ contest: ContestDetail; problems: ContestProblem[] }>(`/api/contests/${encodeURIComponent(contestId)}`),
      forgeJson<{ frozen: boolean; entries: PublicLeaderboardEntry[] }>(`/api/contests/${encodeURIComponent(contestId)}/leaderboard`),
    ]);
    setContest(detail.contest); setProblems(detail.problems); setEntries(board.entries); setFrozen(board.frozen);
  }, [contestId]);

  useEffect(() => {
    const timer = window.setTimeout(() => void load().catch((error: unknown) => setMessage(error instanceof Error ? error.message : String(error))), 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  async function join(event: FormEvent) {
    event.preventDefault(); setBusy(true); setMessage("");
    try {
      await forgeMutation(`/api/contests/${encodeURIComponent(contestId)}/join`, inviteCode ? { inviteCode } : {});
      await load(); setMessage("Contest joined.");
    } catch (error) { setMessage(error instanceof Error ? error.message : String(error)); } finally { setBusy(false); }
  }

  return <main className="product-page">
    <header className="product-page-header"><Link className="product-back" href="/contests">← Contests</Link><h1>{contest?.title ?? "Contest"}</h1><p>{contest?.description}</p></header>
    {!contest && !message && <section className="product-empty large">Loading contest…</section>}
    {contest && <>
      <section className="contest-facts"><div><span>Schedule</span><strong>{new Date(contest.startsAt).toLocaleString()}</strong><small>to {new Date(contest.endsAt).toLocaleString()}</small></div><div><span>Access</span><strong>{contest.accessMode}</strong><small>{contest.joined ? "Joined" : contest.organizer ? "Organizer" : "Not joined"}</small></div><div><span>Status</span><strong>{new Date(contest.endsAt) <= new Date() ? "Ended" : new Date(contest.startsAt) > new Date() ? "Upcoming" : "Running"}</strong><small>{contest.freezeAt ? `Freeze ${new Date(contest.freezeAt).toLocaleString()}` : "Live leaderboard"}</small></div></section>
      {!contest.joined && !contest.organizer && new Date(contest.endsAt) > new Date() && <form className="contest-join organizer-product-form" onSubmit={(event) => void join(event)}><div><h2>Join contest</h2><p>Join to make verified submissions. Statements remain visible for public contests.</p></div>{contest.accessMode === "invite" && <label>Invite code<input value={inviteCode} minLength={16} maxLength={128} required onChange={(event) => setInviteCode(event.target.value)} /></label>}<button className="primary-action" disabled={busy}>Join contest</button></form>}
      <section className="organizer-product-section"><h2>Problems</h2><div className="contest-problem-list">{problems.map((problem) => <Link key={problem.problemVersionId} href={managedProblemWorkspacePath({ contestId, problemVersionId: problem.problemVersionId })}><span>{problem.ordinal}</span><strong>{problem.title["zh-TW"] ?? problem.title.en ?? problem.problemSlug}</strong><span>Open →</span></Link>)}</div></section>
      <section className="organizer-product-section"><h2>Leaderboard</h2>{frozen ? <p className="product-empty">The leaderboard is frozen until the contest ends.</p> : <LeaderboardTable entries={entries} showProblems />}</section>
    </>}
    {message && <output className="product-message" role="status">{message}</output>}
  </main>;
}
